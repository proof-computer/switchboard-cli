import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ethers } from "ethers";

import { safeParseRelayDeploymentSpec } from "../../../src/relay-deployment-spec.js";
import { DEFAULT_SWITCHBOARD_SERVICE_DOMAIN } from "../switchboard-home.js";
import { parseDuration } from "./duration.js";

export interface RunRelayScaffoldOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  createWallet?: () => RelayScaffoldWallet;
}

export interface RelayScaffoldResult {
  relayId: string;
  filePath: string;
  generatedKey?: { address: string; privateKey: string; envName: string; fishLine: string };
}

export interface RelayScaffoldWallet {
  address: string;
  privateKey: string;
}

/**
 * Generate a relays/<id>.json deployment spec from flags. Required:
 *   --target acurast|bootstrap
 * Optional:
 *   --keygen        Generate a fresh relayer key inline; address baked
 *                   into the spec metadata, env var name written into
 *                   spec.secrets.relayerPrivateKeyEnv, fish secrets line
 *                   printed to stderr for capture.
 *   --validation-report-url, --control-plane-url, --catalog-state,
 *   --compose-service, --compose-file, --env-file (bootstrap target)
 *   --acurast-deployer-seed-env, --acurast-network, --acurast-project-name,
 *   --acurast-stage-dir, --acurast-max-cost-per-execution (acurast target)
 *   --force         Overwrite existing spec.
 */
