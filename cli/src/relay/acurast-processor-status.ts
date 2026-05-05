import type { ApiPromise } from "@polkadot/api";

import { createAcurastApi, rpcForAcurastNetwork } from "../../../src/acurast-manager.js";

export interface AcurastProcessorStatusInput {
  deploymentId: string;
  origin: string;
  network: "mainnet" | "canary";
  rpcUrl?: string;
}

export interface AcurastProcessorStatusSnapshot {
  deploymentId: string;
  origin: string;
  /** Number of processors currently assigned to the job. */
  assignedCount: number;
  /** Number of assignments where the processor has acknowledged the job. */
  acknowledgedCount: number;
  /** True when at least one assignment has nextReportIndex > 0. */
  anyReportIndexAdvanced: boolean;
  /** Highest nextReportIndex across all assignments (0 if none yet). */
  maxReportIndex: number;
  /** Current chain timestamp in ms (for reasoning about start-window timing). */
  chainTimestampMs: number;
}

/**
 * Connect to the Acurast chain and snapshot the on-chain assignment + report
 * state for an Acurast deployment. Returns shape that maps cleanly to a
 * one-line supplementary signal in the relay readiness poll.
 *
 * The caller owns lifecycle: open the API once, query each readiness cycle,
 * disconnect when polling ends.
 */
export async function queryAcurastProcessorStatus(
  api: ApiPromise,
  input: AcurastProcessorStatusInput
): Promise<AcurastProcessorStatusSnapshot> {
  if (!/^[0-9]+$/.test(input.deploymentId)) {
    throw new Error("deploymentId must be a numeric Acurast job sequence");
  }
  const sequence = Number(input.deploymentId);
  const origin = { acurast: input.origin };
  const jobId = [origin, sequence];

  const market = (api.query as unknown as { acurastMarketplace: Record<string, (...args: unknown[]) => Promise<unknown> & { entries?: unknown }> }).acurastMarketplace;
  const timestamp = (api.query as unknown as { timestamp: { now: () => Promise<{ toJSON(): unknown }> } }).timestamp;

  const chainTimestampMs = Number((await timestamp.now()).toJSON());

  // assignedProcessors is a double-map keyed (jobId, processor); .entries(jobId)
  // returns one row per assignment.
  const entries = (await (market.assignedProcessors as unknown as { entries: (k: unknown[]) => Promise<Array<[{ args: unknown[] }, unknown]>> }).entries(jobId)) as Array<[{ args: { toString(): string }[] }, unknown]>;
  const assignedCount = entries.length;

  let acknowledgedCount = 0;
  let maxReportIndex = 0;
  for (const [key] of entries) {
    const processor = key.args[1].toString();
    const matchValue = (await market.storedMatches(processor, jobId)) as { toJSON(): unknown };
    const matchJson = matchValue.toJSON() as { acknowledged?: unknown } | null;
    if (matchJson?.acknowledged === true) {
      acknowledgedCount += 1;
    }
    const nextReport = (await market.nextReportIndex(jobId, processor)) as { toJSON(): unknown };
    const nextReportNum = Number(nextReport.toJSON() ?? 0);
    if (Number.isFinite(nextReportNum) && nextReportNum > maxReportIndex) {
      maxReportIndex = nextReportNum;
    }
  }

  return {
    deploymentId: input.deploymentId,
    origin: input.origin,
    assignedCount,
    acknowledgedCount,
    anyReportIndexAdvanced: maxReportIndex > 0,
    maxReportIndex,
    chainTimestampMs
  };
}

/** One-line operator summary of the snapshot. */
export function describeAcurastProcessorStatus(snapshot: AcurastProcessorStatusSnapshot): string {
  if (snapshot.assignedCount === 0) {
    return `processor: no assignments on chain yet (deployment ${snapshot.deploymentId})`;
  }
  if (snapshot.anyReportIndexAdvanced) {
    return `processor: relay reporting (assignments=${snapshot.assignedCount}, acked=${snapshot.acknowledgedCount}, nextReportIndex=${snapshot.maxReportIndex}); operator-side ingress not yet routing`;
  }
  if (snapshot.acknowledgedCount > 0) {
    return `processor: assignment acknowledged but no execution reports yet (assignments=${snapshot.assignedCount}, acked=${snapshot.acknowledgedCount})`;
  }
  return `processor: assigned but not yet acknowledged (assignments=${snapshot.assignedCount})`;
}

/** Convenience: open an api just for the duration of a single snapshot. */
export async function snapshotAcurastProcessorStatus(input: AcurastProcessorStatusInput): Promise<AcurastProcessorStatusSnapshot> {
  const rpcUrl = input.rpcUrl ?? rpcForAcurastNetwork(input.network);
  const api = await createAcurastApi({ network: input.network, rpcUrl });
  try {
    return await queryAcurastProcessorStatus(api, input);
  } finally {
    await api.disconnect();
  }
}
