import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { prepareAcurastDeployContext, runAcurastDeploy } from "../cli/src/relay/acurast-target.js";
import {
  ENCRYPTED_BUNDLE_LOADER_MARKER,
  encryptAcurastBundleFile,
  SWITCHBOARD_CODE_KEY_ENV
} from "../cli/src/relay/encrypted-code.js";
import { parseRelayDeploymentSpec, type RelayDeploymentSpec } from "../src/relay-deployment-spec.js";

const execFileAsync = promisify(execFile);

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
    assert.match(ctx.runtimeEnv.SWITCHBOARD_CODE_KEY ?? "", /^[0-9a-f]{64}$/);

    const peers = JSON.parse(ctx.runtimeEnv.PROOF_RELAY_PEERS_JSON ?? "[]");
    assert.deepEqual(peers, [
      {
        relayId: "relay-a",
        apiBaseUrl: "https://relay-a.switchboard.proof.computer",
        readToken: "VALIDATION_READ_TOKEN_VALUE"
      }
    ]);
    assert.ok(!ctx.buildConfig.PROOF_RELAY_PEERS_JSON, "peer JSON with tokens must not appear in buildConfig");
    assert.ok(!JSON.stringify(ctx.buildConfig).includes(ctx.runtimeEnv.SWITCHBOARD_CODE_KEY), "code key must not appear in buildConfig");
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
    assert.ok(ctx.acurastEnv.ACURAST_INCLUDE_ENV.includes("SWITCHBOARD_CODE_KEY"));
    assert.ok(ctx.acurastEnv.ACURAST_INCLUDE_ENV.includes("PROOF_RELAY_PEER_BACKFILL_ENABLED"));
  });

  it("keeps the relay-d self-ingress runtime env within the Acurast 10-env cap", () => {
    const relayDSpec = spec({
      peers: [
        {
          relayId: "relay-a",
          apiBaseUrl: "https://relay-a.switchboard.proof.computer",
          readTokenEnv: "PROOF_VALIDATION_READ_TOKEN"
        },
        {
          relayId: "relay-b",
          apiBaseUrl: "https://relay-b.switchboard.proof.computer",
          readTokenEnv: "PROOF_VALIDATION_READ_TOKEN"
        },
        {
          relayId: "relay-c",
          apiBaseUrl: "https://relay-c.switchboard.proof.computer",
          readTokenEnv: "PROOF_VALIDATION_READ_TOKEN"
        }
      ],
      relay: {
        autoRegister: true,
        bootstrapRelayUrl: "https://relay-a.switchboard.proof.computer",
        enableLogs: true
      } as Record<string, unknown>
    });
    const ctx = prepareAcurastDeployContext(relayDSpec, {
      env: { ...baseEnv, PROOF_OPERATOR_ID: `0x${"5c".repeat(32)}` },
      jobSignerPrivateKey: `0x${"7a".repeat(32)}`,
      logSink: {
        writeUrl: "https://relay-a.switchboard.proof.computer/v1/log-sinks/sink/events",
        writeToken: "LOG_WRITE_TOKEN",
        encryptionKey: "LOG_ENCRYPTION_KEY"
      },
      codeKeyHex: "12".repeat(32)
    });
    assert.deepEqual(Object.keys(ctx.runtimeEnv).sort(), [
      "JOB_SIGNER_PRIVATE_KEY",
      "PROOF_RELAY_PEERS_JSON",
      "PROOF_VALIDATION_READ_TOKEN",
      "RELAYER_PRIVATE_KEY",
      "SWITCHBOARD_CODE_KEY",
      "SWITCHBOARD_LOG_ENCRYPTION_KEY",
      "SWITCHBOARD_LOG_TOKEN"
    ]);
    assert.equal(ctx.includeEnv.length, 7);
  });

  it("populates ACURAST_MAINNET_SEED on mainnet from the spec deployerSeedEnv", () => {
    const ctx = prepareAcurastDeployContext(spec(), { env: baseEnv });
    assert.equal(ctx.acurastEnv.ACURAST_MAINNET_SEED, "//Alice//acurast-deployer");
    assert.equal(ctx.acurastEnv.ACURAST_NETWORK, "mainnet");
  });

  it("gives Acurast relay jobs outbound network request capacity by default", () => {
    const ctx = prepareAcurastDeployContext(spec(), { env: baseEnv });
    assert.equal(ctx.acurastEnv.ACURAST_MAX_NETWORK_REQUESTS, "1000");

    const overridden = prepareAcurastDeployContext(spec(), {
      env: { ...baseEnv, ACURAST_MAX_NETWORK_REQUESTS: "2500" }
    });
    assert.equal(overridden.acurastEnv.ACURAST_MAX_NETWORK_REQUESTS, "2500");
  });

  it("passes Acurast DevTools to the harness without consuming runtime env slots", () => {
    const ctx = prepareAcurastDeployContext(spec(), {
      env: { ...baseEnv, ACURAST_ENABLE_DEVTOOLS: "true" }
    });
    assert.equal(ctx.acurastEnv.ACURAST_ENABLE_DEVTOOLS, "true");
    assert.equal(ctx.runtimeEnv.ACURAST_ENABLE_DEVTOOLS, undefined);
    assert.equal(ctx.includeEnv.includes("ACURAST_ENABLE_DEVTOOLS"), false);
  });

  it("copies relay startup diagnostics into public build config, not Acurast runtime env", () => {
    const ctx = prepareAcurastDeployContext(spec(), {
      env: {
        ...baseEnv,
        SWITCHBOARD_RELAY_STARTUP_DIAGNOSTICS: "true",
        SWITCHBOARD_LOG_LEVEL: "debug"
      }
    });
    assert.equal(ctx.buildConfig.SWITCHBOARD_RELAY_STARTUP_DIAGNOSTICS, "true");
    assert.equal(ctx.buildConfig.SWITCHBOARD_LOG_LEVEL, "debug");
    assert.equal(ctx.runtimeEnv.SWITCHBOARD_RELAY_STARTUP_DIAGNOSTICS, undefined);
    assert.equal(ctx.runtimeEnv.SWITCHBOARD_LOG_LEVEL, undefined);
    assert.equal(ctx.includeEnv.includes("SWITCHBOARD_RELAY_STARTUP_DIAGNOSTICS"), false);
    assert.equal(ctx.includeEnv.includes("SWITCHBOARD_LOG_LEVEL"), false);
  });

  it("copies LOG_LEVEL into SWITCHBOARD_LOG_LEVEL build config when the Switchboard alias is unset", () => {
    const ctx = prepareAcurastDeployContext(spec(), {
      env: { ...baseEnv, LOG_LEVEL: "WARN" }
    });
    assert.equal(ctx.buildConfig.SWITCHBOARD_LOG_LEVEL, "warn");
    assert.equal(ctx.runtimeEnv.LOG_LEVEL, undefined);
    assert.equal(ctx.includeEnv.includes("LOG_LEVEL"), false);
  });

  it("rejects invalid relay build-config log levels", () => {
    assert.throws(
      () => prepareAcurastDeployContext(spec(), {
        env: { ...baseEnv, SWITCHBOARD_LOG_LEVEL: "verbose" }
      }),
      /must be one of trace, debug, info, warn, error, fatal, silent/
    );
  });

  it("keeps PROOF_LOG_CREATE_TOKEN local unless legacy PROOF_LOGS_ENABLED is explicitly true", () => {
    const withLogCreateEnv = spec({
      secrets: {
        ...((baseSpec as Record<string, unknown>).secrets as Record<string, unknown>),
        logCreateTokenEnv: "PROOF_LOG_CREATE_TOKEN"
      }
    });
    const disabled = prepareAcurastDeployContext(withLogCreateEnv, {
      env: { ...baseEnv, PROOF_LOG_CREATE_TOKEN: "CREATE_TOKEN" }
    });
    assert.equal(disabled.runtimeEnv.PROOF_LOG_CREATE_TOKEN, undefined);
    assert.equal(disabled.includeEnv.includes("PROOF_LOG_CREATE_TOKEN"), false);

    const enabled = prepareAcurastDeployContext(withLogCreateEnv, {
      env: { ...baseEnv, PROOF_LOG_CREATE_TOKEN: "CREATE_TOKEN", PROOF_LOGS_ENABLED: "true" }
    });
    assert.equal(enabled.runtimeEnv.PROOF_LOG_CREATE_TOKEN, "CREATE_TOKEN");
    assert.equal(enabled.includeEnv.includes("PROOF_LOG_CREATE_TOKEN"), true);
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
    // sessionId defaults to randomBytes; jobId was overridden.
    assert.equal(ctx.buildConfig.JOB_ID, `0x${"11".repeat(32)}`);
    assert.equal(ctx.buildConfig.SESSION_ID, `0x${"ab".repeat(32)}`);
    // V1 funded sessions start with nextNonce=1.
    assert.equal(ctx.buildConfig.NONCE, "1");
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

  it("emits proof-infra admission env without paid self-registration", () => {
    const proofInfraSpec = spec({
      secrets: {
        ...((baseSpec as Record<string, unknown>).secrets as Record<string, unknown>),
        relayInfraAdmissionTokenEnv: "PROOF_RELAY_INFRA_ADMISSION_TOKEN"
      },
      relay: {
        admissionMode: "proof-infra",
        autoRegister: false,
        bootstrapRelayUrl: "https://relay-a.switchboard.proof.computer",
        enablePeerBackfill: false
      } as Record<string, unknown>,
      peers: []
    });
    const ctx = prepareAcurastDeployContext(proofInfraSpec, {
      env: {
        ...baseEnv,
        PROOF_RELAY_INFRA_ADMISSION_TOKEN: "ADMISSION_TOKEN_VALUE"
      }
    });

    assert.equal(ctx.buildConfig.SWITCHBOARD_RELAY_ADMISSION_MODE, "proof-infra");
    assert.equal(ctx.buildConfig.SWITCHBOARD_AUTO_REGISTER, "false");
    assert.equal(
      ctx.buildConfig.SWITCHBOARD_RELAY_INFRA_ADMISSION_URL,
      "https://relay-a.switchboard.proof.computer/v1/relay-infra/admissions"
    );
    assert.equal(ctx.buildConfig.SWITCHBOARD_RELAY_HOSTNAME, "relay-d.switchboard.proof.computer");
    assert.equal(ctx.buildConfig.ENDPOINT_HOSTNAME, "relay-d.switchboard.proof.computer");
    assert.equal(ctx.buildConfig.ACURAST_RPC, "wss://acurast.rpc.proof.computer");
    assert.match(ctx.buildConfig.PROCESSOR_ID, /^0x[0-9a-f]{64}$/);
    assert.equal(ctx.buildConfig.RELAY_URL, undefined);
    assert.equal(ctx.buildConfig.SESSION_ID, undefined);
    assert.equal(ctx.runtimeEnv.ACURAST_RPC, undefined);
    assert.equal(ctx.runtimeEnv.SB_RELAY_INFRA_ADMISSION_TOKEN, "ADMISSION_TOKEN_VALUE");
    assert.ok(!JSON.stringify(ctx.buildConfig).includes("ADMISSION_TOKEN_VALUE"));
  });

  it("requires a dedicated proof-infra admission token even when a control-plane token is set", () => {
    const proofInfraSpec = spec({
      secrets: {
        ...((baseSpec as Record<string, unknown>).secrets as Record<string, unknown>),
        controlPlaneTokenEnv: "PROOF_CONTROL_PLANE_TOKEN",
        relayInfraAdmissionTokenEnv: "PROOF_RELAY_INFRA_ADMISSION_TOKEN"
      },
      relay: {
        admissionMode: "proof-infra",
        autoRegister: false,
        bootstrapRelayUrl: "https://relay-a.switchboard.proof.computer",
        enablePeerBackfill: false
      } as Record<string, unknown>,
      peers: []
    });

    assert.throws(
      () =>
        prepareAcurastDeployContext(proofInfraSpec, {
          env: {
            ...baseEnv,
            PROOF_CONTROL_PLANE_TOKEN: "BROAD_TOKEN_ONLY"
          }
        }),
      /requires spec\.secrets\.relayInfraAdmissionTokenEnv to be set in env/
    );
  });

  it("keeps declared control-plane tokens out of proof-infra runtime env when control-plane is disabled", () => {
    const proofInfraSpec = spec({
      secrets: {
        ...((baseSpec as Record<string, unknown>).secrets as Record<string, unknown>),
        controlPlaneTokenEnv: "PROOF_CONTROL_PLANE_TOKEN",
        relayInfraAdmissionTokenEnv: "PROOF_RELAY_INFRA_ADMISSION_TOKEN"
      },
      relay: {
        admissionMode: "proof-infra",
        autoRegister: false,
        bootstrapRelayUrl: "https://relay-a.switchboard.proof.computer",
        enablePeerBackfill: false
      } as Record<string, unknown>,
      peers: []
    });
    const ctx = prepareAcurastDeployContext(proofInfraSpec, {
      env: {
        ...baseEnv,
        PROOF_CONTROL_PLANE_TOKEN: "BROAD_CONTROL_PLANE_TOKEN",
        PROOF_RELAY_INFRA_ADMISSION_TOKEN: "ADMISSION_TOKEN_VALUE"
      }
    });

    assert.equal(ctx.runtimeEnv.SB_RELAY_INFRA_ADMISSION_TOKEN, "ADMISSION_TOKEN_VALUE");
    assert.equal(ctx.runtimeEnv.PROOF_CONTROL_PLANE_TOKEN, undefined);
    assert.equal(ctx.includeEnv.includes("SB_RELAY_INFRA_ADMISSION_TOKEN"), true);
    assert.equal(ctx.includeEnv.includes("PROOF_CONTROL_PLANE_TOKEN"), false);
  });

  it("lets operators override the proof-infra Acurast RPC build config without runtime env slots", () => {
    const proofInfraSpec = spec({
      secrets: {
        ...((baseSpec as Record<string, unknown>).secrets as Record<string, unknown>),
        relayInfraAdmissionTokenEnv: "PROOF_RELAY_INFRA_ADMISSION_TOKEN"
      },
      relay: {
        admissionMode: "proof-infra",
        autoRegister: false,
        bootstrapRelayUrl: "https://relay-a.switchboard.proof.computer",
        enablePeerBackfill: false
      } as Record<string, unknown>,
      peers: []
    });
    const ctx = prepareAcurastDeployContext(proofInfraSpec, {
      env: {
        ...baseEnv,
        ACURAST_RPC: "wss://custom.acurast.example",
        PROOF_RELAY_INFRA_ADMISSION_TOKEN: "ADMISSION_TOKEN_VALUE"
      }
    });

    assert.equal(ctx.buildConfig.ACURAST_RPC, "wss://custom.acurast.example");
    assert.equal(ctx.runtimeEnv.ACURAST_RPC, undefined);
    assert.equal(ctx.includeEnv.includes("ACURAST_RPC"), false);
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
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-acurast-encrypted-deploy-"));
    const calls: string[][] = [];
    const nodeCalls: string[][] = [];
    const childEnvs: NodeJS.ProcessEnv[] = [];
    const captured: string[] = [];
    const bundlePath = path.join(cwd, "dist/acurast/switchboard-mainnet-relay-d/dist/bundle.cjs");
    const plaintextMarker = "PLAINTEXT_RELAY_BUNDLE_MARKER";
    const order: string[] = [];

    try {
      await runAcurastDeploy(spec(), {
        yes: true,
        cwd,
        sources: {
          env: baseEnv as NodeJS.ProcessEnv,
          codeKeyHex: "34".repeat(32)
        },
        io: { log: (l) => captured.push(l), warn: () => {}, error: () => {} },
        spawnPnpm: async (args, env) => {
          calls.push(args);
          childEnvs.push(env);
          if (args[0] === "acurast:prepare-express") {
            order.push("prepare");
            await mkdir(path.dirname(bundlePath), { recursive: true });
            await writeFile(bundlePath, `globalThis.__marker = ${JSON.stringify(plaintextMarker)};\n`, "utf8");
          }
          if (args[0] === "acurast:deploy-express:direct") {
            order.push("deploy");
            assert.equal(env.ACURAST_USE_EXISTING_STAGE, "true");
            assert.equal(env.ACURAST_REQUIRE_ENCRYPTED_BUNDLE, "true");
            const uploaded = await readFile(bundlePath, "utf8");
            assert.match(uploaded, /SWITCHBOARD_CODE_CIPHERTEXT_B64/);
            assert.doesNotMatch(uploaded, new RegExp(plaintextMarker));
          }
          return 0;
        },
        spawnNode: async (args) => {
          order.push("scan");
          nodeCalls.push(args);
          assert.match(await readFile(bundlePath, "utf8"), new RegExp(plaintextMarker));
          return 0;
        },
        skipReadinessPoll: true,
        skipPeerCheck: true
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }

    Object.assign(process.env, baseEnv);

    assert.deepEqual(order, ["prepare", "scan", "deploy"]);
    assert.deepEqual(calls, [
      ["acurast:prepare-express"],
      ["acurast:deploy-express:direct", "--", "--yes", "--use-existing-stage", "--require-encrypted-bundle"]
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
      assert.ok(env.ACURAST_INCLUDE_ENV?.includes("SWITCHBOARD_CODE_KEY"));
      assert.ok(env.RELAYER_PRIVATE_KEY === "0xRELAYER_PRIVATE_KEY_VALUE");
      assert.equal(env.SWITCHBOARD_CODE_KEY, "34".repeat(32));
      const buildConfig = JSON.parse(env.SWITCHBOARD_BUILD_CONFIG!);
      assert.ok(!JSON.stringify(buildConfig).includes("0xRELAYER_PRIVATE_KEY_VALUE"));
      assert.ok(!JSON.stringify(buildConfig).includes("34".repeat(32)));
    }
  });

  it("does not submit broad control-plane tokens for proof-infra deploys when control-plane is disabled", async () => {
    const proofInfraSpec = spec({
      secrets: {
        ...((baseSpec as Record<string, unknown>).secrets as Record<string, unknown>),
        controlPlaneTokenEnv: "PROOF_CONTROL_PLANE_TOKEN",
        relayInfraAdmissionTokenEnv: "PROOF_RELAY_INFRA_ADMISSION_TOKEN"
      },
      relay: {
        admissionMode: "proof-infra",
        autoRegister: false,
        bootstrapRelayUrl: "https://relay-a.switchboard.proof.computer",
        enablePeerBackfill: false
      } as Record<string, unknown>,
      peers: [],
      acurast: {
        ...((baseSpec as Record<string, unknown>).acurast as Record<string, unknown>),
        encryptedCode: false
      }
    });
    const childEnvs: NodeJS.ProcessEnv[] = [];
    let deployEnv: NodeJS.ProcessEnv | undefined;

    await runAcurastDeploy(proofInfraSpec, {
      yes: true,
      sources: {
        env: {
          ...baseEnv,
          PROOF_CONTROL_PLANE_TOKEN: "BROAD_CONTROL_PLANE_TOKEN",
          PROOF_RELAY_INFRA_ADMISSION_TOKEN: "ADMISSION_TOKEN_VALUE"
        } as NodeJS.ProcessEnv
      },
      io: { log: () => {}, warn: () => {}, error: () => {} },
      spawnPnpm: async (args, env) => {
        childEnvs.push(env);
        if (args[0] === "acurast:deploy-express:direct") {
          deployEnv = env;
        }
        return 0;
      },
      spawnNode: async () => 0,
      skipReadinessPoll: true,
      skipPeerCheck: true
    });

    assert.ok(deployEnv);
    for (const env of childEnvs) {
      assert.equal(env.PROOF_CONTROL_PLANE_TOKEN, undefined);
      assert.equal(env.SB_RELAY_INFRA_ADMISSION_TOKEN, "ADMISSION_TOKEN_VALUE");
      assert.ok(env.ACURAST_INCLUDE_ENV?.includes("SB_RELAY_INFRA_ADMISSION_TOKEN"));
      assert.equal(env.ACURAST_INCLUDE_ENV?.includes("PROOF_CONTROL_PLANE_TOKEN"), false);
    }
  });

  it("executes an encrypted bootstrap bundle with Acurast runtime env lookups and fails closed", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-acurast-loader-"));
    const bundlePath = path.join(cwd, "bundle.cjs");
    const keyHex = "56".repeat(32);
    const plaintextSource = "globalThis.__switchboardEncryptedLoaderTest = 'ok'; console.log('loader-ok');\n";
    try {
      await writeFile(bundlePath, plaintextSource, "utf8");
      const encrypted = await encryptAcurastBundleFile(bundlePath, {
        keyHex,
        randomBytes: () => Buffer.alloc(12, 0x11)
      });
      assert.equal(encrypted.ciphertextBytes > 0, true);
      const encryptedLoader = await readFile(bundlePath, "utf8");
      assert.match(encryptedLoader, /SWITCHBOARD_CODE_CIPHERTEXT_B64/);
      assert.ok(encryptedLoader.includes(ENCRYPTED_BUNDLE_LOADER_MARKER));

      const ok = await execFileAsync(process.execPath, [bundlePath], {
        env: { PATH: process.env.PATH ?? "", [SWITCHBOARD_CODE_KEY_ENV]: keyHex }
      });
      assert.match(ok.stdout, /loader-ok/);
      assert.match(ok.stdout, /"event":"switchboard\.encrypted_code\.bootstrap_start"/);
      assert.match(ok.stdout, /"source":"process\.env"/);
      assert.match(ok.stdout, /"event":"switchboard\.encrypted_code\.decrypt_start"/);
      assert.match(ok.stdout, /"event":"switchboard\.encrypted_code\.decrypt_complete"/);
      assert.match(ok.stdout, /"event":"switchboard\.encrypted_code\.bundle_evaluate_complete"/);
      assert.doesNotMatch(`${ok.stdout}\n${ok.stderr}`, new RegExp(keyHex));
      assert.doesNotMatch(`${ok.stdout}\n${ok.stderr}`, /__switchboardEncryptedLoaderTest/);

      const stdEnv = await execFileAsync(
        process.execPath,
        [
          "-e",
          `globalThis._STD_ = { env: { ${JSON.stringify(SWITCHBOARD_CODE_KEY_ENV)}: process.argv[2] } }; require(process.argv[1]);`,
          bundlePath,
          keyHex
        ],
        { env: { PATH: process.env.PATH ?? "" } }
      );
      assert.match(stdEnv.stdout, /loader-ok/);
      assert.match(stdEnv.stdout, /"source":"_STD_\.env"/);
      assert.match(stdEnv.stdout, /"event":"switchboard\.encrypted_code\.code_key_validated"/);
      assert.doesNotMatch(`${stdEnv.stdout}\n${stdEnv.stderr}`, new RegExp(keyHex));
      assert.doesNotMatch(`${stdEnv.stdout}\n${stdEnv.stderr}`, /__switchboardEncryptedLoaderTest/);

      const environmentFn = await execFileAsync(
        process.execPath,
        [
          "-e",
          `globalThis.environment = (name) => name === ${JSON.stringify(SWITCHBOARD_CODE_KEY_ENV)} ? process.argv[2] : undefined; require(process.argv[1]);`,
          bundlePath,
          keyHex
        ],
        { env: { PATH: process.env.PATH ?? "" } }
      );
      assert.match(environmentFn.stdout, /loader-ok/);
      assert.match(environmentFn.stdout, /"source":"environment"/);
      assert.match(environmentFn.stdout, /"event":"switchboard\.encrypted_code\.code_key_validated"/);
      assert.doesNotMatch(`${environmentFn.stdout}\n${environmentFn.stderr}`, new RegExp(keyHex));
      assert.doesNotMatch(`${environmentFn.stdout}\n${environmentFn.stderr}`, /__switchboardEncryptedLoaderTest/);

      let failed: unknown;
      try {
        await execFileAsync(process.execPath, [bundlePath], {
          env: { PATH: process.env.PATH ?? "" }
        });
      } catch (error) {
        failed = error;
      }
      assert.ok(failed instanceof Error);
      const failureOutput = `${(failed as { stdout?: string }).stdout ?? ""}\n${(failed as { stderr?: string }).stderr ?? ""}\n${failed.message}`;
      assert.match(failureOutput, /"event":"switchboard\.encrypted_code\.code_key_lookup"/);
      assert.match(failureOutput, /"event":"switchboard\.encrypted_code\.error"/);
      assert.match(failureOutput, /"stage":"bootstrap"/);
      assert.match(failureOutput, /"source":"none"/);
      assert.match(failureOutput, /"processEnvAvailable":true/);
      assert.match(failureOutput, /"stdEnvAvailable":false/);
      assert.match(failureOutput, /"environmentFunctionAvailable":false/);
      assert.match(failureOutput, /SWITCHBOARD_CODE_KEY is required/);
      assert.doesNotMatch(failureOutput, new RegExp(keyHex));
      assert.doesNotMatch(failureOutput, /"event":"switchboard\.encrypted_code\.decrypt_start"/);

      let invalid: unknown;
      try {
        await execFileAsync(process.execPath, [bundlePath], {
          env: { PATH: process.env.PATH ?? "", [SWITCHBOARD_CODE_KEY_ENV]: "not-a-64-hex-key" }
        });
      } catch (error) {
        invalid = error;
      }
      assert.ok(invalid instanceof Error);
      const invalidOutput = `${(invalid as { stdout?: string }).stdout ?? ""}\n${(invalid as { stderr?: string }).stderr ?? ""}\n${invalid.message}`;
      assert.match(invalidOutput, /"event":"switchboard\.encrypted_code\.code_key_lookup"/);
      assert.match(invalidOutput, /"event":"switchboard\.encrypted_code\.error"/);
      assert.match(invalidOutput, /"stage":"bootstrap"/);
      assert.match(invalidOutput, /"source":"process\.env"/);
      assert.match(invalidOutput, /SWITCHBOARD_CODE_KEY must be a 32-byte hex string/);
      assert.doesNotMatch(invalidOutput, /not-a-64-hex-key/);
      assert.doesNotMatch(invalidOutput, /"event":"switchboard\.encrypted_code\.decrypt_start"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to submit if the staged bundle is not the encrypted loader", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-acurast-plaintext-guard-"));
    const calls: string[][] = [];
    const bundlePath = path.join(cwd, "dist/acurast/switchboard-mainnet-relay-d/dist/bundle.cjs");
    try {
      await assert.rejects(
        runAcurastDeploy(spec(), {
          yes: true,
          cwd,
          sources: {
            env: baseEnv as NodeJS.ProcessEnv,
            codeKeyHex: "78".repeat(32)
          },
          io: { log: () => {}, warn: () => {}, error: () => {} },
          spawnPnpm: async (args) => {
            calls.push(args);
            if (args[0] === "acurast:prepare-express") {
              await mkdir(path.dirname(bundlePath), { recursive: true });
              await writeFile(bundlePath, "globalThis.__marker = 'PLAINTEXT_RELAY_BUNDLE_MARKER';\n", "utf8");
              return 0;
            }
            assert.fail("deploy-express must not run with a plaintext staged bundle");
          },
          spawnNode: async () => 0,
          encryptBundleFile: async (pathToBundle) => {
            await writeFile(
              pathToBundle,
              "globalThis.__marker = 'PLAINTEXT_RELAY_BUNDLE_MARKER';\nconst x = '__SWITCHBOARD_BUILD_CONFIG__';\n",
              "utf8"
            );
            return {
              bundlePath: pathToBundle,
              plaintextSha256: "ab".repeat(32),
              ciphertextBytes: 1,
              loaderBytes: 1
            };
          },
          skipReadinessPoll: true,
          skipPeerCheck: true
        }),
        /Refusing to upload unencrypted Acurast relay bundle/
      );
      assert.deepEqual(calls, [["acurast:prepare-express"]]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects runtime env that would exceed the Acurast env count cap before submit", async () => {
    const extras = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [`EXTRA_ENV_${index}`, `value-${index}`])
    );
    const tainted = spec({
      acurast: {
        ...((baseSpec as Record<string, unknown>).acurast as Record<string, unknown>),
        includeEnv: Object.keys(extras)
      }
    });
    await assert.rejects(
      runAcurastDeploy(tainted, {
        yes: true,
        sources: { env: { ...baseEnv, ...extras } as NodeJS.ProcessEnv },
        io: { log: () => {}, warn: () => {}, error: () => {} },
        spawnPnpm: async () => {
          throw new Error("should not spawn after env-budget failure");
        },
        spawnNode: async () => 0,
        skipReadinessPoll: true,
        skipPeerCheck: true
      }),
      /count 11 > 10/
    );
  });

  it("rejects runtime env keys that exceed the Acurast key byte cap before submit", async () => {
    const longKey = "A".repeat(33);
    const tainted = spec({
      acurast: {
        ...((baseSpec as Record<string, unknown>).acurast as Record<string, unknown>),
        includeEnv: [longKey]
      }
    });
    await assert.rejects(
      runAcurastDeploy(tainted, {
        yes: true,
        sources: { env: { ...baseEnv, [longKey]: "value" } as NodeJS.ProcessEnv },
        io: { log: () => {}, warn: () => {}, error: () => {} },
        spawnPnpm: async () => {
          throw new Error("should not spawn after env-budget failure");
        },
        spawnNode: async () => 0,
        skipReadinessPoll: true,
        skipPeerCheck: true
      }),
      /33 bytes > 32/
    );
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
      encryptBundleFile: async (bundlePath) => {
        await mkdir(path.dirname(bundlePath), { recursive: true });
        await writeFile(
          bundlePath,
          `// ${ENCRYPTED_BUNDLE_LOADER_MARKER}\nconst SWITCHBOARD_CODE_CIPHERTEXT_B64 = "x";\nconst SWITCHBOARD_CODE_PLAINTEXT_SHA256 = "y";\n`,
          "utf8"
        );
        return {
          bundlePath,
          plaintextSha256: "0".repeat(64),
          ciphertextBytes: 1,
          loaderBytes: 1
        };
      },
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
        encryptBundleFile: async (bundlePath) => {
          await mkdir(path.dirname(bundlePath), { recursive: true });
          await writeFile(
            bundlePath,
            `// ${ENCRYPTED_BUNDLE_LOADER_MARKER}\nconst SWITCHBOARD_CODE_CIPHERTEXT_B64 = "x";\nconst SWITCHBOARD_CODE_PLAINTEXT_SHA256 = "y";\n`,
            "utf8"
          );
          return {
            bundlePath,
            plaintextSha256: "0".repeat(64),
            ciphertextBytes: 1,
            loaderBytes: 1
          };
        },
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
