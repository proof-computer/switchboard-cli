import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildBootstrapDeployPlan, runBootstrapDeploy } from "../cli/src/relay/bootstrap-target.js";
import { parseRelayDeploymentSpec } from "../src/relay-deployment-spec.js";

const spec = parseRelayDeploymentSpec({
  version: 1,
  relayId: "relay-a",
  target: "bootstrap",
  catalogState: "active",
  apiBaseUrl: "https://relay-a.switchboard.proof.computer",
  secrets: { relayerPrivateKeyEnv: "PROOF_MAINNET_RELAY_A_RECORDER_PRIVATE_KEY" },
  bootstrap: { composeService: "relay" }
});

describe("buildBootstrapDeployPlan", () => {
  it("targets the local Docker daemon with --no-deps and rebuild flags", () => {
    const plan = buildBootstrapDeployPlan(spec);
    assert.deepEqual(plan.composeArgs, [
      "compose",
      "--env-file",
      ".control-plane/control-plane.env",
      "-f",
      "docker-compose.control-plane.yaml",
      "up",
      "-d",
      "--no-deps",
      "--build",
      "--force-recreate",
      "relay"
    ]);
    assert.deepEqual(plan.pollUrls, [
      "https://relay-a.switchboard.proof.computer/health",
      "https://relay-a.switchboard.proof.computer/v1/relay-status"
    ]);
  });

  it("uses --no-build when bootstrap.rebuild is false", () => {
    const noRebuild = parseRelayDeploymentSpec({
      version: 1,
      relayId: "relay-a",
      target: "bootstrap",
      catalogState: "active",
      apiBaseUrl: "https://relay-a.switchboard.proof.computer",
      secrets: { relayerPrivateKeyEnv: "PROOF_MAINNET_RELAY_A_RECORDER_PRIVATE_KEY" },
      bootstrap: { composeService: "relay", rebuild: false }
    });
    const plan = buildBootstrapDeployPlan(noRebuild);
    assert.ok(plan.composeArgs.includes("--no-build"));
    assert.ok(!plan.composeArgs.includes("--build"));
  });

  it("rejects non-bootstrap specs", () => {
    assert.throws(
      () =>
        buildBootstrapDeployPlan(
          parseRelayDeploymentSpec({
            version: 1,
            relayId: "relay-d",
            target: "acurast",
            catalogState: "candidate",
            apiBaseUrl: "https://relay-d.switchboard.proof.computer",
            secrets: { relayerPrivateKeyEnv: "PROOF_RELAY_D_RELAYER_PRIVATE_KEY" },
            acurast: {
              deployerSeedEnv: "PROOF_ACURAST_MAINNET_DEPLOYER_SEED",
              projectName: "p",
              stageDir: "d",
              maxCostPerExecution: 1
            }
          })
        ),
      /spec.target=bootstrap/
    );
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("runBootstrapDeploy", () => {
  it("invokes docker compose up via the spawner with the planned args", async () => {
    const calls: string[][] = [];
    await runBootstrapDeploy(spec, {
      yes: true,
      io: { log: () => {}, warn: () => {}, error: () => {} },
      spawnDocker: async (args) => {
        calls.push(args);
        return 0;
      },
      skipReadinessPoll: true
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "compose");
    assert.ok(calls[0].includes("relay"));
  });

  it("polls readiness after a successful compose up", async () => {
    const fetchedUrls: string[] = [];
    const result = await runBootstrapDeploy(spec, {
      yes: true,
      io: { log: () => {}, warn: () => {}, error: () => {} },
      spawnDocker: async () => 0,
      fetchImpl: (async (input: Request | URL | string) => {
        fetchedUrls.push(input.toString());
        return jsonResponse({});
      }) as typeof fetch
    });
    assert.ok(result.readiness, "readiness result should be populated");
    assert.equal(result.readiness?.attempts, 1);
    assert.ok(fetchedUrls.some((url) => url.endsWith("/health")));
    assert.ok(fetchedUrls.some((url) => url.endsWith("/v1/relay-status")));
    assert.ok(fetchedUrls.some((url) => url.endsWith("/v1/service-catalogs/relay")));
  });

  it("refuses without yes", async () => {
    await assert.rejects(
      runBootstrapDeploy(spec, {
        yes: false,
        io: { log: () => {}, warn: () => {}, error: () => {} },
        spawnDocker: async () => 0
      }),
      /without --yes/
    );
  });

  it("propagates non-zero exit codes", async () => {
    await assert.rejects(
      runBootstrapDeploy(spec, {
        yes: true,
        io: { log: () => {}, warn: () => {}, error: () => {} },
        spawnDocker: async () => 2,
        skipReadinessPoll: true
      }),
      /docker compose up exited with code 2/
    );
  });
});
