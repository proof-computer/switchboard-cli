import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activeServiceCatalogMembers,
  normalizeServiceCatalog,
  relayCatalogInputArraySchema,
  relayCatalogInputEntrySchema,
  relayCatalogMemberFromInput,
  signServiceCatalog,
  verifySignedServiceCatalog,
  type ServiceCatalog
} from "../src/service-catalog.js";

const SIGNER_SEED = "//Alice//switchboard-service-catalog";
const OTHER_SIGNER_SEED = "//Bob//switchboard-service-catalog";

describe("service catalog", () => {
  it("signs, verifies, normalizes URLs, and filters active members", async () => {
    const catalog = testRelayCatalog();
    const signed = await signServiceCatalog(catalog, SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42,
      signedAt: "2026-05-01T12:00:00.000Z"
    });
    const verified = await verifySignedServiceCatalog(signed, {
      expectedSigner: signed.signature.signer,
      now: new Date("2026-05-01T12:01:00.000Z")
    });

    assert.equal(verified.catalog.role, "relay");
    assert.equal(verified.signer, signed.signature.signer);
    assert.deepEqual(
      activeServiceCatalogMembers(verified.catalog, { now: new Date("2026-05-01T12:01:00.000Z") }).map((member) => [
        member.serviceId,
        member.apiBaseUrl,
        member.validationReportUrl
      ]),
      [
        [
          "relay-a",
          "https://relay-a.example",
          "https://relay-a.example/v1/validation-reports"
        ]
      ]
    );
    assert.deepEqual(
      activeServiceCatalogMembers(verified.catalog, {
        now: new Date("2026-05-01T12:01:00.000Z"),
        includeDegraded: true
      }).map((member) => member.serviceId),
      ["relay-a", "relay-b"]
    );
  });

  it("rejects stale catalogs and untrusted signers", async () => {
    const signed = await signServiceCatalog(
      {
        ...testRelayCatalog(),
        expiresAt: "2026-05-01T12:00:00.000Z"
      },
      SIGNER_SEED,
      {
        scheme: "substrate-sr25519",
        ss58Format: 42
      }
    );
    await assert.rejects(
      () =>
        verifySignedServiceCatalog(signed, {
          expectedSigner: signed.signature.signer,
          now: new Date("2026-05-01T12:00:01.000Z")
        }),
      /expired/
    );

    const otherSigned = await signServiceCatalog(testRelayCatalog(), OTHER_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    await assert.rejects(
      () =>
        verifySignedServiceCatalog(otherSigned, {
          expectedSigner: signed.signature.signer,
          now: new Date("2026-05-01T11:59:00.000Z")
        }),
      /does not match expected signer/
    );
  });

  it("normalizes catalog member roles to the catalog role", () => {
    const normalized = normalizeServiceCatalog(testRelayCatalog());
    assert.deepEqual(normalized.members.map((member) => member.role), ["relay", "relay", "relay", "relay"]);
  });
});

