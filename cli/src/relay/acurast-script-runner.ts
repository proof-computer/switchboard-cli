import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AcurastScriptRunnerContext {
  currentFile?: string;
}

interface ResolvedAcurastScriptRunner {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export function resolveAcurastScriptRunner(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  context: AcurastScriptRunnerContext = {}
): ResolvedAcurastScriptRunner {
  const currentFile = context.currentFile ?? fileURLToPath(import.meta.url);
  if (isSourceCliFile(currentFile)) {
    return { command: "pnpm", args, env, cwd };
  }

  const distDir = path.dirname(currentFile);
  const internalDir = path.join(distDir, "internal");
  const assetsDir = path.join(distDir, "..", "assets");
  const acurastExpress = path.join(internalDir, "acurast-express.js");
  if (!existsSync(acurastExpress)) {
    throw new Error("Acurast relay commands require the packaged Acurast helper. Rebuild or reinstall the Switchboard CLI package.");
  }

  const bundleName = packagedJobBundleName(env.ACURAST_ENTRYPOINT);
  return {
    command: process.execPath,
    args: [acurastExpress, ...mapAcurastScriptArgs(args)],
    cwd,
    env: {
      ...env,
      SWITCHBOARD_WORK_DIR: cwd,
      SWITCHBOARD_INTERNAL_BIN_DIR: internalDir,
      SWITCHBOARD_PACKAGED_ASSETS_DIR: assetsDir,
      SWITCHBOARD_PREBUILT_JOB_BUNDLE: bundleName ? path.join(assetsDir, "jobs", bundleName, "bundle.cjs") : undefined
    }
  };
}

export function spawnAcurastScript(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  const resolved = resolveAcurastScriptRunner(args, env, cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd: resolved.cwd,
      env: resolved.env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}

function mapAcurastScriptArgs(args: string[]): string[] {
  const scriptName = args[0];
  const forwarded = args[1] === "--" ? args.slice(2) : args.slice(1);
  switch (scriptName) {
    case "acurast:prepare-express":
      return ["prepare", ...forwarded];
    case "acurast:estimate-express":
      return ["estimate-fee", ...forwarded];
    case "acurast:deploy-express:dry-run":
      return ["deploy-dry-run", ...forwarded];
    case "acurast:deploy-express":
      return ["deploy", ...forwarded];
    case "acurast:deploy-express:direct":
      return ["deploy-direct", ...forwarded];
    case "acurast:update-env-express":
      return ["update-env", ...forwarded];
    case "acurast:status-express":
      return ["status", ...forwarded];
    case "acurast:inspect-express":
      return ["inspect", ...forwarded];
    default:
      throw new Error(`No packaged Acurast helper maps ${scriptName ?? "<missing script>"}`);
  }
}

function packagedJobBundleName(_entrypoint: string | undefined): undefined {
  return undefined;
}

function isSourceCliFile(currentFile: string): boolean {
  return currentFile.replace(/\\/g, "/").includes("/cli/src/");
}
