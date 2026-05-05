import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  JsonFileReplicatedDocumentStore,
  MemoryReplicatedDocumentStore,
  RevisionConflictError
} from "../src/replicated-doc-store.js";

describe("replicated document store", () => {
  it("enforces revision-checked document updates and exposes ordered changes", async () => {
    const store = new MemoryReplicatedDocumentStore<{ status: string }>();

    const created = await store.put("session:1", { status: "pending" });
    await assert.rejects(
      () => store.put("session:1", { status: "active" }),
      (error) => error instanceof RevisionConflictError
    );

    const updated = await store.put("session:1", { status: "active" }, { expectedRev: created.rev });
    assert.notEqual(updated.rev, created.rev);
    assert.deepEqual(await store.get("session:1"), updated);

    const changes = await store.changesSince(created.sequence);
    assert.deepEqual(
      changes.map((change) => [change.id, change.rev, change.value?.status]),
      [["session:1", updated.rev, "active"]]
    );
  });

  it("uses expiring leases for single-writer control-plane duties", async () => {
    const store = new MemoryReplicatedDocumentStore();
    const now = new Date("2026-04-29T12:00:00.000Z");

    const first = await store.acquireLease("fulfillment-batcher", "relay-a", { ttlMs: 60_000, now });
    assert.equal(first?.ownerId, "relay-a");

    const blocked = await store.acquireLease("fulfillment-batcher", "relay-b", { ttlMs: 60_000, now });
    assert.equal(blocked, undefined);

    const renewed = await store.acquireLease("fulfillment-batcher", "relay-a", { ttlMs: 60_000, now });
    assert.equal(renewed?.ownerId, "relay-a");

    const expired = await store.acquireLease("fulfillment-batcher", "relay-b", {
      ttlMs: 60_000,
      now: new Date("2026-04-29T12:01:01.000Z")
    });
    assert.equal(expired?.ownerId, "relay-b");
  });

  it("persists documents and leases to a JSON file", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "proof-replicated-docs-"));
    const storePath = path.join(dataDir, "store.json");
    const firstStore = new JsonFileReplicatedDocumentStore<{ count: number }>(storePath);

    const created = await firstStore.put("counter", { count: 1 });
    const lease = await firstStore.acquireLease("scheduler", "control-plane-a", {
      ttlMs: 30_000,
      now: new Date("2026-04-29T12:00:00.000Z")
    });
    assert.ok(lease);

    const secondStore = new JsonFileReplicatedDocumentStore<{ count: number }>(storePath);
    assert.deepEqual(await secondStore.get("counter"), created);
    assert.equal(
      await secondStore.acquireLease("scheduler", "control-plane-b", {
        ttlMs: 30_000,
        now: new Date("2026-04-29T12:00:01.000Z")
      }),
      undefined
    );

    const raw = JSON.parse(await readFile(storePath, "utf8")) as Record<string, unknown>;
    assert.equal(raw.sequence, 1);
  });
});
