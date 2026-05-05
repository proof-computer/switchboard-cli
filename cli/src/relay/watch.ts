import { readRelayCatalogStore } from "./catalog.js";
import { probeRelay, type RelayStatusResult } from "./status.js";

export interface RunRelayWatchOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  fetchImpl?: typeof fetch;
  cwd?: string;
  /** Replace sleep / now (for tests). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Long-running relay health watch. Probes one relay (or all in the
 * catalog) at a configurable interval and emits one event per state
 * transition or probe failure. Pairs with the `schedule` skill —
 * instead of running this forever, the user can schedule a one-shot
 * `relay status` every N minutes.
 *
 * The default `--max-runs` cap ends the watch deterministically so
 * tests don't hang; pass --max-runs 0 to run until interrupted.
 */
export async function runRelayWatch(options: RunRelayWatchOptions): Promise<void> {
  const io = options.io ?? defaultIo();
  const cwd = options.cwd ?? process.cwd();
  // positionals shape: ["relay", "watch", "<id>?"]
  const relayId = (options.positionals ?? [])[2];

  const intervalMs = numberFlag(options.flags, "interval-ms", 60_000);
  const maxRuns = numberFlag(options.flags, "max-runs", 1);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  const store = await readRelayCatalogStore(cwd);
  let entries = store.entries;
  if (relayId) {
    if (!/^[a-z0-9-]+$/.test(relayId)) throw new Error(`Invalid relay id ${JSON.stringify(relayId)}`);
    entries = entries.filter((e) => e.relayId === relayId);
    if (entries.length === 0) throw new Error(`relay ${relayId} not in catalog`);
  }

  const lastState = new Map<string, "ok" | "fail">();
  let runs = 0;
  while (true) {
    runs += 1;
    for (const entry of entries) {
      const probe = await probeRelay(entry, { timeoutMs: Math.min(10_000, intervalMs), fetchImpl: options.fetchImpl });
      const ok = probeOk(probe);
      const previous = lastState.get(entry.relayId);
      const current = ok ? "ok" : "fail";
      if (previous !== current) {
        const transition = previous ? `${previous} -> ${current}` : `initial=${current}`;
        io.log(`${new Date(now()).toISOString()}  ${entry.relayId.padEnd(12)}  ${transition}  ${describe(probe)}`);
      }
      lastState.set(entry.relayId, current);
    }
    if (maxRuns > 0 && runs >= maxRuns) break;
    await sleep(intervalMs);
  }
}

function probeOk(probe: RelayStatusResult): boolean {
  return probe.health.ok && probe.relayStatus.ok && probe.relayCatalog.ok;
}

function describe(probe: RelayStatusResult): string {
  const failing: string[] = [];
  if (!probe.health.ok) failing.push(`health=${probe.health.error ?? probe.health.httpStatus}`);
  if (!probe.relayStatus.ok) failing.push(`relay-status=${probe.relayStatus.error ?? probe.relayStatus.httpStatus}`);
  if (!probe.relayCatalog.ok) failing.push(`catalog=${probe.relayCatalog.error ?? probe.relayCatalog.httpStatus}`);
  return failing.length > 0 ? failing.join(", ") : `ok (${probe.health.durationMs}ms / ${probe.relayStatus.durationMs}ms / ${probe.relayCatalog.durationMs}ms)`;
}

function numberFlag(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  const value = flags.get(name);
  if (typeof value !== "string") return fallback;
  if (!/^[0-9]+$/.test(value)) throw new Error(`--${name} must be a non-negative integer`);
  return Number(value);
}

function defaultIo() {
  return {
    log: (line: string) => console.log(line),
    warn: (line: string) => console.warn(line),
    error: (line: string) => console.error(line)
  };
}
