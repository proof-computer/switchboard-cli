import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { runRelayPickProcessor, type PickProcessorDiscoverInput } from "../cli/src/relay/pick-processor.js";
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

const baseSpec = {
  version: 1,
  relayId: "relay-d",
  target: "acurast" as const,
  catalogState: "candidate",
  apiBaseUrl: "https://relay-d.switchboard.proof.computer",
  peers: [],
  secrets: { relayerPrivateKeyEnv: "PROOF_MAINNET_RELAY_D_RECORDER_PRIVATE_KEY" },
  relay: { enablePeerBackfill: false, enableValidationReports: true },
  acurast: {
    deployerSeedEnv: "PROOF_ACURAST_MAINNET_DEPLOYER_SEED",
    network: "mainnet" as const,
    projectName: "switchboard-mainnet-relay-d",
    stageDir: "dist/acurast/switchboard-mainnet-relay-d",
    maxCostPerExecution: "41999580000",
    managerId: "9470",
    instantMatchProcessors: ["5HePinnedCachedAddressxxxxxxxxxxxxxxxxxxxxxxxxx"],
    includeEnv: [],
    encryptedCode: false,
    executionMs: 3_600_000
  }
};

function processor(overrides: Partial<ProcessorInfo> & { processor: string }): ProcessorInfo {
  return {
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
    },
    ...overrides
  };
}

function inventory(processors: ProcessorInfo[], overrides: Partial<ManagerProcessorInventory> = {}): ManagerProcessorInventory {
  return {
    network: "mainnet",
    managerId: "9470",
    rpcUrl: "wss://archive.mainnet.acurast.com",
    chainTimestampIso: new Date().toISOString(),
    chainLagSeconds: 5,
    processors,
    totalProcessors: processors.length,
    recentProcessors: processors.length,
    availableProcessors: processors.filter((p) => p.availability?.conflicts === 0).length,
    recentAvailableProcessors: processors.filter((p) => p.availability?.conflicts === 0).length,
    availabilityWindow: {
      proposedStartIso: "2026-05-03T14:00:00.000Z",
      proposedEndIso: "2026-05-03T15:00:00.000Z"
    },
    ...overrides
  };
}