describe("relayCatalogMemberFromInput", () => {
  const baseInput = {
    relayId: "relay-d",
    apiBaseUrl: "https://relay-d.example"
  };

  it("defaults state to active when neither state nor active flag is set", () => {
    const entry = relayCatalogInputEntrySchema.parse(baseInput);
    const member = relayCatalogMemberFromInput(entry);
    assert.equal(member.state, "active");
    assert.equal(member.serviceId, "relay-d");
    assert.equal(member.role, "relay");
  });

  it("derives validationReportUrl from apiBaseUrl when omitted", () => {
    const entry = relayCatalogInputEntrySchema.parse(baseInput);
    const member = relayCatalogMemberFromInput(entry);
    assert.equal(member.validationReportUrl, "https://relay-d.example/v1/validation-reports");
  });

  it("treats active=false as state=disabled (back-compat)", () => {
    const entry = relayCatalogInputEntrySchema.parse({ ...baseInput, active: false });
    const member = relayCatalogMemberFromInput(entry);
    assert.equal(member.state, "disabled");
  });

  it("treats active=true as the implicit default state=active (back-compat)", () => {
    const entry = relayCatalogInputEntrySchema.parse({ ...baseInput, active: true });
    const member = relayCatalogMemberFromInput(entry);
    assert.equal(member.state, "active");
  });

  it("honors explicit state field for canary, degraded, and draining", () => {
    for (const state of ["candidate", "degraded", "draining"] as const) {
      const entry = relayCatalogInputEntrySchema.parse({ ...baseInput, state });
      const member = relayCatalogMemberFromInput(entry);
      assert.equal(member.state, state, `expected state ${state}`);
    }
  });

  it("rejects unknown state values via the schema", () => {
    assert.throws(
      () => relayCatalogInputEntrySchema.parse({ ...baseInput, state: "bogus" }),
      /Invalid option|Invalid enum value|invalid_value/
    );
  });

  it("refuses to silently override state when both state and active=false are set", () => {
    const entry = relayCatalogInputEntrySchema.parse({ ...baseInput, state: "candidate", active: false });
    assert.throws(
      () => relayCatalogMemberFromInput(entry),
      /remove the legacy active flag/
    );
  });

  it("preserves weight, capabilities, controlPlaneUrl, and metadata", () => {
    const entry = relayCatalogInputEntrySchema.parse({
      ...baseInput,
      weight: 5,
      capabilities: ["peer-backfill"],
      controlPlaneUrl: "https://relay-d.example/control",
      metadata: { region: "eu-central" }
    });
    const member = relayCatalogMemberFromInput(entry, { defaultCapabilities: ["ignored"] });
    assert.equal(member.weight, 5);
    assert.deepEqual(member.capabilities, ["peer-backfill"]);
    assert.equal(member.controlPlaneUrl, "https://relay-d.example/control");
    assert.deepEqual(member.metadata, { region: "eu-central" });
  });

  it("falls back to defaultCapabilities when entry omits capabilities", () => {
    const entry = relayCatalogInputEntrySchema.parse(baseInput);
    const member = relayCatalogMemberFromInput(entry, { defaultCapabilities: ["validation-reports"] });
    assert.deepEqual(member.capabilities, ["validation-reports"]);
  });

  it("rejects unknown top-level fields (strict)", () => {
    assert.throws(
      () => relayCatalogInputEntrySchema.parse({ ...baseInput, somethingExtra: "nope" }),
      /Unrecognized key|unrecognized_keys/
    );
  });

  it("array schema accepts a heterogeneous list of state-tagged entries", () => {
    const entries = relayCatalogInputArraySchema.parse([
      { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "active" },
      { relayId: "relay-b", apiBaseUrl: "https://relay-b.example", state: "draining" },
      { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "candidate" }
    ]);
    const members = entries.map((entry) => relayCatalogMemberFromInput(entry));
    assert.deepEqual(
      members.map((member) => [member.serviceId, member.state]),
      [
        ["relay-a", "active"],
        ["relay-b", "draining"],
        ["relay-d", "candidate"]
      ]
    );
  });
});

function testRelayCatalog(): ServiceCatalog {
  return {
    version: 1,
    role: "relay",
    sequence: 3,
    issuedAt: "2026-05-01T11:59:00.000Z",
    expiresAt: "2026-05-01T12:05:00.000Z",
    members: [
      {
        serviceId: "relay-a",
        state: "active",
        apiBaseUrl: "https://relay-a.example/",
        validationReportUrl: "https://relay-a.example/v1/validation-reports"
      },
      {
        serviceId: "relay-b",
        state: "degraded",
        apiBaseUrl: "https://relay-b.example/"
      },
      {
        serviceId: "relay-c",
        state: "draining",
        apiBaseUrl: "https://relay-c.example/"
      },
      {
        serviceId: "relay-d",
        state: "disabled",
        apiBaseUrl: "https://relay-d.example/"
      }
    ]
  };
}
