import { spawn } from "node:child_process";

import type { RelayDeploymentSpec } from "../../../src/relay-deployment-spec.js";
import { pollRelayReadiness, type PollRelayReadinessResult } from "./readiness.js";

export interface BootstrapDeployPlan {
  composeArgs: string[];
  pollUrls: string[];
}

export function buildBootstrapDeployPlan(spec: RelayDeploymentSpec): BootstrapDeployPlan {
  if (spec.target !== "bootstrap" || !spec.bootstrap) {
    throw new Error("buildBootstrapDeployPlan requires spec.target=bootstrap");
  }
  const recreateArgs = spec.bootstrap.rebuild
    ? ["--build", "--force-recreate"]
    : ["--no-build", "--force-recreate"];

  const composeArgs = [
    "compose",
    "--env-file",
    spec.bootstrap.envFile,
    "-f",
    spec.bootstrap.composeFile,
    "up",
    "-d",
    "--no-deps",
    ...recreateArgs,
    spec.bootstrap.composeService
  ];

  const pollUrls = [
    `${spec.apiBaseUrl.replace(/\/+$/, "")}/health`,
    `${spec.apiBaseUrl.replace(/\/+$/, "")}/v1/relay-status`
  ];

  return { composeArgs, pollUrls };
}

export interface RunBootstrapDeployOptions {
  yes?: boolean;
  cwd?: string;
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  /** Replace the docker spawn. Used by tests. */
  spawnDocker?: (args: string[], cwd: string) => Promise<number>;
  /** Override the fetch implementation used for readiness polling. Used by tests. */
  fetchImpl?: typeof fetch;
  /** Skip the post-deploy readiness poll. Used by tests and emergency runs. */
  skipReadinessPoll?: boolean;
}

export async function runBootstrapDeploy(
  spec: RelayDeploymentSpec,
  options: RunBootstrapDeployOptions = {}
): Promise<{ plan: BootstrapDeployPlan; readiness?: PollRelayReadinessResult }> {
  const io = options.io ?? {
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
    error: (line) => console.error(line)
  };

  if (!options.yes) {
    throw new Error("Refusing to run bootstrap deploy without --yes");
  }

  const plan = buildBootstrapDeployPlan(spec);
  const cwd = options.cwd ?? process.cwd();
  const spawner = options.spawnDocker ?? defaultSpawnDocker;

  io.log(`relay deploy ${spec.relayId} -> bootstrap (local docker compose)`);
  io.log(`  compose file    : ${spec.bootstrap?.composeFile}`);
  io.log(`  compose service : ${spec.bootstrap?.composeService}`);
  io.log(`  env file        : ${spec.bootstrap?.envFile}`);
  io.log("");
  io.log(`> docker ${plan.composeArgs.join(" ")}`);

  const code = await spawner(plan.composeArgs, cwd);
  if (code !== 0) {
    throw new Error(`docker compose up exited with code ${code}`);
  }

  if (options.skipReadinessPoll) {
    io.log("");
    io.log(`Skipped readiness poll. Verify with: switchboard relay status ${spec.relayId}`);
    return { plan };
  }

  io.log("");
  io.log(
    `Polling ${spec.apiBaseUrl} for readiness (timeout=${spec.verification.pollTimeoutMs}ms, interval=${spec.verification.pollIntervalMs}ms)`
  );
  const readiness = await pollRelayReadiness({
    apiBaseUrl: spec.apiBaseUrl,
    relayId: spec.relayId,
    pollIntervalMs: spec.verification.pollIntervalMs,
    pollTimeoutMs: spec.verification.pollTimeoutMs,
    fetchImpl: options.fetchImpl,
    io
  });
  io.log(`Relay ${spec.relayId} ready after ${readiness.attempts} attempt(s) in ${readiness.durationMs}ms`);

  return { plan, readiness };
}

function defaultSpawnDocker(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}
