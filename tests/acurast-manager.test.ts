import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyProcessorReadiness, selectReadyProcessors, type ProcessorInfo } from "../src/acurast-manager.js";

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
});
