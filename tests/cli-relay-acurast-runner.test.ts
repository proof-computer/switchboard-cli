import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveAcurastScriptRunner } from "../cli/src/relay/acurast-script-runner.js";

describe("relay Acurast helper runner resolution", () => {
  it("uses bundled acurast-express from a packaged CLI", async () => {
    const root = await mkTempTree("switchboard-relay-packaged-");
    const workDir = await mkTempTree("switchboard-relay-workdir-");

    try {
      const distDir = path.join(root, "dist");
      const internalDir = path.join(distDir, "internal");
      const assetsDir = path.join(root, "assets");
      const currentFile = path.join(distDir, "index.js");
      const acurastExpress = path.join(internalDir, "acurast-express.js");
      await mkdir(internalDir, { recursive: true });
      await writeFile(currentFile, "");
      await writeFile(acurastExpress, "");

      const runner = resolveAcurastScriptRunner(
        ["acurast:deploy-express:direct", "--", "--yes"],
        { ACURAST_ENTRYPOINT: "src/jobs/express-webserver.ts" },
        workDir,
        { currentFile }
      );

      assert.equal(runner.command, process.execPath);
      assert.deepEqual(runner.args, [acurastExpress, "deploy-direct", "--yes"]);
      assert.equal(runner.cwd, workDir);
      assert.equal(runner.env.SWITCHBOARD_WORK_DIR, workDir);
      assert.equal(runner.env.SWITCHBOARD_INTERNAL_BIN_DIR, internalDir);
      assert.equal(runner.env.SWITCHBOARD_PACKAGED_ASSETS_DIR, assetsDir);
      assert.equal(runner.env.SWITCHBOARD_PREBUILT_JOB_BUNDLE, path.join(assetsDir, "jobs", "express-webserver", "bundle.cjs"));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps pnpm script execution for the source checkout", () => {
    const cwd = "/tmp/source-checkout";
    const runner = resolveAcurastScriptRunner(
      ["acurast:inspect-express", "--", "--deployment-id", "51808"],
      {},
      cwd,
      { currentFile: path.join(cwd, "cli", "src", "relay", "acurast-script-runner.ts") }
    );

    assert.equal(runner.command, "pnpm");
    assert.deepEqual(runner.args, ["acurast:inspect-express", "--", "--deployment-id", "51808"]);
    assert.equal(runner.cwd, cwd);
  });
});

async function mkTempTree(prefix: string): Promise<string> {
  const root = path.join(tmpdir(), `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}
