import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractActiveIngressUses,
  selectNextProcessorRefs,
  updateDiscoveryState,
  type OperatorDiscoveryState
} from "../scripts/operator/discover.js";

describe("operator discovery state", () => {
  it("extracts active non-discovery ingress routes by processor", () => {
    const uses = extractActiveIngressUses(
      {
        activeRoutes: [
          {
            routeId: "route-1",
            sessionId: "0x1111111111111111111111111111111111111111111111111111111111111111",
            hostname: "app.ingress.works",
            expiresAt: 200,
            source: {
              operatorId: "0x2222222222222222222222222222222222222222222222222222222222222222",
              processorId: "0x3333333333333333333333333333333333333333333333333333333333333333"
            }
          },
          {
            routeId: "discovery-smoke",
            sessionId: "0x4444444444444444444444444444444444444444444444444444444444444444",
            hostname: "smoke.ingress.works",
            expiresAt: 200,
            source: {
              mode: "operator-discovery",
              processorId: "0x3333333333333333333333333333333333333333333333333333333333333333"
            }
          },
          {
            routeId: "expired",
            sessionId: "0x5555555555555555555555555555555555555555555555555555555555555555",
            hostname: "old.ingress.works",
            expiresAt: 50,
            source: {
              processorId: "0x3333333333333333333333333333333333333333333333333333333333333333"
            }
          }
        ]
      },
      100
    );

    assert.deepEqual(uses, [
      {
        routeId: "route-1",
        sessionId: "0x1111111111111111111111111111111111111111111111111111111111111111",
        hostname: "app.ingress.works",
        processorId: "0x3333333333333333333333333333333333333333333333333333333333333333",
        operatorId: "0x2222222222222222222222222222222222222222222222222222222222222222",
        expiresAt: 200,
        expiresAtIso: "1970-01-01T00:03:20.000Z"
      }
    ]);
  });

  it("updates readiness state while preserving prior ready timestamps on failures", () => {
    const previous: OperatorDiscoveryState = {
      version: 1,
      updatedAt: "2026-04-29T00:00:00.000Z",
      activeIngress: {},
      processors: {
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": {
          processor: "5Existing",
          processorId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          managerId: "9470",
          lastCheckedAt: "2026-04-29T00:00:00.000Z",
          lastStatus: "ready",
          lastReadyAt: "2026-04-29T00:00:00.000Z",
          readyUntil: "2026-04-30T00:00:00.000Z",
          heartbeatIso: "2026-04-29T00:00:00.000Z",
          heartbeatAgeSeconds: 10,
          reasons: ["processor heartbeat is fresh"],
          activeIngress: []
        }
      }
    };

    const next = updateDiscoveryState(previous, {
      version: 1,
      kind: "switchboard.operator.discovery",
      checkedAt: "2026-04-29T12:00:00.000Z",
      network: "mainnet",
      rpcUrl: "wss://example.invalid",
      managerId: "9470",
      gateway: {} as any,
      inventory: {
        chainTimestampIso: "2026-04-29T12:00:00.000Z",
        chainLagSeconds: 0,
        totalProcessors: 1,
        selectedProcessors: 1,
        recentProcessors: 0
      },
      state: {
        enabled: true,
        readyTtlMs: 86_400_000,
        recentCheckTtlMs: 86_400_000,
        loadedProcessorCount: 1
      },
      activeIngress: {
        processorCount: 0,
        sessionCount: 0,
        byProcessor: {}
      },
      summary: {
        ready: 0,
        offline_stale: 1,
        schedule_conflicted: 0,
        route_failed: 0,
        config_blocked: 0,
        cachedReady: 1,
        activeIngressProcessors: 0,
        activeIngressSessions: 0
      },
      processors: [
        {
          processor: "5Existing",
          processorId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          heartbeatIso: null,
          heartbeatAgeSeconds: null,
          version: null,
          status: "offline_stale",
          reasons: ["processor heartbeat is unknown"],
          cachedReady: true,
          lastReadyAt: "2026-04-29T00:00:00.000Z",
          readyUntil: "2026-04-30T00:00:00.000Z",
          activeIngress: []
        }
      ],
      suggestedEnv: {}
    }, { readyTtlMs: 86_400_000 });

    assert.equal(
      next.processors["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"].lastReadyAt,
      "2026-04-29T00:00:00.000Z"
    );
    assert.equal(
      next.processors["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"].lastStatus,
      "offline_stale"
    );
  });

  it("selects the next limited processors while skipping recently checked entries", () => {
    const previous: OperatorDiscoveryState = {
      version: 1,
      updatedAt: "2026-04-29T00:00:00.000Z",
      activeIngress: {},
      processors: {
        "processor-a": {
          processor: "processor-a",
          managerId: "9470",
          lastCheckedAt: "2026-04-29T11:30:00.000Z",
          lastStatus: "ready",
          lastReadyAt: "2026-04-29T11:30:00.000Z",
          readyUntil: "2026-04-30T11:30:00.000Z",
          heartbeatIso: "2026-04-29T11:30:00.000Z",
          heartbeatAgeSeconds: 10,
          reasons: ["processor heartbeat is fresh"],
          activeIngress: []
        }
      }
    };

    assert.deepEqual(
      selectNextProcessorRefs(["processor-a", "processor-b", "processor-c"], previous, {
        now: new Date("2026-04-29T12:00:00.000Z"),
        limit: 1,
        recentCheckTtlMs: 86_400_000
      }),
      ["processor-b"]
    );
  });
});
