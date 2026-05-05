import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { probeRelay, summarizeRelayStatus } from "../cli/src/relay/status.js";

const entry = {
  relayId: "relay-d",
  apiBaseUrl: "https://relay-d.switchboard.proof.computer",
  state: "candidate" as const
};

function fetchStub(map: Record<string, { ok: boolean; status: number; body: unknown }>): typeof fetch {
  return (async (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : ((input as { url?: string }).url ?? String(input));
    const match = map[url];
    if (!match) {
      throw new Error(`Unexpected fetch ${url}`);
    }
    return new Response(typeof match.body === "string" ? match.body : JSON.stringify(match.body), {
      status: match.status
    }) as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("relay status probes", () => {
  it("collects health, relay-status, and service-catalogs/relay outcomes", async () => {
    const fetchImpl = fetchStub({
      "https://relay-d.switchboard.proof.computer/health": { ok: true, status: 200, body: "ok" },
      "https://relay-d.switchboard.proof.computer/v1/relay-status": {
        ok: true,
        status: 200,
        body: { relayId: "relay-d", peerBackfillEnabled: true, recorderCoordinatorEnabled: false }
      },
      "https://relay-d.switchboard.proof.computer/v1/service-catalogs/relay": {
        ok: true,
        status: 200,
        body: {
          catalog: {
            role: "relay",
            members: [
              { serviceId: "relay-a", state: "active" },
              { serviceId: "relay-d", state: "candidate" }
            ]
          }
        }
      }
    });

    const result = await probeRelay(entry, { fetchImpl });
    assert.equal(result.health.ok, true);
    assert.equal(result.relayStatus.ok, true);
    assert.equal(result.relayCatalog.ok, true);
    assert.equal(result.relayStatus.body?.relayId, "relay-d");
    const lines = summarizeRelayStatus(result);
    const out = lines.join("\n");
    assert.match(out, /relay relay-d \(candidate\)/);
    assert.match(out, /health: ok/);
    assert.match(out, /peerBackfillEnabled: true/);
    assert.match(out, /catalog members:.*relay-d=candidate/);
  });

  it("reports failures when a probe returns 5xx", async () => {
    const fetchImpl = fetchStub({
      "https://relay-d.switchboard.proof.computer/health": { ok: false, status: 503, body: "" },
      "https://relay-d.switchboard.proof.computer/v1/relay-status": { ok: false, status: 503, body: "" },
      "https://relay-d.switchboard.proof.computer/v1/service-catalogs/relay": { ok: false, status: 404, body: "" }
    });
    const result = await probeRelay(entry, { fetchImpl });
    assert.equal(result.health.ok, false);
    assert.equal(result.relayStatus.ok, false);
    assert.equal(result.relayCatalog.ok, false);
    const lines = summarizeRelayStatus(result);
    const out = lines.join("\n");
    assert.match(out, /health: FAIL/);
    assert.match(out, /service-catalogs\/relay: FAIL/);
  });

  it("handles fetch exceptions as failed probes", async () => {
    const fetchImpl: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await probeRelay(entry, { fetchImpl });
    assert.equal(result.health.ok, false);
    assert.match(result.health.error ?? "", /ECONNREFUSED/);
  });
});
