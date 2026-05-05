import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { runRelaySync } from "../cli/src/relay/sync.js";
import { runRelayList } from "../cli/src/relay/list.js";
import { runRelayDiff } from "../cli/src/relay/diff.js";
import { runRelayBackfillSpecs } from "../cli/src/relay/backfill-specs.js";
import { runRelayKeygen } from "../cli/src/relay/keygen.js";
import { runRelayScaffold } from "../cli/src/relay/scaffold.js";
import { signNetworkManifest, type NetworkManifest } from "../src/network-manifest.js";
import { signServiceCatalog, type ServiceCatalog } from "../src/service-catalog.js";

const MANIFEST_SIGNER_SEED = "//Alice//switchboard-network-manifest";
const CATALOG_SIGNER_SEED = "//Alice//switchboard-service-catalog";

interface Captured {
  log: string[];
  warn: string[];
  error: string[];
}

function makeIo(): { io: { log: (l: string) => void; warn: (l: string) => void; error: (l: string) => void }; captured: Captured } {
  const captured: Captured = { log: [], warn: [], error: [] };
  return {
    io: {
      log: (line) => {
        captured.log.push(line);
      },
      warn: (line) => {
        captured.warn.push(line);
      },
      error: (line) => {
        captured.error.push(line);
      }
    },
    captured
  };
}

function relayCatalog(): ServiceCatalog {
  return {
    version: 1,
    role: "relay",
    sequence: 5,
    issuedAt: "2026-05-02T12:00:00.000Z",
    expiresAt: "2030-05-02T12:00:00.000Z",
    members: [
      { serviceId: "relay-a", state: "active", apiBaseUrl: "https://relay-a.switchboard.proof.computer" },
      { serviceId: "relay-b", state: "active", apiBaseUrl: "https://relay-b.switchboard.proof.computer" },
      { serviceId: "relay-c", state: "active", apiBaseUrl: "https://relay-c.switchboard.proof.computer" },
      { serviceId: "relay-d", state: "candidate", apiBaseUrl: "https://relay-d.switchboard.proof.computer" }
    ]
  };
}

