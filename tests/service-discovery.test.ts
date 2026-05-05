import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { ethers } from "ethers";

import { signNetworkManifest, type NetworkManifest } from "../src/network-manifest.js";
import {
  discoverServices,
  resolveControlApiEndpoints,
  resolveRelayInventoryMembers,
  resolveRelayMembers,
  resolveValidationReportSubmitUrls
} from "../src/service-discovery.js";
import { signServiceCatalog, type ServiceCatalog } from "../src/service-catalog.js";

const MANIFEST_SIGNER_SEED = "//Alice//switchboard-network-manifest";
const CATALOG_SIGNER_SEED = "//Alice//switchboard-service-catalog";
const OTHER_CATALOG_SIGNER_SEED = "//Bob//switchboard-service-catalog";

describe("service discovery", () => {
  it("prefers signed service catalogs over legacy manifest URLs", async () => {
    const relayCatalog = await signServiceCatalog(testRelayCatalog(), CATALOG_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const controlCatalog = await signServiceCatalog(testControlCatalog(), CATALOG_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const manifest = await signNetworkManifest(testManifest(relayCatalog.signature.signer), MANIFEST_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });

    const discovered = await discoverServices({
      manifestUrlCandidates: ["https://control.example/v1/network-manifest"],
      expectedManifestSigner: manifest.signature.signer,
      now: new Date("2026-05-01T12:01:00.000Z"),
      fetchImpl: async (input) => {
        const url = input.toString();
        if (url.endsWith("/v1/network-manifest")) return jsonResponse(manifest);
        if (url.endsWith("/v1/service-catalogs/relay")) return jsonResponse(relayCatalog);
        if (url.endsWith("/v1/service-catalogs/control-api")) return jsonResponse(controlCatalog);
        return new Response("missing", { status: 404 });
      }
    });

    assert.deepEqual(resolveControlApiEndpoints(discovered), ["https://catalog-control.example"]);
    assert.deepEqual(resolveValidationReportSubmitUrls(discovered), [
      "https://catalog-relay.example/v1/validation-reports"
    ]);
    assert.deepEqual(resolveRelayMembers(discovered).map((member) => member.relayId), ["catalog-relay"]);
    assert.deepEqual(
      resolveRelayInventoryMembers(discovered).map((member) => [member.relayId, member.state]),
      [
        ["catalog-relay", "active"],
        ["catalog-relay-d", "candidate"]
      ]
    );
  });

  it("falls back to legacy manifest fields when no catalogs are advertised", async () => {
    const manifest = await signNetworkManifest(
      {
        ...testManifest(undefined),
        catalogs: undefined
      },
      MANIFEST_SIGNER_SEED,
      {
        scheme: "substrate-sr25519",
        ss58Format: 42
      }
    );

    const discovered = await discoverServices({
      manifestUrlCandidates: ["https://control.example/v1/network-manifest"],
      expectedManifestSigner: manifest.signature.signer,
      now: new Date("2026-05-01T12:01:00.000Z"),
      fetchImpl: async () => jsonResponse(manifest)
    });

    assert.deepEqual(resolveControlApiEndpoints(discovered), [
      "https://legacy-control.example",
      "https://legacy-relay.example"
    ]);
    assert.deepEqual(resolveValidationReportSubmitUrls(discovered), [
      "https://legacy-relay.example/v1/validation-reports"
    ]);
  });

  it("fails closed for required catalogs signed by the wrong key", async () => {
    const wrongRelayCatalog = await signServiceCatalog(testRelayCatalog(), OTHER_CATALOG_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const expectedCatalogSigner = (await signServiceCatalog(testRelayCatalog(), CATALOG_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    })).signature.signer;
    const manifest = await signNetworkManifest(testManifest(expectedCatalogSigner), MANIFEST_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });

    await assert.rejects(
      () =>
        discoverServices({
          manifestUrlCandidates: ["https://control.example/v1/network-manifest"],
          expectedManifestSigner: manifest.signature.signer,
          now: new Date("2026-05-01T12:01:00.000Z"),
          fetchImpl: async (input) => {
            const url = input.toString();
            if (url.endsWith("/v1/network-manifest")) return jsonResponse(manifest);
            if (url.endsWith("/v1/service-catalogs/relay")) return jsonResponse(wrongRelayCatalog);
            return new Response("missing", { status: 404 });
          }
        }),
      /does not match expected signer/
    );
  });

  it("rejects required catalogs without signer or digest", async () => {
    const relayCatalog = await signServiceCatalog(testRelayCatalog(), CATALOG_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const manifest = await signNetworkManifest(testManifestWithCatalogRef({ required: true }), MANIFEST_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });

    await assert.rejects(
      () =>
        discoverServices({
          manifestUrlCandidates: ["https://control.example/v1/network-manifest"],
          expectedManifestSigner: manifest.signature.signer,
          now: new Date("2026-05-01T12:01:00.000Z"),
          fetchImpl: async (input) => {
            const url = input.toString();
            if (url.endsWith("/v1/network-manifest")) return jsonResponse(manifest);
            if (url.endsWith("/v1/service-catalogs/relay")) return jsonResponse(relayCatalog);
            return new Response("missing", { status: 404 });
          }
        }),
      /must declare signer or digest/
    );
  });

  it("accepts digest-pinned catalogs without signer", async () => {
    const relayCatalog = await signServiceCatalog(testRelayCatalog(), CATALOG_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const manifest = await signNetworkManifest(
      testManifestWithCatalogRef({ required: true, digest: signedCatalogDigest(relayCatalog) }),
      MANIFEST_SIGNER_SEED,
      {
        scheme: "substrate-sr25519",
        ss58Format: 42
      }
    );

    const discovered = await discoverServices({
      manifestUrlCandidates: ["https://control.example/v1/network-manifest"],
      expectedManifestSigner: manifest.signature.signer,
      now: new Date("2026-05-01T12:01:00.000Z"),
      fetchImpl: async (input) => {
        const url = input.toString();
        if (url.endsWith("/v1/network-manifest")) return jsonResponse(manifest);
        if (url.endsWith("/v1/service-catalogs/relay")) return jsonResponse(relayCatalog);
        return new Response("missing", { status: 404 });
      }
    });

    assert.deepEqual(resolveRelayMembers(discovered).map((member) => member.relayId), ["catalog-relay"]);
  });

  it("rejects digest-pinned catalogs when the fetched body does not match", async () => {
    const legitRelayCatalog = await signServiceCatalog(testRelayCatalog(), CATALOG_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const attackerRelayCatalog = await signServiceCatalog(testAttackerRelayCatalog(), OTHER_CATALOG_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const manifest = await signNetworkManifest(
      testManifestWithCatalogRef({ required: true, digest: signedCatalogDigest(legitRelayCatalog) }),
      MANIFEST_SIGNER_SEED,
      {
        scheme: "substrate-sr25519",
        ss58Format: 42
      }
    );

    await assert.rejects(
      () =>
        discoverServices({
          manifestUrlCandidates: ["https://control.example/v1/network-manifest"],
          expectedManifestSigner: manifest.signature.signer,
          now: new Date("2026-05-01T12:01:00.000Z"),
          fetchImpl: async (input) => {
            const url = input.toString();
            if (url.endsWith("/v1/network-manifest")) return jsonResponse(manifest);
            if (url.endsWith("/v1/service-catalogs/relay")) return jsonResponse(attackerRelayCatalog);
            return new Response("missing", { status: 404 });
          }
        }),
      /digest mismatch/
    );
  });

  it("rejects catalogs when signer matches but digest does not", async () => {
    const relayCatalog = await signServiceCatalog(testRelayCatalog(), CATALOG_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const staleCatalog = await signServiceCatalog(
      {
        ...testRelayCatalog(),
        sequence: 0
      },
      CATALOG_SIGNER_SEED,
      {
        scheme: "substrate-sr25519",
        ss58Format: 42
      }
    );
    const manifest = await signNetworkManifest(
      testManifestWithCatalogRef({
        signer: relayCatalog.signature.signer,
        required: true,
        digest: signedCatalogDigest(staleCatalog)
      }),
      MANIFEST_SIGNER_SEED,
      {
        scheme: "substrate-sr25519",
        ss58Format: 42
      }
    );

    await assert.rejects(
      () =>
        discoverServices({
          manifestUrlCandidates: ["https://control.example/v1/network-manifest"],
          expectedManifestSigner: manifest.signature.signer,
          now: new Date("2026-05-01T12:01:00.000Z"),
          fetchImpl: async (input) => {
            const url = input.toString();
            if (url.endsWith("/v1/network-manifest")) return jsonResponse(manifest);
            if (url.endsWith("/v1/service-catalogs/relay")) return jsonResponse(relayCatalog);
            return new Response("missing", { status: 404 });
          }
        }),
      /digest mismatch/
    );
  });
});

function testManifest(catalogSigner: string | undefined): NetworkManifest {
  return {
    version: 1,
    sequence: 1,
    issuedAt: "2026-05-01T12:00:00.000Z",
    expiresAt: "2026-05-01T12:05:00.000Z",
    chain: {
      name: "local-test",
      chainId: "31337"
    },
    registries: {
      active: [
        {
          status: "active",
          address: "0x1000000000000000000000000000000000000001"
        }
      ],
      deprecated: [],
      retired: []
    },
    quoteSigner: new ethers.Wallet("0x0000000000000000000000000000000000000000000000000000000000000100").address,
    controlPlane: {
      apiBaseUrl: "https://legacy-control.example"
    },
    catalogs: catalogSigner
      ? {
          relays: {
            url: "https://control.example/v1/service-catalogs/relay",
            signer: catalogSigner,
            required: true,
            maxStaleSeconds: 300
          },
          controlApi: {
            url: "https://control.example/v1/service-catalogs/control-api",
            signer: catalogSigner,
            required: true,
            maxStaleSeconds: 300
          }
        }
      : undefined,
    relays: [
      {
        relayId: "legacy-relay",
        apiBaseUrl: "https://legacy-relay.example"
      }
    ]
  };
}

function testManifestWithCatalogRef(relaysRef: { signer?: string; required?: boolean; maxStaleSeconds?: number; digest?: string }): NetworkManifest {
  return {
    ...testManifest(undefined),
    catalogs: {
      relays: {
        url: "https://control.example/v1/service-catalogs/relay",
        ...relaysRef
      }
    }
  };
}

function testRelayCatalog(): ServiceCatalog {
  return {
    version: 1,
    role: "relay",
    sequence: 1,
    issuedAt: "2026-05-01T12:00:00.000Z",
    expiresAt: "2026-05-01T12:05:00.000Z",
    members: [
      {
        serviceId: "catalog-relay",
        state: "active",
        apiBaseUrl: "https://catalog-relay.example"
      },
      {
        serviceId: "catalog-relay-d",
        state: "candidate",
        apiBaseUrl: "https://catalog-relay-d.example"
      }
    ]
  };
}

function testAttackerRelayCatalog(): ServiceCatalog {
  return {
    ...testRelayCatalog(),
    members: [
      {
        serviceId: "attacker-relay",
        state: "active",
        apiBaseUrl: "https://evil-relay.attacker.example"
      }
    ]
  };
}

function testControlCatalog(): ServiceCatalog {
  return {
    version: 1,
    role: "control-api",
    sequence: 1,
    issuedAt: "2026-05-01T12:00:00.000Z",
    expiresAt: "2026-05-01T12:05:00.000Z",
    members: [
      {
        serviceId: "catalog-control",
        state: "active",
        apiBaseUrl: "https://catalog-control.example"
      }
    ]
  };
}

function signedCatalogDigest(value: unknown): string {
  return `0x${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}
