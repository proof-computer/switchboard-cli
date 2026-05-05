import {
  rebuildSignedRelayCatalog,
  readRelayCatalogStore,
  withRelayCatalogState,
  writeRelayCatalogStore
} from "./catalog.js";
import { probeRelay } from "./status.js";
import {
  type RelayCatalogInputEntry,
  type ServiceState
} from "../../../src/service-catalog.js";

export interface RunRelayPromoteOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  fetchImpl?: typeof fetch;
  cwd?: string;
}

export interface RelayPromoteResult {
  relayId: string;
  fromState?: string;
  toState: ServiceState;
  gatesPassed: string[];
  gatesSkipped: string[];
  forced: boolean;
}

/**
 * Promote a relay to `active` (or another target state) with policy
 * gates. Default gates:
 *
 *   - All three /health, /v1/relay-status, /v1/service-catalogs/relay
 *     return 200 right now.
 *   - The catalog already lists this relay in `candidate` or
 *     `degraded` (refuses promotion of a non-staged relay).
 *
 * Pass --force to bypass with a noisy warning. Future gates (uptime
 * window, validation activity, peer reachability) will hook into the
 * same mechanism.
 */
export async function runRelayPromote(options: RunRelayPromoteOptions): Promise<RelayPromoteResult> {
  const io = options.io ?? defaultIo();
  const cwd = options.cwd ?? process.cwd();
  // positionals shape: ["relay", "promote", "<id>"]
  const relayId = (options.positionals ?? [])[2];
  if (!relayId || !/^[a-z0-9-]+$/.test(relayId)) {
    throw new Error("Usage: switchboard relay promote <relay-id> [--state active]");
  }
  const targetState = (stringFlag(options.flags, "state") ?? "active") as ServiceState;
  if (!["candidate", "active", "degraded", "draining", "disabled"].includes(targetState)) {
    throw new Error(`--state must be candidate|active|degraded|draining|disabled (got ${targetState})`);
  }
  const force = boolFlag(options.flags, "force");
  const skipRebuild = boolFlag(options.flags, "no-rebuild");
  const catalogFileFlag = stringFlag(options.flags, "catalog-file");

  const store = await readRelayCatalogStore(cwd, catalogFileFlag);
  const entry = store.entries.find((e) => e.relayId === relayId);
  if (!entry) {
    throw new Error(
      `Relay ${relayId} is not in the catalog file ${store.filePath}. Add it via \`switchboard relay deploy\` first.`
    );
  }
  const fromState = entry.state ?? (entry.active === false ? "disabled" : "active");

  const gatesPassed: string[] = [];
  const gatesSkipped: string[] = [];
  if (force) {
    io.warn(`--force: skipping policy gates`);
    gatesSkipped.push("status-green", "stage-state");
  } else {
    if (fromState !== "candidate" && fromState !== "degraded") {
      throw new Error(
        `Refusing to promote ${relayId}: current state is ${fromState}, expected candidate or degraded. Pass --force to override.`
      );
    }
    gatesPassed.push("stage-state");

    io.log(`Probing ${entry.apiBaseUrl} for current health…`);
    const probe = await probeRelay(entry as RelayCatalogInputEntry, {
      fetchImpl: options.fetchImpl,
      timeoutMs: 5000
    });
    const failing: string[] = [];
    if (!probe.health.ok) failing.push("health");
    if (!probe.relayStatus.ok) failing.push("relay-status");
    if (!probe.relayCatalog.ok) failing.push("service-catalogs/relay");
    if (failing.length > 0) {
      throw new Error(
        `Refusing to promote ${relayId}: failing endpoints [${failing.join(", ")}]. Pass --force to override.`
      );
    }
    gatesPassed.push("status-green");
  }

  const next = withRelayCatalogState(store.entries, relayId, targetState);
  const updated = { ...store, entries: next };
  await writeRelayCatalogStore(updated);
  io.log("");
  io.log(`Promoted ${relayId}: ${fromState} -> ${targetState}`);
  if (!skipRebuild) {
    await rebuildSignedRelayCatalog(updated, { cwd, io });
  }

  return {
    relayId,
    fromState,
    toState: targetState,
    gatesPassed,
    gatesSkipped,
    forced: force
  };
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
