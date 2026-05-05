import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { orderedSettlementRelayIds, selectSettlementLeader } from "../src/relay-leadership.js";

const relays = [
  { relayId: "relay-a" },
  { relayId: "relay-b" },
  { relayId: "relay-c" },
  { relayId: "relay-disabled", active: false }
];

describe("relay settlement leadership", () => {
  it("orders active relays deterministically for a settlement window", () => {
    const first = orderedSettlementRelayIds({
      registryAddress: "0x1000000000000000000000000000000000000001",
      windowStart: 1000,
      windowEnd: 1300,
      shard: "0",
      relays
    });
    const second = orderedSettlementRelayIds({
      registryAddress: "0x1000000000000000000000000000000000000001",
      windowStart: "1000",
      windowEnd: "1300",
      shard: "0",
      relays: [...relays].reverse()
    });

    assert.deepEqual(first, second);
    assert.equal(first.includes("relay-disabled"), false);
    assert.equal(new Set(first).size, 3);
  });

  it("fails over to the next relay after each grace interval", () => {
    const base = {
      registryAddress: "0x1000000000000000000000000000000000000001",
      windowStart: 1000,
      windowEnd: 1300,
      shard: "0",
      relays,
      failoverGraceSeconds: 60
    };
    const ordered = orderedSettlementRelayIds(base);

    assert.equal(selectSettlementLeader({ ...base, nowUnixSeconds: 1300 })?.leaderId, ordered[0]);
    assert.equal(selectSettlementLeader({ ...base, nowUnixSeconds: 1359 })?.leaderId, ordered[0]);
    assert.equal(selectSettlementLeader({ ...base, nowUnixSeconds: 1360 })?.leaderId, ordered[1]);
    assert.equal(selectSettlementLeader({ ...base, nowUnixSeconds: 1420 })?.leaderId, ordered[2]);
    assert.equal(selectSettlementLeader({ ...base, nowUnixSeconds: 9999 })?.leaderId, ordered[2]);
  });

  it("selects from the active filtered relay set", () => {
    const base = {
      registryAddress: "0x1000000000000000000000000000000000000001",
      windowStart: 2000,
      windowEnd: 2300,
      shard: "0",
      relays,
      failoverGraceSeconds: 60,
      nowUnixSeconds: 2300
    };
    const primary = selectSettlementLeader(base);
    assert(primary);
    const filtered = selectSettlementLeader({
      ...base,
      relays: relays.map((relay) => relay.relayId === primary.leaderId ? { ...relay, active: false } : relay)
    });

    assert(filtered);
    assert.notEqual(filtered.leaderId, primary.leaderId);
    assert.equal(filtered.orderedRelayIds.includes(primary.leaderId), false);
  });
});
