import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { runCatalogBuild } from "../cli/src/catalog/index.js";
import { verifySignedServiceCatalog } from "../src/service-catalog.js";

const SIGNER_SEED = "//Alice//switchboard-service-catalog";

interface CapturedIo {
  log: string[];
  warn: string[];
  error: string[];
}

function makeIo(): { io: { log: (l: string) => void; warn: (l: string) => void; error: (l: string) => void }; captured: CapturedIo } {
  const captured: CapturedIo = { log: [], warn: [], error: [] };
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

describe("switchboard catalog build", () => {
  let workDir: string;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "switchboard-catalog-build-"));
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("builds a signed bundle from a JSON spec file and writes it atomically", async () => {
    const specFile = path.join(workDir, "spec.json");
    await writeFile(
      specFile,
      JSON.stringify({
        version: 1,
        ttlSeconds: 3600,
        sequence: 42,
        issuedAt: "2026-05-01T12:00:00.000Z",
        controlApi: [
          {
            serviceId: "control-bootstrap",
            apiBaseUrl: "https://control.example",
            capabilities: ["quotes"]
          }
        ],
        relays: [
          { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "active" },
          { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "candidate" }
        ]
      }),
      "utf8"
    );
    const outputFile = path.join(workDir, "out", "catalogs.json");
    const { io, captured } = makeIo();

    const result = await runCatalogBuild({
      flags: new Map<string, string | boolean>([
        ["spec", specFile],
        ["output", outputFile]
      ]),
      env: { PROOF_SERVICE_CATALOG_SIGNING_KEY: SIGNER_SEED },
      io
    });

    assert.equal(result.bundle.controlApi.catalog.role, "control-api");
    assert.equal(result.bundle.relays.catalog.role, "relay");
    assert.equal(result.bundle.relays.catalog.sequence, 42);
    assert.equal(result.issuedAt, "2026-05-01T12:00:00.000Z");

    const onDisk = JSON.parse(await readFile(outputFile, "utf8")) as { controlApi: unknown; relays: unknown };
    const verified = await verifySignedServiceCatalog(onDisk.relays, {
      expectedSigner: result.signer,
      now: new Date("2026-05-01T12:30:00.000Z")
    });
    assert.equal(verified.catalog.members.length, 2);
    assert.deepEqual(
      verified.catalog.members.map((m) => [m.serviceId, m.state]),
      [
        ["relay-a", "active"],
        ["relay-d", "candidate"]
      ]
    );

    assert.match(captured.log.join("\n"), /Wrote signed service catalogs/);
  });

  it("falls back to env inputs when no --spec is passed (back-compat with the script)", async () => {
    const outputFile = path.join(workDir, "env-driven", "catalogs.json");
    const { io } = makeIo();

    await runCatalogBuild({
      flags: new Map<string, string | boolean>([["output", outputFile]]),
      env: {
        PROOF_SERVICE_CATALOG_SIGNING_KEY: SIGNER_SEED,
        PROOF_CONTROL_PLANE_URL: "https://control.example",
        PROOF_CONTROL_API_SERVICE_ID: "control-bootstrap",
        PROOF_CONTROL_API_CAPABILITIES: "quotes,manifest",
        PROOF_NETWORK_MANIFEST_RELAYS_JSON: JSON.stringify([
          { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "active" }
        ]),
        PROOF_SERVICE_CATALOG_TTL_SECONDS: "3600",
        PROOF_SERVICE_CATALOG_SEQUENCE: "7"
      },
      io
    });

    const onDisk = JSON.parse(await readFile(outputFile, "utf8")) as { controlApi: { catalog: { sequence: number; members: Array<{ serviceId: string }> } } };
    assert.equal(onDisk.controlApi.catalog.sequence, 7);
    assert.equal(onDisk.controlApi.catalog.members[0].serviceId, "control-bootstrap");
  });

  it("falls back to PROOF_MAINNET_MANIFEST_SIGNING_KEY when no service-catalog key is set", async () => {
    const outputFile = path.join(workDir, "fallback-key", "catalogs.json");
    const { io } = makeIo();

    await runCatalogBuild({
      flags: new Map<string, string | boolean>([["output", outputFile]]),
      env: {
        PROOF_MAINNET_MANIFEST_SIGNING_KEY: SIGNER_SEED,
        PROOF_CONTROL_PLANE_URL: "https://control.example",
        PROOF_NETWORK_MANIFEST_RELAYS_JSON: JSON.stringify([
          { relayId: "relay-a", apiBaseUrl: "https://relay-a.example" }
        ])
      },
      io
    });

    const onDisk = JSON.parse(await readFile(outputFile, "utf8")) as { relays: { signature: { signer: string } } };
    assert.equal(typeof onDisk.relays.signature.signer, "string");
  });

  it("falls back to PROOF_MAINNET_MANIFEST_SIGNING_KEY when service-catalog key is an empty placeholder", async () => {
    const outputFile = path.join(workDir, "empty-fallback-key", "catalogs.json");

    await runCatalogBuild({
      flags: new Map<string, string | boolean>([["output", outputFile]]),
      env: {
        PROOF_SERVICE_CATALOG_SIGNING_KEY: "",
        PROOF_MAINNET_MANIFEST_SIGNING_KEY: SIGNER_SEED,
        PROOF_CONTROL_PLANE_URL: "https://control.example",
        PROOF_NETWORK_MANIFEST_RELAYS_JSON: JSON.stringify([
          { relayId: "relay-a", apiBaseUrl: "https://relay-a.example" }
        ])
      }
    });

    const onDisk = JSON.parse(await readFile(outputFile, "utf8")) as { relays: { signature: { signer: string } } };
    assert.equal(typeof onDisk.relays.signature.signer, "string");
  });

  it("rejects builds with no relay entries", async () => {
    await assert.rejects(
      runCatalogBuild({
        flags: new Map<string, string | boolean>(),
        env: {
          PROOF_SERVICE_CATALOG_SIGNING_KEY: SIGNER_SEED,
          PROOF_CONTROL_PLANE_URL: "https://control.example",
          PROOF_NETWORK_MANIFEST_RELAYS_JSON: "[]"
        }
      }),
      /at least one relay/
    );
  });

  it("rejects builds with no signing key", async () => {
    await assert.rejects(
      runCatalogBuild({
        flags: new Map<string, string | boolean>(),
        env: {
          PROOF_CONTROL_PLANE_URL: "https://control.example",
          PROOF_NETWORK_MANIFEST_RELAYS_JSON: JSON.stringify([
            { relayId: "relay-a", apiBaseUrl: "https://relay-a.example" }
          ])
        }
      }),
      /signing key/i
    );
  });
});
