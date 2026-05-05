import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyRelayLifecycle, selectEarliestRelayScheduleEnd } from "../src/relay-lifecycle.js";

describe("relay lifecycle authority runway", () => {
  it("classifies the 10 minute authority runway states", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    assert.equal(classifyRelayLifecycle({ scheduleEndMs: now + 20 * 60_000 }, now).state, "authority_eligible");
    assert.equal(classifyRelayLifecycle({ scheduleEndMs: now + 5 * 60_000 }, now).state, "draining");
    assert.equal(classifyRelayLifecycle({ scheduleEndMs: now }, now).state, "expired");
    assert.equal(classifyRelayLifecycle({ scheduleEndSource: "unknown" }, now).authorityEligible, false);
    assert.equal(classifyRelayLifecycle(undefined, now).authorityEligible, true);
  });

  it("chooses the earlier deployment hint or RPC schedule end", () => {
    assert.deepEqual(
      selectEarliestRelayScheduleEnd([
        { scheduleEndMs: 2_000, source: "SWITCHBOARD_ACURAST_SCHEDULE_END_MS" },
        { scheduleEndMs: 1_000, source: "acurast-rpc" }
      ]),
      {
        scheduleEndMs: 1_000,
        scheduleEndSource: "acurast-rpc"
      }
    );
  });
});