async function buildLiveFetch(): Promise<typeof fetch> {
  const relayCat = await signServiceCatalog(relayCatalog(), CATALOG_SIGNER_SEED, {
    scheme: "substrate-sr25519",
    ss58Format: 42
  });
  const manifest: NetworkManifest = {
    version: 1,
    sequence: 1,
    issuedAt: "2026-05-02T12:00:00.000Z",
    expiresAt: "2030-05-02T12:00:00.000Z",
    chain: { name: "test", chainId: "31337" },
    registries: { active: [{ status: "active", address: "0x1000000000000000000000000000000000000001" }], deprecated: [], retired: [] },
    catalogs: {
      relays: {
        url: "https://control.example/v1/service-catalogs/relay",
        signer: relayCat.signature.signer,
        required: true
      }
    },
    relays: []
  };
  const signedManifest = await signNetworkManifest(manifest, MANIFEST_SIGNER_SEED, {
    scheme: "substrate-sr25519",
    ss58Format: 42
  });
  return (async (input: Request | URL | string) => {
    const url = input.toString();
    if (url.endsWith("/v1/network-manifest")) {
      return new Response(JSON.stringify(signedManifest), { status: 200 });
    }
    if (url.endsWith("/v1/service-catalogs/relay")) {
      return new Response(JSON.stringify(relayCat), { status: 200 });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
}

async function liveSigner(): Promise<{ manifestSigner: string }> {
  const m = await signNetworkManifest(
    {
      version: 1,
      sequence: 1,
      issuedAt: "2026-05-02T12:00:00.000Z",
      expiresAt: "2030-05-02T12:00:00.000Z",
      chain: { name: "test", chainId: "31337" },
      registries: { active: [], deprecated: [], retired: [] },
      relays: []
    },
    MANIFEST_SIGNER_SEED,
    { scheme: "substrate-sr25519", ss58Format: 42 }
  );
  return { manifestSigner: m.signature.signer };
}

describe("relay sync", () => {
  let cwd: string;
  before(async () => { cwd = await mkdtemp(path.join(tmpdir(), "switchboard-relay-sync-")); });
  after(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("writes relays/catalog.json and stub specs for new relays", async () => {
    const fetchImpl = await buildLiveFetch();
    const { manifestSigner } = await liveSigner();
    const { io } = makeIo();

    const result = await runRelaySync({
      flags: new Map<string, string | boolean>([
        ["manifest-url", "https://control.example/v1/network-manifest"],
        ["manifest-signer", manifestSigner]
      ]),
      io,
      fetchImpl,
      cwd
    });

    assert.equal(result.members.length, 4);
    assert.equal(result.newSpecs.length, 4);
    const catalogContent = JSON.parse(await readFile(path.join(cwd, "relays", "catalog.json"), "utf8"));
    assert.equal(catalogContent.length, 4);
    assert.deepEqual(catalogContent.map((e: { relayId: string }) => e.relayId).sort(), ["relay-a", "relay-b", "relay-c", "relay-d"]);
    assert.equal(catalogContent.find((e: { relayId: string }) => e.relayId === "relay-d").state, "candidate");

    const stubA = JSON.parse(await readFile(path.join(cwd, "relays", "relay-a.json"), "utf8"));
    assert.equal(stubA.relayId, "relay-a");
    assert.ok(typeof stubA._stub === "string");
  });

  it("preserves existing spec files on re-sync", async () => {
    const customSpec = { version: 1, relayId: "relay-a", target: "bootstrap", catalogState: "active", apiBaseUrl: "https://relay-a.switchboard.proof.computer", peers: [], secrets: { relayerPrivateKeyEnv: "FOO" }, bootstrap: { composeService: "relay-a" }, _custom: "edited" };
    await mkdir(path.join(cwd, "relays"), { recursive: true });
    await writeFile(path.join(cwd, "relays", "relay-a.json"), JSON.stringify(customSpec), "utf8");
    const fetchImpl = await buildLiveFetch();
    const { manifestSigner } = await liveSigner();
    const { io } = makeIo();

    const result = await runRelaySync({
      flags: new Map<string, string | boolean>([
        ["manifest-url", "https://control.example/v1/network-manifest"],
        ["manifest-signer", manifestSigner]
      ]),
      io,
      fetchImpl,
      cwd
    });

    assert.ok(result.existingSpecs.some((p) => p.endsWith("relay-a.json")));
    const after = JSON.parse(await readFile(path.join(cwd, "relays", "relay-a.json"), "utf8"));
    assert.equal(after._custom, "edited", "must not overwrite local spec edits");
  });
});

describe("relay list", () => {
  it("returns local entries from relays/catalog.json plus spec target", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-relay-list-"));
    try {
      await mkdir(path.join(cwd, "relays"), { recursive: true });
      await writeFile(
        path.join(cwd, "relays", "catalog.json"),
        JSON.stringify([{ relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "active" }]),
        "utf8"
      );
      await writeFile(
        path.join(cwd, "relays", "relay-a.json"),
        JSON.stringify({ relayId: "relay-a", target: "bootstrap", apiBaseUrl: "https://relay-a.example", catalogState: "active" }),
        "utf8"
      );
      const { io } = makeIo();
      const entries = await runRelayList({
        flags: new Map<string, string | boolean>([["source", "local"]]),
        io,
        cwd
      });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].relayId, "relay-a");
      assert.equal(entries[0].target, "bootstrap");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("relay diff", () => {
  it("flags an add and a state change between local and live", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-relay-diff-"));
    try {
      await mkdir(path.join(cwd, "relays"), { recursive: true });
      await writeFile(
        path.join(cwd, "relays", "catalog.json"),
        JSON.stringify([
          { relayId: "relay-a", apiBaseUrl: "https://relay-a.switchboard.proof.computer", state: "draining" },
          { relayId: "relay-b", apiBaseUrl: "https://relay-b.switchboard.proof.computer", state: "active" },
          { relayId: "relay-c", apiBaseUrl: "https://relay-c.switchboard.proof.computer", state: "active" },
          { relayId: "relay-d", apiBaseUrl: "https://relay-d.switchboard.proof.computer", state: "candidate" },
          { relayId: "relay-e", apiBaseUrl: "https://relay-e.switchboard.proof.computer", state: "candidate" }
        ]),
        "utf8"
      );
      const fetchImpl = await buildLiveFetch();
      const { manifestSigner } = await liveSigner();
      const { io } = makeIo();
      const result = await runRelayDiff({
        flags: new Map<string, string | boolean>([
          ["manifest-url", "https://control.example/v1/network-manifest"],
          ["manifest-signer", manifestSigner]
        ]),
        io,
        fetchImpl,
        cwd
      });
      const byId: Record<string, string> = {};
      for (const e of result.entries) byId[e.relayId] = e.change;
      assert.equal(byId["relay-d"], "unchanged");
      assert.equal(byId["relay-e"], "add");
      assert.equal(byId["relay-a"], "state-change");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("relay backfill-specs", () => {
  it("authors complete bootstrap specs for live members lacking specs", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-relay-backfill-"));
    try {
      const fetchImpl = await buildLiveFetch();
      const { manifestSigner } = await liveSigner();
      const { io } = makeIo();
      const result = await runRelayBackfillSpecs({
        flags: new Map<string, string | boolean>([
          ["manifest-url", "https://control.example/v1/network-manifest"],
          ["manifest-signer", manifestSigner],
          ["target", "bootstrap"]
        ]),
        io,
        fetchImpl,
        cwd
      });
      assert.equal(result.written.length, 4);
      const specA = JSON.parse(await readFile(path.join(cwd, "relays", "relay-a.json"), "utf8"));
      assert.equal(specA.target, "bootstrap");
      assert.equal(specA.bootstrap.composeService, "relay-a");
      assert.equal(specA.secrets.relayerPrivateKeyEnv, "PROOF_MAINNET_RELAY_A_RECORDER_PRIVATE_KEY");
      const specD = JSON.parse(await readFile(path.join(cwd, "relays", "relay-d.json"), "utf8"));
      assert.equal(specD.catalogState, "candidate");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("relay keygen", () => {
  it("generates a fresh secp256k1 keypair and prints a fish-set line to stderr", async () => {
    const { io, captured } = makeIo();
    const result = await runRelayKeygen({
      flags: new Map<string, string | boolean>(),
      positionals: ["relay", "keygen", "relay-q"],
      io
    });
    assert.match(result.address, /^0x[0-9a-fA-F]{40}$/);
    assert.match(result.privateKey, /^0x[0-9a-fA-F]{64}$/);
    assert.equal(result.envName, "PROOF_MAINNET_RELAY_Q_RECORDER_PRIVATE_KEY");
    assert.ok(captured.error.some((line) => line.startsWith("set -gx PROOF_MAINNET_RELAY_Q_RECORDER_PRIVATE_KEY ")));
  });

  it("rejects bad relay ids", async () => {
    await assert.rejects(
      runRelayKeygen({
        flags: new Map<string, string | boolean>(),
        positionals: ["relay", "keygen", "BadID!"]
      }),
      /must match/
    );
  });
});

describe("relay scaffold", () => {
  it("writes a valid acurast spec when --keygen is set", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-relay-scaffold-"));
    try {
      const { io } = makeIo();
      const result = await runRelayScaffold({
        flags: new Map<string, string | boolean>([
          ["target", "acurast"],
          ["api-base-url", "https://relay-q.example"],
          ["keygen", true],
          ["manager-id", "9470"]
        ]),
        positionals: ["relay", "scaffold", "relay-q"],
        io,
        cwd
      });
      assert.ok(result.generatedKey, "generatedKey should be populated");
      const onDisk = JSON.parse(await readFile(result.filePath, "utf8"));
      assert.equal(onDisk.relayId, "relay-q");
      assert.equal(onDisk.target, "acurast");
      assert.equal(onDisk.acurast.network, "mainnet");
      assert.equal(onDisk.acurast.managerId, "9470");
      assert.equal(onDisk.secrets.relayerPrivateKeyEnv, "PROOF_MAINNET_RELAY_Q_RECORDER_PRIVATE_KEY");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing spec without --force", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-relay-scaffold-overwrite-"));
    try {
      await mkdir(path.join(cwd, "relays"), { recursive: true });
      await writeFile(path.join(cwd, "relays", "relay-q.json"), "{}", "utf8");
      await assert.rejects(
        runRelayScaffold({
          flags: new Map<string, string | boolean>([
            ["target", "acurast"],
            ["api-base-url", "https://relay-q.example"]
          ]),
          positionals: ["relay", "scaffold", "relay-q"],
          cwd
        }),
        /already exists/
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
