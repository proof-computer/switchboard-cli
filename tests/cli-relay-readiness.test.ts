import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkPeerReachability, pollRelayReadiness } from "../cli/src/relay/readiness.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function notReady(status = 503): Response {
  return new Response("not ready", { status });
}

const NULL_IO = { log: () => {}, warn: () => {}, error: () => {} };

describe("pollRelayReadiness", () => {
  it("resolves on first attempt when all three probes return 200", async () => {
    const fetched: string[] = [];
    const result = await pollRelayReadiness({
      apiBaseUrl: "https://relay-d.example",
      relayId: "relay-d",
      pollIntervalMs: 1000,
      pollTimeoutMs: 60_000,
      fetchImpl: async (input) => {
        fetched.push(input.toString());
        return jsonResponse({});
      },
      io: NULL_IO,
      sleep: async () => undefined,
      now: () => 0
    });
    assert.equal(result.attempts, 1);
    assert.ok(fetched.some((url) => url === "https://relay-d.example/health"));
    assert.ok(fetched.some((url) => url === "https://relay-d.example/v1/relay-status"));
    assert.ok(fetched.some((url) => url === "https://relay-d.example/v1/service-catalogs/relay"));
  });

  it("retries until all probes are ready", async () => {
    let calls = 0;
    const result = await pollRelayReadiness({
      apiBaseUrl: "https://relay-d.example",
      relayId: "relay-d",
      pollIntervalMs: 100,
      pollTimeoutMs: 60_000,
      fetchImpl: async () => {
        calls += 1;
        if (calls <= 3) return notReady();
        return jsonResponse({});
      },
      io: NULL_IO,
      sleep: async () => undefined,
      now: () => 0
    });
    assert.equal(result.attempts, 2);
  });

  it("waits until startAtMs + grace before the first probe", async () => {
    let nowValue = 1_000;
    let probeAttempts = 0;
    const sleeps: number[] = [];
    const result = await pollRelayReadiness({
      apiBaseUrl: "https://relay-d.example",
      relayId: "relay-d",
      pollIntervalMs: 100,
      pollTimeoutMs: 60_000,
      startAtMs: 11_000, // 10s in the future from `nowValue`
      startAtGraceMs: 5_000, // +5s grace
      fetchImpl: async () => {
        probeAttempts += 1;
        return jsonResponse({});
      },
      io: NULL_IO,
      sleep: async (ms) => {
        sleeps.push(ms);
        // Advance the simulated clock past the sleep so the next now() reflects elapsed time.
        nowValue += ms;
      },
      now: () => nowValue
    });
    // First sleep should be the wait-for-startAt: target=16_000 - now=1_000 = 15_000ms.
    assert.equal(sleeps[0], 15_000);
    assert.equal(result.attempts, 1);
    // probeRelay issues three fetches per attempt (health, relay-status, service-catalogs/relay).
    assert.equal(probeAttempts, 3);
  });

  it("startAtMs grace defaults to 30s when not specified", async () => {
    let nowValue = 0;
    const sleeps: number[] = [];
    await pollRelayReadiness({
      apiBaseUrl: "https://relay-d.example",
      relayId: "relay-d",
      pollIntervalMs: 100,
      pollTimeoutMs: 60_000,
      startAtMs: 60_000,
      fetchImpl: async () => jsonResponse({}),
      io: NULL_IO,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowValue += ms;
      },
      now: () => nowValue
    });
    assert.equal(sleeps[0], 90_000);
  });

  it("does not wait when startAtMs is already in the past", async () => {
    const sleeps: number[] = [];
    await pollRelayReadiness({
      apiBaseUrl: "https://relay-d.example",
      relayId: "relay-d",
      pollIntervalMs: 100,
      pollTimeoutMs: 60_000,
      startAtMs: 0,
      startAtGraceMs: 30_000,
      fetchImpl: async () => jsonResponse({}),
      io: NULL_IO,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1_000_000 // far in the future
    });
    // No initial wait sleep — first probe runs immediately.
    assert.equal(sleeps.length, 0);
  });

  it("calls collectSupplementarySignal on each failing attempt and includes it in the timeout error", async () => {
    let nowValue = 0;
    const signalCalls: number[] = [];
    await assert.rejects(
      pollRelayReadiness({
        apiBaseUrl: "https://relay-d.example",
        relayId: "relay-d",
        pollIntervalMs: 100,
        pollTimeoutMs: 250,
        fetchImpl: async () => notReady(),
        io: NULL_IO,
        sleep: async () => undefined,
        now: () => {
          nowValue += 100;
          return nowValue;
        },
        collectSupplementarySignal: async () => {
          signalCalls.push(nowValue);
          return "processor: assigned but not yet acknowledged (assignments=1)";
        }
      }),
      (error: Error) => /processor: assigned but not yet acknowledged/.test(error.message)
    );
    assert.ok(signalCalls.length >= 1);
  });

  it("supplementary signal probe failure does not abort polling", async () => {
    let nowValue = 0;
    const warnings: string[] = [];
    const io = { log: () => {}, warn: (line: string) => warnings.push(line), error: () => {} };
    let probeAttempts = 0;
    await pollRelayReadiness({
      apiBaseUrl: "https://relay-d.example",
      relayId: "relay-d",
      pollIntervalMs: 100,
      pollTimeoutMs: 60_000,
      fetchImpl: async () => {
        probeAttempts += 1;
        if (probeAttempts < 3) return notReady();
        return jsonResponse({});
      },
      io,
      sleep: async () => undefined,
      now: () => {
        nowValue += 100;
        return nowValue;
      },
      collectSupplementarySignal: async () => {
        throw new Error("boom");
      }
    });
    assert.ok(warnings.some((line) => line.includes("supplementary signal probe failed")));
    assert.ok(warnings.some((line) => line.includes("boom")));
  });

  it("rejects on timeout with a clear message about which endpoints failed", async () => {
    let nowValue = 0;
    await assert.rejects(
      pollRelayReadiness({
        apiBaseUrl: "https://relay-d.example",
        relayId: "relay-d",
        pollIntervalMs: 100,
        pollTimeoutMs: 250,
        fetchImpl: async (input) => {
          if (input.toString().endsWith("/health")) return jsonResponse({});
          return notReady();
        },
        io: NULL_IO,
        sleep: async () => undefined,
        now: () => {
          nowValue += 100;
          return nowValue;
        }
      }),
      /did not become ready/
    );
  });
});

