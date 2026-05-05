import { runRelayDeploy } from "./index.js";
import { runRelayDrain } from "./drain.js";
import {
  rebuildSignedRelayCatalog,
  readRelayCatalogStore,
  withRelayCatalogState,
  writeRelayCatalogStore
} from "./catalog.js";

export interface RunRelayReplaceOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  cwd?: string;
}

export interface RelayReplaceResult {
  oldRelayId: string;
  newRelayId: string;
}

/**
 * Replace one relay with another in a single command:
 *   1. Deploy new (uses runRelayDeploy with auto-catalog as candidate).
 *   2. Promote new to active (set-state).
 *   3. Drain old (set-state draining → grace → disabled).
 *
 * Each phase publishes a refreshed signed catalog locally; SCP to
 * bootstrap remains the operator's job between phases.
 */
export async function runRelayReplace(options: RunRelayReplaceOptions): Promise<RelayReplaceResult> {
  const io = options.io ?? defaultIo();
  const cwd = options.cwd ?? process.cwd();
  // positionals shape: ["relay", "replace", "<old-id>", "<new-id>"]
  const oldRelayId = (options.positionals ?? [])[2];
  const newRelayId = (options.positionals ?? [])[3];
  if (!oldRelayId || !newRelayId || !/^[a-z0-9-]+$/.test(oldRelayId) || !/^[a-z0-9-]+$/.test(newRelayId)) {
    throw new Error("Usage: switchboard relay replace <old-relay-id> <new-relay-id>");
  }
  if (oldRelayId === newRelayId) {
    throw new Error("relay replace requires distinct old and new relay ids");
  }
  const skipRebuild = boolFlag(options.flags, "no-rebuild");
  const catalogFileFlag = stringFlag(options.flags, "catalog-file");

  io.log("");
  io.log(`==> Phase 1: deploy ${newRelayId} (auto-adds to catalog as candidate)`);
  io.log("");
  await runRelayDeploy({
    flags: subFlags(options.flags, ["target", "yes", "spec-file", "spec", "catalog-file", "state"]),
    positionals: ["relay", "deploy", newRelayId],
    io
  });

  io.log("");
  io.log(`==> Phase 2: promote ${newRelayId} to active`);
  let store = await readRelayCatalogStore(cwd, catalogFileFlag);
  let entries = withRelayCatalogState(store.entries, newRelayId, "active");
  let updated = { ...store, entries };
  await writeRelayCatalogStore(updated);
  io.log(`Updated ${updated.filePath}: ${newRelayId} -> state=active`);
  if (!skipRebuild) {
    await rebuildSignedRelayCatalog(updated, { cwd, io });
  }

  io.log("");
  io.log(`==> Phase 3: drain ${oldRelayId}`);
  io.log("");
  await runRelayDrain({
    flags: subFlags(options.flags, ["grace-ms", "catalog-file", "no-rebuild"]),
    positionals: ["relay", "drain", oldRelayId],
    io,
    cwd
  });

  io.log("");
  io.log(`==> relay replace complete: ${oldRelayId} -> ${newRelayId}`);
  return { oldRelayId, newRelayId };
}

function subFlags(flags: Map<string, string | boolean>, keys: string[]): Map<string, string | boolean> {
  const next = new Map<string, string | boolean>();
  for (const key of keys) {
    const value = flags.get(key);
    if (value !== undefined) next.set(key, value);
  }
  return next;
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function defaultIo() {
  return {
    log: (line: string) => console.log(line),
    warn: (line: string) => console.warn(line),
    error: (line: string) => console.error(line)
  };
}
