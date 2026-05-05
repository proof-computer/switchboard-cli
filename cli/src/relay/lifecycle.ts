import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseRelayDeploymentSpec, type RelayDeploymentSpec } from "../../../src/relay-deployment-spec.js";
import { spawnAcurastScript } from "./acurast-script-runner.js";
import { buildAcurastCliEnv } from "./acurast-cli-env.js";
import { readLatestAcurastDeployState } from "./acurast-deploy-state.js";
import { loadRelayDeploymentHistory } from "./history.js";

export interface RelayLifecycleIo {
  log: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

const DEFAULT_IO: RelayLifecycleIo = {
  log: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line)
};

export interface RelayLifecycleArgs {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: RelayLifecycleIo;
  cwd?: string;
  /** Replace the Acurast helper spawner. Used by tests. */
  spawnPnpm?: (args: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<number>;
}

/** `switchboard relay inspect <id> [--deployment-id <n>] [--watch]` */
export async function runRelayInspect(args: RelayLifecycleArgs): Promise<{ deploymentId: string }> {
  const { spec: _spec, deploymentId, env, cwd, io, spawner } = await resolveLifecycleContext(args, "inspect");
  const passthrough: string[] = ["acurast:inspect-express", "--", "--deployment-id", deploymentId];
  if (args.flags.get("watch") === true) passthrough.push("--watch");
  if (args.flags.get("events") === true) passthrough.push("--events");
  io.log(`> acurast inspect-express ${passthrough.slice(2).join(" ")}`);
  const code = await spawner(passthrough, env, cwd);
  if (code !== 0) {
    throw new Error(`acurast:inspect-express exited with code ${code}`);
  }
  return { deploymentId };
}

/** `switchboard relay deployment-status <id> [--deployment-id <n>]` */
export async function runRelayDeploymentStatus(args: RelayLifecycleArgs): Promise<{ deploymentId: string }> {
  const { spec: _spec, deploymentId, env, cwd, io, spawner } = await resolveLifecycleContext(args, "status");
  io.log(`> acurast status-express --deployment-id ${deploymentId}`);
  const code = await spawner(["acurast:status-express", "--", "--deployment-id", deploymentId], env, cwd);
  if (code !== 0) {
    throw new Error(`acurast:status-express exited with code ${code}`);
  }
  return { deploymentId };
}

interface LifecycleContext {
  spec: RelayDeploymentSpec;
  deploymentId: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  io: RelayLifecycleIo;
  spawner: (args: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<number>;
}

async function resolveLifecycleContext(args: RelayLifecycleArgs, verb: string): Promise<LifecycleContext> {
  const io = args.io ?? DEFAULT_IO;
  const cwd = args.cwd ?? process.cwd();
  const baseEnv = args.env ?? process.env;
  const spawner = args.spawnPnpm ?? spawnAcurastScript;

  // positionals shape: ["relay", "<verb>", "<id>"]
  const relayId = (args.positionals ?? [])[2];
  if (!relayId || !/^[a-z0-9-]+$/.test(relayId)) {
    throw new Error(`Usage: switchboard relay ${verb} <relay-id> [--deployment-id <n>]`);
  }
  const specFlag = stringFlag(args.flags, "spec") ?? stringFlag(args.flags, "spec-file");
  const specPath = specFlag ?? path.join(cwd, "relays", `${relayId}.json`);
  const raw = await readFile(specPath, "utf8").catch(() => {
    throw new Error(`Spec ${specPath} not found. Run \`switchboard relay scaffold ${relayId}\` first.`);
  });
  const spec = parseRelayDeploymentSpec(JSON.parse(raw));
  if (spec.target !== "acurast") {
    throw new Error(`relay ${verb} is acurast-target only; ${specPath} has target=${spec.target}`);
  }
  if (spec.relayId !== relayId) {
    throw new Error(
      `Spec at ${specPath} declares relayId=${spec.relayId}, but command was invoked for ${relayId}`
    );
  }

  const deploymentId = await resolveDeploymentId(args.flags, relayId, spec, cwd);
  const env = buildAcurastCliEnv(spec, baseEnv);

  return { spec, deploymentId, env, cwd, io, spawner };
}

async function resolveDeploymentId(
  flags: Map<string, string | boolean>,
  relayId: string,
  spec: RelayDeploymentSpec,
  cwd: string
): Promise<string> {
  const explicit = stringFlag(flags, "deployment-id");
  if (explicit) {
    if (!/^[0-9]+$/.test(explicit)) {
      throw new Error("--deployment-id must be a numeric Acurast job sequence");
    }
    return explicit;
  }
  // Prefer the stage-dir state because it always reflects the latest
  // deploy attempt that successfully registered on chain. History
  // only carries an `acurast.deploymentId` for entries the deploy
  // flow recorded post-success; a `setEnvironment` trap leaves the
  // entry without a deploymentId, so a stale older success would
  // shadow the actually-relevant failed attempt we want to recover.
  if (spec.acurast) {
    const stageDir = path.isAbsolute(spec.acurast.stageDir)
      ? spec.acurast.stageDir
      : path.resolve(cwd, spec.acurast.stageDir);
    const state = await readLatestAcurastDeployState(stageDir).catch(() => undefined);
    if (state?.deploymentId) {
      return state.deploymentId;
    }
  }
  const history = await loadRelayDeploymentHistory(relayId, cwd).catch(() => undefined);
  if (history) {
    for (let i = history.entries.length - 1; i >= 0; i -= 1) {
      const entry = history.entries[i];
      if (entry.target === "acurast" && entry.acurast?.deploymentId) {
        return entry.acurast.deploymentId;
      }
    }
  }
  throw new Error(
    `No deployment ID for ${relayId} found in stage dir or history. Pass --deployment-id <n> explicitly.`
  );
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
