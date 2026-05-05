import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface AcurastDeployState {
  deploymentId?: string;
  origin?: string;
  ipfsHash?: string;
  startTime?: number;
  endTime?: number;
  duration?: number;
  status?: string;
  fileMtimeMs: number;
  filePath: string;
}

/**
 * Read the most recent Acurast deploy state file (written by the
 * @acurast/cli into `<stageDir>/.acurast/deploy/`). Returns parsed
 * fields useful for relay history: deploymentId tuple, IPFS script
 * hash, schedule window, current status (init/registered/etc).
 *
 * Returns undefined if no state file is present.
 */
export async function readLatestAcurastDeployState(stageDir: string): Promise<AcurastDeployState | undefined> {
  const deployDir = path.join(stageDir, ".acurast", "deploy");
  let names: string[];
  try {
    names = await readdir(deployDir);
  } catch {
    return undefined;
  }
  const candidates = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const filePath = path.join(deployDir, name);
        const details = await stat(filePath);
        return { name, filePath, mtimeMs: details.mtimeMs };
      })
  );
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length === 0) return undefined;
  const latest = candidates[0];

  const raw = await readFile(latest.filePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  let deploymentId: string | undefined;
  let origin: string | undefined;
  if (Array.isArray(parsed.deploymentId) && parsed.deploymentId.length >= 2) {
    const tuple = parsed.deploymentId as unknown[];
    const head = tuple[0] as Record<string, unknown> | string | undefined;
    origin = typeof head === "object" && head !== null && "acurast" in head
      ? String((head as { acurast?: unknown }).acurast)
      : typeof head === "string" ? head : undefined;
    deploymentId = String(tuple[1]);
  } else {
    const filenameMatch = latest.name.match(/-(\d+)\.json$/);
    if (filenameMatch && parsed.status && parsed.status !== "init") {
      deploymentId = filenameMatch[1];
    }
  }

  const config = parsed.config as Record<string, unknown> | undefined;
  const script = config && typeof config.script === "string" ? config.script : undefined;
  const ipfsHash = script?.startsWith("ipfs://") ? script.slice("ipfs://".length) : script;

  const schedule = config?.schedule as Record<string, unknown> | undefined;
  const startTime = schedule && typeof schedule.startTime === "number" ? schedule.startTime : undefined;
  const endTime = schedule && typeof schedule.endTime === "number" ? schedule.endTime : undefined;
  const duration = schedule && typeof schedule.duration === "number"
    ? schedule.duration
    : startTime !== undefined && endTime !== undefined ? endTime - startTime : undefined;

  return {
    deploymentId,
    origin,
    ipfsHash,
    startTime,
    endTime,
    duration,
    status: typeof parsed.status === "string" ? parsed.status : undefined,
    fileMtimeMs: latest.mtimeMs,
    filePath: latest.filePath
  };
}

export function isDeploymentActive(state: AcurastDeployState | undefined, now: number = Date.now()): boolean {
  if (!state || !state.deploymentId) return false;
  if (state.endTime === undefined) return false;
  if (state.startTime !== undefined && state.startTime > now) {
    // future-scheduled deploy is "active" in the sense that it occupies the slot
    return true;
  }
  return state.endTime > now;
}
