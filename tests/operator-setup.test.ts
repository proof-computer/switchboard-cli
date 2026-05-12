import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  capabilityRegistrationWarning,
  composePullServicesCommand,
  composeUpCommand,
  mergeOperatorEnv,
  migrateLegacyGatewayImage,
  migrateLegacyTlsTestUpstreamImage,
  parseOsRelease,
  planOperatorImageMigration,
  setupOperator,
  shouldPrompt
} from "../scripts/operator/setup.js";

describe("operator setup helpers", () => {
  it("--yes disables readline prompts so sudo can own the terminal", () => {
    assert.equal(shouldPrompt(new Map<string, string | boolean>([["yes", true]])), false);
  });

  it("parses apt-compatible os-release files", () => {
    assert.deepEqual(
      parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nID_LIKE="debian"\nVERSION_ID="24.04"\n'),
      {
        id: "ubuntu",
        idLike: ["debian"],
        name: "Ubuntu",
        versionId: "24.04"
      }
    );
  });

  it("updates operator env keys while preserving unrelated existing secrets", () => {
    const next = mergeOperatorEnv(
      [
        "GRAFANA_ADMIN_PASSWORD=existing-secret",
        "OPERATOR_MANAGER_IDS=old",
        "OPERATOR_SLUG=old-local-label",
        "OPERATOR_PUBLIC_ADDRESSES=",
        "OPERATOR_PROCESSORS=",
        ""
      ].join("\n"),
      {
        OPERATOR_MANAGER_IDS: "9470",
        OPERATOR_PUBLIC_ADDRESSES: "203.0.113.10",
        OPERATOR_PROCESSORS: "5First,5Second",
        OPERATOR_PROCESSOR_DISCOVERY_ENABLED: "true"
      }
    );

    assert.match(next, /^GRAFANA_ADMIN_PASSWORD=existing-secret$/m);
    assert.match(next, /^OPERATOR_MANAGER_IDS=9470$/m);
    assert.doesNotMatch(next, /^OPERATOR_SLUG=/m);
    assert.match(next, /^OPERATOR_PUBLIC_ADDRESSES=203\.0\.113\.10$/m);
    assert.match(next, /^OPERATOR_PROCESSORS=5First,5Second$/m);
    assert.match(next, /^OPERATOR_PROCESSOR_DISCOVERY_ENABLED=true$/m);
  });

  it("builds docker compose plugin commands for prebuilt images by default", () => {
    assert.deepEqual(
      composeUpCommand({
        envFile: "/srv/proof/.operator-host/operator.env",
        composeFile: "/srv/proof/docker-compose.yaml",
        composeStyle: "docker-compose-plugin",
        build: false
      }),
      [
        "docker",
        "compose",
        "--env-file",
        "/srv/proof/.operator-host/operator.env",
        "-f",
        "/srv/proof/docker-compose.yaml",
        "up",
        "-d",
        "--no-build"
      ]
    );
  });

  it("builds docker compose pull commands for selected services", () => {
    assert.deepEqual(
      composePullServicesCommand({
        envFile: "/srv/proof/.operator-host/operator.env",
        composeFile: "/srv/proof/docker-compose.yaml",
        composeStyle: "docker-compose-plugin",
        services: ["envoy", "victoria-metrics", "grafana", "gateway-agent", "hub-watcher"]
      }),
      [
        "docker",
        "compose",
        "--env-file",
        "/srv/proof/.operator-host/operator.env",
        "-f",
        "/srv/proof/docker-compose.yaml",
        "pull",
        "envoy",
        "victoria-metrics",
        "grafana",
        "gateway-agent",
        "hub-watcher"
      ]
    );
  });

  it("includes every compose override in upgrade commands", () => {
    assert.deepEqual(
      composePullServicesCommand({
        envFile: "/srv/proof/.operator-host/operator.env",
        composeFiles: [
          "/srv/proof/docker-compose.yaml",
          "/srv/proof/docker-compose.public-bases.yaml"
        ],
        composeStyle: "docker-compose-plugin",
        services: ["envoy", "gateway-agent"]
      }),
      [
        "docker",
        "compose",
        "--env-file",
        "/srv/proof/.operator-host/operator.env",
        "-f",
        "/srv/proof/docker-compose.yaml",
        "-f",
        "/srv/proof/docker-compose.public-bases.yaml",
        "pull",
        "envoy",
        "gateway-agent"
      ]
    );
  });

  it("still supports explicit local build commands", () => {
    assert.deepEqual(
      composeUpCommand({
        envFile: "/srv/proof/.operator-host/operator.env",
        composeFile: "/srv/proof/docker-compose.yaml",
        composeStyle: "docker-compose-plugin",
        build: true
      }).at(-1),
      "--build"
    );
  });

  it("can plan a clean operator install from packaged assets", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "proof-operator-"));
    const report = await setupOperator(
      new Map<string, string | boolean>([
        ["project-dir", projectDir],
        ["public-address", "127.0.0.1"],
        ["manager-id", "1"],
        ["skip-install", true],
        ["skip-compose", true],
        ["dry-run", true],
        ["yes", true]
      ])
    );

    assert.equal(report.config.composeFile, path.join(projectDir, "docker-compose.yaml"));
    const actions = report.actions.join("\n");
    assert.match(actions, /would write packaged operator compose file/);
    assert.match(actions, /would write packaged operator Envoy config/);
    assert.match(actions, /would write packaged operator VictoriaMetrics scrape config/);
    assert.match(actions, /would write packaged operator Grafana datasource config/);
    assert.equal(
      report.warnings.some((warning) => warning.includes("Compose file not found")),
      false
    );
  });

  it("seeds public base-image config and mainnet operator defaults", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "proof-operator-seed-"));
    await setupOperator(
      new Map<string, string | boolean>([
        ["project-dir", projectDir],
        ["public-address", "127.0.0.1"],
        ["manager-id", "9470"],
        ["skip-install", true],
        ["skip-compose", true],
        ["yes", true]
      ])
    );

    const compose = await readFile(path.join(projectDir, "docker-compose.yaml"), "utf8");
    assert.match(compose, /envoyproxy\/envoy:v1\.35-latest/);
    assert.match(compose, /victoriametrics\/victoria-metrics:latest/);
    assert.match(compose, /grafana\/grafana-oss:latest/);
    assert.match(compose, /ghcr\.io\/proof-computer\/switchboard-gateway\/gateway:latest/);
    assert.doesNotMatch(compose, /ghcr\.io\/proof-computer\/switchboard\/operator:latest/);
    assert.match(compose, /docker\/envoy\/envoy\.yaml/);
    assert.match(compose, /docker\/victoria-metrics\/promscrape\.yml/);
    assert.match(compose, /docker\/grafana\/provisioning/);

    assert.match(await readFile(path.join(projectDir, "docker", "envoy", "envoy.yaml"), "utf8"), /lds\.json/);
    assert.match(await readFile(path.join(projectDir, "docker", "victoria-metrics", "promscrape.yml"), "utf8"), /envoy:9901/);
    assert.match(
      await readFile(path.join(projectDir, "docker", "grafana", "provisioning", "datasources", "victoria-metrics.yml"), "utf8"),
      /VictoriaMetrics/
    );

    const env = await readFile(path.join(projectDir, ".operator-host", "operator.env"), "utf8");
    assert.match(env, /^GATEWAY_AGENT_IMAGE=ghcr\.io\/proof-computer\/switchboard-gateway\/gateway:latest$/m);
    assert.match(env, /^HUB_WATCHER_IMAGE=ghcr\.io\/proof-computer\/switchboard-gateway\/gateway:latest$/m);
    assert.match(env, /^OPERATOR_ID=$/m);
    assert.match(env, /^OPERATOR_PROCESSOR_MAX_AGE_SECONDS=1800$/m);
    assert.match(env, /^OPERATOR_PROCESSOR_DISCOVERY_CHECK_AVAILABILITY=true$/m);
    assert.match(env, /^ACURAST_RPC=wss:\/\/archive\.mainnet\.acurast\.com$/m);
    assert.match(env, /^INGRESS_REGISTRY_ADDRESS=0x65d6B76BeC50F46D198fFa3598E381a298025Da0$/m);
    assert.match(env, /^PROOF_NETWORK_MANIFEST_URL=https:\/\/control\.switchboard\.proof\.computer\/v1\/network-manifest$/m);
  });

  it("migrates known old operator image defaults during upgrade planning", async () => {
    assert.equal(
      migrateLegacyGatewayImage("ghcr.io/proof-computer/switchboard/operator:sha-deadbee"),
      "ghcr.io/proof-computer/switchboard-gateway/gateway:sha-deadbee"
    );
    assert.equal(
      migrateLegacyGatewayImage("ghcr.io/mooselabs/switchboard/operator:latest"),
      "ghcr.io/proof-computer/switchboard-gateway/gateway:latest"
    );
    assert.equal(migrateLegacyGatewayImage("ghcr.io/example/custom/operator:latest"), undefined);
    assert.equal(
      migrateLegacyTlsTestUpstreamImage("ghcr.io/proof-computer/switchboard/tls-test-upstream:sha-deadbee"),
      "ghcr.io/proof-computer/switchboard-gateway/tls-test-upstream:sha-deadbee"
    );

    const projectDir = await mkdtemp(path.join(os.tmpdir(), "proof-operator-upgrade-"));
    const envFile = path.join(projectDir, ".operator-host", "operator.env");
    await mkdir(path.dirname(envFile), { recursive: true });
    await writeFile(
      envFile,
      [
        "GATEWAY_AGENT_IMAGE=ghcr.io/proof-computer/switchboard/operator:sha-old",
        "HUB_WATCHER_IMAGE=ghcr.io/mooselabs/switchboard/operator:latest",
        "TLS_TEST_UPSTREAM_IMAGE=ghcr.io/proof-computer/switchboard/tls-test-upstream:sha-old",
        "ENVOY_IMAGE=envoyproxy/envoy:v1.35-latest",
        ""
      ].join("\n"),
      "utf8"
    );

    const migration = await planOperatorImageMigration(envFile, false);
    assert.deepEqual(migration.updates, {
      GATEWAY_AGENT_IMAGE: "ghcr.io/proof-computer/switchboard-gateway/gateway:sha-old",
      HUB_WATCHER_IMAGE: "ghcr.io/proof-computer/switchboard-gateway/gateway:latest",
      TLS_TEST_UPSTREAM_IMAGE: "ghcr.io/proof-computer/switchboard-gateway/tls-test-upstream:sha-old"
    });

    const kept = await planOperatorImageMigration(envFile, true);
    assert.equal(kept.updates, undefined);
  });

  it("records explicit site processor includes during setup", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "proof-operator-processors-"));
    const report = await setupOperator(
      new Map<string, string | boolean>([
        ["project-dir", projectDir],
        ["public-address", "127.0.0.1"],
        ["manager-id", "9470"],
        ["processor", "5First, 5Second"],
        ["skip-install", true],
        ["skip-compose", true],
        ["dry-run", true],
        ["yes", true]
      ])
    );

    assert.equal(report.config.processorRefs, "5First,5Second");
  });

  it("records explicit Hub operator ID during setup", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "proof-operator-id-"));
    const operatorId = "0x5c58c1d827db4fc0df06f17cc1e469b96dd86e17e3c2f19d8a7efec218028763";
    const report = await setupOperator(
      new Map<string, string | boolean>([
        ["project-dir", projectDir],
        ["public-address", "127.0.0.1"],
        ["manager-id", "9470"],
        ["operator-id", operatorId],
        ["skip-install", true],
        ["skip-compose", true],
        ["yes", true]
      ])
    );

    assert.equal(report.config.operatorId, operatorId);
    const env = await readFile(path.join(projectDir, ".operator-host", "operator.env"), "utf8");
    assert.match(env, new RegExp(`^OPERATOR_ID=${operatorId}$`, "m"));
  });

  it("records capability report configuration during setup", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "proof-operator-capability-"));
    const previousSeed = process.env.JEN_OPERATOR_REPORT_SEED;
    const previousToken = process.env.JEN_OPERATOR_CAPABILITY_TOKEN;
    process.env.JEN_OPERATOR_REPORT_SEED = "test report seed";
    process.env.JEN_OPERATOR_CAPABILITY_TOKEN = "test-token";
    try {
      const report = await setupOperator(
        new Map<string, string | boolean>([
          ["project-dir", projectDir],
          ["public-address", "127.0.0.1"],
          ["manager-id", "9470"],
          ["operator-report-seed-env", "JEN_OPERATOR_REPORT_SEED"],
          ["capability-url", "https://control.switchboard.proof.computer/v1/operator-capabilities"],
          ["capability-token-env", "JEN_OPERATOR_CAPABILITY_TOKEN"],
          ["skip-install", true],
          ["skip-compose", true],
          ["yes", true]
        ])
      );

      assert.equal(report.config.capabilityReportUrl, "https://control.switchboard.proof.computer/v1/operator-capabilities");
      const env = await readFile(path.join(projectDir, ".operator-host", "operator.env"), "utf8");
      assert.match(env, /^OPERATOR_REPORT_SEED=test report seed$/m);
      assert.match(env, /^PROOF_OPERATOR_CAPABILITY_URL=https:\/\/control\.switchboard\.proof\.computer\/v1\/operator-capabilities$/m);
      assert.match(env, /^PROOF_OPERATOR_CAPABILITY_TOKEN=test-token$/m);
    } finally {
      if (previousSeed === undefined) {
        delete process.env.JEN_OPERATOR_REPORT_SEED;
      } else {
        process.env.JEN_OPERATOR_REPORT_SEED = previousSeed;
      }
      if (previousToken === undefined) {
        delete process.env.JEN_OPERATOR_CAPABILITY_TOKEN;
      } else {
        process.env.JEN_OPERATOR_CAPABILITY_TOKEN = previousToken;
      }
    }
  });

  it("records route-state polling configuration during setup", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "proof-operator-route-api-"));
    const previousToken = process.env.PROOF_OPERATOR_CAPABILITY_TOKEN;
    process.env.PROOF_OPERATOR_CAPABILITY_TOKEN = "capability-token";
    try {
      const report = await setupOperator(
        new Map<string, string | boolean>([
          ["project-dir", projectDir],
          ["public-address", "195.22.134.245"],
          ["manager-id", "9470"],
          ["operator-id", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          ["gateway-id", "switchboard-az-01"],
          ["gateway-agent-bind-address", "127.0.0.1"],
          ["skip-install", true],
          ["skip-compose", true],
          ["yes", true]
        ])
      );
      const expectedRouteStateUrl =
        "https://control.switchboard.proof.computer/v1/operators/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/gateways/switchboard-az-01/route-state";
      assert.equal(report.network.gatewayAgentBindAddress, "127.0.0.1");
      assert.equal(report.network.routeStateUrl, expectedRouteStateUrl);
      const env = await readFile(path.join(projectDir, ".operator-host", "operator.env"), "utf8");
      assert.match(env, /^GATEWAY_AGENT_BIND_ADDR=127\.0\.0\.1$/m);
      assert.match(env, new RegExp(`^GATEWAY_ROUTE_STATE_URL=${expectedRouteStateUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
      assert.match(env, /^GATEWAY_ROUTE_STATE_TOKEN=capability-token$/m);
      assert.match(env, /^ROUTE_INTENT_OUTPUT_URL=http:\/\/gateway-agent:18080\/internal\/route-intents$/m);
      assert.doesNotMatch(env, /^GATEWAY_MANAGEMENT_HOSTNAME=/m);
      assert.doesNotMatch(env, /^GATEWAY_AGENT_ROUTE_INTENT_AUTH_MODE=/m);
      assert.doesNotMatch(env, /^GATEWAY_AGENT_ROUTE_INTENT_ALLOWED_SIGNERS=/m);
    } finally {
      if (previousToken === undefined) {
        delete process.env.PROOF_OPERATOR_CAPABILITY_TOKEN;
      } else {
        process.env.PROOF_OPERATOR_CAPABILITY_TOKEN = previousToken;
      }
    }
  });

  it("warns clearly when relay capability registration is not allowlisted", () => {
    const warning = capabilityRegistrationWarning(
      403,
      JSON.stringify({
        error: "manager_scope_not_authorized",
        managerIds: ["9470"]
      })
    );

    assert.match(warning ?? "", /Relay rejected this operator capability report/);
    assert.match(warning ?? "", /manager_scope_not_authorized/);
    assert.match(warning ?? "", /managerIds=9470/);
    assert.match(warning ?? "", /allowlist/);
  });
});