async function writeSpec(workDir: string, relayId: string, spec: unknown): Promise<void> {
  const dir = path.join(workDir, "relays");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${relayId}.json`), JSON.stringify(spec, null, 2), "utf8");
}

describe("relay pick-processor", () => {
  let workDir: string;
  let prevCwd: string;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "switchboard-pick-processor-"));
    prevCwd = process.cwd();
    process.chdir(workDir);
  });

  after(async () => {
    process.chdir(prevCwd);
    await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(path.join(workDir, "relays"), { recursive: true, force: true });
  });

  it("errors clearly when the spec has no managerId", async () => {
    const noManagerSpec = JSON.parse(JSON.stringify(baseSpec));
    delete noManagerSpec.acurast.managerId;
    await writeSpec(workDir, "relay-d", noManagerSpec);
    const { io } = makeIo();

    await assert.rejects(
      runRelayPickProcessor({
        flags: new Map(),
        positionals: ["relay", "pick-processor", "relay-d"],
        io,
        cwd: workDir,
        discover: async () => inventory([])
      }),
      /no acurast.managerId.*Add it/s
    );
  });

  it("rejects non-acurast specs", async () => {
    const bootstrapSpec = {
      version: 1,
      relayId: "relay-a",
      target: "bootstrap",
      catalogState: "active",
      apiBaseUrl: "https://relay-a.switchboard.proof.computer",
      peers: [],
      secrets: { relayerPrivateKeyEnv: "PROOF_MAINNET_RELAY_A_RECORDER_PRIVATE_KEY" },
      bootstrap: {
        composeService: "relay-a",
        composeFile: "docker-compose.control-plane.yaml",
        envFile: ".control-plane/control-plane.env",
        rebuild: true
      }
    };
    await writeSpec(workDir, "relay-a", bootstrapSpec);
    const { io } = makeIo();

    await assert.rejects(
      runRelayPickProcessor({
        flags: new Map(),
        positionals: ["relay", "pick-processor", "relay-a"],
        io,
        cwd: workDir,
        discover: async () => inventory([])
      }),
      /target=bootstrap.*only applies to acurast/
    );
  });

  it("lists available processors and prints suggested commands", async () => {
    await writeSpec(workDir, "relay-d", baseSpec);
    const { io, captured } = makeIo();
    const top = processor({ processor: "5GfAvaiTopxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", heartbeatAgeSeconds: 2 });
    const second = processor({ processor: "5DFzAvaiSecndxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", heartbeatAgeSeconds: 14 });

    const result = await runRelayPickProcessor({
      flags: new Map(),
      positionals: ["relay", "pick-processor", "relay-d"],
      io,
      cwd: workDir,
      discover: async (input) => {
        assert.equal(input.managerId, "9470");
        assert.equal(input.network, "mainnet");
        assert.equal(input.durationMs, 3_600_000);
        return inventory([top, second]);
      }
    });

    assert.equal(result.available.length, 2);
    assert.equal(result.selected, undefined);
    const output = captured.log.join("\n");
    assert.match(output, /relay-d\s+network=mainnet\s+manager=9470/);
    assert.match(output, /Available \(heartbeat-fresh, schedule-clear\): 2/);
    assert.match(output, /1\.\s+5GfAvaiTop/);
    assert.match(output, /Pin one in:/);
    assert.match(output, /--pin 5GfAvaiTop/);
    assert.match(output, /--pin auto/);
  });

  it("annotates the currently pinned address as schedule-conflicted", async () => {
    await writeSpec(workDir, "relay-d", baseSpec);
    const { io, captured } = makeIo();
    const pinnedAddr = baseSpec.acurast.instantMatchProcessors[0];
    const conflicted = processor({
      processor: pinnedAddr,
      availability: {
        proposedStartIso: "2026-05-03T14:00:00.000Z",
        proposedEndIso: "2026-05-03T15:00:00.000Z",
        matches: 1,
        conflicts: 1,
        conflictingJobs: [
          {
            jobId: 1,
            status: "active",
            startIso: "2026-05-03T13:30:00.000Z",
            endIso: "2026-05-03T16:00:00.000Z"
          }
        ]
      }
    });
    const fresh = processor({ processor: "5GfAvaiTopxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", heartbeatAgeSeconds: 2 });

    await runRelayPickProcessor({
      flags: new Map(),
      positionals: ["relay", "pick-processor", "relay-d"],
      io,
      cwd: workDir,
      discover: async () => inventory([conflicted, fresh])
    });

    const output = captured.log.join("\n");
    assert.match(output, /Currently pinned:/);
    assert.match(output, /SCHEDULE CONFLICT.*2026-05-03T16:00:00/);
  });

  it("--pin auto writes the top candidate into the spec", async () => {
    await writeSpec(workDir, "relay-d", baseSpec);
    const { io } = makeIo();
    const top = processor({ processor: "5GfAvaiTopxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", heartbeatAgeSeconds: 2 });

    const result = await runRelayPickProcessor({
      flags: new Map<string, string | boolean>([["pin", "auto"]]),
      positionals: ["relay", "pick-processor", "relay-d"],
      io,
      cwd: workDir,
      discover: async () => inventory([top])
    });

    assert.equal(result.selected?.processor, top.processor);
    assert.deepEqual(result.pin?.from, baseSpec.acurast.instantMatchProcessors);
    assert.deepEqual(result.pin?.to, [top.processor]);

    const onDisk = JSON.parse(await readFile(path.join(workDir, "relays", "relay-d.json"), "utf8"));
    assert.deepEqual(onDisk.acurast.instantMatchProcessors, [top.processor]);
  });

  it("--pin auto errors when no schedule-clear processor exists", async () => {
    await writeSpec(workDir, "relay-d", baseSpec);
    const { io } = makeIo();

    await assert.rejects(
      runRelayPickProcessor({
        flags: new Map<string, string | boolean>([["pin", "auto"]]),
        positionals: ["relay", "pick-processor", "relay-d"],
        io,
        cwd: workDir,
        discover: async () => inventory([])
      }),
      /no schedule-clear processor found under manager 9470/
    );

    const onDisk = JSON.parse(await readFile(path.join(workDir, "relays", "relay-d.json"), "utf8"));
    assert.deepEqual(onDisk.acurast.instantMatchProcessors, baseSpec.acurast.instantMatchProcessors);
  });

  it("--pin <addr> refuses to pin a conflicting processor without --force", async () => {
    await writeSpec(workDir, "relay-d", baseSpec);
    const { io } = makeIo();
    const target = processor({
      processor: "5HeCnfctngxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      availability: {
        proposedStartIso: "2026-05-03T14:00:00.000Z",
        proposedEndIso: "2026-05-03T15:00:00.000Z",
        matches: 1,
        conflicts: 1,
        conflictingJobs: [
          { jobId: 1, status: "active", startIso: "...", endIso: "2026-05-03T16:00:00.000Z" }
        ]
      }
    });

    await assert.rejects(
      runRelayPickProcessor({
        flags: new Map<string, string | boolean>([["pin", target.processor]]),
        positionals: ["relay", "pick-processor", "relay-d"],
        io,
        cwd: workDir,
        discover: async () => inventory([target])
      }),
      /refusing to pin.*1 schedule conflict.*--force/s
    );
  });

  it("--pin <addr> --force pins despite conflicts", async () => {
    await writeSpec(workDir, "relay-d", baseSpec);
    const { io } = makeIo();
    const target = processor({
      processor: "5HeCnfctngxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      availability: {
        proposedStartIso: "2026-05-03T14:00:00.000Z",
        proposedEndIso: "2026-05-03T15:00:00.000Z",
        matches: 1,
        conflicts: 1,
        conflictingJobs: [
          { jobId: 1, status: "active", startIso: "...", endIso: "2026-05-03T16:00:00.000Z" }
        ]
      }
    });

    const result = await runRelayPickProcessor({
      flags: new Map<string, string | boolean>([
        ["pin", target.processor],
        ["force", true]
      ]),
      positionals: ["relay", "pick-processor", "relay-d"],
      io,
      cwd: workDir,
      discover: async () => inventory([target])
    });

    assert.deepEqual(result.pin?.to, [target.processor]);
  });

  it("--pin <addr> errors when address is not visible under the manager", async () => {
    await writeSpec(workDir, "relay-d", baseSpec);
    const { io } = makeIo();

    await assert.rejects(
      runRelayPickProcessor({
        flags: new Map<string, string | boolean>([["pin", "5DDifferentManagerxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]]),
        positionals: ["relay", "pick-processor", "relay-d"],
        io,
        cwd: workDir,
        discover: async () => inventory([processor({ processor: "5GfNyOtherxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" })])
      }),
      /not visible under manager 9470/
    );
  });

  it("--json emits structured output with window and inventory counts", async () => {
    await writeSpec(workDir, "relay-d", baseSpec);
    const { io, captured } = makeIo();
    const ok = processor({ processor: "5GfAvaiTopxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    const conflicting = processor({
      processor: "5HeCnfctngxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      availability: {
        proposedStartIso: "x",
        proposedEndIso: "y",
        matches: 1,
        conflicts: 1,
        conflictingJobs: [{ jobId: 1, status: "active", startIso: "...", endIso: "..." }]
      }
    });

    await runRelayPickProcessor({
      flags: new Map<string, string | boolean>([
        ["json", true],
        ["include-conflicting", true]
      ]),
      positionals: ["relay", "pick-processor", "relay-d"],
      io,
      cwd: workDir,
      discover: async () => inventory([ok, conflicting])
    });

    const json = JSON.parse(captured.log[0]);
    assert.equal(json.relayId, "relay-d");
    assert.equal(json.managerId, "9470");
    assert.equal(json.network, "mainnet");
    assert.equal(json.totalProcessors, 2);
    assert.equal(json.availableProcessors, 1);
    assert.equal(json.conflictingProcessors, 1);
    assert.equal(json.available.length, 1);
    assert.equal(json.conflicting.length, 1);
  });

  it("--manager-id flag overrides the spec's pin (without writing it)", async () => {
    await writeSpec(workDir, "relay-d", baseSpec);
    const { io } = makeIo();
    let observed: PickProcessorDiscoverInput | undefined;

    await runRelayPickProcessor({
      flags: new Map<string, string | boolean>([["manager-id", "9999"]]),
      positionals: ["relay", "pick-processor", "relay-d"],
      io,
      cwd: workDir,
      discover: async (input) => {
        observed = input;
        return inventory([]);
      }
    });

    assert.equal(observed?.managerId, "9999");
    const onDisk = JSON.parse(await readFile(path.join(workDir, "relays", "relay-d.json"), "utf8"));
    assert.equal(onDisk.acurast.managerId, "9470");
  });
});
