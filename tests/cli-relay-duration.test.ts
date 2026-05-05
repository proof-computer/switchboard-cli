import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { formatDuration, parseDuration } from "../cli/src/relay/duration.js";
import { runRelayScaffold } from "../cli/src/relay/scaffold.js";

describe("parseDuration", () => {
  it("accepts ms / s / m / h / d / w", () => {
    assert.equal(parseDuration("500ms"), 500);
    assert.equal(parseDuration("30s"), 30_000);
    assert.equal(parseDuration("15m"), 15 * 60_000);
    assert.equal(parseDuration("1h"), 60 * 60_000);
    assert.equal(parseDuration("24h"), 24 * 60 * 60_000);
    assert.equal(parseDuration("7d"), 7 * 24 * 60 * 60_000);
    assert.equal(parseDuration("2w"), 2 * 7 * 24 * 60 * 60_000);
  });

  it("rejects unknown formats", () => {
    assert.throws(() => parseDuration("1y"), /Invalid duration/);
    assert.throws(() => parseDuration("1.5h"), /Invalid duration/);
    assert.throws(() => parseDuration("1h30m"), /Invalid duration/);
    assert.throws(() => parseDuration(""), /Invalid duration/);
    assert.throws(() => parseDuration("h"), /Invalid duration/);
  });
});

describe("formatDuration", () => {
  it("picks the largest exact unit for the value", () => {
    // 7d == 1w in ms, so the formatter normalises up to the larger unit.
    assert.equal(formatDuration(parseDuration("7d")), "1w");
    assert.equal(formatDuration(parseDuration("2w")), "2w");
    assert.equal(formatDuration(parseDuration("90m")), "90m");
    assert.equal(formatDuration(parseDuration("3d")), "3d");
    assert.equal(formatDuration(500), "500ms");
  });
});

describe("relay scaffold --duration", () => {
  it("writes spec.acurast.executionMs from the parsed duration", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-relay-duration-scaffold-"));
    try {
      await runRelayScaffold({
        flags: new Map<string, string | boolean>([
          ["target", "acurast"],
          ["api-base-url", "https://relay-z.example"],
          ["duration", "7d"],
          ["manager-id", "9470"]
        ]),
        positionals: ["relay", "scaffold", "relay-z"],
        cwd
      });
      const onDisk = JSON.parse(await readFile(path.join(cwd, "relays", "relay-z.json"), "utf8"));
      assert.equal(onDisk.acurast.executionMs, 7 * 24 * 60 * 60_000);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects garbage durations at scaffold time", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-relay-duration-bad-"));
    try {
      await mkdir(path.join(cwd, "relays"), { recursive: true });
      await assert.rejects(
        runRelayScaffold({
          flags: new Map<string, string | boolean>([
            ["target", "acurast"],
            ["api-base-url", "https://relay-z.example"],
            ["duration", "1month"]
          ]),
          positionals: ["relay", "scaffold", "relay-z"],
          cwd
        }),
        /Invalid duration/
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("omits executionMs when --duration is not passed (uses schema default)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-relay-duration-default-"));
    try {
      await runRelayScaffold({
        flags: new Map<string, string | boolean>([
          ["target", "acurast"],
          ["api-base-url", "https://relay-z.example"],
          ["manager-id", "9470"]
        ]),
        positionals: ["relay", "scaffold", "relay-z"],
        cwd
      });
      const onDisk = JSON.parse(await readFile(path.join(cwd, "relays", "relay-z.json"), "utf8"));
      // schema default kicks in at deploy time; the spec on disk doesn't include the field
      assert.equal(onDisk.acurast.executionMs, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
