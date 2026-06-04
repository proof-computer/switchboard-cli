import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runRelayLogs } from "../cli/src/relay/logs.js";
import { runRelayWatch } from "../cli/src/relay/watch.js";
import { runRelayVerify } from "../cli/src/relay/verify.js";
import { signNetworkManifest, type NetworkManifest } from "../src/network-manifest.js";
import { signServiceCatalog, type ServiceCatalog } from "../src/service-catalog.js";

interface Captured {
  log: string[];
  warn: string[];
  error: string[];
}

function makeIo(): { io: { log: (l: string) => void; warn: (l: string) => void; error: (l: string) => void }; captured: Captured } {
  const captured: Captured = { log: [], warn: [], error: [] };
  return {
    io: {
      log: (line) => { captured.log.push(line); },
      warn: (line) => { captured.warn.push(line); },
      error: (line) => { captured.error.push(line); }
    },
    captured
  };
}

async function setupCwdWithCatalog(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-relay-tier3-"));
  await mkdir(path.join(cwd, "relays"), { recursive: true });
  await writeFile(
    path.join(cwd, "relays", "catalog.json"),
    JSON.stringify([
      { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "active" },
      { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "candidate" }
    ]),
    "utf8"
  );
  return cwd;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("relay logs", () => {
  it("decrypts and prints log events via the injected reader", async () => {
    const { io, captured } = makeIo();
    await runRelayLogs({
      flags: new Map<string, string | boolean>([
        ["read-url", "https://control.example/v1/log-sinks/abc/events"]
      ]),
      env: { SWITCHBOARD_LOG_ENCRYPTION_KEY: "test" },
      io,
      reader: async () => [
        { sequence: 1, receivedAt: "2026-05-02T12:00:00.000Z", message: "boot" } as never,
        { sequence: 2, receivedAt: "2026-05-02T12:00:01.000Z", message: "ready" } as never
      ]
    });
    const out = captured.log.join("\n");
    assert.match(out, /#1.*boot/);
    assert.match(out, /#2.*ready/);
  });

  it("prints structured event names and nested error messages in text mode", async () => {
    const { io, captured } = makeIo();
    await runRelayLogs({
      flags: new Map<string, string | boolean>([
        ["read-url", "https://control.example/v1/log-sinks/abc/events"]
      ]),
      env: { SWITCHBOARD_LOG_ENCRYPTION_KEY: "test" },
      io,
      reader: async () => [
        {
          sequence: 1,
          receivedAt: "2026-05-15T12:00:00.000Z",
          event: "relay-infra-admission-failed",
          details: {
            error: { message: "Relay infra admission requires Acurast schedule.startTime from RPC" }
          }
        } as never
      ]
    });
    const out = captured.log.join("\n");
    assert.match(out, /relay-infra-admission-failed/);
    assert.match(out, /requires Acurast schedule\.startTime from RPC/);
  });

  it("requires --read-url", async () => {
    await assert.rejects(
      runRelayLogs({
        flags: new Map<string, string | boolean>(),
        env: {}
      }),
      /read-url/
    );
  });
});

describe("relay watch", () => {
  it("emits a single transition event on first probe and exits at max-runs", async () => {
    const cwd = await setupCwdWithCatalog();
    try {
      const { io, captured } = makeIo();
      await runRelayWatch({
        flags: new Map<string, string | boolean>([["max-runs", "1"]]),
        positionals: ["relay", "watch"],
        io,
        cwd,
        fetchImpl: (async () => jsonResponse({})) as typeof fetch,
        sleep: async () => undefined,
        now: () => 0
      });
      const transitions = captured.log.filter((line) => line.includes("initial=ok") || line.includes("initial=fail"));
      assert.equal(transitions.length, 2); // relay-a and relay-d
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("relay verify", () => {
  it("flags a missing relay in the live catalog", async () => {
    const cwd = await setupCwdWithCatalog();
    try {
      const { io } = makeIo();
      // live catalog will be the standard 3 (a/b/c); relay-d is local-only.
      const relayCat = await signServiceCatalog(
        {
          version: 1,
          role: "relay",
          sequence: 1,
          issuedAt: "2026-05-02T12:00:00.000Z",
          expiresAt: "2030-05-02T12:00:00.000Z",
          members: [{ serviceId: "relay-a", state: "active", apiBaseUrl: "https://relay-a.example" }]
        } as ServiceCatalog,
        "//Alice//switchboard-service-catalog",
        { scheme: "substrate-sr25519", ss58Format: 42 }
      );
      const manifest: NetworkManifest = {
        version: 1,
        sequence: 1,
        issuedAt: "2026-05-02T12:00:00.000Z",
        expiresAt: "2030-05-02T12:00:00.000Z",
        chain: { name: "test", chainId: "31337" },
        registries: { active: [{ status: "active", address: "0x1000000000000000000000000000000000000001" }], deprecated: [], retired: [] },
        catalogs: { relays: { url: "https://control.example/v1/service-catalogs/relay", signer: relayCat.signature.signer, required: true } },
        relays: []
      };
      const signedManifest = await signNetworkManifest(manifest, "//Alice//switchboard-network-manifest", { scheme: "substrate-sr25519", ss58Format: 42 });
      const fetchImpl = (async (input: Request | URL | string) => {
        const url = input.toString();
        if (url.endsWith("/v1/network-manifest")) return jsonResponse(signedManifest);
        if (url.endsWith("/v1/service-catalogs/relay")) return jsonResponse(relayCat);
        return jsonResponse({});
      }) as typeof fetch;
      const result = await runRelayVerify({
        flags: new Map<string, string | boolean>([
          ["manifest-url", "https://control.example/v1/network-manifest"],
          ["manifest-signer", signedManifest.signature.signer]
        ]),
        positionals: ["relay", "verify", "relay-d"],
        io,
        cwd,
        fetchImpl
      });
      const live = result.checks.find((c) => c.name === "live-catalog-publish");
      assert.equal(live?.ok, false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