export async function runRelayScaffold(options: RunRelayScaffoldOptions): Promise<RelayScaffoldResult> {
  const io = options.io ?? defaultIo();
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  // positionals shape: ["relay", "scaffold", "<id>"]
  const relayId = (options.positionals ?? [])[2];
  if (!relayId || !/^[a-z0-9-]+$/.test(relayId)) {
    throw new Error("Usage: switchboard relay scaffold <relay-id> --target ...  (id must match /^[a-z0-9-]+$/)");
  }
  const target = stringFlag(options.flags, "target");
  if (target !== "acurast" && target !== "bootstrap") {
    throw new Error("--target must be acurast or bootstrap");
  }
  const apiBaseUrl = stringFlag(options.flags, "api-base-url") ?? defaultRelayApiBaseUrl(relayId, env);

  const filePath = path.join(cwd, "relays", `${relayId}.json`);
  if (!boolFlag(options.flags, "force") && (await fileExists(filePath))) {
    throw new Error(`${filePath} already exists; pass --force to overwrite`);
  }

  let generatedKey: RelayScaffoldResult["generatedKey"];
  let relayerKeyEnv = stringFlag(options.flags, "relayer-private-key-env");
  if (boolFlag(options.flags, "keygen")) {
    if (relayerKeyEnv === undefined) {
      relayerKeyEnv = mainnetRecorderEnvName(relayId);
    }
    const wallet = (options.createWallet ?? (() => ethers.Wallet.createRandom()))();
    generatedKey = {
      address: wallet.address,
      privateKey: wallet.privateKey,
      envName: relayerKeyEnv,
      fishLine: `set -gx ${relayerKeyEnv} ${wallet.privateKey}`
    };
  }
  if (!relayerKeyEnv) {
    relayerKeyEnv = mainnetRecorderEnvName(relayId);
  }

  const durationFlag = stringFlag(options.flags, "duration");
  const executionMs = durationFlag ? parseDuration(durationFlag) : undefined;
  const acurastManagerId = stringFlag(options.flags, "manager-id");
  if (target === "acurast" && !acurastManagerId) {
    throw new Error(
      "--manager-id <id> is required when --target acurast (pins the relay to that Acurast manager — treat as region/AZ)"
    );
  }
  if (target === "acurast" && acurastManagerId) {
    const collisions = await findManagerCollisions(cwd, acurastManagerId, relayId);
    if (collisions.length > 0) {
      io.warn(
        `manager ${acurastManagerId} is already pinned by: ${collisions.join(", ")}. Continuing — pass distinct manager ids per region for redundancy.`
      );
    }
  }

  const spec = buildSpec({
    relayId,
    target: target as "acurast" | "bootstrap",
    apiBaseUrl,
    catalogState: stringFlag(options.flags, "catalog-state") ?? (target === "acurast" ? "candidate" : "active"),
    validationReportUrl: stringFlag(options.flags, "validation-report-url"),
    controlPlaneUrl: stringFlag(options.flags, "control-plane-url"),
    relayerKeyEnv,
    acurastDeployerSeedEnv: stringFlag(options.flags, "acurast-deployer-seed-env") ?? "PROOF_ACURAST_MAINNET_DEPLOYER_SEED",
    acurastNetwork: (stringFlag(options.flags, "acurast-network") ?? "mainnet") as "mainnet" | "canary",
    acurastProjectName: stringFlag(options.flags, "acurast-project-name") ?? `switchboard-mainnet-${relayId}`,
    acurastStageDir: stringFlag(options.flags, "acurast-stage-dir") ?? `dist/acurast/switchboard-mainnet-${relayId}`,
    acurastMaxCost: stringFlag(options.flags, "acurast-max-cost-per-execution") ?? "40000000000",
    acurastExecutionMs: executionMs,
    acurastManagerId,
    composeService: stringFlag(options.flags, "compose-service") ?? relayId,
    composeFile: stringFlag(options.flags, "compose-file") ?? "docker-compose.control-plane.yaml",
    envFile: stringFlag(options.flags, "env-file") ?? ".control-plane/control-plane.env",
    cnameTarget: stringFlag(options.flags, "cname-target") ?? env.SWITCHBOARD_GATEWAY_HOSTNAME,
    generatedAddress: generatedKey?.address
  });

  // Validate the generated spec before writing.
  const result = safeParseRelayDeploymentSpec(spec);
  if (!result.ok) {
    const detail = result.error.errors.map((issue) => `  - ${issue.path || "(root)"}: ${issue.message}`).join("\n");
    throw new Error(`Generated spec failed validation:\n${detail}`);
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  io.log(`Wrote ${filePath}`);
  io.log(`  target  : ${target}`);
  io.log(`  apiBaseUrl: ${apiBaseUrl}`);
  if (generatedKey) {
    io.log("");
    io.log(`Generated relayer key:`);
    io.log(`  address: ${generatedKey.address}`);
    io.log(`  env    : ${generatedKey.envName}`);
    io.log("");
    io.log("Capture the private key from stderr below and paste into your secrets file:");
    io.error(generatedKey.fishLine);
  }

  return { relayId, filePath, generatedKey };
}

interface BuildSpecArgs {
  relayId: string;
  target: "acurast" | "bootstrap";
  apiBaseUrl: string;
  catalogState: string;
  validationReportUrl?: string;
  controlPlaneUrl?: string;
  relayerKeyEnv: string;
  acurastDeployerSeedEnv: string;
  acurastNetwork: "mainnet" | "canary";
  acurastProjectName: string;
  acurastStageDir: string;
  acurastMaxCost: string;
  acurastExecutionMs?: number;
  acurastManagerId?: string;
  composeService: string;
  composeFile: string;
  envFile: string;
  cnameTarget?: string;
  generatedAddress?: string;
}

function buildSpec(args: BuildSpecArgs): Record<string, unknown> {
  const base: Record<string, unknown> = {
    version: 1,
    relayId: args.relayId,
    target: args.target,
    catalogState: args.catalogState,
    apiBaseUrl: args.apiBaseUrl,
    ...(args.validationReportUrl ? { validationReportUrl: args.validationReportUrl } : {}),
    ...(args.controlPlaneUrl ? { controlPlaneUrl: args.controlPlaneUrl } : {}),
    peers: [],
    secrets: {
      relayerPrivateKeyEnv: args.relayerKeyEnv
    },
    ...(args.cnameTarget
      ? {
          dns: {
            provider: "cloudflare",
            cnameTarget: args.cnameTarget
          }
        }
      : {})
  };
  if (args.target === "acurast") {
    base.relay = {
      enablePeerBackfill: false,
      enableValidationReports: true
    };
    base.acurast = {
      deployerSeedEnv: args.acurastDeployerSeedEnv,
      network: args.acurastNetwork,
      projectName: args.acurastProjectName,
      stageDir: args.acurastStageDir,
      ...(args.acurastExecutionMs !== undefined ? { executionMs: args.acurastExecutionMs } : {}),
      maxCostPerExecution: args.acurastMaxCost,
      ...(args.acurastManagerId ? { managerId: args.acurastManagerId } : {}),
      instantMatchProcessors: [],
      includeEnv: []
    };
  } else {
    base.bootstrap = {
      composeService: args.composeService,
      composeFile: args.composeFile,
      envFile: args.envFile,
      rebuild: true
    };
  }
  return base;
}

function mainnetRecorderEnvName(relayId: string): string {
  // Match the convention in scripts/mainnet/prepare-acurast-relay-env.fish:
  //   PROOF_MAINNET_RELAY_<X>_RECORDER_PRIVATE_KEY
  const upper = relayId.toUpperCase().replace(/-/g, "_");
  return `PROOF_MAINNET_${upper}_RECORDER_PRIVATE_KEY`;
}

function defaultRelayApiBaseUrl(relayId: string, env: NodeJS.ProcessEnv): string {
  const pattern =
    env.SWITCHBOARD_RELAY_HOSTNAME_PATTERN ??
    `\${relayId}.${env.SWITCHBOARD_SERVICE_DOMAIN ?? DEFAULT_SWITCHBOARD_SERVICE_DOMAIN}`;
  return `https://${pattern.replace(/\$\{relayId\}/g, relayId)}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function findManagerCollisions(cwd: string, managerId: string, selfRelayId: string): Promise<string[]> {
  const dir = path.join(cwd, "relays");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const collisions: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === "catalog.json") continue;
    const filePath = path.join(dir, entry);
    const raw = await readFile(filePath, "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const result = safeParseRelayDeploymentSpec(parsed);
    if (!result.ok) continue;
    const spec = result.spec;
    if (spec.relayId === selfRelayId) continue;
    if (spec.target === "acurast" && spec.acurast?.managerId === managerId) {
      collisions.push(spec.relayId);
    }
  }
  return collisions;
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function defaultIo() {
  return {
    log: (line: string) => console.log(line),
    warn: (line: string) => console.warn(line),
    error: (line: string) => console.error(line)
  };
}
