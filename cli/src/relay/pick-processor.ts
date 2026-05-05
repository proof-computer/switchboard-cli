import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseRelayDeploymentSpec,
  type RelayDeploymentSpec
} from "../../../src/relay-deployment-spec.js";
import {
  createAcurastApi,
  discoverManagerProcessorsWithApi,
  rpcForAcurastNetwork,
  type AcurastNetwork,
  type ManagerProcessorInventory,
  type ProcessorInfo
} from "../../../src/acurast-manager.js";

export interface PickProcessorIo {
  log: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

export interface PickProcessorDiscoverInput {
  network: AcurastNetwork;
  managerId: string;
  rpcUrl: string;
  startDelayMs: number;
  durationMs: number;
  maxAgeSeconds: number;
}

export type PickProcessorDiscover = (
  input: PickProcessorDiscoverInput
) => Promise<ManagerProcessorInventory>;

export interface RunRelayPickProcessorOptions {
  flags: Map<string, string | boolean>;
  positionals: string[];
  io?: PickProcessorIo;
  cwd?: string;
  /** Test seam: replace live discovery. */
  discover?: PickProcessorDiscover;
}

export interface RelayPickProcessorResult {
  relayId: string;
  managerId: string;
  network: AcurastNetwork;
  rpcUrl: string;
  inventory: ManagerProcessorInventory;
  available: ProcessorInfo[];
  selected?: ProcessorInfo;
  pin?: { from: string[]; to: string[]; specFile: string };
}

const DEFAULT_START_DELAY_MS = 360_000;
const DEFAULT_MAX_AGE_SECONDS = 900;
const DEFAULT_TABLE_LIMIT = 5;
const DEFAULT_MAX_CHAIN_LAG_SECONDS = 300;
const SS58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{45,50}$/;

export async function runRelayPickProcessor(
  options: RunRelayPickProcessorOptions
): Promise<RelayPickProcessorResult> {
  const io = options.io ?? defaultIo();
  const cwd = options.cwd ?? process.cwd();
  // positionals shape: ["relay", "pick-processor", "<id>"]
  const relayId = options.positionals[2];
  if (!relayId || !/^[a-z0-9-]+$/.test(relayId)) {
    throw new Error("Usage: switchboard relay pick-processor <relay-id> [--pin auto|<addr>]");
  }

  const specFile = path.join(cwd, "relays", `${relayId}.json`);
  const raw = await readFile(specFile, "utf8").catch(() => {
    throw new Error(`Spec ${specFile} not found. Run \`switchboard relay scaffold ${relayId}\` first.`);
  });
  const parsedJson = JSON.parse(raw) as unknown;
  const spec = parseRelayDeploymentSpec(parsedJson);

  if (spec.target !== "acurast" || !spec.acurast) {
    throw new Error(
      `relay ${relayId} target=${spec.target}; pick-processor only applies to acurast-targeted relays`
    );
  }

  const managerIdFlag = stringFlag(options.flags, "manager-id");
  const managerId = managerIdFlag ?? spec.acurast.managerId;
  if (!managerId) {
    throw new Error(
      `relay ${relayId} has no acurast.managerId. Add it to ${specFile}:\n  "acurast": { ..., "managerId": "<id>" }\nor pass --manager-id <id> for this run only.`
    );
  }

  const network = spec.acurast.network;
  const rpcUrl = stringFlag(options.flags, "rpc") ?? rpcForAcurastNetwork(network);
  const startDelayMs = numberFlag(options.flags, "start-delay-ms", DEFAULT_START_DELAY_MS);
  const durationMs = numberFlag(options.flags, "duration-ms", spec.acurast.executionMs);
  const maxAgeSeconds = numberFlag(options.flags, "max-age-seconds", DEFAULT_MAX_AGE_SECONDS);
  const limitFlag = optionalNumberFlag(options.flags, "limit");
  const limit = limitFlag ?? DEFAULT_TABLE_LIMIT;
  const excludeSet = new Set(
    (stringFlag(options.flags, "exclude") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  );
  const includeConflicting = boolFlag(options.flags, "include-conflicting");
  const force = boolFlag(options.flags, "force");
  const json = boolFlag(options.flags, "json");

  const pinFlag = stringFlag(options.flags, "pin");
  if (pinFlag !== undefined && pinFlag !== "auto" && !SS58_ADDRESS_RE.test(pinFlag)) {
    throw new Error(`--pin must be "auto" or a substrate ss58 address (got ${JSON.stringify(pinFlag)})`);
  }

  const discover = options.discover ?? defaultDiscover;
  const inventory = await discover({
    network,
    managerId,
    rpcUrl,
    startDelayMs,
    durationMs,
    maxAgeSeconds
  });

  if (inventory.chainLagSeconds > DEFAULT_MAX_CHAIN_LAG_SECONDS) {
    io.warn(
      `RPC chain timestamp is ${inventory.chainLagSeconds}s behind local time (${inventory.chainTimestampIso}); discovery may use stale heartbeats.`
    );
  }

  const fresh = inventory.processors.filter(
    (processor) =>
      processor.heartbeatAgeSeconds !== null && processor.heartbeatAgeSeconds <= maxAgeSeconds
  );
  const available = fresh.filter(
    (processor) =>
      processor.availability !== undefined &&
      processor.availability.conflicts === 0 &&
      !excludeSet.has(processor.processor)
  );
  const conflicting = fresh.filter(
    (processor) => processor.availability !== undefined && processor.availability.conflicts > 0
  );
  const currentPins = spec.acurast.instantMatchProcessors;
  const pinnedStatus = currentPins.length > 0
    ? currentPins.map((address) => evaluatePinnedStatus(address, inventory))
    : [];

  let selected: ProcessorInfo | undefined;
  let pin: RelayPickProcessorResult["pin"];
  if (pinFlag !== undefined) {
    selected = resolvePinTarget(pinFlag, inventory, available);
    if (!selected) {
      if (pinFlag === "auto") {
        throw new Error(
          `--pin auto: no schedule-clear processor found under manager ${managerId} for window ${inventory.availabilityWindow?.proposedStartIso} → ${inventory.availabilityWindow?.proposedEndIso}`
        );
      }
      throw new Error(
        `--pin ${pinFlag}: processor is not visible under manager ${managerId} on ${network}`
      );
    }
    const conflictCount = selected.availability?.conflicts ?? 0;
    if (conflictCount > 0 && !force) {
      const firstFree = selected.availability?.conflictingJobs[0]?.endIso;
      throw new Error(
        `refusing to pin ${selected.processor}: ${conflictCount} schedule conflict(s) in window` +
          (firstFree ? `; first conflicting job ends at ${firstFree}` : "") +
          `\nre-run with --pin auto, or pass --force to pin anyway`
      );
    }
    const next = [selected.processor];
    pin = { from: currentPins, to: next, specFile };
    await writeSpecPin(specFile, raw, next);
  }

  if (json) {
    io.log(
      JSON.stringify(
        {
          relayId,
          managerId,
          network,
          rpcUrl,
          chainTimestampIso: inventory.chainTimestampIso,
          chainLagSeconds: inventory.chainLagSeconds,
          window: inventory.availabilityWindow,
          totalProcessors: inventory.totalProcessors,
          freshProcessors: fresh.length,
          availableProcessors: available.length,
          conflictingProcessors: conflicting.length,
          currentPins,
          pinnedStatus,
          available: available.slice(0, limit).map(processorJson),
          conflicting: includeConflicting ? conflicting.map(processorJson) : undefined,
          selected: selected ? processorJson(selected) : undefined,
          pin
        },
        null,
        2
      )
    );
    return { relayId, managerId, network, rpcUrl, inventory, available, selected, pin };
  }

  const window = inventory.availabilityWindow;
  io.log(`${relayId}  network=${network}  manager=${managerId}`);
  if (window) {
    io.log(
      `window   ${window.proposedStartIso} → ${window.proposedEndIso}  (startDelay=${formatMs(startDelayMs)}, duration=${formatMs(durationMs)})`
    );
  }
  io.log("");

  if (currentPins.length > 0) {
    io.log("Currently pinned:");
    for (let index = 0; index < currentPins.length; index += 1) {
      const status = pinnedStatus[index];
      io.log(`  ${currentPins[index]}   ${status.label}`);
    }
    io.log("");
  }

  if (available.length === 0) {
    io.log(
      `No schedule-clear processors found under manager ${managerId} (fresh=${fresh.length}, conflicting=${conflicting.length}, total=${inventory.totalProcessors}).`
    );
  } else {
    io.log(`Available (heartbeat-fresh, schedule-clear): ${available.length}`);
    const top = available.slice(0, limit);
    for (let index = 0; index < top.length; index += 1) {
      const processor = top[index];
      io.log(
        `  ${index + 1}. ${processor.processor}   heartbeat=${processor.heartbeatAgeSeconds}s   ${formatVersion(processor.version)}`
      );
    }
    if (available.length > top.length) {
      io.log(`  ... ${available.length - top.length} more (raise --limit to see)`);
    }
    io.log("");
    if (!pin) {
      io.log("Pin one in:");
      io.log(`  switchboard relay pick-processor ${relayId} --pin ${available[0].processor}`);
      io.log(`  switchboard relay pick-processor ${relayId} --pin auto`);
    }
  }

  if (includeConflicting && conflicting.length > 0) {
    io.log("");
    io.log(`Conflicting (would fail today): ${conflicting.length}`);
    for (const processor of conflicting.slice(0, limit)) {
      const firstFree = processor.availability?.conflictingJobs[0]?.endIso;
      io.log(
        `  ${processor.processor}   conflicts=${processor.availability?.conflicts ?? 0}` +
          (firstFree ? `   first-free=${firstFree}` : "")
      );
    }
  }

  if (pin) {
    io.log("");
    io.log(`Updated ${pin.specFile}: acurast.instantMatchProcessors`);
    io.log(`  - ${pin.from.length === 0 ? "(empty)" : pin.from.join(", ")}`);
    io.log(`  + ${pin.to.join(", ")}`);
  }

  return { relayId, managerId, network, rpcUrl, inventory, available, selected, pin };
}

interface PinnedStatus {
  conflicts: number;
  fresh: boolean;
  label: string;
}

function evaluatePinnedStatus(address: string, inventory: ManagerProcessorInventory): PinnedStatus {
  const match = inventory.processors.find((processor) => processor.processor === address);
  if (!match) {
    return { conflicts: 0, fresh: false, label: "NOT MANAGED — outside this manager's processors" };
  }
  const heartbeatAge = match.heartbeatAgeSeconds;
  const fresh = heartbeatAge !== null && heartbeatAge <= DEFAULT_MAX_AGE_SECONDS;
  const conflicts = match.availability?.conflicts ?? 0;
  if (!fresh) {
    return {
      conflicts,
      fresh: false,
      label: `STALE — last heartbeat ${heartbeatAge ?? "unknown"}s ago`
    };
  }
  if (conflicts === 0) {
    return { conflicts: 0, fresh: true, label: "ok — schedule-clear in window" };
  }
  const firstFree = match.availability?.conflictingJobs[0]?.endIso;
  return {
    conflicts,
    fresh: true,
    label: `SCHEDULE CONFLICT — ${conflicts} job(s)${firstFree ? `, first-free=${firstFree}` : ""}`
  };
}

function resolvePinTarget(
  pinFlag: string,
  inventory: ManagerProcessorInventory,
  available: ProcessorInfo[]
): ProcessorInfo | undefined {
  if (pinFlag === "auto") {
    return available[0];
  }
  return inventory.processors.find((processor) => processor.processor === pinFlag);
}

async function writeSpecPin(specFile: string, raw: string, processors: string[]): Promise<void> {
  const updated = JSON.parse(raw) as Record<string, unknown>;
  const acurast = (updated.acurast as Record<string, unknown> | undefined) ?? {};
  acurast.instantMatchProcessors = processors;
  updated.acurast = acurast;
  await writeFile(specFile, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
}

async function defaultDiscover(input: PickProcessorDiscoverInput): Promise<ManagerProcessorInventory> {
  const api = await createAcurastApi({ network: input.network, rpcUrl: input.rpcUrl });
  try {
    return await discoverManagerProcessorsWithApi(api, {
      network: input.network,
      managerId: input.managerId,
      rpcUrl: input.rpcUrl,
      maxAgeSeconds: input.maxAgeSeconds,
      checkAvailability: true,
      startDelayMs: input.startDelayMs,
      durationMs: input.durationMs
    });
  } finally {
    await api.disconnect();
  }
}

function processorJson(processor: ProcessorInfo): Record<string, unknown> {
  return {
    processor: processor.processor,
    heartbeatIso: processor.heartbeatIso,
    heartbeatAgeSeconds: processor.heartbeatAgeSeconds,
    version: processor.version,
    availability: processor.availability
  };
}

function formatVersion(version: unknown): string {
  if (!version || typeof version !== "object") {
    return `version=${JSON.stringify(version)}`;
  }
  const record = version as { platform?: unknown; buildNumber?: unknown };
  return `version=platform:${String(record.platform ?? "?")},build:${String(record.buildNumber ?? "?")}`;
}

function formatMs(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 1_000 && ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function numberFlag(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  const value = stringFlag(flags, name);
  if (!value) return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return Number(value);
}

function optionalNumberFlag(flags: Map<string, string | boolean>, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return Number(value);
}

function defaultIo(): PickProcessorIo {
  return {
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
    error: (line) => console.error(line)
  };
}
