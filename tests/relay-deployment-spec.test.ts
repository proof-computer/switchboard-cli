import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FORBIDDEN_ACURAST_ENV_NAMES,
  HIGH_AUTHORITY_ACURAST_ENV_NAMES,
  assertNoForbiddenAcurastEnv,
  isHighAuthorityAcurastEnvName,
  isForbiddenAcurastEnvName,
  parseRelayDeploymentSpec,
  safeParseRelayDeploymentSpec
} from "../src/relay-deployment-spec.js";

const validAcurastSpec = {
  version: 1,
  relayId: "relay-d",
  target: "acurast",
  catalogState: "candidate",
  apiBaseUrl: "https://relay-d.switchboard.proof.computer",
  peers: [
    {
      relayId: "relay-a",
      apiBaseUrl: "https://relay-a.switchboard.proof.computer",
      readTokenEnv: "PROOF_VALIDATION_READ_TOKEN"
    }
  ],
  secrets: {
    relayerPrivateKeyEnv: "PROOF_RELAY_D_RELAYER_PRIVATE_KEY",
    validationReadTokenEnv: "PROOF_VALIDATION_READ_TOKEN"
  },
  acurast: {
    deployerSeedEnv: "PROOF_ACURAST_MAINNET_DEPLOYER_SEED",
    projectName: "switchboard-mainnet-relay-d",
    stageDir: "dist/acurast/switchboard-mainnet-relay-d",
    maxCostPerExecution: 40_000_000_000,
    includeEnv: ["CHAIN_ID", "HUB_ETH_RPC_URL", "INGRESS_REGISTRY_ADDRESS"]
  }
};

