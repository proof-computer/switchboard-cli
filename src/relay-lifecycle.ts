export const DEFAULT_RELAY_AUTHORITY_RUNWAY_MS = 10 * 60_000;

export type RelayAuthorityState = "authority_eligible" | "draining" | "expired" | "unknown";

export interface RelayLifecycleConfig {
  scheduleEndMs?: number;
  scheduleEndSource?: string;
  authorityRunwayMs?: number;
}

export interface RelayLifecycleStatus {
  configured: boolean;
  state: RelayAuthorityState;
  authorityEligible: boolean;
  reason: string;
  scheduleEndMs?: number;
  scheduleEndIso?: string;
  scheduleEndSource?: string;
  authorityRunwayMs: number;
  authorityCutoffMs?: number;
  authorityCutoffIso?: string;
  millisecondsRemaining?: number;
}

export interface RelayScheduleEndCandidate {
  scheduleEndMs?: number;
  source: string;
}

export function classifyRelayLifecycle(
  config: RelayLifecycleConfig | undefined,
  nowMs = Date.now()
): RelayLifecycleStatus {
  const authorityRunwayMs = normalizeAuthorityRunwayMs(config?.authorityRunwayMs);
  if (!config) {
    return {
      configured: false,
      state: "authority_eligible",
      authorityEligible: true,
      reason: "lifecycle_not_configured",
      authorityRunwayMs
    };
  }

  const scheduleEndMs = normalizeScheduleEndMs(config.scheduleEndMs);
  const scheduleEndSource = config.scheduleEndSource ?? "unknown";
  if (scheduleEndMs === undefined) {
    return {
      configured: true,
      state: "unknown",
      authorityEligible: false,
      reason: "schedule_end_unknown",
      scheduleEndSource,
      authorityRunwayMs
    };
  }

  const authorityCutoffMs = scheduleEndMs - authorityRunwayMs;
  const millisecondsRemaining = scheduleEndMs - nowMs;
  const common = {
    configured: true,
    scheduleEndMs,
    scheduleEndIso: safeIso(scheduleEndMs),
    scheduleEndSource,
    authorityRunwayMs,
    authorityCutoffMs,
    authorityCutoffIso: safeIso(authorityCutoffMs),
    millisecondsRemaining
  };

  if (nowMs >= scheduleEndMs) {
    return {
      ...common,
      state: "expired",
      authorityEligible: false,
      reason: "schedule_expired"
    };
  }

  if (nowMs >= authorityCutoffMs) {
    return {
      ...common,
      state: "draining",
      authorityEligible: false,
      reason: "inside_authority_runway"
    };
  }

  return {
    ...common,
    state: "authority_eligible",
    authorityEligible: true,
    reason: "authority_runway_available"
  };
}

export function selectEarliestRelayScheduleEnd(
  candidates: RelayScheduleEndCandidate[]
): { scheduleEndMs?: number; scheduleEndSource: string } {
  const valid = candidates
    .map((candidate) => ({
      scheduleEndMs: normalizeScheduleEndMs(candidate.scheduleEndMs),
      source: candidate.source
    }))
    .filter((candidate): candidate is { scheduleEndMs: number; source: string } => candidate.scheduleEndMs !== undefined);

  if (valid.length === 0) {
    return { scheduleEndSource: "unknown" };
  }

  valid.sort((left, right) => left.scheduleEndMs - right.scheduleEndMs || left.source.localeCompare(right.source));
  const earliest = valid[0];
  const tiedSources = valid
    .filter((candidate) => candidate.scheduleEndMs === earliest.scheduleEndMs)
    .map((candidate) => candidate.source);
  return {
    scheduleEndMs: earliest.scheduleEndMs,
    scheduleEndSource: Array.from(new Set(tiedSources)).join("+")
  };
}

function normalizeScheduleEndMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeAuthorityRunwayMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_RELAY_AUTHORITY_RUNWAY_MS;
  }
  return Math.floor(value);
}

function safeIso(ms: number): string | undefined {
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}
