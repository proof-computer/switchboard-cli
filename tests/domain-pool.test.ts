import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseDomainPool, selectDomainFromPool } from "../src/domain-pool.js";

describe("domain pool helpers", () => {
  it("normalizes and deduplicates configured domains", () => {
    assert.deepEqual(parseDomainPool(" Ingress.Works. , jobs.example.com, ingress.works "), [
      "ingress.works",
      "jobs.example.com"
    ]);
  });

  it("falls back when no domains are configured", () => {
    assert.deepEqual(parseDomainPool("", ["ingress.test"]), ["ingress.test"]);
  });

  it("selects a stable domain for the same seed", () => {
    const pool = ["ingress.works", "jobs.example.com", "jobs.example.net"];
    assert.equal(selectDomainFromPool(pool, "run-123"), selectDomainFromPool(pool, "run-123"));
    assert.ok(pool.includes(selectDomainFromPool(pool, "run-456")));
  });
});
