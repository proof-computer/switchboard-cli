import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { synthesizeAcurastDeployEnv } from "../cli/src/relay/deploy-env.js";
import { signNetworkManifest, type NetworkManifest } from "../src/network-manifest.js";

const MANIFEST_SIGNER_SEED = "//Alice//switchboard-network-manifest";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

async function buildSignedManifest(): Promise<{ signed: unknown; signer: string }> {
  const manifest: NetworkManifest = {
    version: 1,
    sequence: 1,
    issuedAt: "2026-05-02T12:00:00.000Z",
    expiresAt: "2030-05-02T12:00:00.000Z",
    chain: { name: "polkadot-hub", chainId: "420420419" },
    rpc: { eth: ["https://services.polkadothub-rpc.com/mainnet"] },
    registries: {
      active: [{ status: "active", address: "0x65d6b76bec50f46d198ffa3598e381a298025da0" }],
      deprecated: [],
      retired: []
    },
    relays: []
  };
  const signed = await signNetworkManifest(manifest, MANIFEST_SIGNER_SEED, { scheme: "substrate-sr25519", ss58Format: 42 });
  return { signed, signer: signed.signature.signer };
}

describe("synthesizeAcurastDeployEnv", () => {
  it("populates CHAIN_ID, HUB_ETH_RPC_URL, INGRESS_REGISTRY_ADDRESS from the manifest", async () => {
    const { signed, signer } = await buildSignedManifest();
    const fetchImpl = (async () => jsonResponse(signed)) as typeof fetch;
    const env = await synthesizeAcurastDeployEnv({
      baseEnv: {},
      manifestUrl: "https://control.example/v1/network-manifest",
      manifestSigner: signer,
      fallbackRecorderCoordinatorAddress: "0xRECORDER_FALLBACK",
      fetchImpl
    });
    assert.equal(env.CHAIN_ID, "420420419");
    assert.equal(env.HUB_ETH_RPC_URL, "https://services.polkadothub-rpc.com/mainnet");
    assert.equal(env.INGRESS_REGISTRY_ADDRESS, "0x65d6B76BeC50F46D198fFa3598E381a298025Da0");
    assert.equal(env.PROOF_RECORDER_COORDINATOR_ADDRESS, "0xRECORDER_FALLBACK");
  });

  it("matching env + manifest values pass through", async () => {
    const { signed, signer } = await buildSignedManifest();
    const fetchImpl = (async () => jsonResponse(signed)) as typeof fetch;
    const env = await synthesizeAcurastDeployEnv({
      baseEnv: {
        CHAIN_ID: "420420419",
        HUB_ETH_RPC_URL: "https://services.polkadothub-rpc.com/mainnet",
        INGRESS_REGISTRY_ADDRESS: "0x65d6B76BeC50F46D198fFa3598E381a298025Da0",
        PROOF_RECORDER_COORDINATOR_ADDRESS: "0xLOCAL_COORD"
      },
      manifestUrl: "https://control.example/v1/network-manifest",
      manifestSigner: signer,
      fallbackRecorderCoordinatorAddress: "0xRECORDER_FALLBACK",
      fetchImpl
    });
    assert.equal(env.CHAIN_ID, "420420419");
    assert.equal(env.HUB_ETH_RPC_URL, "https://services.polkadothub-rpc.com/mainnet");
    assert.equal(env.INGRESS_REGISTRY_ADDRESS, "0x65d6B76BeC50F46D198fFa3598E381a298025Da0");
    // The recorder-coordinator field is not in the manifest schema — env still wins via the fallback path.
    assert.equal(env.PROOF_RECORDER_COORDINATOR_ADDRESS, "0xLOCAL_COORD");
  });

  it("INGRESS_REGISTRY_ADDRESS env-vs-manifest mismatch is case-insensitive", async () => {
    const { signed, signer } = await buildSignedManifest();
    const fetchImpl = (async () => jsonResponse(signed)) as typeof fetch;
    // Mixed-case env value vs lowercase manifest value: still considered a match.
    const env = await synthesizeAcurastDeployEnv({
      baseEnv: { INGRESS_REGISTRY_ADDRESS: "0x65D6B76BEC50F46D198FFA3598E381A298025DA0" },
      manifestUrl: "https://control.example/v1/network-manifest",
      manifestSigner: signer,
      fallbackRecorderCoordinatorAddress: "0xRECORDER_FALLBACK",
      fetchImpl
    });
    assert.equal(env.INGRESS_REGISTRY_ADDRESS, "0x65D6B76BEC50F46D198FFA3598E381A298025DA0");
  });

  it("refuses to deploy when CHAIN_ID disagrees with the manifest", async () => {
    const { signed, signer } = await buildSignedManifest();
    const fetchImpl = (async () => jsonResponse(signed)) as typeof fetch;
    await assert.rejects(
      synthesizeAcurastDeployEnv({
        baseEnv: { CHAIN_ID: "420420417" },
        manifestUrl: "https://control.example/v1/network-manifest",
        manifestSigner: signer,
        fallbackRecorderCoordinatorAddress: "0xRECORDER_FALLBACK",
        fetchImpl
      }),
      /CHAIN_ID=420420417 \(env\) vs 420420419 \(manifest\)/
    );
  });

  it("refuses to deploy when HUB_ETH_RPC_URL disagrees with the manifest", async () => {
    const { signed, signer } = await buildSignedManifest();
    const fetchImpl = (async () => jsonResponse(signed)) as typeof fetch;
    await assert.rejects(
      synthesizeAcurastDeployEnv({
        baseEnv: { HUB_ETH_RPC_URL: "https://services.polkadothub-rpc.com/testnet" },
        manifestUrl: "https://control.example/v1/network-manifest",
        manifestSigner: signer,
        fallbackRecorderCoordinatorAddress: "0xRECORDER_FALLBACK",
        fetchImpl
      }),
      /HUB_ETH_RPC_URL=.*testnet.*env.*mainnet.*manifest/
    );
  });

  it("refuses to deploy when INGRESS_REGISTRY_ADDRESS disagrees with the manifest", async () => {
    const { signed, signer } = await buildSignedManifest();
    const fetchImpl = (async () => jsonResponse(signed)) as typeof fetch;
    await assert.rejects(
      synthesizeAcurastDeployEnv({
        baseEnv: { INGRESS_REGISTRY_ADDRESS: "0xA902E4212895ba4d5E5018a3540b96c2856e6Dce" },
        manifestUrl: "https://control.example/v1/network-manifest",
        manifestSigner: signer,
        fallbackRecorderCoordinatorAddress: "0xRECORDER_FALLBACK",
        fetchImpl
      }),
      /INGRESS_REGISTRY_ADDRESS=0xA902E4212895ba4d5E5018a3540b96c2856e6Dce.*env.*manifest/
    );
  });

  it("lists every conflict at once (operator fixes them in one pass)", async () => {
    const { signed, signer } = await buildSignedManifest();
    const fetchImpl = (async () => jsonResponse(signed)) as typeof fetch;
    await assert.rejects(
      synthesizeAcurastDeployEnv({
        baseEnv: {
          CHAIN_ID: "31337",
          HUB_ETH_RPC_URL: "http://localhost:8545",
          INGRESS_REGISTRY_ADDRESS: "0xLOCAL"
        },
        manifestUrl: "https://control.example/v1/network-manifest",
        manifestSigner: signer,
        fallbackRecorderCoordinatorAddress: "0xRECORDER_FALLBACK",
        fetchImpl
      }),
      (error: Error) => {
        return /CHAIN_ID/.test(error.message) && /HUB_ETH_RPC_URL/.test(error.message) && /INGRESS_REGISTRY_ADDRESS/.test(error.message);
      }
    );
  });

  it("skipManifest leaves env untouched except for the recorder fallback", async () => {
    const env = await synthesizeAcurastDeployEnv({
      baseEnv: { CHAIN_ID: "31337" },
      manifestUrl: "unused",
      skipManifest: true,
      fallbackRecorderCoordinatorAddress: "0xRECORDER_FALLBACK"
    });
    assert.equal(env.CHAIN_ID, "31337");
    assert.equal(env.HUB_ETH_RPC_URL, undefined);
    assert.equal(env.PROOF_RECORDER_COORDINATOR_ADDRESS, "0xRECORDER_FALLBACK");
  });
});
