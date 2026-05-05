import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { readFile } from "node:fs/promises";

import { runRelayDeploy } from "../cli/src/relay/index.js";
import type {
  FundIngressSessionInput,
  FundIngressSessionResult
} from "../src/ledger-fund-ingress-session.js";
import type { CreatedLogSink } from "../src/log-sink-client.js";
import type {
  FundIngressSessionSubstrateInput,
  FundIngressSessionSubstrateResult
} from "../src/substrate-fund-ingress-session.js";
import type {
  ManagerProcessorInventory,
  ProcessorInfo
} from "../src/acurast-manager.js";

interface CapturedIo {
  log: string[];
  warn: string[];
  error: string[];
}

function makeIo(): {
  io: { log: (l: string) => void; warn: (l: string) => void; error: (l: string) => void };
  captured: CapturedIo;
} {
  const captured: CapturedIo = { log: [], warn: [], error: [] };
  return {
    io: {
      log: (line) => captured.log.push(line),
      warn: (line) => captured.warn.push(line),
      error: (line) => captured.error.push(line)
    },
    captured
  };
}

const autoRegisterSpec = {
  version: 1,
  relayId: "relay-d",
  target: "acurast" as const,
  catalogState: "candidate",
  apiBaseUrl: "https://relay-d.switchboard.proof.computer",
  peers: [],
  secrets: { relayerPrivateKeyEnv: "PROOF_MAINNET_RELAY_D_RECORDER_PRIVATE_KEY" },
  relay: {
    enablePeerBackfill: false,
    enableValidationReports: true,
    autoRegister: true,
    bootstrapRelayUrl: "https://relay-a.switchboard.proof.computer",
    certificateMode: "job-acme" as const
  },
  dns: { provider: "cloudflare" as const, cnameTarget: "gateway.switchboard.proof.computer" },
  acurast: {
    deployerSeedEnv: "PROOF_ACURAST_MAINNET_DEPLOYER_SEED",
    network: "mainnet" as const,
    projectName: "switchboard-mainnet-relay-d",
    stageDir: "dist/acurast/switchboard-mainnet-relay-d",
    maxCostPerExecution: "41999580000",
    managerId: "9470",
    instantMatchProcessors: ["5EYNfUtMgdxNQUwif5byPvzDWeMWcrv9tEnSAcsAVMuNbUHF"],
    includeEnv: [],
    executionMs: 3_600_000
  }
};

function processor(addr: string): ProcessorInfo {
  return {
    processor: addr,
    heartbeatMs: 1_700_000_000_000,
    heartbeatIso: new Date(1_700_000_000_000).toISOString(),
    heartbeatAgeSeconds: 30,
    version: { platform: 1, buildNumber: 100 },
    availability: {
      proposedStartIso: "2026-05-03T14:00:00.000Z",
      proposedEndIso: "2026-05-03T15:00:00.000Z",
      matches: 0,
      conflicts: 0,
      conflictingJobs: []
    }
  };
}

function inventory(addr: string): ManagerProcessorInventory {
  return {
    network: "mainnet",
    managerId: "9470",
    rpcUrl: "wss://archive.mainnet.acurast.com",
    chainTimestampIso: new Date().toISOString(),
    chainLagSeconds: 5,
    processors: [processor(addr)],
    totalProcessors: 1,
    recentProcessors: 1,
    availableProcessors: 1,
    recentAvailableProcessors: 1,
    availabilityWindow: {
      proposedStartIso: "2026-05-03T14:00:00.000Z",
      proposedEndIso: "2026-05-03T15:00:00.000Z"
    }
  };
}

