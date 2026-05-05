import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { prepareAcurastDeployContext, runAcurastDeploy } from "../cli/src/relay/acurast-target.js";
import { parseRelayDeploymentSpec, type RelayDeploymentSpec } from "../src/relay-deployment-spec.js";

const baseSpec: unknown = {
  version: 1,
  relayId: "relay-d",
  target: "acurast",
  catalogState: "candidate",
  apiBaseUrl: "https://relay-d.switchboard.proof.computer",
  peers: [
    {
      relayId: "relay-a",
      apiBaseUrl: "https://relay-a.switchboard.proof.computer",
      readTokenEnv: "PROOF_VALIDATION_READ_TOKEN"
    }
  ],
  secrets: {
    relayerPrivateKeyEnv: "PROOF_RELAY_D_RELAYER_PRIVATE_KEY",
    validationReadTokenEnv: "PROOF_VALIDATION_READ_TOKEN"
  },
  acurast: {
    deployerSeedEnv: "PROOF_ACURAST_MAINNET_DEPLOYER_SEED",
    projectName: "switchboard-mainnet-relay-d",
    stageDir: "dist/acurast/switchboard-mainnet-relay-d",
    maxCostPerExecution: 40_000_000_000,
    instantMatchProcessors: ["5DH3ipjftEhSSihRyXJEndcMtRBmxyVbphdH85rXw8BUJFkv"],
    includeEnv: []
  }
};

const baseEnv = {
  HUB_ETH_RPC_URL: "https://services.polkadothub-rpc.com/mainnet",
  INGRESS_REGISTRY_ADDRESS: "0x65d6B76BeC50F46D198fFa3598E381a298025Da0",
  CHAIN_ID: "420420419",
  PROOF_RECORDER_COORDINATOR_ADDRESS: "0xd4dFB4AD9A4a2AfF56CCBe479F661b84947287A5",
  PROOF_VALIDATION_ALLOWED_SIGNERS: "5DA1ndYXtjSZZur5oWww4W4N5WfhLGANhFzUGsSrtYmUD76W",
  PROOF_RELAY_D_RELAYER_PRIVATE_KEY: "0xRELAYER_PRIVATE_KEY_VALUE",
  PROOF_VALIDATION_READ_TOKEN: "VALIDATION_READ_TOKEN_VALUE",
  PROOF_ACURAST_MAINNET_DEPLOYER_SEED: "//Alice//acurast-deployer"
} satisfies NodeJS.ProcessEnv;

function spec(overrides: Record<string, unknown> = {}): RelayDeploymentSpec {
  return parseRelayDeploymentSpec({ ...(baseSpec as Record<string, unknown>), ...overrides });
}

function signedCatalogsJson(): string {
  return JSON.stringify({
    relays: {
      catalog: {
        version: 1,
        role: "relay",
        sequence: 1,
        issuedAt: "2026-05-04T00:00:00.000Z",
        members: []
      },
      signature: {
        scheme: "substrate-sr25519",
        domain: "switchboard.service-catalog.v1",
        signer: "5EpwnRzamXpqWo3jW9h4ecSJHL9LBjR6jTMW5Wzw6p9nMTh7",
        signature: "0x1234",
        signedAt: "2026-05-04T00:00:00.000Z"
      }
    }
  });
}

