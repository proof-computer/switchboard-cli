import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployRunnerUrl = pathToFileURL(path.join(cliRoot, "scripts/acurast/switchboard-deploy.ts")).href;

describe("switchboard deploy helper script resolution", () => {
  it("runs internal helper scripts from the CLI package when the workload root is elsewhere", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-workload-root-"));

    try {
      const mod = await importDeployRunnerWithWorkDir(workDir);
      const mapped = mod.mapSwitchboardDeployPnpmScript(
        "pnpm",
        ["--silent", "hub:fund-native-asset-quote", "--", "--dry-run"],
        undefined
      );

      assert.ok(mapped);
      assert.equal(mapped.command, "pnpm");
      assert.deepEqual(mapped.args, ["--silent", "hub:fund-native-asset-quote", "--", "--dry-run"]);
      assert.equal(mapped.cwd, cliRoot);
      assert.equal(mapped.env.SWITCHBOARD_WORK_DIR, workDir);
      assert.equal(mapped.env.DOTENV_CONFIG_PATH, path.join(workDir, ".env"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("does not remap unrelated pnpm scripts", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-workload-root-"));

    try {
      const mod = await importDeployRunnerWithWorkDir(workDir);
      const mapped = mod.mapSwitchboardDeployPnpmScript("pnpm", ["--silent", "test"], undefined);
      assert.equal(mapped, undefined);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

async function importDeployRunnerWithWorkDir(workDir: string): Promise<{
  mapSwitchboardDeployPnpmScript: (
    command: string,
    args: string[],
    env: Record<string, string | undefined> | undefined
  ) => { command: string; args: string[]; env: Record<string, string | undefined>; cwd?: string } | undefined;
}> {
  const oldWorkDir = process.env.SWITCHBOARD_WORK_DIR;
  const oldInternalBinDir = process.env.SWITCHBOARD_INTERNAL_BIN_DIR;
  delete process.env.SWITCHBOARD_INTERNAL_BIN_DIR;
  process.env.SWITCHBOARD_WORK_DIR = workDir;
  try {
    return await import(`${deployRunnerUrl}?case=${Date.now()}-${Math.random()}`);
  } finally {
    if (oldWorkDir === undefined) {
      delete process.env.SWITCHBOARD_WORK_DIR;
    } else {
      process.env.SWITCHBOARD_WORK_DIR = oldWorkDir;
    }
    if (oldInternalBinDir === undefined) {
      delete process.env.SWITCHBOARD_INTERNAL_BIN_DIR;
    } else {
      process.env.SWITCHBOARD_INTERNAL_BIN_DIR = oldInternalBinDir;
    }
  }
}
