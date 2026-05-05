import { createHash } from "node:crypto";

export interface RelayLeadershipMember {
  relayId: string;
  active?: boolean;
  weight?: number;
}

export interface SettlementLeadershipInput {
  registryAddress: string;
  windowStart: bigint | number | string;
  windowEnd: bigint | number | string;
  shard?: string;
  relays: RelayLeadershipMember[];
  nowUnixSeconds?: number;
  failoverGraceSeconds?: number;
}

export interface SettlementLeadership {
  seed: string;
  orderedRelayIds: string[];
  leaderId: string;
  leaderIndex: number;
  failoverGraceSeconds: number;
  primaryDeadlineUnixSeconds: number;
}

export function orderedSettlementRelayIds(input: SettlementLeadershipInput): string[] {
  const seed = settlementLeadershipSeed(input);
  return activeUniqueRelayIds(input.relays)
    .map((relayId) => ({
      relayId,
      score: scoreRelay(seed, relayId)
    }))
    .sort((left, right) => left.score.localeCompare(right.score) || left.relayId.localeCompare(right.relayId))
    .map((item) => item.relayId);
}

export function selectSettlementLeader(input: SettlementLeadershipInput): SettlementLeadership | undefined {
  const orderedRelayIds = orderedSettlementRelayIds(input);
  if (orderedRelayIds.length === 0) {
    return undefined;
  }

  const failoverGraceSeconds = input.failoverGraceSeconds ?? 300;
  if (!Number.isInteger(failoverGraceSeconds) || failoverGraceSeconds <= 0) {
    throw new Error(`failoverGraceSeconds must be positive, got ${failoverGraceSeconds}`);
  }
  const windowEnd = Number(input.windowEnd);
  if (!Number.isFinite(windowEnd)) {
    throw new Error(`windowEnd must be numeric, got ${input.windowEnd}`);
  }
  const nowUnixSeconds = input.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  const elapsedAfterWindow = Math.max(0, nowUnixSeconds - windowEnd);
  const leaderIndex = Math.min(Math.floor(elapsedAfterWindow / failoverGraceSeconds), orderedRelayIds.length - 1);

  return {
    seed: settlementLeadershipSeed(input),
    orderedRelayIds,
    leaderId: orderedRelayIds[leaderIndex],
    leaderIndex,
    failoverGraceSeconds,
    primaryDeadlineUnixSeconds: windowEnd + failoverGraceSeconds
  };
}

export function isSettlementLeader(input: SettlementLeadershipInput & { relayId: string }): boolean {
  return selectSettlementLeader(input)?.leaderId === input.relayId;
}

function settlementLeadershipSeed(input: SettlementLeadershipInput): string {
  return [
    input.registryAddress.toLowerCase(),
    String(input.windowStart),
    String(input.windowEnd),
    input.shard ?? "default"
  ].join(":");
}

function activeUniqueRelayIds(relays: RelayLeadershipMember[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const relay of relays) {
    if ((relay.active ?? true) === false || !relay.relayId || seen.has(relay.relayId)) {
      continue;
    }
    seen.add(relay.relayId);
    ids.push(relay.relayId);
  }
  return ids;
}

function scoreRelay(seed: string, relayId: string): string {
  return createHash("sha256").update(`${seed}:${relayId}`).digest("hex");
}
