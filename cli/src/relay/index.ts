import {
  rebuildSignedRelayCatalog,
  readRelayCatalogStore,
  withRelayCatalogState,
  writeRelayCatalogStore,
  type RebuildSignedCatalogOptions
} from "./catalog.js";
import { probeRelay, summarizeRelayStatus } from "./status.js";
import { serviceStateSchema, type ServiceState } from "../../../src/service-catalog.js";

export interface RelayCommandIo {
  log: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

const DEFAULT_IO: RelayCommandIo = {
  log: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line)
};

export interface RunRelayCatalogSetStateOptions {
  flags: Map<string, string | boolean>;
  positionals: string[];
  io?: RelayCommandIo;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  build?: RebuildSignedCatalogOptions["build"];
}

export async function runRelayCatalogSetState(args: RunRelayCatalogSetStateOptions): Promise<void> {
  const io = args.io ?? DEFAULT_IO;
  const relayId = args.positionals[3];
  const stateInput = args.positionals[4];
  if (!relayId || !stateInput) {
    throw new Error("Usage: switchboard relay catalog set-state <relay-id> <state>");
  }
  if (!/^[a-z0-9-]+$/.test(relayId)) {
    throw new Error(`Invalid relay id ${JSON.stringify(relayId)}: must match /^[a-z0-9-]+$/`);
  }
  const stateResult = serviceStateSchema.safeParse(stateInput);
  if (!stateResult.success) {
    throw new Error(`Invalid catalog state ${JSON.stringify(stateInput)}: must be candidate|active|degraded|draining|disabled`);
  }
  const state: ServiceState = stateResult.data;

  const cwd = args.cwd ?? process.cwd();
  const catalogFileFlag = stringFlag(args.flags, "catalog-file");
  const store = await readRelayCatalogStore(cwd, catalogFileFlag);
  const next = withRelayCatalogState(store.entries, relayId, state);
  const updated = { ...store, entries: next };
  await writeRelayCatalogStore(updated);
  io.log(`Updated ${updated.filePath}: ${relayId} -> state=${state}`);

  if (boolFlag(args.flags, "no-rebuild")) {
    io.log("Skipped catalog signing because --no-rebuild was passed.");
    return;
  }
  await rebuildSignedRelayCatalog(updated, { cwd, io, env: args.env, build: args.build });
}

export async function runRelayStatus(args: {
  flags: Map<string, string | boolean>;
  positionals: string[];
  io?: RelayCommandIo;
}): Promise<void> {
  const io = args.io ?? DEFAULT_IO;
  const cwd = process.cwd();
  const catalogFileFlag = stringFlag(args.flags, "catalog-file");
  const store = await readRelayCatalogStore(cwd, catalogFileFlag);
  const explicitRelayId = args.positionals[2];

  let entries = store.entries;
  if (explicitRelayId) {
    if (!/^[a-z0-9-]+$/.test(explicitRelayId)) {
      throw new Error(`Invalid relay id ${JSON.stringify(explicitRelayId)}: must match /^[a-z0-9-]+$/`);
    }
    entries = entries.filter((entry) => entry.relayId === explicitRelayId);
    if (entries.length === 0) {
      throw new Error(`relay ${explicitRelayId} not found in ${store.filePath}`);
    }
  }

  const timeoutMs = numberFlag(args.flags, "timeout-ms", 5_000);
  io.log(`Probing ${entries.length} relay${entries.length === 1 ? "" : "s"} from ${store.filePath}`);
  io.log("");

  let anyFail = false;
  for (const entry of entries) {
    const result = await probeRelay(entry, { timeoutMs });
    if (!result.health.ok || !result.relayStatus.ok || !result.relayCatalog.ok) anyFail = true;
    for (const line of summarizeRelayStatus(result)) io.log(line);
    io.log("");
  }
  if (anyFail) {
    process.exitCode = 1;
  }
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFlag(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  const value = stringFlag(flags, name);
  if (!value) return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return Number(value);
}