describe("relay deployment spec", () => {
  it("parses a valid Acurast candidate spec and applies defaults", () => {
    const spec = parseRelayDeploymentSpec(validAcurastSpec);
    assert.equal(spec.version, 1);
    assert.equal(spec.relayId, "relay-d");
    assert.equal(spec.target, "acurast");
    assert.equal(spec.catalogState, "candidate");
    assert.equal(spec.acurast?.entrypoint, "src/server.ts");
    assert.equal(spec.acurast?.executionMs, 3_600_000);
    assert.equal(spec.acurast?.maxCostPerExecution, "40000000000");
    assert.equal(spec.relay.authorityProfile, "durable-relay");
    assert.equal(spec.relay.autoRegister, false);
    assert.equal(spec.relay.enablePeerBackfill, true);
    assert.equal(spec.relay.sqliteDriver, "node:sqlite");
  });

  it("requires an acurast section when target=acurast", () => {
    const result = safeParseRelayDeploymentSpec({ ...validAcurastSpec, acurast: undefined });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error.errors.some((issue) => issue.message.includes("acurast section")));
    }
  });

  it("requires a bootstrap section when target=bootstrap", () => {
    const result = safeParseRelayDeploymentSpec({
      ...validAcurastSpec,
      target: "bootstrap",
      acurast: undefined
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error.errors.some((issue) => issue.message.includes("bootstrap section")));
    }
  });

  it("rejects forbidden env names anywhere in the spec", () => {
    for (const forbidden of FORBIDDEN_ACURAST_ENV_NAMES) {
      const result = safeParseRelayDeploymentSpec({
        ...validAcurastSpec,
        acurast: {
          ...validAcurastSpec.acurast,
          includeEnv: [...validAcurastSpec.acurast.includeEnv, forbidden]
        }
      });
      assert.equal(result.ok, false, `expected ${forbidden} to be rejected`);
    }
  });

  it("rejects forbidden env names in secrets references", () => {
    const result = safeParseRelayDeploymentSpec({
      ...validAcurastSpec,
      secrets: {
        ...validAcurastSpec.secrets,
        relayerPrivateKeyEnv: "QUOTE_SIGNER_PRIVATE_KEY"
      }
    });
    assert.equal(result.ok, false);
  });

  it("rejects quote-enabled durable Acurast relays", () => {
    const result = safeParseRelayDeploymentSpec({
      ...validAcurastSpec,
      relay: { quotesEnabled: true }
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error.errors.some((issue) => issue.message.includes("quote-rootless")));
    }
  });

  it("allows an explicit bootstrap control-plane authority profile without allowing quote roots", () => {
    const spec = parseRelayDeploymentSpec({
      ...validAcurastSpec,
      relay: {
        authorityProfile: "bootstrap-control-plane",
        quotesEnabled: true
      }
    });
    assert.equal(spec.relay.authorityProfile, "bootstrap-control-plane");
    assert.equal(spec.relay.quotesEnabled, true);

    const rootResult = safeParseRelayDeploymentSpec({
      ...validAcurastSpec,
      relay: {
        authorityProfile: "bootstrap-control-plane"
      },
      acurast: {
        ...validAcurastSpec.acurast,
        includeEnv: [...validAcurastSpec.acurast.includeEnv, "QUOTE_SIGNER_PRIVATE_KEY"]
      }
    });
    assert.equal(rootResult.ok, false);
  });

  it("keeps DNS/ACME authority explicit bootstrap-only for managed Acurast relays", () => {
    const durable = safeParseRelayDeploymentSpec({
      ...validAcurastSpec,
      acurast: {
        ...validAcurastSpec.acurast,
        includeEnv: [...validAcurastSpec.acurast.includeEnv, "CLOUDFLARE_API_TOKEN"]
      }
    });
    assert.equal(durable.ok, false);
    if (!durable.ok) {
      assert.ok(durable.error.errors.some((issue) => issue.message.includes("bootstrap env")));
    }

    const bootstrap = parseRelayDeploymentSpec({
      ...validAcurastSpec,
      relay: {
        authorityProfile: "bootstrap-control-plane"
      },
      acurast: {
        ...validAcurastSpec.acurast,
        includeEnv: [...validAcurastSpec.acurast.includeEnv, "CLOUDFLARE_API_TOKEN"]
      }
    });
    assert.equal(bootstrap.relay.authorityProfile, "bootstrap-control-plane");
    assert.ok(bootstrap.acurast?.includeEnv.includes("CLOUDFLARE_API_TOKEN"));
  });

  it("rejects unknown top-level fields (strict)", () => {
    const result = safeParseRelayDeploymentSpec({
      ...validAcurastSpec,
      somethingExtra: "nope"
    });
    assert.equal(result.ok, false);
  });

  it("supports a valid bootstrap spec", () => {
    const spec = parseRelayDeploymentSpec({
      version: 1,
      relayId: "relay-a",
      target: "bootstrap",
      catalogState: "active",
      apiBaseUrl: "https://relay-a.switchboard.proof.computer",
      secrets: { relayerPrivateKeyEnv: "PROOF_MAINNET_RELAY_A_RECORDER_PRIVATE_KEY" },
      bootstrap: { composeService: "relay" }
    });
    assert.equal(spec.target, "bootstrap");
    assert.equal(spec.bootstrap?.composeFile, "docker-compose.control-plane.yaml");
    assert.equal(spec.bootstrap?.envFile, ".control-plane/control-plane.env");
    assert.equal(spec.bootstrap?.rebuild, true);
  });

  it("verification.acurastReadyGraceMs defaults to 5 minutes", () => {
    const spec = parseRelayDeploymentSpec(validAcurastSpec);
    assert.equal(spec.verification.acurastReadyGraceMs, 300_000);
  });

  it("verification.acurastReadyGraceMs accepts an explicit override", () => {
    const spec = parseRelayDeploymentSpec({
      ...validAcurastSpec,
      verification: { acurastReadyGraceMs: 600_000 }
    });
    assert.equal(spec.verification.acurastReadyGraceMs, 600_000);
  });

  it("accepts an optional dns block with cnameTarget", () => {
    const spec = parseRelayDeploymentSpec({
      ...validAcurastSpec,
      dns: {
        provider: "cloudflare",
        cnameTarget: "gateway.switchboard.proof.computer"
      }
    });
    assert.equal(spec.dns?.provider, "cloudflare");
    assert.equal(spec.dns?.cnameTarget, "gateway.switchboard.proof.computer");
    assert.equal(spec.dns?.ttl, 60);
  });

  it("rejects a non-FQDN cnameTarget", () => {
    const result = safeParseRelayDeploymentSpec({
      ...validAcurastSpec,
      dns: { provider: "cloudflare", cnameTarget: "not-an-fqdn" }
    });
    assert.equal(result.ok, false);
  });

  it("accepts relay.autoRegister with relay.bootstrapRelayUrl on Acurast", () => {
    const spec = parseRelayDeploymentSpec({
      ...validAcurastSpec,
      relay: {
        autoRegister: true,
        bootstrapRelayUrl: "https://relay-a.switchboard.proof.computer",
        certificateMode: "job-acme"
      }
    });
    assert.equal(spec.relay.autoRegister, true);
    assert.equal(spec.relay.bootstrapRelayUrl, "https://relay-a.switchboard.proof.computer");
    assert.equal(spec.relay.certificateMode, "job-acme");
  });

  it("requires relay.bootstrapRelayUrl when target=acurast and autoRegister=true", () => {
    const result = safeParseRelayDeploymentSpec({
      ...validAcurastSpec,
      relay: { autoRegister: true }
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error.errors.some((issue) => issue.message.includes("bootstrapRelayUrl")));
    }
  });

  it("certificateMode defaults to job-acme", () => {
    const spec = parseRelayDeploymentSpec(validAcurastSpec);
    assert.equal(spec.relay.certificateMode, "job-acme");
  });

  it("rejects unknown certificateMode values", () => {
    const result = safeParseRelayDeploymentSpec({
      ...validAcurastSpec,
      relay: { certificateMode: "lets-encrypt-letsdance" }
    });
    assert.equal(result.ok, false);
  });

  it("rejects unknown fields inside dns (strict)", () => {
    const result = safeParseRelayDeploymentSpec({
      ...validAcurastSpec,
      dns: {
        provider: "cloudflare",
        cnameTarget: "gateway.switchboard.proof.computer",
        somethingExtra: 1
      }
    });
    assert.equal(result.ok, false);
  });

  it("isForbiddenAcurastEnvName matches case-insensitively", () => {
    assert.equal(isForbiddenAcurastEnvName("quote_signer_private_key"), true);
    assert.equal(isForbiddenAcurastEnvName("HUB_ETH_RPC_URL"), false);
  });

  it("classifies high-authority bootstrap env names separately", () => {
    for (const name of HIGH_AUTHORITY_ACURAST_ENV_NAMES) {
      assert.equal(isHighAuthorityAcurastEnvName(name.toLowerCase()), true);
      assert.equal(isForbiddenAcurastEnvName(name), false);
    }
  });

  it("assertNoForbiddenAcurastEnv throws on offenders, otherwise no-ops", () => {
    assert.doesNotThrow(() => assertNoForbiddenAcurastEnv(["CHAIN_ID", "HUB_ETH_RPC_URL"]));
    assert.throws(
      () => assertNoForbiddenAcurastEnv(["CHAIN_ID", "PROOF_NETWORK_MANIFEST_SIGNING_KEY"]),
      /forbidden env names to Acurast/
    );
  });
});
