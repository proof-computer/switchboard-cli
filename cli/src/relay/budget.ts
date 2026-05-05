import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatDuration, parseDuration } from "./duration.js";

export interface RunRelayBudgetOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  cwd?: string;
}

export interface RelayBudgetResult {
  durationMs: number;
  ratePerMs: bigint;
  marginPercent: number;
  baseCost: bigint;
  recommendedMaxCost: bigint;
  updatedSpecPath?: string;
}

/**
 * Default rate matches the existing convention used by relays a/b/c:
 * `maxCostPerExecution: 40_000_000_000` for `executionMs: 3_600_000`
 * (1 hour) → 40_000_000_000 / 3_600_000 ≈ 11_111 units per ms.
 *
 * Override with --rate-per-ms when actual processor pricing diverges.
 */
const DEFAULT_RATE_PER_MS = 11_111n;

/**
 * Compute the recommended `maxCostPerExecution` for a given execution
 * duration. Optionally update a spec file in place.
 *
 *   switchboard relay budget 7d
 *   switchboard relay budget 24h --margin-percent 20
 *   switchboard relay budget 7d --update relays/relay-d.json
 */
export async function runRelayBudget(options: RunRelayBudgetOptions): Promise<RelayBudgetResult> {
  const io = options.io ?? defaultIo();
  const cwd = options.cwd ?? process.cwd();
  // positionals shape: ["relay", "budget", "<duration>"]
  const durationArg = (options.positionals ?? [])[2];
  if (!durationArg) {
    throw new Error("Usage: switchboard relay budget <duration>  (e.g. 7d, 24h, 30m)");
  }
  const durationMs = parseDuration(durationArg);

  const ratePerMs = bigintFlag(options.flags, "rate-per-ms", DEFAULT_RATE_PER_MS);
  const marginPercent = numberFlag(options.flags, "margin-percent", 0);
  if (marginPercent < 0 || marginPercent > 1000) {
    throw new Error("--margin-percent must be between 0 and 1000");
  }

  const baseCost = ratePerMs * BigInt(durationMs);
  const margin = (baseCost * BigInt(marginPercent)) / 100n;
  const recommendedMaxCost = baseCost + margin;

  if (boolFlag(options.flags, "json")) {
    io.log(JSON.stringify({
      duration: durationArg,
      durationMs,
      ratePerMs: ratePerMs.toString(),
      marginPercent,
      baseCost: baseCost.toString(),
      recommendedMaxCost: recommendedMaxCost.toString()
    }, null, 2));
  } else {
    io.log(`duration             : ${formatDuration(durationMs)} (${durationMs}ms)`);
    io.log(`rate per ms          : ${ratePerMs} units`);
    io.log(`base cost            : ${baseCost} units`);
    io.log(`margin               : ${marginPercent}%`);
    io.log(`recommended max cost : ${recommendedMaxCost} units`);
  }

  const updatePath = stringFlag(options.flags, "update");
  let updatedSpecPath: string | undefined;
  if (updatePath) {
    const resolved = path.isAbsolute(updatePath) ? updatePath : path.resolve(cwd, updatePath);
    const raw = await readFile(resolved, "utf8");
    const spec = JSON.parse(raw) as Record<string, unknown>;
    const acurast = (spec.acurast as Record<string, unknown> | undefined) ?? {};
    if (spec.target !== "acurast") {
      throw new Error(`Spec at ${resolved} is target=${spec.target ?? "(unset)"}; --update only works for acurast specs`);
    }
    acurast.executionMs = durationMs;
    acurast.maxCostPerExecution = recommendedMaxCost.toString();
    spec.acurast = acurast;
    await writeFile(resolved, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
    updatedSpecPath = resolved;
    io.log("");
    io.log(`Updated ${resolved}: executionMs=${durationMs}, maxCostPerExecution=${recommendedMaxCost}`);
  }

  return {
    durationMs,
    ratePerMs,
    marginPercent,
    baseCost,
    recommendedMaxCost,
    updatedSpecPath
  };
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

function bigintFlag(flags: Map<string, string | boolean>, name: string, fallback: bigint): bigint {
  const value = stringFlag(flags, name);
  if (!value) return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return BigInt(value);
}

function defaultIo() {
  return {
    log: (line: string) => console.log(line),
    warn: (line: string) => console.warn(line),
    error: (line: string) => console.error(line)
  };
}
