import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { relayStatePath } from "../switchboard-paths.js";

export interface RelayDeploymentHistoryEntry {
  timestamp: string;
  relayId: string;
  target: "acurast" | "bootstrap";
  apiBaseUrl: string;
  catalogState: string;
  outcome: "success" | "failed";
  durationMs?: number;
  signer?: string;
  notes?: string;
  acurast?: {
    deploymentId?: string;
    origin?: string;
    ipfsHash?: string;
    startTime?: number;
    endTime?: number;
    duration?: number;
    status?: string;
  };
}

export interface RelayDeploymentHistory {
  relayId: string;
  filePath: string;
  entries: RelayDeploymentHistoryEntry[];
}

export async function loadRelayDeploymentHistory(
  relayId: string,
  cwd: string = process.cwd()
): Promise<RelayDeploymentHistory> {
  const filePath = relayStatePath(cwd, `${relayId}.history.json`);
  const raw = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw !== undefined) {
    const parsed = JSON.parse(raw) as { entries?: RelayDeploymentHistoryEntry[] };
    return { relayId, filePath, entries: parsed.entries ?? [] };
  }
  return { relayId, filePath, entries: [] };
}

export async function recordRelayDeployment(
  entry: RelayDeploymentHistoryEntry,
  cwd: string = process.cwd()
): Promise<void> {
  const existing = await loadRelayDeploymentHistory(entry.relayId, cwd);
  const next: RelayDeploymentHistoryEntry[] = [...existing.entries, entry];
  await mkdir(path.dirname(existing.filePath), { recursive: true });
  await writeFile(
    existing.filePath,
    `${JSON.stringify({ relayId: entry.relayId, entries: next }, null, 2)}\n`,
    "utf8"
  );
}

export interface RunRelayDeploymentsOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  cwd?: string;
}

/**
 * Show deployment history for a relay. Reads
 * .switchboard/relays/<id>.history.json which is appended to by
 * runRelayDeploy on each successful or failed deploy.
 */
export async function runRelayDeployments(options: RunRelayDeploymentsOptions): Promise<RelayDeploymentHistory> {
  const io = options.io ?? defaultIo();
  const cwd = options.cwd ?? process.cwd();
  // positionals shape: ["relay", "deployments", "<id>"]
  const relayId = (options.positionals ?? [])[2];
  if (!relayId || !/^[a-z0-9-]+$/.test(relayId)) {
    throw new Error("Usage: switchboard relay deployments <relay-id>");
  }

  const history = await loadRelayDeploymentHistory(relayId, cwd);
  if (boolFlag(options.flags, "json")) {
    io.log(JSON.stringify(history, null, 2));
    return history;
  }

  if (history.entries.length === 0) {
    io.log(`No deployment history for ${relayId} (${history.filePath} not found)`);
    return history;
  }

  const now = Date.now();
  io.log(`${relayId} deployment history (${history.entries.length} entr${history.entries.length === 1 ? "y" : "ies"})`);
  io.log(`source: ${history.filePath}`);
  io.log("");
  for (const entry of history.entries.slice().reverse()) {
    const duration = entry.durationMs ? ` (${(entry.durationMs / 1000).toFixed(1)}s)` : "";
    const acu = entry.acurast?.deploymentId ? ` acurast=${entry.acurast.deploymentId}` : "";
    io.log(`${entry.timestamp}  ${entry.outcome.padEnd(7)}  target=${entry.target.padEnd(9)}  state=${entry.catalogState.padEnd(10)}${duration}${acu}`);
    if (entry.acurast) {
      const a = entry.acurast;
      if (a.ipfsHash) io.log(`  ipfs        : ${a.ipfsHash}`);
      if (a.startTime !== undefined && a.endTime !== undefined) {
        const startsIn = a.startTime - now;
        const endsIn = a.endTime - now;
        const startTag = startsIn > 0 ? `(starts in ${formatRelative(startsIn)})` : "(started)";
        const endTag = endsIn > 0 ? `(ends in ${formatRelative(endsIn)})` : "(ended)";
        io.log(`  schedule    : ${new Date(a.startTime).toISOString()} ${startTag} -> ${new Date(a.endTime).toISOString()} ${endTag}`);
      }
      if (a.status) io.log(`  status      : ${a.status}`);
    }
    if (entry.notes) {
      io.log(`  note        : ${entry.notes}`);
    }
  }
  return history;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function formatRelative(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${Math.round(abs / 1000)}s`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
  if (abs < 86_400_000) return `${(abs / 3_600_000).toFixed(1)}h`;
  return `${(abs / 86_400_000).toFixed(1)}d`;
}

/**
 * Find the most recent successful Acurast deployment in history that is
 * still active (schedule.endTime > now). Used by `relay deploy` to skip
 * a redundant submit when a relay-d job is already running.
 */
export function findActiveAcurastDeployment(
  history: RelayDeploymentHistory,
  now: number = Date.now()
): RelayDeploymentHistoryEntry | undefined {
  for (let i = history.entries.length - 1; i >= 0; i -= 1) {
    const entry = history.entries[i];
    if (entry.target !== "acurast") continue;
    if (entry.outcome !== "success") continue;
    const a = entry.acurast;
    if (!a) continue;
    if (!a.deploymentId) continue;
    if (a.endTime !== undefined && a.endTime > now) return entry;
  }
  return undefined;
}

function defaultIo() {
  return {
    log: (line: string) => console.log(line),
    warn: (line: string) => console.warn(line),
    error: (line: string) => console.error(line)
  };
}
