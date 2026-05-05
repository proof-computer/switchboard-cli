import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { contextAddCommand } from "../cli/src/context/add.js";

describe("switchboard context add", () => {
  let workDir: string;
  const originalHome = process.env.SWITCHBOARD_HOME;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "switchboard-context-add-"));
    process.env.SWITCHBOARD_HOME = workDir;
  });

  after(async () => {
    if (originalHome === undefined) {
      delete process.env.SWITCHBOARD_HOME;
    } else {
      process.env.SWITCHBOARD_HOME = originalHome;
    }
    await rm(workDir, { recursive: true, force: true });
  });

  it("rejects --json (interactive only)", async () => {
    const flags = new Map<string, string | boolean>([["json", true]]);
    await assert.rejects(
      () => contextAddCommand(flags, ["context", "add", "demo"]),
      /interactive/i
    );
  });

  it("rejects when stdin is not a TTY", async () => {
    await writeFile(path.join(workDir, "contexts.json"), JSON.stringify({ contexts: {} }));
    const flags = new Map<string, string | boolean>();
    await assert.rejects(
      () => contextAddCommand(flags, ["context", "add", "demo"]),
      /TTY|interactive/i
    );
  });
});
