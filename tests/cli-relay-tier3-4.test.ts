import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runRelayDrain } from "../cli/src/relay/drain.js";
import { runRelayRotateKey } from "../cli/src/relay/rotate-key.js";
import { runRelayDeployments, recordRelayDeployment } from "../cli/src/relay/history.js";
import { runRelayLogs } from "../cli/src/relay/logs.js";
import { runRelayPromote } from "../cli/src/relay/promote.js";
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

describe("relay drain", () => {
  it("transitions draining → grace → disabled when --no-rebuild is set", async () => {
    const cwd = await setupCwdWithCatalog();
    try {
      const { io } = makeIo();
      const sleeps: number[] = [];
      await runRelayDrain({
        flags: new Map<string, string | boolean>([
          ["grace-ms", "100"],
          ["no-rebuild", true]
        ]),
        positionals: ["relay", "drain", "relay-d"],
        io,
        cwd,
        sleep: async (ms) => { sleeps.push(ms); }
      });
      assert.deepEqual(sleeps, [100]);
      const final = JSON.parse(await readFile(path.join(cwd, "relays", "catalog.json"), "utf8"));
      const entry = final.find((e: { relayId: string }) => e.relayId === "relay-d");
      assert.equal(entry.state, "disabled");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("relay rotate-key", () => {
  it("generates a new key and updates the spec env name", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-relay-rotate-"));
    try {
      await mkdir(path.join(cwd, "relays"), { recursive: true });
      await writeFile(
        path.join(cwd, "relays", "relay-d.json"),
        JSON.stringify({
          version: 1,
          relayId: "relay-d",
          target: "acurast",
          catalogState: "active",
          apiBaseUrl: "https://relay-d.example",
          peers: [],
          secrets: { relayerPrivateKeyEnv: "PROOF_RELAY_D_RELAYER_PRIVATE_KEY" },
          acurast: { deployerSeedEnv: "X", projectName: "p", stageDir: "s", maxCostPerExecution: 1, includeEnv: [] }
        }),
        "utf8"
      );
      const { io, captured } = makeIo();
      const result = await runRelayRotateKey({
        flags: new Map<string, string | boolean>(),
        positionals: ["relay", "rotate-key", "relay-d"],
        io,
        cwd
      });
      assert.equal(result.oldEnvName, "PROOF_RELAY_D_RELAYER_PRIVATE_KEY");
      assert.equal(result.newEnvName, "PROOF_RELAY_D_RELAYER_PRIVATE_KEY_V2");
      assert.match(result.newPrivateKey, /^0x[0-9a-fA-F]{64}$/);
      const updated = JSON.parse(await readFile(path.join(cwd, "relays", "relay-d.json"), "utf8"));
      assert.equal(updated.secrets.relayerPrivateKeyEnv, "PROOF_RELAY_D_RELAYER_PRIVATE_KEY_V2");
      assert.ok(captured.error.some((line) => line.includes("PROOF_RELAY_D_RELAYER_PRIVATE_KEY_V2")));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("relay deployments history", () => {
  it("records and reads deployment history", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-relay-history-"));
    try {
      await recordRelayDeployment({
        timestamp: "2026-05-02T12:00:00.000Z",
        relayId: "relay-d",
        target: "acurast",
        apiBaseUrl: "https://relay-d.example",
        catalogState: "candidate",
        outcome: "success",
        durationMs: 12345
      }, cwd);

      const { io } = makeIo();
      const history = await runRelayDeployments({
        flags: new Map<string, string | boolean>(),
        positionals: ["relay", "deployments", "relay-d"],
        io,
        cwd
      });
      assert.equal(history.entries.length, 1);
      assert.equal(history.entries[0].outcome, "success");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

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

describe("relay promote", () => {
  it("promotes candidate → active when probes are green", async () => {
    const cwd = await setupCwdWithCatalog();
    try {
      const { io } = makeIo();
      const result = await runRelayPromote({
        flags: new Map<string, string | boolean>([["no-rebuild", true]]),
        positionals: ["relay", "promote", "relay-d"],
        io,
        cwd,
        fetchImpl: (async () => jsonResponse({})) as typeof fetch
      });
      assert.equal(result.fromState, "candidate");
      assert.equal(result.toState, "active");
      assert.ok(result.gatesPassed.includes("status-green"));
      assert.ok(result.gatesPassed.includes("stage-state"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to promote a relay that's already active without --force", async () => {
    const cwd = await setupCwdWithCatalog();
    try {
      const { io } = makeIo();
      await assert.rejects(
        runRelayPromote({
          flags: new Map<string, string | boolean>([["no-rebuild", true]]),
          positionals: ["relay", "promote", "relay-a"],
          io,
          cwd,
          fetchImpl: (async () => jsonResponse({})) as typeof fetch
        }),
        /current state is active/
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
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
