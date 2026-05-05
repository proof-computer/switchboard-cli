import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runCatalogVerify } from "../cli/src/catalog/index.js";
import { signNetworkManifest, type NetworkManifest } from "../src/network-manifest.js";
import { signServiceCatalog, type ServiceCatalog } from "../src/service-catalog.js";

const MANIFEST_SIGNER_SEED = "//Alice//switchboard-network-manifest";
const CATALOG_SIGNER_SEED = "//Alice//switchboard-service-catalog";
const OTHER_SEED = "//Bob//switchboard-service-catalog";

interface Captured {
  log: string[];
  warn: string[];
  error: string[];
}

function makeIo(): { io: { log: (l: string) => void; warn: (l: string) => void; error: (l: string) => void }; captured: Captured } {
  const captured: Captured = { log: [], warn: [], error: [] };
  return {
    io: {
      log: (line) => captured.log.push(line),
      warn: (line) => captured.warn.push(line),
      error: (line) => captured.error.push(line)
    },
    captured
  };
}

function relayCatalog(): ServiceCatalog {
  return {
    version: 1,
    role: "relay",
    sequence: 1,
    issuedAt: "2026-05-01T12:00:00.000Z",
    expiresAt: "2030-05-01T12:00:00.000Z",
    members: [{ serviceId: "relay-a", state: "active", apiBaseUrl: "https://relay-a.example" }]
  };
}

function controlCatalog(): ServiceCatalog {
  return {
    version: 1,
    role: "control-api",
    sequence: 1,
    issuedAt: "2026-05-01T12:00:00.000Z",
    expiresAt: "2030-05-01T12:00:00.000Z",
    members: [{ serviceId: "control-bootstrap", state: "active", apiBaseUrl: "https://control.example" }]
  };
}

function makeManifest(catalogSigner: string): NetworkManifest {
  return {
    version: 1,
    sequence: 1,
    issuedAt: "2026-05-01T12:00:00.000Z",
    expiresAt: "2030-05-01T12:00:00.000Z",
    chain: { name: "test", chainId: "31337" },
    registries: { active: [{ status: "active", address: "0x1000000000000000000000000000000000000001" }], deprecated: [], retired: [] },
    catalogs: {
      relays: {
        url: "https://control.example/v1/service-catalogs/relay",
        signer: catalogSigner,
        required: true
      },
      controlApi: {
        url: "https://control.example/v1/service-catalogs/control-api",
        signer: catalogSigner,
        required: true
      }
    },
    relays: []
  };
}

describe("switchboard catalog verify", () => {
  it("walks the manifest, fetches each catalog, and reports them as ok", async () => {
    const relays = await signServiceCatalog(relayCatalog(), CATALOG_SIGNER_SEED, { scheme: "substrate-sr25519", ss58Format: 42 });
    const controlApi = await signServiceCatalog(controlCatalog(), CATALOG_SIGNER_SEED, { scheme: "substrate-sr25519", ss58Format: 42 });
    const manifest = await signNetworkManifest(makeManifest(relays.signature.signer), MANIFEST_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const { io, captured } = makeIo();

    const result = await runCatalogVerify({
      flags: new Map<string, string | boolean>([
        ["manifest-url", "https://control.example/v1/network-manifest"],
        ["manifest-signer", manifest.signature.signer]
      ]),
      io,
      fetchImpl: async (input) => {
        const url = input.toString();
        if (url.endsWith("/v1/network-manifest")) return jsonResponse(manifest);
        if (url.endsWith("/v1/service-catalogs/relay")) return jsonResponse(relays);
        if (url.endsWith("/v1/service-catalogs/control-api")) return jsonResponse(controlApi);
        return new Response("missing", { status: 404 });
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.manifestSigner, manifest.signature.signer);
    const roles = result.catalogs.map((c) => c.role).sort();
    assert.deepEqual(roles, ["control-api", "relay"]);
    const output = captured.log.join("\n");
    assert.match(output, /relay/);
  });

  it("fails when a required catalog is signed by an unexpected key", async () => {
    const wrongRelays = await signServiceCatalog(relayCatalog(), OTHER_SEED, { scheme: "substrate-sr25519", ss58Format: 42 });
    const expectedRelays = await signServiceCatalog(relayCatalog(), CATALOG_SIGNER_SEED, { scheme: "substrate-sr25519", ss58Format: 42 });
    const controlApi = await signServiceCatalog(controlCatalog(), CATALOG_SIGNER_SEED, { scheme: "substrate-sr25519", ss58Format: 42 });
    const manifest = await signNetworkManifest(makeManifest(expectedRelays.signature.signer), MANIFEST_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });

    await assert.rejects(
      runCatalogVerify({
        flags: new Map<string, string | boolean>([
          ["manifest-url", "https://control.example/v1/network-manifest"],
          ["manifest-signer", manifest.signature.signer]
        ]),
        fetchImpl: async (input) => {
          const url = input.toString();
          if (url.endsWith("/v1/network-manifest")) return jsonResponse(manifest);
          if (url.endsWith("/v1/service-catalogs/relay")) return jsonResponse(wrongRelays);
          if (url.endsWith("/v1/service-catalogs/control-api")) return jsonResponse(controlApi);
          return new Response("missing", { status: 404 });
        }
      }),
      /does not match expected signer/
    );
  });

  it("requires --manifest-url unless PROOF_NETWORK_MANIFEST_URL is set", async () => {
    await assert.rejects(
      runCatalogVerify({
        flags: new Map<string, string | boolean>(),
        env: {}
      }),
      /manifest-url/
    );
  });

  it("requires a pinned signer unless --allow-unpinned-signer is passed", async () => {
    await assert.rejects(
      runCatalogVerify({
        flags: new Map<string, string | boolean>([
          ["manifest-url", "https://control.example/v1/network-manifest"]
        ]),
        env: {}
      }),
      /manifest-signer/
    );
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
