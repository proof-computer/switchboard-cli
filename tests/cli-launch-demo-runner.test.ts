import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveLaunchDemoEstimateRunner } from "../cli/src/index.js";

describe("launch-demo runner resolution", () => {
  it("uses bundled internal helpers from a packaged CLI even inside a user project with matching scripts", async () => {
    const root = await mkTempTree("switchboard-cli-packaged-");
    const workDir = await mkTempTree("switchboard-user-project-");

    try {
      const distDir = path.join(root, "dist");
      const internalDir = path.join(distDir, "internal");
      const assetsDir = path.join(root, "assets");
      const currentFile = path.join(distDir, "index.js");
      const acurastExpress = path.join(internalDir, "acurast-express.js");
      await mkdir(internalDir, { recursive: true });
      await writeFile(currentFile, "");
      await writeFile(acurastExpress, "");
      await writeFile(
        path.join(workDir, "package.json"),
        JSON.stringify({ scripts: { "acurast:estimate-express": "echo should-not-run" } })
      );

      const runner = await resolveLaunchDemoEstimateRunner(
        { ACURAST_ENTRYPOINT: "src/server.ts" },
        { cwd: workDir, currentFile, workDir }
      );

      assert.equal(runner.command, process.execPath);
      assert.deepEqual(runner.args, [acurastExpress, "estimate-fee", "--json"]);
      assert.equal(runner.cwd, undefined);
      assert.equal(runner.env.SWITCHBOARD_WORK_DIR, workDir);
      assert.equal(runner.env.SWITCHBOARD_INTERNAL_BIN_DIR, internalDir);
      assert.equal(runner.env.SWITCHBOARD_PACKAGED_ASSETS_DIR, assetsDir);
      assert.equal(runner.env.SWITCHBOARD_PREBUILT_JOB_BUNDLE, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps pnpm script execution for the source checkout", async () => {
    const root = await mkTempTree("switchboard-cli-source-");

    try {
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: { "acurast:estimate-express": "tsx scripts/acurast/express-harness.ts estimate-fee" } })
      );

      const runner = await resolveLaunchDemoEstimateRunner(
        { ACURAST_ENTRYPOINT: "src/server.ts" },
        { cwd: root, currentFile: path.join(root, "cli", "src", "index.ts"), workDir: "/tmp/demo-project" }
      );

      assert.equal(runner.command, "pnpm");
      assert.deepEqual(runner.args, ["--silent", "acurast:estimate-express", "--", "--json"]);
      assert.equal(runner.cwd, root);
      assert.equal(runner.env.SWITCHBOARD_WORK_DIR, "/tmp/demo-project");
      assert.equal(runner.env.ACURAST_ENTRYPOINT, "src/server.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function mkTempTree(prefix: string): Promise<string> {
  const root = path.join(tmpdir(), `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}
