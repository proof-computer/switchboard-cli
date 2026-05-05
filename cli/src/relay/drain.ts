import {
  rebuildSignedRelayCatalog,
  readRelayCatalogStore,
  withRelayCatalogState,
  writeRelayCatalogStore
} from "./catalog.js";
import { parseDuration } from "./duration.js";

export interface RunRelayDrainOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  cwd?: string;
  /** Override sleep (for tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface RelayDrainResult {
  relayId: string;
  graceMs: number;
  finalState: "disabled";
}

/**
 * Drain a relay: set state to draining, rebuild + sign catalog, wait for
 * the grace window so in-flight work can flow to peers, then set state
 * to disabled and rebuild again. Two catalog publishes happen during
 * this command; both are local. Pushing the new bundle to the bootstrap
 * host remains a separate bootstrap-host command.
 */
export async function runRelayDrain(options: RunRelayDrainOptions): Promise<RelayDrainResult> {
  const io = options.io ?? defaultIo();
  const cwd = options.cwd ?? process.cwd();
  // positionals shape: ["relay", "drain", "<id>"]
  const relayId = (options.positionals ?? [])[2];
  if (!relayId || !/^[a-z0-9-]+$/.test(relayId)) {
    throw new Error("Usage: switchboard relay drain <relay-id> [--grace-ms <ms>]");
  }

  const graceFlag = stringFlag(options.flags, "grace");
  const graceMs = graceFlag
    ? parseDuration(graceFlag)
    : numberFlag(options.flags, "grace-ms", 5 * 60 * 1000);
  const skipRebuild = boolFlag(options.flags, "no-rebuild");
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const catalogFileFlag = stringFlag(options.flags, "catalog-file");

  io.log(`Phase 1: marking ${relayId} as draining`);
  let store = await readRelayCatalogStore(cwd, catalogFileFlag);
  let entries = withRelayCatalogState(store.entries, relayId, "draining");
  let updated = { ...store, entries };
  await writeRelayCatalogStore(updated);
  io.log(`Updated ${updated.filePath}: ${relayId} -> state=draining`);
  if (!skipRebuild) {
    await rebuildSignedRelayCatalog(updated, { cwd, io });
  }

  io.log("");
  io.log(`Phase 2: waiting ${Math.round(graceMs / 1000)}s grace for in-flight work to flow to peers`);
  io.log(`(run switchboard bootstrap host catalog push --yes now if you haven't already)`);
  await sleep(graceMs);

  io.log("");
  io.log(`Phase 3: marking ${relayId} as disabled`);
  store = await readRelayCatalogStore(cwd, catalogFileFlag);
  entries = withRelayCatalogState(store.entries, relayId, "disabled");
  updated = { ...store, entries };
  await writeRelayCatalogStore(updated);
  io.log(`Updated ${updated.filePath}: ${relayId} -> state=disabled`);
  if (!skipRebuild) {
    await rebuildSignedRelayCatalog(updated, { cwd, io });
  }

  return { relayId, graceMs, finalState: "disabled" };
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

function defaultIo() {
  return {
    log: (line: string) => console.log(line),
    warn: (line: string) => console.warn(line),
    error: (line: string) => console.error(line)
  };
}
