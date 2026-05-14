import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyProcessorReadiness, selectReadyProcessors, type ProcessorInfo } from "../src/acurast-manager.js";
import {
  relayUrlPinnedByUser,
  resolveValidatorLaunchExecutionMs,
  resolveValidatorLaunchWorkRuntimeEnv,
  selectWritableControlRelayUrl,
  selectValidatorLaunchProcessorsFromInventory,
  validatorLaunchControlRelayCandidates
} from "../cli/src/index.js";

function processor(overrides: Partial<ProcessorInfo>): ProcessorInfo {
  return {
    processor: "5FakeProcessor",
    heartbeatMs: Date.now(),
    heartbeatIso: new Date().toISOString(),
    heartbeatAgeSeconds: 10,
    version: { platform: "android", buildNumber: 1 },
    ...overrides
  };
}

describe("acurast manager processor readiness", () => {
  it("marks fresh processors without schedule conflicts as ready", () => {
    const result = classifyProcessorReadiness(
      processor({
        availability: {
          proposedStartIso: "2026-04-29T00:00:00.000Z",
          proposedEndIso: "2026-04-29T00:05:00.000Z",
          matches: 0,
          conflicts: 0,
          conflictingJobs: []
        }
      }),
      {
        maxAgeSeconds: 900,
        requireAvailability: true
      }
    );

    assert.equal(result.status, "ready");
    assert.match(result.reasons.join(" "), /heartbeat is fresh/);
  });

  it("excludes stale and schedule-conflicted processors from the ready set", () => {
    const ready = processor({
      processor: "5Ready",
      heartbeatAgeSeconds: 60,
      heartbeatMs: 30
    });
    const stale = processor({
      processor: "5Stale",
      heartbeatAgeSeconds: 2_000,
      heartbeatMs: 10
    });
    const conflicted = processor({
      processor: "5Conflicted",
      heartbeatAgeSeconds: 30,
      heartbeatMs: 20,
      availability: {
        proposedStartIso: "2026-04-29T00:00:00.000Z",
        proposedEndIso: "2026-04-29T00:05:00.000Z",
        matches: 1,
        conflicts: 1,
        conflictingJobs: []
      }
    });

    assert.deepEqual(
      selectReadyProcessors([stale, conflicted, ready], {
        maxAgeSeconds: 900,
        requireAvailability: true
      }).map((item) => item.processor),
      ["5Ready"]
    );
  });

  it("treats explicit includes as a filter over discovered processors", () => {
    const onboarded = processor({
      processor: "5Onboarded",
      heartbeatAgeSeconds: 60,
      heartbeatMs: 30
    });

    assert.deepEqual(
      selectReadyProcessors([onboarded], {
        maxAgeSeconds: 900,
        includeProcessors: ["5Onboarded", "5NotInManager"]
      }).map((item) => item.processor),
      ["5Onboarded"]
    );
  });

  it("selects exact fresh validator launch processor capacity", () => {
    const readyA = processor({
      processor: "5ReadyA",
      heartbeatMs: 100,
      heartbeatAgeSeconds: 60,
      availability: {
        proposedStartIso: "2026-04-29T00:00:00.000Z",
        proposedEndIso: "2026-04-29T00:05:00.000Z",
        matches: 0,
        conflicts: 0,
        conflictingJobs: []
      }
    });
    const readyB = processor({
      processor: "5ReadyB",
      heartbeatMs: 200,
      heartbeatAgeSeconds: 50,
      availability: {
        proposedStartIso: "2026-04-29T00:00:00.000Z",
        proposedEndIso: "2026-04-29T00:05:00.000Z",
        matches: 0,
        conflicts: 0,
        conflictingJobs: []
      }
    });
    const stale = processor({
      processor: "5Stale",
      heartbeatAgeSeconds: 2_000,
      availability: {
        proposedStartIso: "2026-04-29T00:00:00.000Z",
        proposedEndIso: "2026-04-29T00:05:00.000Z",
        matches: 0,
        conflicts: 0,
        conflictingJobs: []
      }
    });

    assert.deepEqual(
      selectValidatorLaunchProcessorsFromInventory([stale, readyA, readyB], { requestedCount: 2 }),
      ["5ReadyB", "5ReadyA"]
    );
    assert.throws(
      () => selectValidatorLaunchProcessorsFromInventory([readyA], { requestedCount: 2 }),
      /Insufficient fresh available validator processor capacity/
    );
    assert.throws(
      () => selectValidatorLaunchProcessorsFromInventory([readyA, processor({ processor: "5NoAvailability" })], { requestedCount: 2 }),
      /Insufficient fresh available validator processor capacity/
    );
  });

  it("derives validator work polling runtime from the launch execution duration", () => {
    assert.equal(
      resolveValidatorLaunchExecutionMs({ durationMinutes: 75, scheduleBufferMinutes: 5 }),
      "4800000"
    );
    assert.equal(
      resolveValidatorLaunchExecutionMs({ executionMs: "1234567", durationMinutes: 75, scheduleBufferMinutes: 5 }),
      "1234567"
    );

    assert.deepEqual(
      resolveValidatorLaunchWorkRuntimeEnv({
        executionMs: "4800000",
        env: {}
      }),
      {
        VALIDATOR_WORK_POLL: "true",
        VALIDATOR_WORK_RUN_MS: "4800000",
        VALIDATOR_WORK_POLL_INTERVAL_MS: "30000",
        VALIDATOR_WORK_LEASE_SECONDS: "120",
        VALIDATOR_WORK_MAX_ITEMS: "1"
      }
    );
  });

  it("keeps explicit validator work polling overrides", () => {
    assert.deepEqual(
      resolveValidatorLaunchWorkRuntimeEnv({
        executionMs: "4800000",
        env: {
          VALIDATOR_WORK_RUN_MS: "600000",
          SWITCHBOARD_DEPLOY_VALIDATOR_WORK_POLL_INTERVAL_MS: "15000",
          SWITCHBOARD_DEPLOY_VALIDATOR_WORK_LEASE_SECONDS: "90",
          SWITCHBOARD_DEPLOY_VALIDATOR_WORK_MAX_ITEMS: "2"
        }
      }),
      {
        VALIDATOR_WORK_POLL: "true",
        VALIDATOR_WORK_RUN_MS: "600000",
        VALIDATOR_WORK_POLL_INTERVAL_MS: "15000",
        VALIDATOR_WORK_LEASE_SECONDS: "90",
        VALIDATOR_WORK_MAX_ITEMS: "2"
      }
    );
  });

  it("selects a healthy writable relay for validator launch", async () => {
    const result = await selectWritableControlRelayUrl(["https://relay-a.example", "https://relay-b.example"], {
      fetchImpl: relayProbeFetch({
        "https://relay-a.example/health": { status: 503, body: { ok: false } },
        "https://relay-b.example/health": { status: 200, body: { ok: true } },
        "https://relay-b.example/v1/control-readiness": {
          status: 200,
          body: { ok: true, authorityEligible: true }
        }
      })
    });

    assert.equal(result.relayUrl, "https://relay-b.example");
    assert.equal(result.probes.length, 2);
    assert.equal(result.probes[0].ok, false);
    assert.equal(result.probes[1].ok, true);
  });

  it("does not select a relay that reports authority ineligible", async () => {
    const result = await selectWritableControlRelayUrl(["https://relay-a.example", "https://relay-b.example"], {
      fetchImpl: relayProbeFetch({
        "https://relay-a.example/health": { status: 200, body: { ok: true } },
        "https://relay-a.example/v1/control-readiness": {
          status: 200,
          body: { ok: false, authorityEligible: false }
        },
        "https://relay-b.example/health": { status: 200, body: { ok: true } },
        "https://relay-b.example/v1/control-readiness": {
          status: 200,
          body: { ok: true, authorityEligible: true }
        }
      })
    });

    assert.equal(result.relayUrl, "https://relay-b.example");
    assert.equal(result.probes[0].authorityEligible, false);
  });

  it("prefers the fastest healthy writable relay", async () => {
    const result = await selectWritableControlRelayUrl(["https://relay-a.example", "https://relay-b.example"], {
      fetchImpl: relayProbeFetch({
        "https://relay-a.example/health": { status: 200, body: { ok: true }, delayMs: 20 },
        "https://relay-a.example/v1/control-readiness": {
          status: 200,
          body: { ok: true, authorityEligible: true },
          delayMs: 20
        },
        "https://relay-b.example/health": { status: 200, body: { ok: true } },
        "https://relay-b.example/v1/control-readiness": {
          status: 200,
          body: { ok: true, authorityEligible: true }
        }
      })
    });

    assert.equal(result.relayUrl, "https://relay-b.example");
    assert.ok((result.probes[0].elapsedMs ?? 0) >= (result.probes[1].elapsedMs ?? 0));
  });

  it("prefers direct manifest relay URLs for validator launch writes", () => {
    const candidates = validatorLaunchControlRelayCandidates(
      "https://control.example",
      {
        controlApiUrls: ["https://control.example"],
        manifest: {
          relays: [
            { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", active: true },
            { relayId: "relay-b", controlPlaneUrl: "https://relay-b-control.example", apiBaseUrl: "https://relay-b.example", active: true },
            { relayId: "relay-c", apiBaseUrl: "https://relay-c.example", active: false }
          ]
        }
      } as any,
      { pinned: false }
    );

    assert.deepEqual(candidates, [
      "https://relay-a.example",
      "https://relay-b-control.example"
    ]);
    assert.deepEqual(
      validatorLaunchControlRelayCandidates("https://control.example", { controlApiUrls: ["https://relay-a.example"] } as any, { pinned: true }),
      ["https://control.example"]
    );
  });

  it("does not treat context-default relay URLs as explicit relay pins", () => {
    assert.equal(relayUrlPinnedByUser(new Map([["relay-url", "https://control.example"]]), []), true);
    assert.equal(
      relayUrlPinnedByUser(new Map<string, string | boolean>([
        ["relay-url", "https://control.example"],
        ["__runtime-default:relay-url", true]
      ]), []),
      false
    );
  });
});

function relayProbeFetch(
  responses: Record<string, { status: number; body: Record<string, unknown>; delayMs?: number }>
): typeof fetch {
  return async (input) => {
    const url = input instanceof URL ? input.toString() : String(input);
    const response = responses[url];
    if (!response) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" }
      });
    }
    if (response.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, response.delayMs));
    }
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" }
    });
  };
}
