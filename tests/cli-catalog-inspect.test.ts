import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { runCatalogInspect } from "../cli/src/catalog/index.js";
import { signServiceCatalog, type ServiceCatalog } from "../src/service-catalog.js";

const SIGNER_SEED = "//Alice//switchboard-service-catalog";
const OTHER_SIGNER_SEED = "//Bob//switchboard-service-catalog";

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
    sequence: 42,
    issuedAt: "2030-05-01T12:00:00.000Z",
    expiresAt: "2030-05-02T12:00:00.000Z",
    members: [
      { serviceId: "relay-a", state: "active", apiBaseUrl: "https://relay-a.example/" },
      { serviceId: "relay-d", state: "candidate", apiBaseUrl: "https://relay-d.example/" }
    ]
  };
}

describe("switchboard catalog inspect", () => {
  let workDir: string;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "switchboard-catalog-inspect-"));
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("verifies and pretty-prints a single signed catalog file", async () => {
    const signed = await signServiceCatalog(relayCatalog(), SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42,
      signedAt: "2030-05-01T12:00:00.000Z"
    });
    const file = path.join(workDir, "relay.json");
    await writeFile(file, JSON.stringify(signed), "utf8");
    const { io, captured } = makeIo();

    const result = await runCatalogInspect({
      flags: new Map<string, string | boolean>([
        ["file", file],
        ["signer", signed.signature.signer]
      ]),
      io
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].signed.catalog.role, "relay");
    assert.equal(result[0].signer, signed.signature.signer);
    const output = captured.log.join("\n");
    assert.match(output, /role\s*:\s*relay/);
    assert.match(output, /relay-a\s+state=active/);
    assert.match(output, /relay-d\s+state=candidate/);
  });

  it("inspects every entry of a signed-bundle file", async () => {
    const relays = await signServiceCatalog(relayCatalog(), SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const controlApi = await signServiceCatalog(
      {
        version: 1,
        role: "control-api",
        sequence: 42,
        issuedAt: "2030-05-01T12:00:00.000Z",
        expiresAt: "2030-05-02T12:00:00.000Z",
        members: [
          { serviceId: "control-bootstrap", state: "active", apiBaseUrl: "https://control.example" }
        ]
      },
      SIGNER_SEED,
      { scheme: "substrate-sr25519", ss58Format: 42 }
    );
    const bundle = path.join(workDir, "bundle.json");
    await writeFile(bundle, JSON.stringify({ controlApi, relays }), "utf8");
    const { io } = makeIo();

    const result = await runCatalogInspect({
      flags: new Map<string, string | boolean>([
        ["file", bundle],
        ["signer", relays.signature.signer]
      ]),
      io
    });

    const roles = result.map((r) => r.signed.catalog.role).sort();
    assert.deepEqual(roles, ["control-api", "relay"]);
  });

  it("rejects a catalog signed by a different key when --signer is pinned", async () => {
    const wrong = await signServiceCatalog(relayCatalog(), OTHER_SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const expected = await signServiceCatalog(relayCatalog(), SIGNER_SEED, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const file = path.join(workDir, "wrong.json");
    await writeFile(file, JSON.stringify(wrong), "utf8");

    await assert.rejects(
      runCatalogInspect({
        flags: new Map<string, string | boolean>([
          ["file", file],
          ["signer", expected.signature.signer]
        ])
      }),
      /does not match expected signer/
    );
  });

  it("rejects an expired catalog by default and accepts it under --allow-expired", async () => {
    const expired = await signServiceCatalog(
      { ...relayCatalog(), expiresAt: "2020-01-01T00:00:00.000Z" },
      SIGNER_SEED,
      { scheme: "substrate-sr25519", ss58Format: 42 }
    );
    const file = path.join(workDir, "expired.json");
    await writeFile(file, JSON.stringify(expired), "utf8");

    await assert.rejects(
      runCatalogInspect({ flags: new Map<string, string | boolean>([["file", file]]) }),
      /expired/
    );

    const { io } = makeIo();
    const result = await runCatalogInspect({
      flags: new Map<string, string | boolean>([
        ["file", file],
        ["allow-expired", true]
      ]),
      io
    });
    assert.equal(result[0].expired, true);
  });

  it("requires --file or --url and rejects passing both", async () => {
    await assert.rejects(
      runCatalogInspect({ flags: new Map<string, string | boolean>() }),
      /requires --file/
    );
    await assert.rejects(
      runCatalogInspect({
        flags: new Map<string, string | boolean>([
          ["file", "x"],
          ["url", "https://x"]
        ])
      }),
      /not both/
    );
  });
});
