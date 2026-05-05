import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildAcurastCliEnv } from "../cli/src/relay/acurast-cli-env.js";
import { runRelayDeploymentStatus, runRelayInspect } from "../cli/src/relay/lifecycle.js";
import { parseRelayDeploymentSpec } from "../src/relay-deployment-spec.js";

const baseSpec = {
  version: 1,
  relayId: "relay-d",
  target: "acurast",
  catalogState: "candidate",
  apiBaseUrl: "https://relay-d.example",
  peers: [],
  secrets: { relayerPrivateKeyEnv: "PROOF_MAINNET_RELAY_D_RECORDER_PRIVATE_KEY" },
  acurast: {
    deployerSeedEnv: "PROOF_ACURAST_MAINNET_DEPLOYER_SEED",
    network: "mainnet",
    projectName: "switchboard-mainnet-relay-d",
    stageDir: "dist/acurast/switchboard-mainnet-relay-d",
    maxCostPerExecution: 1,
    includeEnv: []
  }
};

describe("buildAcurastCliEnv", () => {
  it("bridges PROOF_ACURAST_MAINNET_DEPLOYER_SEED -> ACURAST_MAINNET_SEED", () => {
    const spec = parseRelayDeploymentSpec(baseSpec);
    const env = buildAcurastCliEnv(spec, {
      PROOF_ACURAST_MAINNET_DEPLOYER_SEED: "twelve word mnemonic ..."
    });
    assert.equal(env.ACURAST_MAINNET_SEED, "twelve word mnemonic ...");
    assert.equal(env.ACURAST_NETWORK, "mainnet");
    assert.equal(env.ACURAST_PROJECT_NAME, "switchboard-mainnet-relay-d");
    assert.equal(env.ACURAST_STAGE_DIR, "dist/acurast/switchboard-mainnet-relay-d");
  });

  it("throws when the deployer seed env is unset", () => {
    const spec = parseRelayDeploymentSpec(baseSpec);
    assert.throws(() => buildAcurastCliEnv(spec, {}), /is not set in the calling shell/);
  });

  it("uses ACURAST_CANARY_SEED on canary network", () => {
    const spec = parseRelayDeploymentSpec({
      ...baseSpec,
      acurast: { ...baseSpec.acurast, network: "canary" }
    });
    const env = buildAcurastCliEnv(spec, { PROOF_ACURAST_MAINNET_DEPLOYER_SEED: "x" });
    assert.equal(env.ACURAST_CANARY_SEED, "x");
    assert.equal(env.ACURAST_MAINNET_SEED, undefined);
  });
});

async function setupCwd(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-lifecycle-"));
  await mkdir(path.join(cwd, "relays"), { recursive: true });
  await writeFile(path.join(cwd, "relays", "relay-d.json"), JSON.stringify(baseSpec), "utf8");
  return cwd;
}

describe("runRelayInspect / runRelayDeploymentStatus", () => {
  it("inspect passes --watch through", async () => {
    const cwd = await setupCwd();
    try {
      const calls: string[][] = [];
      await runRelayInspect({
        flags: new Map<string, string | boolean>([["deployment-id", "51808"], ["watch", true]]),
        positionals: ["relay", "inspect", "relay-d"],
        env: { PROOF_ACURAST_MAINNET_DEPLOYER_SEED: "test-seed" },
        cwd,
        spawnPnpm: async (args) => { calls.push(args); return 0; }
      });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], ["acurast:inspect-express", "--", "--deployment-id", "51808", "--watch"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("deployment-status calls acurast:status-express", async () => {
    const cwd = await setupCwd();
    try {
      const calls: string[][] = [];
      await runRelayDeploymentStatus({
        flags: new Map<string, string | boolean>([["deployment-id", "51808"]]),
        positionals: ["relay", "deployment-status", "relay-d"],
        env: { PROOF_ACURAST_MAINNET_DEPLOYER_SEED: "test-seed" },
        cwd,
        spawnPnpm: async (args) => { calls.push(args); return 0; }
      });
      assert.deepEqual(calls[0], ["acurast:status-express", "--", "--deployment-id", "51808"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
