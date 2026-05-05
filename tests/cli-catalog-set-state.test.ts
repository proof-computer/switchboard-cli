import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { applySetState, runCatalogSetState } from "../cli/src/catalog/index.js";
import { catalogBuildSpecSchema } from "../cli/src/catalog/build.js";
import { verifySignedServiceCatalog } from "../src/service-catalog.js";

const SIGNER_SEED = "//Alice//switchboard-service-catalog";

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

function baseSpec() {
  return {
    version: 1,
    ttlSeconds: 3600,
    sequence: 1,
    issuedAt: "2026-05-01T12:00:00.000Z",
    controlApi: [
      { serviceId: "control-bootstrap", apiBaseUrl: "https://control.example", state: "active" }
    ],
    relays: [
      { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "active" },
      { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "candidate" }
    ]
  };
}

describe("applySetState (library)", () => {
  it("transitions a relay state without touching other entries", () => {
    const spec = catalogBuildSpecSchema.parse(baseSpec());
    const { spec: next, previousState } = applySetState(spec, "relay", "relay-d", "active");
    assert.equal(previousState, "candidate");
    assert.deepEqual(
      next.relays.map((r) => [r.relayId, r.state]),
      [
        ["relay-a", "active"],
        ["relay-d", "active"]
      ]
    );
    assert.deepEqual(next.controlApi, spec.controlApi);
  });

  it("transitions a control-api state by id", () => {
    const spec = catalogBuildSpecSchema.parse(baseSpec());
    const { spec: next, previousState } = applySetState(spec, "control-api", "control-bootstrap", "draining");
    assert.equal(previousState, "active");
    assert.equal(next.controlApi[0].state, "draining");
  });

  it("rejects unknown service ids", () => {
    const spec = catalogBuildSpecSchema.parse(baseSpec());
    assert.throws(() => applySetState(spec, "relay", "ghost", "active"), /not present/);
  });
});

describe("switchboard catalog set-state", () => {
  let workDir: string;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "switchboard-catalog-set-state-"));
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("mutates the spec file, rebuilds the bundle, and re-signs both catalogs", async () => {
    const specFile = path.join(workDir, "spec.json");
    await writeFile(specFile, JSON.stringify(baseSpec()), "utf8");
    const outputFile = path.join(workDir, "catalogs.json");
    const { io } = makeIo();

    const result = await runCatalogSetState({
      flags: new Map<string, string | boolean>([
        ["spec", specFile],
        ["output", outputFile]
      ]),
      positionals: ["catalog", "set-state", "relay", "relay-d", "active"],
      env: { PROOF_SERVICE_CATALOG_SIGNING_KEY: SIGNER_SEED },
      io
    });

    assert.equal(result.role, "relay");
    assert.equal(result.serviceId, "relay-d");
    assert.equal(result.previousState, "candidate");
    assert.equal(result.nextState, "active");
    assert.equal(result.rebuilt, true);

    const updatedSpec = JSON.parse(await readFile(specFile, "utf8")) as { relays: Array<{ relayId: string; state: string }> };
    assert.deepEqual(
      updatedSpec.relays.map((r) => [r.relayId, r.state]),
      [
        ["relay-a", "active"],
        ["relay-d", "active"]
      ]
    );

    const onDisk = JSON.parse(await readFile(outputFile, "utf8")) as { relays: unknown };
    const verified = await verifySignedServiceCatalog(onDisk.relays, {
      now: new Date("2026-05-01T12:30:00.000Z")
    });
    assert.equal(verified.catalog.members.find((m) => m.serviceId === "relay-d")?.state, "active");
  });

  it("supports the short form ['<service-id>', '<state>'] (assumes role=relay)", async () => {
    const specFile = path.join(workDir, "spec-short.json");
    await writeFile(specFile, JSON.stringify(baseSpec()), "utf8");
    const { io } = makeIo();

    const result = await runCatalogSetState({
      flags: new Map<string, string | boolean>([
        ["spec", specFile],
        ["no-rebuild", true]
      ]),
      positionals: ["catalog", "set-state", "relay-d", "draining"],
      env: { PROOF_SERVICE_CATALOG_SIGNING_KEY: SIGNER_SEED },
      io
    });

    assert.equal(result.role, "relay");
    assert.equal(result.serviceId, "relay-d");
    assert.equal(result.nextState, "draining");
    assert.equal(result.rebuilt, false);
  });

  it("rejects an unknown state literal", async () => {
    const specFile = path.join(workDir, "spec-bogus.json");
    await writeFile(specFile, JSON.stringify(baseSpec()), "utf8");

    await assert.rejects(
      runCatalogSetState({
        flags: new Map<string, string | boolean>([
          ["spec", specFile],
          ["no-rebuild", true]
        ]),
        positionals: ["catalog", "set-state", "relay", "relay-d", "bogus"],
        env: { PROOF_SERVICE_CATALOG_SIGNING_KEY: SIGNER_SEED }
      }),
      /candidate\|active\|degraded\|draining\|disabled/
    );
  });

  it("requires --spec", async () => {
    await assert.rejects(
      runCatalogSetState({
        flags: new Map<string, string | boolean>(),
        positionals: ["catalog", "set-state", "relay", "relay-d", "active"]
      }),
      /--spec/
    );
  });
});
