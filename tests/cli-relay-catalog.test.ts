import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  rebuildSignedRelayCatalog,
  readRelayCatalogStore,
  upsertRelayCatalogEntry,
  withRelayCatalogState,
  writeRelayCatalogStore
} from "../cli/src/relay/catalog.js";

import type { RelayCatalogInputEntry } from "../src/service-catalog.js";

const initialEntries: RelayCatalogInputEntry[] = [
  { relayId: "relay-a", apiBaseUrl: "https://relay-a.switchboard.proof.computer", state: "active" },
  { relayId: "relay-b", apiBaseUrl: "https://relay-b.switchboard.proof.computer", state: "active" },
  { relayId: "relay-c", apiBaseUrl: "https://relay-c.switchboard.proof.computer", state: "active" }
];

describe("relay catalog store", () => {
  let cwd: string;

  before(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "switchboard-relay-catalog-"));
  });

  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("reads relays/catalog.json from the cwd by default", async () => {
    const file = path.join(cwd, "relays", "catalog.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(initialEntries, null, 2), "utf8");

    const store = await readRelayCatalogStore(cwd);
    assert.equal(store.filePath, file);
    assert.equal(store.entries.length, 3);
    assert.equal(store.entries[0].relayId, "relay-a");
  });

  it("withRelayCatalogState updates the matching entry and strips legacy active flag", () => {
    const next = withRelayCatalogState(
      [
        ...initialEntries,
        { relayId: "relay-d", apiBaseUrl: "https://relay-d.switchboard.proof.computer", active: true } as RelayCatalogInputEntry
      ],
      "relay-d",
      "candidate"
    );
    const updated = next.find((entry) => entry.relayId === "relay-d");
    assert.equal(updated?.state, "candidate");
    assert.equal(updated?.active, undefined);
  });

  it("withRelayCatalogState throws if the relay is not in the catalog", () => {
    assert.throws(
      () => withRelayCatalogState(initialEntries, "relay-zz", "candidate"),
      /relay-zz is not present in the catalog/
    );
  });

  it("writeRelayCatalogStore writes a JSON array with trailing newline", async () => {
    const file = path.join(cwd, "out", "catalog.json");
    await writeRelayCatalogStore({ filePath: file, entries: initialEntries });
    const text = await readFile(file, "utf8");
    assert.ok(text.endsWith("\n"));
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed, initialEntries);
  });

  it("upsertRelayCatalogEntry inserts a new relay with state", () => {
    const next = upsertRelayCatalogEntry(initialEntries, {
      relayId: "relay-d",
      apiBaseUrl: "https://relay-d.switchboard.proof.computer",
      state: "candidate"
    });
    assert.equal(next.length, 4);
    const added = next.find((entry) => entry.relayId === "relay-d");
    assert.equal(added?.state, "candidate");
    assert.equal(added?.apiBaseUrl, "https://relay-d.switchboard.proof.computer");
  });

  it("upsertRelayCatalogEntry updates an existing relay's state and URLs", () => {
    const next = upsertRelayCatalogEntry(initialEntries, {
      relayId: "relay-a",
      apiBaseUrl: "https://relay-a.new.example",
      state: "draining"
    });
    assert.equal(next.length, 3);
    const updated = next.find((entry) => entry.relayId === "relay-a");
    assert.equal(updated?.state, "draining");
    assert.equal(updated?.apiBaseUrl, "https://relay-a.new.example");
  });

  it("rebuildSignedRelayCatalog requires a signing key in env", async () => {
    await assert.rejects(
      rebuildSignedRelayCatalog(
        { filePath: path.join(cwd, "out", "catalog.json"), entries: initialEntries },
        {
          io: { log: () => {}, warn: () => {}, error: () => {} },
          env: {}
        }
      ),
      /SIGNING_KEY/
    );
  });

  it("rebuildSignedRelayCatalog calls runCatalogBuild in-process with the relays JSON", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const calls: number[] = [];
    await rebuildSignedRelayCatalog(
      { filePath: path.join(cwd, "out", "catalog.json"), entries: initialEntries },
      {
        cwd,
        io: { log: () => {}, warn: () => {}, error: () => {} },
        env: {
          PROOF_SERVICE_CATALOG_SIGNING_KEY: "//Alice",
          PROOF_CONTROL_PLANE_URL: "https://control.example"
        },
        build: async ({ env }) => {
          calls.push(1);
          capturedEnv = env;
          return undefined;
        }
      }
    );
    assert.equal(calls.length, 1);
    assert.equal(capturedEnv?.PROOF_SERVICE_CATALOG_SIGNING_KEY, "//Alice");
    const relays = JSON.parse(capturedEnv!.PROOF_NETWORK_MANIFEST_RELAYS_JSON!);
    assert.deepEqual(relays, initialEntries);
  });

  it("rebuildSignedRelayCatalog propagates failures from runCatalogBuild", async () => {
    await assert.rejects(
      rebuildSignedRelayCatalog(
        { filePath: path.join(cwd, "out", "catalog.json"), entries: initialEntries },
        {
          cwd,
          io: { log: () => {}, warn: () => {}, error: () => {} },
          env: { PROOF_SERVICE_CATALOG_SIGNING_KEY: "//Alice" },
          build: async () => {
            throw new Error("build blew up");
          }
        }
      ),
      /build blew up/
    );
  });
});
