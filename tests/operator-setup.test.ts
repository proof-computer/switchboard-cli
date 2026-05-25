import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  capabilityRegistrationWarning,
  classifyOperatorStatus,
  composePullServicesCommand,
  composeUpCommand,
  deriveReportSigner,
  mergeOperatorEnv,
  migrateLegacyGatewayImage,
  migrateLegacyTlsTestUpstreamImage,
  parseOsRelease,
  parseOperatorAdmissionBundle,
  planOperatorImageMigration,
  setupOperator,
  shouldPrompt
} from "../scripts/operator/setup.js";

const TEST_REPORT_MNEMONIC = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

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

  it("can plan a clean gateway install from packaged assets", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "proof-operator-"));
    const report = await setupOperator(
      new Map<string, string | boolean>([
        ["project-dir", projectDir],
        ["public-address", "127.0.0.1"],
        ["manager-id", "1"],
        ["skip-install", true],
        ["skip-compose", true],
        ["local-only", true],
        ["dry-run", true],
        ["yes", true]
      ])
    );

    assert.equal(report.config.composeFile, path.join(projectDir, "docker-compose.yaml"));
    const actions = report.actions.join("\n");
    assert.match(actions, /would write packaged gateway compose file/);
    assert.match(actions, /would write packaged gateway Envoy config/);
    assert.match(actions, /would write packaged gateway VictoriaMetrics scrape config/);
    assert.match(actions, /would write packaged gateway Grafana datasource config/);
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
        ["local-only", true],
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
        ["local-only", true],
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
        ["local-only", true],
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
    process.env.JEN_OPERATOR_REPORT_SEED = TEST_REPORT_MNEMONIC;
    process.env.JEN_OPERATOR_CAPABILITY_TOKEN = "test-token";
    try {
      const report = await setupOperator(
        new Map<string, string | boolean>([
          ["project-dir", projectDir],
          ["public-address", "127.0.0.1"],
          ["manager-id", "9470"],
          ["operator-id", "0x5c58c1d827db4fc0df06f17cc1e469b96dd86e17e3c2f19d8a7efec218028763"],
          ["gateway-id", "switchboard-az-test"],
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
      assert.match(env, new RegExp(`^OPERATOR_REPORT_SEED=${TEST_REPORT_MNEMONIC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
      assert.match(env, /^PROOF_OPERATOR_CAPABILITY_URL=https:\/\/control\.switchboard\.proof\.computer\/v1\/operator-capabilities$/m);
      assert.match(env, /^PROOF_OPERATOR_CAPABILITY_TOKEN=test-token$/m);
      assert.match(env, /^GATEWAY_ROUTE_STATE_TOKEN=test-token$/m);
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
    const previousSeed = process.env.OPERATOR_REPORT_SEED;
    const previousToken = process.env.PROOF_OPERATOR_CAPABILITY_TOKEN;
    process.env.OPERATOR_REPORT_SEED = TEST_REPORT_MNEMONIC;
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
      assert.match(env, /^PROOF_OPERATOR_CAPABILITY_URL=https:\/\/control\.switchboard\.proof\.computer\/v1\/operator-capabilities$/m);
      assert.match(env, new RegExp(`^GATEWAY_ROUTE_STATE_URL=${expectedRouteStateUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
      assert.match(env, /^GATEWAY_ROUTE_STATE_TOKEN=capability-token$/m);
      assert.match(env, /^ROUTE_INTENT_OUTPUT_URL=http:\/\/gateway-agent:18080\/internal\/route-intents$/m);
      assert.doesNotMatch(env, /^GATEWAY_MANAGEMENT_HOSTNAME=/m);
      assert.doesNotMatch(env, /^GATEWAY_AGENT_ROUTE_INTENT_AUTH_MODE=/m);
      assert.doesNotMatch(env, /^GATEWAY_AGENT_ROUTE_INTENT_ALLOWED_SIGNERS=/m);
    } finally {
      if (previousSeed === undefined) {
        delete process.env.OPERATOR_REPORT_SEED;
      } else {
        process.env.OPERATOR_REPORT_SEED = previousSeed;
      }
      if (previousToken === undefined) {
        delete process.env.PROOF_OPERATOR_CAPABILITY_TOKEN;
      } else {
        process.env.PROOF_OPERATOR_CAPABILITY_TOKEN = previousToken;
      }
    }
  });

  it("generates shared route-intent auth for non-loopback gateway-agent binds", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "proof-gateway-route-auth-"));
    const previousGatewayToken = process.env.GATEWAY_AGENT_ROUTE_INTENT_TOKEN;
    const previousOutputToken = process.env.ROUTE_INTENT_OUTPUT_TOKEN;
    try {
      delete process.env.GATEWAY_AGENT_ROUTE_INTENT_TOKEN;
      delete process.env.ROUTE_INTENT_OUTPUT_TOKEN;
      const report = await setupOperator(
        new Map<string, string | boolean>([
          ["project-dir", projectDir],
          ["public-address", "195.22.134.245"],
          ["manager-id", "9470"],
          ["gateway-id", "switchboard-az-token"],
          ["gateway-agent-bind-address", "192.168.3.4"],
          ["skip-install", true],
          ["skip-compose", true],
          ["local-only", true],
          ["yes", true]
        ])
      );

      assert.equal(report.network.gatewayAgentExternallyBound, true);
      assert.equal(report.network.upstreamAdmissionUrl, "http://192.168.3.4:18080/v1/upstream-admissions");
      assert.equal(report.config.routeIntentAuthConfigured, true);
      assert.equal(report.config.routeIntentTokenGenerated, true);

      const env = await readFile(path.join(projectDir, ".operator-host", "operator.env"), "utf8");
      const gatewayToken = env.match(/^GATEWAY_AGENT_ROUTE_INTENT_TOKEN=(.+)$/m)?.[1];
      const outputToken = env.match(/^ROUTE_INTENT_OUTPUT_TOKEN=(.+)$/m)?.[1];
      assert.match(gatewayToken ?? "", /^sb_rt_/);
      assert.equal(outputToken, gatewayToken);
      assert.match(env, /^GATEWAY_UPSTREAM_ADMISSION_URL=http:\/\/192\.168\.3\.4:18080\/v1\/upstream-admissions$/m);
    } finally {
      if (previousGatewayToken === undefined) {
        delete process.env.GATEWAY_AGENT_ROUTE_INTENT_TOKEN;
      } else {
        process.env.GATEWAY_AGENT_ROUTE_INTENT_TOKEN = previousGatewayToken;
      }
      if (previousOutputToken === undefined) {
        delete process.env.ROUTE_INTENT_OUTPUT_TOKEN;
      } else {
        process.env.ROUTE_INTENT_OUTPUT_TOKEN = previousOutputToken;
      }
    }
  });

  it("fails mainnet setup without relay admission material unless local-only", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "proof-operator-admission-"));
    await assert.rejects(
      setupOperator(
        new Map<string, string | boolean>([
          ["project-dir", projectDir],
          ["public-address", "127.0.0.1"],
          ["manager-id", "9470"],
          ["skip-install", true],
          ["skip-compose", true],
          ["dry-run", true],
          ["yes", true]
        ])
      ),
      /Mainnet gateway setup is missing relay admission\/reporting configuration/
    );
  });

  it("records a distinct route-state token when one is supplied", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "proof-operator-route-token-"));
    const previousSeed = process.env.ROUTE_TOKEN_OPERATOR_REPORT_SEED;
    const previousCapabilityToken = process.env.ROUTE_TOKEN_CAPABILITY_TOKEN;
    const previousRouteToken = process.env.ROUTE_TOKEN_ROUTE_STATE_TOKEN;
    process.env.ROUTE_TOKEN_OPERATOR_REPORT_SEED = TEST_REPORT_MNEMONIC;
    process.env.ROUTE_TOKEN_CAPABILITY_TOKEN = "capability-token";
    process.env.ROUTE_TOKEN_ROUTE_STATE_TOKEN = "route-state-token";
    try {
      await setupOperator(
        new Map<string, string | boolean>([
          ["project-dir", projectDir],
          ["public-address", "127.0.0.1"],
          ["manager-id", "9470"],
          ["operator-id", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
          ["gateway-id", "switchboard-az-token-test"],
          ["operator-report-seed-env", "ROUTE_TOKEN_OPERATOR_REPORT_SEED"],
          ["capability-token-env", "ROUTE_TOKEN_CAPABILITY_TOKEN"],
          ["route-state-token-env", "ROUTE_TOKEN_ROUTE_STATE_TOKEN"],
          ["skip-install", true],
          ["skip-compose", true],
          ["yes", true]
        ])
      );

      const env = await readFile(path.join(projectDir, ".operator-host", "operator.env"), "utf8");
      assert.match(env, /^PROOF_OPERATOR_CAPABILITY_TOKEN=capability-token$/m);
      assert.match(env, /^GATEWAY_ROUTE_STATE_TOKEN=route-state-token$/m);
    } finally {
      if (previousSeed === undefined) {
        delete process.env.ROUTE_TOKEN_OPERATOR_REPORT_SEED;
      } else {
        process.env.ROUTE_TOKEN_OPERATOR_REPORT_SEED = previousSeed;
      }
      if (previousCapabilityToken === undefined) {
        delete process.env.ROUTE_TOKEN_CAPABILITY_TOKEN;
      } else {
        process.env.ROUTE_TOKEN_CAPABILITY_TOKEN = previousCapabilityToken;
      }
      if (previousRouteToken === undefined) {
        delete process.env.ROUTE_TOKEN_ROUTE_STATE_TOKEN;
      } else {
        process.env.ROUTE_TOKEN_ROUTE_STATE_TOKEN = previousRouteToken;
      }
    }
  });

  it("generates a report seed for prepare-admission without exposing it in reports", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "proof-operator-generated-seed-"));
    const report = await setupOperator(
      new Map<string, string | boolean>([
        ["project-dir", projectDir],
        ["public-address", "198.51.100.25"],
        ["manager-id", "9470"],
        ["gateway-id", "switchboard-az-generated"],
        ["processor", "5First,5Second"],
        ["payout-address", "0x000000000000000000000000000000000000dEaD"],
        ["generate-report-seed", true],
        ["prepare-admission", true],
        ["skip-install", true],
        ["yes", true]
      ]),
      undefined,
      { generateReportSeed: () => TEST_REPORT_MNEMONIC }
    );

    const envFile = path.join(projectDir, ".operator-host", "operator.env");
    const env = await readFile(envFile, "utf8");
    assert.match(env, new RegExp(`^OPERATOR_REPORT_SEED=${TEST_REPORT_MNEMONIC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.match(env, /^SWITCHBOARD_OPERATOR_MODE=pre-admission$/m);
    assert.match(env, /^OPERATOR_PAYOUT_ADDRESS=0x000000000000000000000000000000000000dEaD$/m);
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
    assert.ok(report.config.reportSigner?.address);
    assert.ok(report.config.reportSigner?.publicKey.startsWith("0x"));
    assert.equal(JSON.stringify(report).includes(TEST_REPORT_MNEMONIC), false);

    const admissionRequestFile = path.join(projectDir, "operator-admission-request.json");
    const admissionRequest = JSON.parse(await readFile(admissionRequestFile, "utf8")) as {
      processorAllowlist: { count: number; sha256: string };
      reportSigner: { address: string; publicKey: string };
    };
    assert.equal(admissionRequest.processorAllowlist.count, 2);
    assert.match(admissionRequest.processorAllowlist.sha256, /^[0-9a-f]{64}$/);
    assert.equal(admissionRequest.reportSigner.address, report.config.reportSigner?.address);
    assert.equal(admissionRequest.reportSigner.publicKey, report.config.reportSigner?.publicKey);
    assert.equal(JSON.stringify(admissionRequest).includes(TEST_REPORT_MNEMONIC), false);
  });

  it("requires an explicit seed source for non-interactive prepare-admission", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "proof-operator-missing-seed-"));
    await assert.rejects(
      setupOperator(
        new Map<string, string | boolean>([
          ["project-dir", projectDir],
          ["public-address", "127.0.0.1"],
          ["manager-id", "9470"],
          ["prepare-admission", true],
          ["skip-install", true],
          ["skip-compose", true],
          ["yes", true]
        ])
      ),
      /Preparing admission requires a valid sr25519 report seed/
    );
  });

  it("parses admission bundles and rejects missing relay material", () => {
    assert.throws(
      () => parseOperatorAdmissionBundle({ operatorId: "0x" + "11".repeat(32), gatewayId: "gw" }),
      /Admission file is missing required field\(s\): capability\.url/
    );
    const parsed = parseOperatorAdmissionBundle({
      operatorId: "0x" + "22".repeat(32),
      gatewayId: "gateway-1",
      capability: { url: "https://control.example/v1/operator-capabilities", token: "cap-token" },
      routeState: { url: "https://control.example/v1/operators/op/gateways/gateway-1/route-state", token: "route-token" },
      upstreamAdmission: { url: "http://192.168.3.4:18080/v1/upstream-admissions" },
      acceptedSigner: { address: "5Signer", publicKey: "0x" + "11".repeat(32) }
    });
    assert.equal(parsed.capabilityReportToken, "cap-token");
    assert.equal(parsed.routeStateToken, "route-token");
    assert.equal(parsed.upstreamAdmissionUrl, "http://192.168.3.4:18080/v1/upstream-admissions");
  });

  it("applies an admission file and verifies accepted signer metadata", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "proof-operator-admission-file-"));
    const signer = await deriveReportSigner(TEST_REPORT_MNEMONIC);
    const admissionFile = path.join(projectDir, "operator-admission.json");
    await writeFile(
      admissionFile,
      JSON.stringify({
        operatorId: "0x" + "33".repeat(32),
        gatewayId: "gateway-admitted",
        capability: { url: "https://control.example/v1/operator-capabilities", token: "cap-token" },
        routeState: { url: "https://control.example/v1/operators/op/gateways/gateway-admitted/route-state", token: "route-token" },
        acceptedSigner: signer
      }),
      "utf8"
    );

    await setupOperator(
      new Map<string, string | boolean>([
        ["project-dir", projectDir],
        ["public-address", "198.51.100.26"],
        ["manager-id", "9470"],
        ["processor", "5First"],
        ["admission-file", admissionFile],
        ["generate-report-seed", true],
        ["skip-install", true],
        ["skip-compose", true],
        ["yes", true]
      ]),
      undefined,
      { generateReportSeed: () => TEST_REPORT_MNEMONIC }
    );

    const env = await readFile(path.join(projectDir, ".operator-host", "operator.env"), "utf8");
    assert.match(env, /^OPERATOR_ID=0x3333333333333333333333333333333333333333333333333333333333333333$/m);
    assert.match(env, /^GATEWAY_ID=gateway-admitted$/m);
    assert.match(env, /^PROOF_OPERATOR_CAPABILITY_TOKEN=cap-token$/m);
    assert.match(env, /^GATEWAY_ROUTE_STATE_TOKEN=route-token$/m);
    assert.match(env, /^SWITCHBOARD_OPERATOR_MODE=admitted$/m);
  });

  it("reads processor allowlists from files", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "proof-operator-processor-file-"));
    const processorFile = path.join(projectDir, "processors.json");
    await writeFile(processorFile, JSON.stringify(["5First", "5Second"]), "utf8");
    const report = await setupOperator(
      new Map<string, string | boolean>([
        ["project-dir", projectDir],
        ["public-address", "127.0.0.1"],
        ["manager-id", "9470"],
        ["processor-file", processorFile],
        ["skip-install", true],
        ["skip-compose", true],
        ["local-only", true],
        ["dry-run", true],
        ["yes", true]
      ])
    );

    assert.equal(report.config.processorRefs, "5First,5Second");
  });

  it("classifies admitted, stale, unhealthy, missing, and Docker-permission status", () => {
    const env = new Map<string, string>([
      ["OPERATOR_ID", "0x" + "44".repeat(32)],
      ["GATEWAY_ID", "gateway-status"],
      ["OPERATOR_REPORT_SEED", "configured"],
      ["PROOF_OPERATOR_CAPABILITY_URL", "https://control.example/v1/operator-capabilities"],
      ["PROOF_OPERATOR_CAPABILITY_TOKEN", "cap-token"],
      ["GATEWAY_ROUTE_STATE_URL", "https://control.example/route-state"],
      ["GATEWAY_ROUTE_STATE_TOKEN", "route-token"]
    ]);
    const docker = {
      docker: { ok: true, command: "docker", args: ["--version"] },
      compose: { ok: true, command: "docker", args: ["compose", "version"] },
      composeStyle: "docker-compose-plugin" as const,
      daemon: { ok: true, command: "docker", args: ["info"] }
    };
    const latest = (expiresAt: string, routeStateHealthy = true) => ({
      latest: [
        {
          report: {
            expiresAt,
            operator: { operatorId: "0x" + "44".repeat(32), gatewayId: "gateway-status" },
            gateway: { routeStateHealthy }
          }
        }
      ]
    });
    const common = {
      env,
      docker,
      health: { routeState: { enabled: true, healthy: true } },
      healthOk: true,
      localCapability: { report: { gateway: { routeStateHealthy: true } } },
      localCapabilityOk: true,
      operatorId: "0x" + "44".repeat(32),
      gatewayId: "gateway-status",
      now: new Date("2026-05-20T12:00:00.000Z")
    };

    assert.equal(classifyOperatorStatus({ ...common, relayCapabilityOk: true, relayCapability: latest("2026-05-20T12:05:00.000Z") }).state, "admitted");
    assert.equal(classifyOperatorStatus({ ...common, relayCapabilityOk: true, relayCapability: latest("2026-05-20T11:59:00.000Z") }).state, "report-stale");
    assert.equal(classifyOperatorStatus({ ...common, relayCapabilityOk: true, relayCapability: latest("2026-05-20T12:05:00.000Z", false) }).state, "route-state-unhealthy");
    assert.equal(classifyOperatorStatus({ ...common, relayCapabilityOk: true, relayCapability: { latest: [] } }).state, "relay-missing");

    const blocked = classifyOperatorStatus({
      ...common,
      docker: {
        ...docker,
        daemon: { ok: false, command: "docker", args: ["info"], reason: "permission denied" }
      },
      relayCapabilityOk: true,
      relayCapability: latest("2026-05-20T12:05:00.000Z")
    });
    assert.equal(blocked.state, "admitted");
    assert.ok(blocked.findings.some((finding) => finding.includes("Docker daemon")));
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
