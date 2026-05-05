import type { RelayCatalogInputEntry } from "../../../src/service-catalog.js";
import { probeRelay, type RelayStatusResult } from "./status.js";

export interface ReadinessIo {
  log: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

export interface PollRelayReadinessOptions {
  apiBaseUrl: string;
  relayId: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  /**
   * If provided, the poller sleeps until this Unix-millisecond timestamp
   * (plus `startAtGraceMs`) before the first probe. Use to skip pointless
   * "fetch failed" cycles for an Acurast deploy whose `startAt.msFromNow`
   * defers the relay's first execution.
   */
  startAtMs?: number;
  /** Extra grace beyond `startAtMs` before the first probe (default: 30_000). */
  startAtGraceMs?: number;
  /**
   * Optional probe of out-of-band signals (e.g. Acurast processor events).
   * Called once per poll attempt when the HTTP probe fails. The returned
   * string is logged as a supplementary diagnostic; falsy means "nothing
   * to add." Useful for distinguishing "relay process hasn't started" from
   * "relay process up but operator-side ingress isn't routing yet."
   */
  collectSupplementarySignal?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  io?: ReadinessIo;
  /** Replace the wall clock. Used by tests. */
  now?: () => number;
  /** Replace the delay function. Used by tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PollRelayReadinessResult {
  attempts: number;
  durationMs: number;
  finalProbe: RelayStatusResult;
  /** If non-empty, the most recent supplementary signal observed. */
  supplementarySignal?: string;
}

export async function pollRelayReadiness(
  options: PollRelayReadinessOptions
): Promise<PollRelayReadinessResult> {
  const io = options.io;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Wait for the relay's scheduled start before the first probe — Acurast
  // processors don't begin executing the job until startAt elapses, and
  // pre-start probes only serve to spam "fetch failed" lines.
  if (options.startAtMs !== undefined) {
    const grace = options.startAtGraceMs ?? 30_000;
    const target = options.startAtMs + grace;
    const waitMs = target - now();
    if (waitMs > 0) {
      io?.log(
        `  readiness: waiting ${Math.round(waitMs / 1000)}s for scheduled relay start (startAt=${new Date(options.startAtMs).toISOString()}, +${Math.round(grace / 1000)}s grace) before probing`
      );
      await sleep(waitMs);
    }
  }

  const start = now();
  const deadline = start + options.pollTimeoutMs;

  const entry: RelayCatalogInputEntry = {
    relayId: options.relayId,
    apiBaseUrl: options.apiBaseUrl
  };
  let attempts = 0;
  let lastProbe: RelayStatusResult | undefined;
  let lastSignal: string | undefined;

  while (true) {
    attempts += 1;
    const probe = await probeRelay(entry, {
      timeoutMs: Math.max(1_000, options.pollIntervalMs),
      fetchImpl: options.fetchImpl
    });
    lastProbe = probe;
    if (probe.health.ok && probe.relayStatus.ok && probe.relayCatalog.ok) {
      return { attempts, durationMs: now() - start, finalProbe: probe, supplementarySignal: lastSignal };
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;

    if (options.collectSupplementarySignal) {
      try {
        const signal = await options.collectSupplementarySignal();
        if (signal) lastSignal = signal;
      } catch (error) {
        io?.warn(`  readiness: supplementary signal probe failed: ${(error as Error).message}`);
      }
    }
    const signalSuffix = lastSignal ? `; ${lastSignal}` : "";
    io?.log(
      `  readiness: attempt ${attempts} not yet ready (${describeFailing(probe)})${signalSuffix}; retrying in ${options.pollIntervalMs}ms`
    );
    await sleep(Math.min(options.pollIntervalMs, remaining));
  }

  if (!lastProbe) {
    throw new Error(`Relay ${options.relayId} readiness polling completed with no probes`);
  }
  const signalDetail = lastSignal ? ` Last supplementary signal: ${lastSignal}.` : "";
  throw new Error(
    `Relay ${options.relayId} did not become ready at ${options.apiBaseUrl} within ${options.pollTimeoutMs}ms after ${attempts} attempt(s); failing endpoints: ${describeFailing(lastProbe)}.${signalDetail}`
  );
}

export interface CheckPeerReachabilityOptions {
  peers: Array<{ relayId: string; apiBaseUrl: string }>;
  required: boolean;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  fetchImpl?: typeof fetch;
  io?: ReadinessIo;
}

export interface CheckPeerReachabilityResult {
  reachable: string[];
  unreachable: Array<{ relayId: string; apiBaseUrl: string; reason: string }>;
}

export async function checkPeerReachability(
  options: CheckPeerReachabilityOptions
): Promise<CheckPeerReachabilityResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const reachable: string[] = [];
  const unreachable: CheckPeerReachabilityResult["unreachable"] = [];

  for (const peer of options.peers) {
    const url = `${peer.apiBaseUrl.replace(/\/+$/, "")}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, options.pollIntervalMs));
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
      if (response.ok) {
        reachable.push(peer.relayId);
      } else {
        unreachable.push({ relayId: peer.relayId, apiBaseUrl: peer.apiBaseUrl, reason: `http=${response.status}` });
      }
    } catch (error) {
      unreachable.push({
        relayId: peer.relayId,
        apiBaseUrl: peer.apiBaseUrl,
        reason: (error as Error).message
      });
    } finally {
      clearTimeout(timer);
    }
  }

  if (options.required && unreachable.length > 0) {
    const detail = unreachable
      .map((peer) => `${peer.relayId} (${peer.apiBaseUrl}): ${peer.reason}`)
      .join("; ");
    throw new Error(
      `requirePeerBackfillReachable=true and ${unreachable.length} peer(s) failed health probe: ${detail}`
    );
  }

  return { reachable, unreachable };
}

function describeFailing(probe: RelayStatusResult): string {
  const failing: string[] = [];
  if (!probe.health.ok) failing.push(`health=${probe.health.error ?? probe.health.httpStatus}`);
  if (!probe.relayStatus.ok) failing.push(`relay-status=${probe.relayStatus.error ?? probe.relayStatus.httpStatus}`);
  if (!probe.relayCatalog.ok) failing.push(`service-catalogs/relay=${probe.relayCatalog.error ?? probe.relayCatalog.httpStatus}`);
  return failing.length > 0 ? failing.join(", ") : "all probes ok";
}
