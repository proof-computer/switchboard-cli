import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runRelayBudget } from "../cli/src/relay/budget.js";

interface Captured {
  log: string[];
  warn: string[];
  error: string[];
}

function makeIo(): { io: { log: (l: string) => void; warn: (l: string) => void; error: (l: string) => void }; captured: Captured } {
  const captured: Captured = { log: [], warn: [], error: [] };
  return {
    io: {
      log: (line) => { captured.log.push(line); },
      warn: (line) => { captured.warn.push(line); },
      error: (line) => { captured.error.push(line); }
    },
    captured
  };
}

describe("relay budget", () => {
  it("reproduces the 1h-at-default-rate baseline (40bn units)", async () => {
    const { io } = makeIo();
    const result = await runRelayBudget({
      flags: new Map<string, string | boolean>(),
      positionals: ["relay", "budget", "1h"],
      io
    });
    assert.equal(result.durationMs, 3_600_000);
    assert.equal(result.ratePerMs, 11_111n);
    assert.equal(result.recommendedMaxCost, 11_111n * 3_600_000n);
    // 11_111 * 3_600_000 = 39_999_600_000 — close to the 40bn historical default
    assert.ok(result.recommendedMaxCost <= 40_000_000_000n);
    assert.ok(result.recommendedMaxCost >= 39_000_000_000n);
  });

  it("scales linearly to a 7d execution", async () => {
    const { io } = makeIo();
    const result = await runRelayBudget({
      flags: new Map<string, string | boolean>(),
      positionals: ["relay", "budget", "7d"],
      io
    });
    assert.equal(result.durationMs, 7 * 24 * 60 * 60_000);
    assert.equal(result.recommendedMaxCost, 11_111n * BigInt(7 * 24 * 60 * 60_000));
  });

  it("applies --margin-percent on top of the base cost", async () => {
    const { io } = makeIo();
    const result = await runRelayBudget({
      flags: new Map<string, string | boolean>([["margin-percent", "20"]]),
      positionals: ["relay", "budget", "1h"],
      io
    });
    const base = 11_111n * 3_600_000n;
    assert.equal(result.recommendedMaxCost, base + (base * 20n) / 100n);
  });

  it("honors --rate-per-ms override", async () => {
    const { io } = makeIo();
    const result = await runRelayBudget({
      flags: new Map<string, string | boolean>([["rate-per-ms", "20000"]]),
      positionals: ["relay", "budget", "1h"],
      io
    });
    assert.equal(result.recommendedMaxCost, 20_000n * 3_600_000n);
  });

  it("--update writes executionMs + maxCostPerExecution into the spec", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-relay-budget-update-"));
    try {
      const specPath = path.join(cwd, "relays", "relay-z.json");
      await mkdir(path.dirname(specPath), { recursive: true });
      await writeFile(
        specPath,
        JSON.stringify({
          version: 1,
          relayId: "relay-z",
          target: "acurast",
          catalogState: "candidate",
          apiBaseUrl: "https://relay-z.example",
          peers: [],
          secrets: { relayerPrivateKeyEnv: "FOO" },
          acurast: {
            deployerSeedEnv: "X",
            projectName: "p",
            stageDir: "s",
            maxCostPerExecution: "40000000000",
            includeEnv: []
          }
        }),
        "utf8"
      );
      const { io } = makeIo();
      const result = await runRelayBudget({
        flags: new Map<string, string | boolean>([["update", specPath]]),
        positionals: ["relay", "budget", "7d"],
        io,
        cwd
      });
      assert.equal(result.updatedSpecPath, specPath);
      const updated = JSON.parse(await readFile(specPath, "utf8"));
      assert.equal(updated.acurast.executionMs, 7 * 24 * 60 * 60_000);
      assert.equal(updated.acurast.maxCostPerExecution, (11_111n * BigInt(7 * 24 * 60 * 60_000)).toString());
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects --update against a non-acurast spec", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-relay-budget-bootstrap-"));
    try {
      const specPath = path.join(cwd, "relays", "relay-a.json");
      await mkdir(path.dirname(specPath), { recursive: true });
      await writeFile(specPath, JSON.stringify({ version: 1, relayId: "relay-a", target: "bootstrap" }), "utf8");
      await assert.rejects(
        runRelayBudget({
          flags: new Map<string, string | boolean>([["update", specPath]]),
          positionals: ["relay", "budget", "7d"],
          cwd
        }),
        /only works for acurast specs/
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects bad durations", async () => {
    await assert.rejects(
      runRelayBudget({
        flags: new Map<string, string | boolean>(),
        positionals: ["relay", "budget", "1month"]
      }),
      /Invalid duration/
    );
  });
});