async function writeSpec(workDir: string, relayId: string, spec: unknown): Promise<void> {
  const dir = path.join(workDir, "relays");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${relayId}.json`), JSON.stringify(spec, null, 2), "utf8");
}

const baseEnv: NodeJS.ProcessEnv = {
  HUB_ETH_RPC_URL: "https://services.polkadothub-rpc.com/mainnet",
  INGRESS_REGISTRY_ADDRESS: "0x65d6B76BeC50F46D198fFa3598E381a298025Da0",
  CHAIN_ID: "420420419",
  PROOF_RECORDER_COORDINATOR_ADDRESS: "0xd4dFB4AD9A4a2AfF56CCBe479F661b84947287A5",
  PROOF_MAINNET_RELAY_D_RECORDER_PRIVATE_KEY: "0xRELAYER_PRIVATE_KEY_VALUE",
  PROOF_ACURAST_MAINNET_DEPLOYER_SEED: "//Alice//acurast-deployer",
  LEDGER_ADDRESS: "0xaE6980ad5D0210585FF381A48Cba5c0be5C02C96",
  PROOF_OPERATOR_ID: `0x${"5c".repeat(32)}`
};

describe("switchboard relay deploy: inline Hub funding", () => {
  let workDir: string;
  let prevCwd: string;
  let prevEnv: NodeJS.ProcessEnv;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "switchboard-deploy-funding-"));
    prevCwd = process.cwd();
    prevEnv = { ...process.env };
    process.chdir(workDir);
    Object.assign(process.env, baseEnv);
  });

  after(async () => {
    process.chdir(prevCwd);
    for (const key of Object.keys(baseEnv)) {
      delete process.env[key];
    }
    Object.assign(process.env, prevEnv);
    await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(path.join(workDir, "relays"), { recursive: true, force: true });
    await rm(path.join(workDir, ".switchboard"), { recursive: true, force: true });
  });

  it("calls fundHubSession when autoRegister is true and --session-id is absent", async () => {
    await writeSpec(workDir, "relay-d", autoRegisterSpec);
    const { io } = makeIo();

    const fundCalls: FundIngressSessionInput[] = [];
    const fakeSessionId = `0x${"42".repeat(32)}`;
    const fakeJobId = `0x${"99".repeat(32)}`;
    const ephemeralBytes = Buffer.alloc(32, 0xaa);

    let envSeenByDeploy: NodeJS.ProcessEnv | undefined;
    await runRelayDeploy({
      flags: new Map<string, string | boolean>([["yes", true], ["no-catalog", true]]),
      positionals: ["relay", "deploy", "relay-d"],
      io,
      discoverProcessor: async () => inventory("5HnGyrtojCxgi9PLduFx5r4p9uFNNrNmmBA9E8zMBg2affQ3"),
      randomBytes: () => ephemeralBytes,
      fundHubSession: async (input) => {
        fundCalls.push(input);
        return {
          sessionId: fakeSessionId,
          jobId: fakeJobId,
          alreadyFunded: false,
          developer: input.ledger.ledgerAddress,
          asset: input.asset,
          amount: "1000000",
          endpointHostname: "relay-d.switchboard.proof.computer"
        } satisfies FundIngressSessionResult;
      },
      spawnPnpm: async (args, env) => {
        if (args[0] === "acurast:deploy-express:direct") envSeenByDeploy = env;
        return 0;
      },
      spawnNode: async () => 0,
      skipReadinessPoll: true,
      skipPeerCheck: true
    });

    assert.equal(fundCalls.length, 1);
    const call = fundCalls[0];
    assert.equal(call.relayUrl, "https://relay-a.switchboard.proof.computer");
    assert.equal(call.registryAddress, baseEnv.INGRESS_REGISTRY_ADDRESS);
    assert.equal(call.ledger.chainId, "420420419");
    assert.equal(call.ledger.ledgerAddress, baseEnv.LEDGER_ADDRESS);
    assert.equal(call.operatorId, baseEnv.PROOF_OPERATOR_ID);
    // jobSignerAddress derives from ephemeral private key bytes; assert
    // that something address-shaped came through.
    assert.match(call.jobSignerAddress, /^0x[0-9a-fA-F]{40}$/);
    // Deploy env should carry the funded sessionId, jobId, and ephemeral signer
    // private key into the relay's encrypted runtime env.
    const buildConfig = JSON.parse(envSeenByDeploy?.SWITCHBOARD_BUILD_CONFIG ?? "{}");
    assert.equal(buildConfig.SESSION_ID, fakeSessionId);
    assert.equal(buildConfig.JOB_ID, fakeJobId);
    assert.equal(envSeenByDeploy?.JOB_SIGNER_PRIVATE_KEY, `0x${"aa".repeat(32)}`);
    // ACURAST_INCLUDE_ENV must contain JOB_SIGNER_PRIVATE_KEY so the job env
    // receives it through the encrypted Acurast channel.
    assert.match(envSeenByDeploy?.ACURAST_INCLUDE_ENV ?? "", /JOB_SIGNER_PRIVATE_KEY/);
  });

  it("skips fundHubSession when --session-id is provided explicitly", async () => {
    await writeSpec(workDir, "relay-d", autoRegisterSpec);
    const { io, captured } = makeIo();

    let fundCalls = 0;
    let envSeenByDeploy: NodeJS.ProcessEnv | undefined;
    const explicitSession = `0x${"77".repeat(32)}`;

    await runRelayDeploy({
      flags: new Map<string, string | boolean>([
        ["yes", true],
        ["no-catalog", true],
        ["session-id", explicitSession]
      ]),
      positionals: ["relay", "deploy", "relay-d"],
      io,
      discoverProcessor: async () => inventory("5DH3ipjftEhSSihRyXJEndcMtRBmxyVbphdH85rXw8BUJFkv"),
      fundHubSession: async () => {
        fundCalls += 1;
        throw new Error("should not be called");
      },
      spawnPnpm: async (args, env) => {
        if (args[0] === "acurast:deploy-express:direct") envSeenByDeploy = env;
        return 0;
      },
      spawnNode: async () => 0,
      skipReadinessPoll: true,
      skipPeerCheck: true
    });

    assert.equal(fundCalls, 0);
    const buildConfig = JSON.parse(envSeenByDeploy?.SWITCHBOARD_BUILD_CONFIG ?? "{}");
    assert.equal(buildConfig.SESSION_ID, explicitSession);
    assert.ok(captured.log.some((line) => line.includes("Skipping inline Hub funding")));
  });

  it("aborts when --no-fund is passed and --session-id is missing", async () => {
    await writeSpec(workDir, "relay-d", autoRegisterSpec);
    const { io } = makeIo();

    await assert.rejects(
      runRelayDeploy({
        flags: new Map<string, string | boolean>([
          ["yes", true],
          ["no-catalog", true],
          ["no-fund", true]
        ]),
        positionals: ["relay", "deploy", "relay-d"],
        io,
        discoverProcessor: async () => inventory("5EYNfUtMgdxNQUwif5byPvzDWeMWcrv9tEnSAcsAVMuNbUHF"),
        spawnPnpm: async () => 0,
        spawnNode: async () => 0,
        skipReadinessPoll: true,
        skipPeerCheck: true
      }),
      /--funding-mode=skip \(or --no-fund\) was passed but no --session-id/
    );
  });

  it("does not call fundHubSession when autoRegister is false", async () => {
    const noAutoRegister = JSON.parse(JSON.stringify(autoRegisterSpec));
    noAutoRegister.relay.autoRegister = false;
    delete noAutoRegister.relay.bootstrapRelayUrl;
    await writeSpec(workDir, "relay-d", noAutoRegister);
    const { io } = makeIo();

    let fundCalls = 0;
    await runRelayDeploy({
      flags: new Map<string, string | boolean>([["yes", true], ["no-catalog", true]]),
      positionals: ["relay", "deploy", "relay-d"],
      io,
      discoverProcessor: async () => inventory("5HnGyrtojCxgi9PLduFx5r4p9uFNNrNmmBA9E8zMBg2affQ3"),
      fundHubSession: async () => {
        fundCalls += 1;
        throw new Error("should not be called");
      },
      spawnPnpm: async () => 0,
      spawnNode: async () => 0,
      skipReadinessPoll: true,
      skipPeerCheck: true
    });

    assert.equal(fundCalls, 0);
  });

  it("provisions an encrypted log sink and persists read state when relay.enableLogs=true", async () => {
    const withLogs = JSON.parse(JSON.stringify(autoRegisterSpec));
    withLogs.relay.enableLogs = true;
    await writeSpec(workDir, "relay-d", withLogs);
    const { io } = makeIo();

    const fakeSink: CreatedLogSink = {
      sinkId: "sink-1",
      writeUrl: "https://relay-a.switchboard.proof.computer/v1/log-sinks/sink-1/events",
      readUrl: "https://relay-a.switchboard.proof.computer/v1/log-sinks/sink-1/events?direction=read",
      writeToken: "wtoken",
      readToken: "rtoken",
      encryptionKey: "ab".repeat(32)
    };

    let envSeenByDeploy: NodeJS.ProcessEnv | undefined;
    let createCalls = 0;
    process.env.PROOF_LOG_CREATE_TOKEN = "ctoken";
    try {
      await runRelayDeploy({
        flags: new Map<string, string | boolean>([["yes", true], ["no-catalog", true]]),
        positionals: ["relay", "deploy", "relay-d"],
        io,
        discoverProcessor: async () => inventory("5HnGyrtojCxgi9PLduFx5r4p9uFNNrNmmBA9E8zMBg2affQ3"),
        randomBytes: () => Buffer.alloc(32, 0xaa),
        fundHubSession: async () => ({
          sessionId: `0x${"42".repeat(32)}`,
          jobId: `0x${"99".repeat(32)}`,
          alreadyFunded: false,
          developer: "0xaE6980ad5D0210585FF381A48Cba5c0be5C02C96",
          asset: "0x0000053900000000000000000000000001200000",
          amount: "1000000",
          endpointHostname: "relay-d.switchboard.proof.computer"
        } satisfies FundIngressSessionResult),
        createLogSink: async (input) => {
          createCalls += 1;
          assert.equal(input.relayUrl, "https://relay-a.switchboard.proof.computer");
          assert.equal(input.createToken, "ctoken");
          return fakeSink;
        },
        spawnPnpm: async (args, env) => {
          if (args[0] === "acurast:deploy-express:direct") envSeenByDeploy = env;
          return 0;
        },
        spawnNode: async () => 0,
        skipReadinessPoll: true,
        skipPeerCheck: true
      });
    } finally {
      delete process.env.PROOF_LOG_CREATE_TOKEN;
    }
    assert.equal(createCalls, 1);
    const buildConfig = JSON.parse(envSeenByDeploy?.SWITCHBOARD_BUILD_CONFIG ?? "{}");
    assert.equal(buildConfig.SWITCHBOARD_LOG_URL, fakeSink.writeUrl);
    assert.equal(buildConfig.SWITCHBOARD_LOG_CONTEXT, "relay-relay-d");
    assert.equal(envSeenByDeploy?.SWITCHBOARD_LOG_TOKEN, fakeSink.writeToken);
    assert.equal(envSeenByDeploy?.SWITCHBOARD_LOG_ENCRYPTION_KEY, fakeSink.encryptionKey);
    assert.match(envSeenByDeploy?.ACURAST_INCLUDE_ENV ?? "", /SWITCHBOARD_LOG_TOKEN/);
    assert.match(envSeenByDeploy?.ACURAST_INCLUDE_ENV ?? "", /SWITCHBOARD_LOG_ENCRYPTION_KEY/);

    // Read state persisted to disk for `switchboard relay logs`.
    const stateRaw = await readFile(`${workDir}/.switchboard/relays/relay-d.log-sink.json`, "utf8");
    const state = JSON.parse(stateRaw);
    assert.equal(state.sinkId, "sink-1");
    assert.equal(state.readUrl, fakeSink.readUrl);
    assert.equal(state.readToken, fakeSink.readToken);
    assert.equal(state.encryptionKey, fakeSink.encryptionKey);
  });

  it("aborts when enableLogs=true but PROOF_LOG_CREATE_TOKEN is absent", async () => {
    const withLogs = JSON.parse(JSON.stringify(autoRegisterSpec));
    withLogs.relay.enableLogs = true;
    await writeSpec(workDir, "relay-d", withLogs);
    const { io } = makeIo();
    const savedToken = process.env.PROOF_LOG_CREATE_TOKEN;
    delete process.env.PROOF_LOG_CREATE_TOKEN;
    try {
      await assert.rejects(
        runRelayDeploy({
          flags: new Map<string, string | boolean>([["yes", true], ["no-catalog", true]]),
          positionals: ["relay", "deploy", "relay-d"],
          io,
          discoverProcessor: async () => inventory("5DH3ipjftEhSSihRyXJEndcMtRBmxyVbphdH85rXw8BUJFkv"),
          fundHubSession: async () => ({
            sessionId: `0x${"42".repeat(32)}`,
            jobId: `0x${"99".repeat(32)}`,
            alreadyFunded: false,
            developer: "0xaE6980ad5D0210585FF381A48Cba5c0be5C02C96",
            asset: "0x0000053900000000000000000000000001200000",
            amount: "1000000"
          }),
          createLogSink: async () => {
            throw new Error("should not reach createLogSink without a token");
          },
          spawnPnpm: async () => 0,
          spawnNode: async () => 0,
          skipReadinessPoll: true,
          skipPeerCheck: true
        }),
        /PROOF_LOG_CREATE_TOKEN is not set/
      );
    } finally {
      if (savedToken !== undefined) process.env.PROOF_LOG_CREATE_TOKEN = savedToken;
    }
  });

  it("--no-logs skips log-sink provisioning even when enableLogs=true", async () => {
    const withLogs = JSON.parse(JSON.stringify(autoRegisterSpec));
    withLogs.relay.enableLogs = true;
    await writeSpec(workDir, "relay-d", withLogs);
    const { io } = makeIo();
    let createCalls = 0;
    await runRelayDeploy({
      flags: new Map<string, string | boolean>([["yes", true], ["no-catalog", true], ["no-logs", true]]),
      positionals: ["relay", "deploy", "relay-d"],
      io,
      discoverProcessor: async () => inventory("5HnGyrtojCxgi9PLduFx5r4p9uFNNrNmmBA9E8zMBg2affQ3"),
      fundHubSession: async () => ({
        sessionId: `0x${"42".repeat(32)}`,
        jobId: `0x${"99".repeat(32)}`,
        alreadyFunded: false,
        developer: "0xaE6980ad5D0210585FF381A48Cba5c0be5C02C96",
        asset: "0x0000053900000000000000000000000001200000",
        amount: "1000000"
      }),
      createLogSink: async () => {
        createCalls += 1;
        throw new Error("should not be called when --no-logs");
      },
      spawnPnpm: async () => 0,
      spawnNode: async () => 0,
      skipReadinessPoll: true,
      skipPeerCheck: true
    });
    assert.equal(createCalls, 0);
  });

  it("errors when LEDGER_ADDRESS is missing for inline funding", async () => {
    await writeSpec(workDir, "relay-d", autoRegisterSpec);
    const { io } = makeIo();
    const savedLedger = process.env.LEDGER_ADDRESS;
    delete process.env.LEDGER_ADDRESS;
    try {
      await assert.rejects(
        runRelayDeploy({
          flags: new Map<string, string | boolean>([["yes", true], ["no-catalog", true]]),
          positionals: ["relay", "deploy", "relay-d"],
          io,
          discoverProcessor: async () => inventory("5DH3ipjftEhSSihRyXJEndcMtRBmxyVbphdH85rXw8BUJFkv"),
          fundHubSession: async () => {
            throw new Error("should not reach funding");
          },
          spawnPnpm: async () => 0,
          spawnNode: async () => 0,
          skipReadinessPoll: true,
          skipPeerCheck: true
        }),
        /requires LEDGER_ADDRESS/
      );
    } finally {
      if (savedLedger !== undefined) process.env.LEDGER_ADDRESS = savedLedger;
    }
  });

  it("--funding-mode=substrate calls the substrate funder, not Ledger", async () => {
    await writeSpec(workDir, "relay-d", autoRegisterSpec);
    const { io } = makeIo();
    let ledgerCalls = 0;
    let substrateCalls = 0;
    let envSeenByDeploy: NodeJS.ProcessEnv | undefined;
    const savedWs = process.env.HUB_SUBSTRATE_WS_URL;
    process.env.HUB_SUBSTRATE_WS_URL = "wss://example/sub";
    try {
      await runRelayDeploy({
        flags: new Map<string, string | boolean>([
          ["yes", true],
          ["no-catalog", true],
          ["funding-mode", "substrate"]
        ]),
        positionals: ["relay", "deploy", "relay-d"],
        io,
        discoverProcessor: async () => inventory("5DH3ipjftEhSSihRyXJEndcMtRBmxyVbphdH85rXw8BUJFkv"),
        fundHubSession: async () => {
          ledgerCalls += 1;
          throw new Error("ledger should not be called");
        },
        fundHubSessionSubstrate: async (input: FundIngressSessionSubstrateInput) => {
          substrateCalls += 1;
          assert.equal(input.relayUrl, "https://relay-a.switchboard.proof.computer");
          assert.equal(input.signing.substrateWsUrl, "wss://example/sub");
          // seed env defaulted to the spec's deployerSeedEnv (PROOF_ACURAST_MAINNET_DEPLOYER_SEED)
          assert.equal(input.signing.seed, baseEnv.PROOF_ACURAST_MAINNET_DEPLOYER_SEED);
          return {
            sessionId: `0x${"42".repeat(32)}`,
            jobId: `0x${"99".repeat(32)}`,
            alreadyFunded: false,
            developerSs58: "136jcDxAEzdU1o25a9555GSwEzVYdEuPi6hxma1bFibU7SHw",
            developerEvm: "0x1938dac993153be94b613bc22f2e0bf5b2156f8f",
            amount: "1000000",
            asset: input.asset,
            txs: [{ action: "fundWithAssetQuote" as const, txHash: "0xtx" }]
          } satisfies FundIngressSessionSubstrateResult;
        },
        spawnPnpm: async (args, env) => {
          if (args[0] === "acurast:deploy-express:direct") envSeenByDeploy = env;
          return 0;
        },
        spawnNode: async () => 0,
        skipReadinessPoll: true,
        skipPeerCheck: true
      });
    } finally {
      if (savedWs !== undefined) process.env.HUB_SUBSTRATE_WS_URL = savedWs;
      else delete process.env.HUB_SUBSTRATE_WS_URL;
    }
    assert.equal(ledgerCalls, 0);
    assert.equal(substrateCalls, 1);
    const buildConfig = JSON.parse(envSeenByDeploy?.SWITCHBOARD_BUILD_CONFIG ?? "{}");
    assert.equal(buildConfig.SESSION_ID, `0x${"42".repeat(32)}`);
  });

  it("--funding-mode=substrate aborts cleanly when HUB_SUBSTRATE_WS_URL is missing", async () => {
    await writeSpec(workDir, "relay-d", autoRegisterSpec);
    const { io } = makeIo();
    const savedWs = process.env.HUB_SUBSTRATE_WS_URL;
    delete process.env.HUB_SUBSTRATE_WS_URL;
    try {
      await assert.rejects(
        runRelayDeploy({
          flags: new Map<string, string | boolean>([
            ["yes", true],
            ["no-catalog", true],
            ["funding-mode", "substrate"]
          ]),
          positionals: ["relay", "deploy", "relay-d"],
          io,
          discoverProcessor: async () => inventory("5DH3ipjftEhSSihRyXJEndcMtRBmxyVbphdH85rXw8BUJFkv"),
          fundHubSessionSubstrate: async () => {
            throw new Error("should not reach substrate funder");
          },
          spawnPnpm: async () => 0,
          spawnNode: async () => 0,
          skipReadinessPoll: true,
          skipPeerCheck: true
        }),
        /requires HUB_SUBSTRATE_WS_URL/
      );
    } finally {
      if (savedWs !== undefined) process.env.HUB_SUBSTRATE_WS_URL = savedWs;
    }
  });

  it("--deployer-seed-env override overrides spec.acurast.deployerSeedEnv with a warning", async () => {
    await writeSpec(workDir, "relay-d", autoRegisterSpec);
    const { io, captured } = makeIo();
    process.env.HUB_SUBSTRATE_WS_URL = "wss://example/sub";
    process.env.ACURAST_MAINNET_SEED = "fish method water vague travel wealth amused river curtain stadium digital wedding";
    let observedSeedEnvName: string | undefined;
    let envSeenByDeploy: NodeJS.ProcessEnv | undefined;
    try {
      await runRelayDeploy({
        flags: new Map<string, string | boolean>([
          ["yes", true],
          ["no-catalog", true],
          ["funding-mode", "substrate"],
          ["deployer-seed-env", "ACURAST_MAINNET_SEED"]
        ]),
        positionals: ["relay", "deploy", "relay-d"],
        io,
        discoverProcessor: async () => inventory("5DH3ipjftEhSSihRyXJEndcMtRBmxyVbphdH85rXw8BUJFkv"),
        fundHubSessionSubstrate: async (input: FundIngressSessionSubstrateInput) => {
          observedSeedEnvName = input.signing.seed === process.env.ACURAST_MAINNET_SEED ? "ACURAST_MAINNET_SEED" : "(other)";
          return {
            sessionId: `0x${"42".repeat(32)}`,
            jobId: `0x${"99".repeat(32)}`,
            alreadyFunded: false,
            developerSs58: "x",
            developerEvm: "0x1938dac993153be94b613bc22f2e0bf5b2156f8f",
            amount: "1000000",
            asset: input.asset,
            txs: []
          };
        },
        spawnPnpm: async (args, env) => {
          if (args[0] === "acurast:deploy-express:direct") envSeenByDeploy = env;
          return 0;
        },
        spawnNode: async () => 0,
        skipReadinessPoll: true,
        skipPeerCheck: true
      });
    } finally {
      delete process.env.HUB_SUBSTRATE_WS_URL;
      delete process.env.ACURAST_MAINNET_SEED;
    }
    // warning surfaced
    assert.ok(captured.warn.some((line) => line.includes("deployer override") && line.includes("ACURAST_MAINNET_SEED")));
    // funding signed with the overridden seed
    assert.equal(observedSeedEnvName, "ACURAST_MAINNET_SEED");
    // Acurast extrinsics also signed with the overridden seed (ACURAST_MAINNET_SEED in childEnv)
    assert.ok(envSeenByDeploy?.ACURAST_MAINNET_SEED);
  });
});
