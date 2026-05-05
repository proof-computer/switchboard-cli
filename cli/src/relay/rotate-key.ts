import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ethers } from "ethers";

import {
  parseRelayDeploymentSpec,
  type RelayDeploymentSpec
} from "../../../src/relay-deployment-spec.js";

export interface RunRelayRotateKeyOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  cwd?: string;
}

export interface RelayRotateKeyResult {
  relayId: string;
  oldEnvName: string;
  newEnvName: string;
  newAddress: string;
  newPrivateKey: string;
  fishLine: string;
  specFile: string;
}

/**
 * Rotate a relay's relayer key: generate a fresh keypair, update the
 * spec to point at a new env name, write the spec back. The operator
 * then re-runs `relay deploy <id>` to propagate the new key into the
 * deployed job, and `relay drain <old>` if the rotation is paired with
 * a relay-id swap.
 *
 * This command does NOT redeploy automatically — rotation is paired
 * with whichever lifecycle the operator wants (in-place key swap on
 * the same relayId, or new-relay-id-with-old-key-disabled). Both flows
 * start with the same "generate + record" step that this command does.
 */
export async function runRelayRotateKey(options: RunRelayRotateKeyOptions): Promise<RelayRotateKeyResult> {
  const io = options.io ?? defaultIo();
  const cwd = options.cwd ?? process.cwd();
  // positionals shape: ["relay", "rotate-key", "<id>"]
  const relayId = (options.positionals ?? [])[2];
  if (!relayId || !/^[a-z0-9-]+$/.test(relayId)) {
    throw new Error("Usage: switchboard relay rotate-key <relay-id>");
  }

  const specFile = path.join(cwd, "relays", `${relayId}.json`);
  const raw = await readFile(specFile, "utf8").catch(() => {
    throw new Error(`Spec ${specFile} not found. Run \`switchboard relay scaffold ${relayId}\` first.`);
  });
  const parsed = JSON.parse(raw) as unknown;
  const spec: RelayDeploymentSpec = parseRelayDeploymentSpec(parsed);

  const oldEnvName = spec.secrets.relayerPrivateKeyEnv;
  const baseEnvName = stringFlag(options.flags, "env-name") ?? deriveRotatedEnvName(oldEnvName);
  const wallet = ethers.Wallet.createRandom();

  const updatedSpecRaw = JSON.parse(raw) as Record<string, unknown>;
  const secrets = (updatedSpecRaw.secrets as Record<string, unknown>) ?? {};
  secrets.relayerPrivateKeyEnv = baseEnvName;
  updatedSpecRaw.secrets = secrets;

  await writeFile(specFile, `${JSON.stringify(updatedSpecRaw, null, 2)}\n`, "utf8");

  const fishLine = `set -gx ${baseEnvName} ${wallet.privateKey}`;
  io.log(`Updated ${specFile}: secrets.relayerPrivateKeyEnv = ${baseEnvName}`);
  io.log(`  old env: ${oldEnvName}  (still references the previous private key — keep until drain)`);
  io.log(`  new address: ${wallet.address}`);
  io.log("");
  io.log("Capture the new private key from stderr below and paste into your secrets file before redeploying:");
  io.error(fishLine);
  io.log("");
  io.log("Next: re-source the secrets file, then run:");
  io.log(`  switchboard relay deploy ${relayId} --target ${spec.target} --yes`);

  return {
    relayId,
    oldEnvName,
    newEnvName: baseEnvName,
    newAddress: wallet.address,
    newPrivateKey: wallet.privateKey,
    fishLine,
    specFile
  };
}

function deriveRotatedEnvName(oldEnvName: string): string {
  // Append _V<n> if the old name has an existing _V suffix; otherwise add _V2.
  const match = oldEnvName.match(/^(.*)_V(\d+)$/);
  if (match) {
    const next = Number(match[2]) + 1;
    return `${match[1]}_V${next}`;
  }
  return `${oldEnvName}_V2`;
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function defaultIo() {
  return {
    log: (line: string) => console.log(line),
    warn: (line: string) => console.warn(line),
    error: (line: string) => console.error(line)
  };
}