describe("prepareAcurastDeployContext", () => {
  it("builds the public buildConfig without any secret values", () => {
    const ctx = prepareAcurastDeployContext(spec(), { env: baseEnv });
    const flat = JSON.stringify(ctx.buildConfig);

    assert.ok(!flat.includes("RELAYER_PRIVATE_KEY_VALUE"), "relayer key must not appear in buildConfig");
    assert.ok(!flat.includes("VALIDATION_READ_TOKEN_VALUE"), "read token must not appear in buildConfig");
    assert.ok(!flat.includes("//Alice//acurast-deployer"), "deployer seed must not appear in buildConfig");

    assert.equal(ctx.buildConfig.PROOF_RELAY_ID, "relay-d");
    assert.equal(ctx.buildConfig.PROOF_SETTLEMENT_RELAY_ID, "relay-d");
    assert.equal(ctx.buildConfig.PROOF_AUTHORITY_LEASE_OWNER_ID, "relay-d");
    assert.equal(ctx.buildConfig.HUB_ETH_RPC_URL, baseEnv.HUB_ETH_RPC_URL);
    assert.equal(ctx.buildConfig.INGRESS_REGISTRY_ADDRESS, baseEnv.INGRESS_REGISTRY_ADDRESS);
    assert.equal(ctx.buildConfig.CHAIN_ID, baseEnv.CHAIN_ID);
    assert.equal(ctx.buildConfig.PROOF_RELAY_PEER_BACKFILL_ENABLED, "true");
    assert.equal(ctx.buildConfig.PROOF_RECORDER_COORDINATOR_ADDRESS, baseEnv.PROOF_RECORDER_COORDINATOR_ADDRESS);
  });

  it("embeds signed service catalogs from env as public build config", () => {
    const catalogs = signedCatalogsJson();
    const ctx = prepareAcurastDeployContext(spec(), {
      env: { ...baseEnv, PROOF_SERVICE_CATALOGS_JSON: catalogs }
    });
    assert.equal(ctx.buildConfig.PROOF_SERVICE_CATALOGS_JSON, catalogs);
    assert.equal(ctx.runtimeEnv.PROOF_SERVICE_CATALOGS_JSON, undefined);
  });

  it("rejects malformed signed service catalog build config before deploy", () => {
    assert.throws(
      () => prepareAcurastDeployContext(spec(), {
        env: {
          ...baseEnv,
          PROOF_SERVICE_CATALOGS_JSON: JSON.stringify({
            relays: { catalog: { role: "relay" }, signature: { signer: "5" } }
          })
        }
      }),
      /version|sequence|issuedAt/
    );
  });

  it("embeds the default signed service catalog file when present", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-acurast-catalogs-"));
    try {
      const catalogs = signedCatalogsJson();
      const file = path.join(cwd, ".control-plane/service-catalogs/service-catalogs.signed.json");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, catalogs, "utf8");
      const ctx = prepareAcurastDeployContext(spec(), { env: baseEnv, cwd });
      assert.equal(ctx.buildConfig.PROOF_SERVICE_CATALOGS_JSON, catalogs);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("places RELAYER_PRIVATE_KEY and peer JSON with read tokens in runtimeEnv only", () => {
    const ctx = prepareAcurastDeployContext(spec(), { env: baseEnv });
    assert.equal(ctx.runtimeEnv.RELAYER_PRIVATE_KEY, "0xRELAYER_PRIVATE_KEY_VALUE");
    assert.equal(ctx.runtimeEnv.PROOF_VALIDATION_READ_TOKEN, "VALIDATION_READ_TOKEN_VALUE");

    const peers = JSON.parse(ctx.runtimeEnv.PROOF_RELAY_PEERS_JSON ?? "[]");
    assert.deepEqual(peers, [
      {
        relayId: "relay-a",
        apiBaseUrl: "https://relay-a.switchboard.proof.computer",
        readToken: "VALIDATION_READ_TOKEN_VALUE"
      }
    ]);
    assert.ok(!ctx.buildConfig.PROOF_RELAY_PEERS_JSON, "peer JSON with tokens must not appear in buildConfig");
  });

  it("computes ACURAST_INCLUDE_ENV from runtimeEnv plus spec-additional names", () => {
    const ctx = prepareAcurastDeployContext(
      spec({
        acurast: {
          ...((baseSpec as Record<string, unknown>).acurast as Record<string, unknown>),
          includeEnv: ["PROOF_RELAY_PEER_BACKFILL_ENABLED"]
        }
      }),
      { env: baseEnv }
    );
    assert.ok(ctx.acurastEnv.ACURAST_INCLUDE_ENV.includes("RELAYER_PRIVATE_KEY"));
    assert.ok(ctx.acurastEnv.ACURAST_INCLUDE_ENV.includes("PROOF_VALIDATION_READ_TOKEN"));
    assert.ok(ctx.acurastEnv.ACURAST_INCLUDE_ENV.includes("PROOF_RELAY_PEERS_JSON"));
    assert.ok(ctx.acurastEnv.ACURAST_INCLUDE_ENV.includes("PROOF_RELAY_PEER_BACKFILL_ENABLED"));
  });

  it("populates ACURAST_MAINNET_SEED on mainnet from the spec deployerSeedEnv", () => {
    const ctx = prepareAcurastDeployContext(spec(), { env: baseEnv });
    assert.equal(ctx.acurastEnv.ACURAST_MAINNET_SEED, "//Alice//acurast-deployer");
    assert.equal(ctx.acurastEnv.ACURAST_NETWORK, "mainnet");
  });

  it("throws when relayerPrivateKeyEnv is missing in the calling shell", () => {
    const env = { ...baseEnv } as Record<string, string | undefined>;
    delete env.PROOF_RELAY_D_RELAYER_PRIVATE_KEY;
    assert.throws(
      () => prepareAcurastDeployContext(spec(), { env: env as NodeJS.ProcessEnv }),
      /relayerPrivateKeyEnv.*PROOF_RELAY_D_RELAYER_PRIVATE_KEY/
    );
  });

  it("throws when controlPlane is enabled but no token env is configured", () => {
    const tainted = spec({
      relay: { enableControlPlane: true } as Record<string, unknown>
    });
    assert.throws(
      () => prepareAcurastDeployContext(tainted, { env: baseEnv }),
      /enableControlPlane=true but spec.secrets.controlPlaneTokenEnv/
    );
  });

  it("emits self-ingress registration env when relay.autoRegister=true", () => {
    const tainted = spec({
      relay: {
        autoRegister: true,
        bootstrapRelayUrl: "https://relay-a.switchboard.proof.computer",
        certificateMode: "job-acme",
        enablePeerBackfill: false
      } as Record<string, unknown>,
      peers: []
    });
    const fixedRandom = Buffer.alloc(32, 0xab);
    const ctx = prepareAcurastDeployContext(tainted, {
      env: { ...baseEnv, PROOF_OPERATOR_ID: `0x${"5c".repeat(32)}` },
      registration: { jobId: `0x${"11".repeat(32)}` },
      randomBytes: () => fixedRandom,
      now: () => Date.parse("2026-05-03T18:00:00Z")
    });
    assert.equal(ctx.buildConfig.RELAY_URL, "https://relay-a.switchboard.proof.computer");
    assert.equal(ctx.buildConfig.ENDPOINT_HOSTNAME, "relay-d.switchboard.proof.computer");
    assert.equal(ctx.buildConfig.OPERATOR_ID, `0x${"5c".repeat(32)}`);
    // The fixed processor in baseSpec is 5DH3...; SS58 → 32-byte hex.
    assert.match(ctx.buildConfig.PROCESSOR_ID, /^0x[0-9a-f]{64}$/);
    assert.equal(ctx.buildConfig.SWITCHBOARD_CERTIFICATE_MODE, "job-acme");
    assert.equal(ctx.buildConfig.SWITCHBOARD_CERTIFICATE_HOSTNAMES, "relay-d.switchboard.proof.computer");
    // sessionId/nonce default to randomBytes; jobId was overridden.
    assert.equal(ctx.buildConfig.JOB_ID, `0x${"11".repeat(32)}`);
    assert.equal(ctx.buildConfig.SESSION_ID, `0x${"ab".repeat(32)}`);
    // NONCE is a decimal uint256 string (relay schema regex /^[0-9]+$/), not hex32.
    // Test fixture's `randomBytes` mock ignores the size argument and returns
    // the full 32-byte buffer of 0xab; converting that to BigInt gives this
    // 256-bit decimal.
    assert.equal(
      ctx.buildConfig.NONCE,
      BigInt(`0x${"ab".repeat(32)}`).toString(10)
    );
    assert.match(ctx.buildConfig.NONCE, /^[0-9]+$/);
    // Deadline = (now + executionMs + 10min buffer) / 1000, default executionMs is 1h.
    assert.match(ctx.buildConfig.DEADLINE, /^\d+$/);
    const deadlineSeconds = Number(ctx.buildConfig.DEADLINE);
    const expected = Math.floor((Date.parse("2026-05-03T18:00:00Z") + 3_600_000 + 600_000) / 1000);
    assert.equal(deadlineSeconds, expected);
  });

  it("does not emit registration env when autoRegister=false", () => {
    const ctx = prepareAcurastDeployContext(spec(), { env: baseEnv });
    assert.equal(ctx.buildConfig.RELAY_URL, undefined);
    assert.equal(ctx.buildConfig.ENDPOINT_HOSTNAME, undefined);
    assert.equal(ctx.buildConfig.SESSION_ID, undefined);
    assert.equal(ctx.buildConfig.SWITCHBOARD_CERTIFICATE_MODE, undefined);
  });

  it("requires PROOF_OPERATOR_ID (or --operator-id) when autoRegister=true", () => {
    const tainted = spec({
      relay: {
        autoRegister: true,
        bootstrapRelayUrl: "https://relay-a.switchboard.proof.computer",
        enablePeerBackfill: false
      } as Record<string, unknown>,
      peers: []
    });
    assert.throws(
      () => prepareAcurastDeployContext(tainted, { env: baseEnv }),
      /requires --operator-id/
    );
  });

  it("rejects malformed registration overrides", () => {
    const tainted = spec({
      relay: {
        autoRegister: true,
        bootstrapRelayUrl: "https://relay-a.switchboard.proof.computer",
        enablePeerBackfill: false
      } as Record<string, unknown>,
      peers: []
    });
    assert.throws(
      () =>
        prepareAcurastDeployContext(tainted, {
          env: { ...baseEnv, PROOF_OPERATOR_ID: `0x${"5c".repeat(32)}` },
          registration: { sessionId: "not-hex" }
        }),
      /--session-id must be 0x-prefixed 32-byte hex/
    );
  });

  it("rejects deploy on non-acurast spec target", () => {
    const bootstrapSpec = parseRelayDeploymentSpec({
      version: 1,
      relayId: "relay-a",
      target: "bootstrap",
      catalogState: "active",
      apiBaseUrl: "https://relay-a.switchboard.proof.computer",
      secrets: { relayerPrivateKeyEnv: "PROOF_RELAY_D_RELAYER_PRIVATE_KEY" },
      bootstrap: { composeService: "relay" }
    });
    assert.throws(
      () => prepareAcurastDeployContext(bootstrapSpec, { env: baseEnv }),
      /spec.target=acurast/
    );
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("runAcurastDeploy", () => {
  it("invokes prepare-express, secret scan, then deploy-direct in order", async () => {
    const calls: string[][] = [];
    const nodeCalls: string[][] = [];
    const childEnvs: NodeJS.ProcessEnv[] = [];
    const captured: string[] = [];

    await runAcurastDeploy(spec(), {
      yes: true,
      sources: { env: baseEnv as NodeJS.ProcessEnv },
      io: { log: (l) => captured.push(l), warn: () => {}, error: () => {} },
      spawnPnpm: async (args, env) => {
        calls.push(args);
        childEnvs.push(env);
        return 0;
      },
      spawnNode: async (args) => {
        nodeCalls.push(args);
        return 0;
      },
      skipReadinessPoll: true,
      skipPeerCheck: true
    });

    Object.assign(process.env, baseEnv);

    assert.deepEqual(calls, [
      ["acurast:prepare-express"],
      ["acurast:deploy-express:direct", "--", "--yes"]
    ]);
    assert.equal(nodeCalls.length, 1);
    assert.equal(nodeCalls[0][0], "scripts/mainnet/scan-acurast-artifact-secrets.mjs");
    assert.equal(nodeCalls[0][1], "dist/acurast/switchboard-mainnet-relay-d");
    const output = captured.join("\n");
    assert.match(output, /secret intent plan:/);
    assert.match(output, /authority profile\s*:\s*durable-relay/);
    assert.match(output, /public build config \(IPFS-public\):/);
    assert.match(output, /encrypted runtime env:/);
    assert.match(output, /local only:/);
    for (const env of childEnvs) {
      assert.ok(env.ACURAST_INCLUDE_ENV?.includes("RELAYER_PRIVATE_KEY"));
      assert.ok(env.RELAYER_PRIVATE_KEY === "0xRELAYER_PRIVATE_KEY_VALUE");
      const buildConfig = JSON.parse(env.SWITCHBOARD_BUILD_CONFIG!);
      assert.ok(!JSON.stringify(buildConfig).includes("0xRELAYER_PRIVATE_KEY_VALUE"));
    }
  });

  it("fails closed when the secret scanner exits non-zero", async () => {
    await assert.rejects(
      runAcurastDeploy(spec(), {
        yes: true,
        sources: { env: baseEnv as NodeJS.ProcessEnv },
        io: { log: () => {}, warn: () => {}, error: () => {} },
        spawnPnpm: async () => 0,
        spawnNode: async () => 1,
        skipReadinessPoll: true,
        skipPeerCheck: true
      }),
      /scan-acurast-artifact-secrets.mjs exited with code 1/
    );
  });

  it("polls readiness and peer reachability after a successful deploy", async () => {
    const fetchedUrls: string[] = [];
    const result = await runAcurastDeploy(spec(), {
      yes: true,
      sources: { env: baseEnv as NodeJS.ProcessEnv },
      io: { log: () => {}, warn: () => {}, error: () => {} },
      spawnPnpm: async () => 0,
      spawnNode: async () => 0,
      fetchImpl: (async (input: Request | URL | string) => {
        fetchedUrls.push(input.toString());
        return jsonResponse({});
      }) as typeof fetch
    });
    assert.ok(result.readiness, "readiness should be populated");
    assert.ok(result.peerReachability, "peerReachability should be populated");
    assert.deepEqual(result.peerReachability?.reachable, ["relay-a"]);
    assert.ok(fetchedUrls.some((url) => url === "https://relay-a.switchboard.proof.computer/health"));
  });

  it("fails closed if a required peer is unreachable", async () => {
    await assert.rejects(
      runAcurastDeploy(spec(), {
        yes: true,
        sources: { env: baseEnv as NodeJS.ProcessEnv },
        io: { log: () => {}, warn: () => {}, error: () => {} },
        spawnPnpm: async () => 0,
        spawnNode: async () => 0,
        fetchImpl: (async (input: Request | URL | string) => {
          const url = input.toString();
          if (url.includes("relay-a.switchboard.proof.computer")) {
            return new Response("nope", { status: 503 });
          }
          return jsonResponse({});
        }) as typeof fetch
      }),
      /requirePeerBackfillReachable=true/
    );
  });

  it("refuses to run without yes", async () => {
    await assert.rejects(
      runAcurastDeploy(spec(), {
        yes: false,
        sources: { env: baseEnv as NodeJS.ProcessEnv },
        io: { log: () => {}, warn: () => {}, error: () => {} },
        spawnPnpm: async () => 0
      }),
      /Refusing to deploy without --yes/
    );
  });

  it("throws if prepare-express fails", async () => {
    await assert.rejects(
      runAcurastDeploy(spec(), {
        yes: true,
        sources: { env: baseEnv as NodeJS.ProcessEnv },
        io: { log: () => {}, warn: () => {}, error: () => {} },
        spawnPnpm: async (args) => (args[0] === "acurast:prepare-express" ? 1 : 0),
        spawnNode: async () => 0,
        skipReadinessPoll: true,
        skipPeerCheck: true
      }),
      /acurast:prepare-express exited with code 1/
    );
  });
});