describe("checkPeerReachability", () => {
  it("returns reachable peers and tolerates failures when not required", async () => {
    const result = await checkPeerReachability({
      peers: [
        { relayId: "relay-a", apiBaseUrl: "https://relay-a.example" },
        { relayId: "relay-b", apiBaseUrl: "https://relay-b.example" }
      ],
      required: false,
      pollIntervalMs: 1000,
      pollTimeoutMs: 5000,
      fetchImpl: async (input) => {
        if (input.toString().includes("relay-b")) return notReady();
        return jsonResponse({});
      },
      io: NULL_IO
    });
    assert.deepEqual(result.reachable, ["relay-a"]);
    assert.equal(result.unreachable.length, 1);
    assert.equal(result.unreachable[0].relayId, "relay-b");
  });

  it("throws when a peer is unreachable and required=true", async () => {
    await assert.rejects(
      checkPeerReachability({
        peers: [{ relayId: "relay-a", apiBaseUrl: "https://relay-a.example" }],
        required: true,
        pollIntervalMs: 1000,
        pollTimeoutMs: 5000,
        fetchImpl: async () => notReady(500),
        io: NULL_IO
      }),
      /requirePeerBackfillReachable=true/
    );
  });

  it("returns empty unreachable when all peers respond 200", async () => {
    const result = await checkPeerReachability({
      peers: [
        { relayId: "relay-a", apiBaseUrl: "https://relay-a.example" },
        { relayId: "relay-b", apiBaseUrl: "https://relay-b.example" }
      ],
      required: true,
      pollIntervalMs: 1000,
      pollTimeoutMs: 5000,
      fetchImpl: async () => jsonResponse({}),
      io: NULL_IO
    });
    assert.deepEqual(result.reachable, ["relay-a", "relay-b"]);
    assert.equal(result.unreachable.length, 0);
  });
});
