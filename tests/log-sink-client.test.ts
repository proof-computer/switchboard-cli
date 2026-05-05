import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createLogSink } from "../src/log-sink-client.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("createLogSink", () => {
  it("POSTs /v1/log-sinks with a Bearer token and returns a fresh AES-256-GCM key", async () => {
    let recordedRequest: { url: string; auth: string | null } | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      recordedRequest = {
        url: input.toString(),
        auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null
      };
      return jsonResponse({
        sinkId: "sink-abc",
        writeUrl: "https://relay-a.switchboard.proof.computer/v1/log-sinks/sink-abc/events",
        readUrl: "https://relay-a.switchboard.proof.computer/v1/log-sinks/sink-abc/events?direction=read",
        writeToken: "wtoken",
        readToken: "rtoken"
      });
    }) as typeof fetch;

    const sink = await createLogSink({
      relayUrl: "https://relay-a.switchboard.proof.computer",
      createToken: "ctoken",
      fetchImpl,
      randomBytes: (size) => Buffer.alloc(size, 0xab)
    });

    assert.equal(recordedRequest?.url, "https://relay-a.switchboard.proof.computer/v1/log-sinks");
    assert.equal(recordedRequest?.auth, "Bearer ctoken");
    assert.equal(sink.sinkId, "sink-abc");
    assert.equal(sink.writeUrl, "https://relay-a.switchboard.proof.computer/v1/log-sinks/sink-abc/events");
    assert.equal(sink.writeToken, "wtoken");
    assert.equal(sink.readToken, "rtoken");
    // 32-byte base64url — matches the SDK's `generateProofLogEncryptionKey`
    // and what `decodeProofLogKey` accepts. Buffer.alloc(32, 0xab) → base64url.
    assert.equal(sink.encryptionKey, Buffer.alloc(32, 0xab).toString("base64url"));
  });

  it("rejects when the response is missing required fields", async () => {
    const fetchImpl = (async () => jsonResponse({ sinkId: "x" })) as typeof fetch;
    await assert.rejects(
      createLogSink({ relayUrl: "https://relay-a.switchboard.proof.computer", createToken: "t", fetchImpl }),
      /missing fields/
    );
  });

  it("rejects on non-2xx with the body excerpt in the error", async () => {
    const fetchImpl = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    await assert.rejects(
      createLogSink({ relayUrl: "https://relay-a.switchboard.proof.computer", createToken: "bad", fetchImpl }),
      /\(403\): forbidden/
    );
  });

  it("rejects when the response is not JSON", async () => {
    const fetchImpl = (async () => new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;
    await assert.rejects(
      createLogSink({ relayUrl: "https://relay-a.switchboard.proof.computer", createToken: "t", fetchImpl }),
      /Log-sink response was not JSON/
    );
  });
});
