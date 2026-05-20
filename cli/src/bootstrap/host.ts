import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { type RelayCatalogInputEntry } from "../../../src/service-catalog.js";
import {
  DEFAULT_SWITCHBOARD_OPS_PROFILE,
  SWITCHBOARD_OPS_PROFILE_ENV,
  defaultSwitchboardOpsConfig,
  loadSwitchboardOpsProfile,
  normalizeSwitchboardProfileName,
  resolveOpsServiceConfig,
  type SwitchboardOpsConfig
} from "../switchboard-home.js";
import {
  runRelayCatalogBuild,
  type RelayCatalogBuildResult,
  type RunRelayCatalogBuildOptions
} from "../relay/catalog-build-from-specs.js";
import { readRelayCatalogStore } from "../relay/catalog.js";

const DEFAULT_REMOTE_DIR = "/srv/switchboard";
const DEFAULT_SSH_CONFIG_FILE = "/dev/null";
const DEFAULT_CATALOG_DIR = ".control-plane/service-catalogs";
const DEFAULT_CATALOG_FILE = "service-catalogs.signed.json";
const HUB_USDC = "0x0000053900000000000000000000000001200000";
const DEFAULT_SERVICE_CATALOG_MAX_STALE_SECONDS = 86_400;

const DEFAULTS = {
  chainId: "420420419",
  hubEthRpcUrl: "https://services.polkadothub-rpc.com/mainnet",
  hubSubstrateWsUrl: "wss://polkadot-asset-hub-rpc.polkadot.io"
} as const;

const WORKTREE_SYNC_EXCLUDES = [
  ".git/",
  "node_modules/",
  "tmp/",
  "dist/",
  ".switchboard/",
  ".switchboard/",
  ".control-plane/",
  ".operator-host/",
  ".explorer/",
  ".env",
  ".envrc"
] as const;

export interface BootstrapHostIo {
  log: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

const DEFAULT_IO: BootstrapHostIo = {
  log: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line)
};

export interface BootstrapHostCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type BootstrapHostRunner = (
  command: string,
  args: string[],
  options: { cwd: string; input?: string }
) => Promise<BootstrapHostCommandResult>;

export interface BootstrapHostArgs {
  flags: Map<string, string | boolean>;
  positionals: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  io?: BootstrapHostIo;
  runner?: BootstrapHostRunner;
  catalogBuilder?: (options: RunRelayCatalogBuildOptions) => Promise<RelayCatalogBuildResult>;
}

interface BootstrapHostContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: BootstrapHostIo;
  profile: string;
  config: SwitchboardOpsConfig;
  host: string;
  remoteDir: string;
  sshConfigFile: string;
  catalogDir: string;
  catalogFile: string;
  catalogPath: string;
  runner: BootstrapHostRunner;
  catalogBuilder: (options: RunRelayCatalogBuildOptions) => Promise<RelayCatalogBuildResult>;
}

type EnvGroup = "control" | "operator" | "explorer";

interface EnvRow {
  group: EnvGroup;
  key: string;
  value: string;
}

interface EnvPlan {
  rows: EnvRow[];
  missing: string[];
}

interface ServiceTarget {
  name: string;
  composeService: string;
  composeFile: string;
  envFile: string;
  apiBaseUrl?: string;
}

export async function runBootstrapHostSubcommand(args: BootstrapHostArgs): Promise<void> {
  const verb = args.positionals[2] ?? "plan";
  if (verb === "help") {
    printBootstrapHostUsage(args.io ?? DEFAULT_IO);
    return;
  }

  const ctx = await resolveBootstrapHostContext(args);

  if (verb === "plan") {
    await runPlan(ctx);
    return;
  }
  if (verb === "sync") {
    await runSync(ctx, args.flags);
    return;
  }
  if (verb === "catalog") {
    await runCatalog(ctx, args);
    return;
  }
  if (verb === "env") {
    await runEnv(ctx, args);
    return;
  }
  if (verb === "deploy") {
    await runDeploy(ctx, args);
    return;
  }
  if (verb === "status") {
    await runStatus(ctx, args);
    return;
  }
  if (verb === "logs") {
    await runLogs(ctx, args);
    return;
  }

  throw new Error(`Unknown bootstrap host command: ${verb}`);
}

export function printBootstrapHostUsage(io: BootstrapHostIo = DEFAULT_IO): void {
  io.log(`switchboard bootstrap host

Commands:
  bootstrap host plan
      Print resolved SSH host, remote dir, catalog path, env groups, and commands.
  bootstrap host sync [--dry-run] --yes
      Rsync the local worktree to the bootstrap host with env/state excludes.
  bootstrap host catalog build
      Build signed service catalogs locally from relays/*.json.
  bootstrap host catalog push [--dry-run] --yes
      Rsync .control-plane/service-catalogs/ to the bootstrap host.
  bootstrap host env plan
      Render remote env updates with secrets redacted.
  bootstrap host env apply [--dry-run] --yes
      Build/push catalogs and upsert remote control/operator/explorer env files.
  bootstrap host deploy <service> [--dry-run] --yes
      Recreate exactly one remote Docker Compose service.
  bootstrap host status [<service>|all]
      Show remote Docker Compose status and relay probes where applicable.
  bootstrap host logs <service> [--tail 200]
      Print remote Docker Compose logs.

Flags:
  --profile <name>        Ops profile, default ${DEFAULT_SWITCHBOARD_OPS_PROFILE}.
  --host <ssh-host>       Default from ops config or SWITCHBOARD_BOOTSTRAP_HOST.
  --remote-dir <path>     Default from ops config, then ${DEFAULT_REMOTE_DIR}.
  --ssh-config <path>     Default ${DEFAULT_SSH_CONFIG_FILE}.
  --catalog-dir <path>    Default ${DEFAULT_CATALOG_DIR}.
`);
}

async function resolveBootstrapHostContext(args: BootstrapHostArgs): Promise<BootstrapHostContext> {
  const env = args.env ?? process.env;
  const cwd = args.cwd ?? process.cwd();
  const io = args.io ?? DEFAULT_IO;
  const profile = normalizeSwitchboardProfileName(
    stringFlag(args.flags, "ops-profile") ??
      stringFlag(args.flags, "profile") ??
      env[SWITCHBOARD_OPS_PROFILE_ENV] ??
      DEFAULT_SWITCHBOARD_OPS_PROFILE
  );
  const loaded = await loadSwitchboardOpsProfile({ profile, env, overrideConfigEnv: true });
  const config = loaded.config ?? defaultSwitchboardOpsConfig(profile);
  const catalogDir = path.resolve(cwd, stringFlag(args.flags, "catalog-dir") ?? DEFAULT_CATALOG_DIR);
  const catalogFile = stringFlag(args.flags, "catalog-file-name") ?? DEFAULT_CATALOG_FILE;
  return {
    cwd,
    env,
    io,
    profile,
    config,
    host: stringFlag(args.flags, "host") ?? config.bootstrap?.host ?? env.SWITCHBOARD_BOOTSTRAP_HOST ?? "",
    remoteDir: stringFlag(args.flags, "remote-dir") ?? config.bootstrap?.remoteDir ?? env.SWITCHBOARD_BOOTSTRAP_REMOTE_DIR ?? DEFAULT_REMOTE_DIR,
    sshConfigFile: stringFlag(args.flags, "ssh-config") ?? env.SWITCHBOARD_BOOTSTRAP_SSH_CONFIG ?? DEFAULT_SSH_CONFIG_FILE,
    catalogDir,
    catalogFile,
    catalogPath: path.join(catalogDir, catalogFile),
    runner: args.runner ?? defaultRunner,
    catalogBuilder: args.catalogBuilder ?? runRelayCatalogBuild
  };
}

async function runPlan(ctx: BootstrapHostContext): Promise<void> {
  const envPlan = await buildEnvPlan(ctx);
  ctx.io.log("bootstrap host plan");
  ctx.io.log(`  profile      : ${ctx.profile}`);
  ctx.io.log(`  host         : ${ctx.host || "(unset)"}`);
  ctx.io.log(`  remote dir   : ${ctx.remoteDir}`);
  ctx.io.log(`  ssh config   : ${ctx.sshConfigFile}`);
  ctx.io.log(`  catalog dir  : ${ctx.catalogDir}`);
  ctx.io.log(`  catalog file : ${ctx.catalogPath}`);
  ctx.io.log(`  env rows     : ${envPlan.rows.length}`);
  ctx.io.log(`  missing      : ${envPlan.missing.length === 0 ? "(none)" : envPlan.missing.join(", ")}`);
  ctx.io.log("");
  ctx.io.log("commands:");
  ctx.io.log("  switchboard bootstrap host sync --yes");
  ctx.io.log("  switchboard bootstrap host catalog build");
  ctx.io.log("  switchboard bootstrap host catalog push --yes");
  ctx.io.log("  switchboard bootstrap host env apply --yes");
  ctx.io.log("  switchboard bootstrap host deploy <service> --yes");
}

async function runSync(ctx: BootstrapHostContext, flags: Map<string, string | boolean>): Promise<void> {
  const dryRun = boolFlag(flags, "dry-run");
  requireYes(ctx, flags, "bootstrap host sync", dryRun);
  const host = requiredBootstrapHost(ctx);
  const args = [
    "-az",
    ...(dryRun ? ["--dry-run"] : []),
    "--delete",
    ...WORKTREE_SYNC_EXCLUDES.flatMap((item) => ["--exclude", item]),
    "-e",
    `ssh -F ${ctx.sshConfigFile}`,
    "./",
    `${host}:${ctx.remoteDir}/`
  ];
  await runChecked(ctx, "rsync", args, { dryRun: false });
}

async function runCatalog(ctx: BootstrapHostContext, args: BootstrapHostArgs): Promise<void> {
  const sub = args.positionals[3] ?? "build";
  if (sub === "build") {
    await buildCatalog(ctx, args.flags);
    return;
  }
  if (sub === "push") {
    await pushCatalog(ctx, args.flags);
    return;
  }
  throw new Error("Usage: switchboard bootstrap host catalog build|push");
}

async function runEnv(ctx: BootstrapHostContext, args: BootstrapHostArgs): Promise<void> {
  const sub = args.positionals[3] ?? "plan";
  if (sub === "plan") {
    await printEnvPlan(ctx);
    return;
  }
  if (sub === "apply") {
    await applyEnv(ctx, args.flags);
    return;
  }
  throw new Error("Usage: switchboard bootstrap host env plan|apply");
}

async function buildCatalog(
  ctx: BootstrapHostContext,
  flags: Map<string, string | boolean>
): Promise<RelayCatalogBuildResult> {
  await mkdir(ctx.catalogDir, { recursive: true });
  const signingKey = val(ctx.env, "PROOF_SERVICE_CATALOG_SIGNING_KEY") || val(ctx.env, "PROOF_MAINNET_MANIFEST_SIGNING_KEY");
  const childEnv: NodeJS.ProcessEnv = {
    ...ctx.env,
    PROOF_SERVICE_CATALOGS_OUTPUT_FILE: stringFlag(flags, "output") ?? ctx.catalogPath,
    ...(signingKey ? { PROOF_SERVICE_CATALOG_SIGNING_KEY: signingKey } : {}),
    PROOF_SERVICE_CATALOG_SIGNING_SCHEME:
      ctx.env.PROOF_SERVICE_CATALOG_SIGNING_SCHEME ?? "substrate-sr25519",
    PROOF_SERVICE_CATALOG_SS58_FORMAT: ctx.env.PROOF_SERVICE_CATALOG_SS58_FORMAT ?? "42",
    PROOF_SERVICE_CATALOG_TTL_SECONDS: ctx.env.PROOF_SERVICE_CATALOG_TTL_SECONDS ?? "172800"
  };
  return ctx.catalogBuilder({
    flags: new Map(flags),
    env: childEnv,
    io: ctx.io,
    cwd: ctx.cwd
  });
}

async function pushCatalog(ctx: BootstrapHostContext, flags: Map<string, string | boolean>): Promise<void> {
  const dryRun = boolFlag(flags, "dry-run");
  requireYes(ctx, flags, "bootstrap host catalog push", dryRun);
  const host = requiredBootstrapHost(ctx);
  const remoteCatalogDir = `${ctx.remoteDir}/.control-plane/service-catalogs/`;
  await runChecked(
    ctx,
    "ssh",
    ["-F", ctx.sshConfigFile, host, `mkdir -p ${shellQuote(remoteCatalogDir)}`],
    { dryRun }
  );
  await runChecked(
    ctx,
    "rsync",
    [
      "-az",
      ...(dryRun ? ["--dry-run"] : []),
      "-e",
      `ssh -F ${ctx.sshConfigFile}`,
      `${ctx.catalogDir.replace(/\/+$/, "")}/`,
      `${host}:${remoteCatalogDir}`
    ],
    { dryRun: false }
  );
}

async function printEnvPlan(ctx: BootstrapHostContext): Promise<void> {
  const plan = await buildEnvPlan(ctx);
  ctx.io.log("bootstrap host env plan");
  ctx.io.log(`  rows    : ${plan.rows.length}`);
  ctx.io.log(`  missing : ${plan.missing.length === 0 ? "(none)" : plan.missing.join(", ")}`);
  for (const row of plan.rows) {
    ctx.io.log(`  ${row.group}\t${row.key}=${redactedValue(row.key, row.value)}`);
  }
}

async function applyEnv(ctx: BootstrapHostContext, flags: Map<string, string | boolean>): Promise<void> {
  const dryRun = boolFlag(flags, "dry-run");
  requireYes(ctx, flags, "bootstrap host env apply", dryRun);
  const host = requiredBootstrapHost(ctx);
  const envOnly = boolFlag(flags, "env-only");
  const catalogOnly = boolFlag(flags, "catalog-only");
  const noBuild = boolFlag(flags, "no-build");
  const noPush = boolFlag(flags, "no-push");

  const plan = await buildEnvPlan(ctx);
  if (plan.missing.length > 0 && !boolFlag(flags, "allow-missing")) {
    throw new Error(`Refusing to apply bootstrap host env with missing values: ${plan.missing.join(", ")}`);
  }
  if (dryRun) {
    ctx.io.log(`dry-run: would apply bootstrap host env to ${host}:${ctx.remoteDir}`);
    if (!envOnly && !noBuild) ctx.io.log(`dry-run: would build signed catalogs at ${ctx.catalogPath}`);
    if (!envOnly && !noPush) ctx.io.log(`dry-run: would push ${ctx.catalogDir}/ to the bootstrap host`);
    if (!catalogOnly) {
      ctx.io.log(`dry-run: would stream ${plan.rows.length} env rows to remote upsert-env-from-stdin.py`);
      for (const row of plan.rows) {
        ctx.io.log(`  ${row.group}\t${row.key}=${redactedValue(row.key, row.value)}`);
      }
    }
    return;
  }

  if (!envOnly && !noBuild) {
    await buildCatalog(ctx, flags);
  }
  if (!envOnly && !noPush) {
    await pushCatalog(ctx, new Map([...flags, ["dry-run", dryRun], ["yes", true]]));
  }
  if (catalogOnly) {
    return;
  }

  const input = serializeEnvRows(plan.rows);
  const remote = `cd ${shellQuote(ctx.remoteDir)} && python3 scripts/mainnet/upsert-env-from-stdin.py`;
  await runChecked(ctx, "ssh", ["-F", ctx.sshConfigFile, host, remote], { input, dryRun: false });
}

async function runDeploy(ctx: BootstrapHostContext, args: BootstrapHostArgs): Promise<void> {
  const serviceName = args.positionals[3];
  if (!serviceName) {
    throw new Error("Usage: switchboard bootstrap host deploy <service>");
  }
  const dryRun = boolFlag(args.flags, "dry-run");
  requireYes(ctx, args.flags, "bootstrap host deploy", dryRun);
  const targets = serviceTargets(ctx, serviceName);
  for (const target of targets) {
    if (target.composeFile === "docker-compose.control-plane.yaml") {
      await snapshotLegacyDeploymentIntents(ctx, target, dryRun);
    }
    await runRemoteCompose(ctx, target, composeUpCommand(target, args.flags), dryRun);
    if (target.composeFile === "docker-compose.control-plane.yaml") {
      await restoreLegacyDeploymentIntents(ctx, target, dryRun);
    }
  }
}

async function runStatus(ctx: BootstrapHostContext, args: BootstrapHostArgs): Promise<void> {
  const serviceName = args.positionals[3] ?? "all";
  const targets = serviceTargets(ctx, serviceName);
  for (const target of targets) {
    const probes = target.apiBaseUrl
      ? ` && curl -fsS ${shellQuote(`${target.apiBaseUrl}/health`)} >/dev/null && curl -fsS ${shellQuote(`${target.apiBaseUrl}/v1/relay-status`)} >/dev/null`
      : "";
    await runRemoteCompose(ctx, target, `ps ${target.composeService}${probes}`, false);
  }
}

async function runLogs(ctx: BootstrapHostContext, args: BootstrapHostArgs): Promise<void> {
  const serviceName = args.positionals[3];
  if (!serviceName) {
    throw new Error("Usage: switchboard bootstrap host logs <service> [--tail 200]");
  }
  const tail = integerFlag(args.flags, "tail", 200);
  const target = serviceTargets(ctx, serviceName)[0];
  await runRemoteCompose(ctx, target, `logs --tail=${tail} ${target.composeService}`, false);
}

function composeUpCommand(target: ServiceTarget, flags: Map<string, string | boolean>): string {
  const rebuildFlags = boolFlag(flags, "no-build") ? "--no-build --force-recreate" : "--build --force-recreate";
  return `up -d --no-deps ${rebuildFlags} ${target.composeService} && sudo docker compose --env-file ${shellQuote(target.envFile)} -f ${shellQuote(target.composeFile)} ps ${target.composeService}`;
}

async function runRemoteCompose(
  ctx: BootstrapHostContext,
  target: ServiceTarget,
  composeCommand: string,
  dryRun: boolean
): Promise<void> {
  const host = requiredBootstrapHost(ctx);
  const remote =
    `cd ${shellQuote(ctx.remoteDir)} && sudo docker compose --env-file ${shellQuote(target.envFile)} ` +
    `-f ${shellQuote(target.composeFile)} ${composeCommand}`;
  await runChecked(ctx, "ssh", ["-F", ctx.sshConfigFile, host, remote], { dryRun });
}

async function snapshotLegacyDeploymentIntents(
  ctx: BootstrapHostContext,
  target: ServiceTarget,
  dryRun: boolean
): Promise<void> {
  const host = requiredBootstrapHost(ctx);
  const legacyDir = `.control-plane/legacy-deployment-intents/${target.composeService}`;
  const remote =
    `cd ${shellQuote(ctx.remoteDir)} && mkdir -p ${shellQuote(legacyDir)} && ` +
    `cid=$(sudo docker compose --env-file ${shellQuote(target.envFile)} -f ${shellQuote(target.composeFile)} ps -q ${target.composeService} 2>/dev/null || true); ` +
    `if [ -n "$cid" ]; then sudo docker cp "$cid:/app/tmp/deployment-intents/." ${shellQuote(legacyDir)} 2>/dev/null || true; fi`;
  await runChecked(ctx, "ssh", ["-F", ctx.sshConfigFile, host, remote], { dryRun });
}

async function restoreLegacyDeploymentIntents(
  ctx: BootstrapHostContext,
  target: ServiceTarget,
  dryRun: boolean
): Promise<void> {
  const host = requiredBootstrapHost(ctx);
  const legacyDir = `.control-plane/legacy-deployment-intents/${target.composeService}`;
  const composeBase = `sudo docker compose --env-file ${shellQuote(target.envFile)} -f ${shellQuote(target.composeFile)}`;
  const remote =
    `cd ${shellQuote(ctx.remoteDir)} && ` +
    `if [ -d ${shellQuote(legacyDir)} ] && find ${shellQuote(legacyDir)} -name '*.json' -print -quit | grep -q .; then ` +
    `cid=$(${composeBase} ps -q ${target.composeService}); ` +
    `sudo docker exec "$cid" mkdir -p /data/deployment-intents; ` +
    `sudo docker cp ${shellQuote(`${legacyDir}/.`)} "$cid:/data/deployment-intents/"; ` +
    `${composeBase} restart ${target.composeService}; ` +
    `fi`;
  await runChecked(ctx, "ssh", ["-F", ctx.sshConfigFile, host, remote], { dryRun });
}

function requiredBootstrapHost(ctx: BootstrapHostContext): string {
  if (!ctx.host) {
    throw new Error("Missing bootstrap host. Pass --host, set bootstrap.host in the ops profile, or set SWITCHBOARD_BOOTSTRAP_HOST.");
  }
  return ctx.host;
}

function serviceTargets(ctx: BootstrapHostContext, name: string): ServiceTarget[] {
  if (name === "all") {
    const names = splitCsv(ctx.env.SWITCHBOARD_BOOTSTRAP_SERVICES ?? "");
    if (names.length === 0) {
      throw new Error("Set SWITCHBOARD_BOOTSTRAP_SERVICES or pass an explicit service name.");
    }
    return names.map((item) => serviceTarget(ctx, item));
  }
  return [serviceTarget(ctx, name)];
}

function serviceTarget(ctx: BootstrapHostContext, name: string): ServiceTarget {
  const envPrefix = `SWITCHBOARD_BOOTSTRAP_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  if (/^[a-z0-9][a-z0-9-]*$/.test(name) && name !== "explorer") {
    const services = resolveOpsServiceConfig(ctx.config.services);
    const apiBaseUrl =
      ctx.env[`${envPrefix}_API_BASE_URL`] ??
      `https://${services.relayHostnamePattern.replace(/\$\{relayId\}/g, name)}`;
    return {
      name,
      composeService: ctx.env[`${envPrefix}_COMPOSE_SERVICE`] ?? name,
      composeFile: ctx.env[`${envPrefix}_COMPOSE_FILE`] ?? "docker-compose.control-plane.yaml",
      envFile: ctx.env[`${envPrefix}_ENV_FILE`] ?? ".control-plane/control-plane.env",
      apiBaseUrl
    };
  }
  if (name === "explorer") {
    return {
      name,
      composeService: ctx.env[`${envPrefix}_COMPOSE_SERVICE`] ?? "explorer",
      composeFile: ctx.env[`${envPrefix}_COMPOSE_FILE`] ?? "docker-compose.explorer.yaml",
      envFile: ctx.env[`${envPrefix}_ENV_FILE`] ?? ".explorer/explorer.env"
    };
  }
  throw new Error("Expected a lowercase service name, explorer, or all");
}

async function buildEnvPlan(ctx: BootstrapHostContext): Promise<EnvPlan> {
  const env = ctx.env;
  const missing: string[] = [];
  const services = resolveOpsServiceConfig(ctx.config.services);
  const controlPlaneUrl = val(env, "PROOF_CONTROL_PLANE_URL", ctx.config.controlPlaneUrl ?? `https://${services.controlHostname}`);
  const chainId = ctx.config.chainId ?? DEFAULTS.chainId;
  const hubEthRpcUrl = ctx.config.hubEthRpcUrl ?? DEFAULTS.hubEthRpcUrl;
  const hubSubstrateWsUrl = ctx.config.hubSubstrateWsUrl ?? DEFAULTS.hubSubstrateWsUrl;
  const registryAddress = requiredValue(
    val(env, "INGRESS_REGISTRY_ADDRESS", ctx.config.registryAddress ?? ""),
    "INGRESS_REGISTRY_ADDRESS or ops config registryAddress",
    missing
  );
  const recorderCoordinatorAddress = requiredValue(
    val(env, "PROOF_RECORDER_COORDINATOR_ADDRESS", ctx.config.recorderCoordinatorAddress ?? ""),
    "PROOF_RECORDER_COORDINATOR_ADDRESS or ops config recorderCoordinatorAddress",
    missing
  );
  const networkManifestSigner = requiredValue(
    val(env, "PROOF_NETWORK_MANIFEST_SIGNER", ctx.config.manifestSigner ?? ""),
    "PROOF_NETWORK_MANIFEST_SIGNER or ops config manifestSigner",
    missing
  );
  const serviceCatalogSigner = val(env, "PROOF_SERVICE_CATALOG_SIGNER", networkManifestSigner);
  const defaultAssetAddress = ctx.config.defaultAssetAddress ?? HUB_USDC;
  const operatorId = requiredValue(val(env, "OPERATOR_ID", ctx.config.operatorId ?? ""), "OPERATOR_ID or ops config operatorId", missing);
  const gatewayId = required(env, "GATEWAY_ID", missing);
  const operatorManagerIds = requiredValue(
    val(env, "OPERATOR_MANAGER_IDS", ctx.config.operatorManagerIds ?? ""),
    "OPERATOR_MANAGER_IDS or ops config operatorManagerIds",
    missing
  );
  const operatorRecipient = required(env, "PROOF_MAINNET_OPERATOR_RECIPIENT", missing);
  const relays = await manifestRelaysJson(ctx.cwd, env);
  if (relays.length === 0) {
    missing.push("relays/catalog.json or PROOF_NETWORK_MANIFEST_RELAYS_JSON");
  }
  const platformJobsJson =
    val(env, "PROOF_PLATFORM_JOBS_JSON") ||
    platformJobsJsonFromRelays(relays, val(env, "PROOF_EXPLORER_PUBLIC_URL", val(env, "PROOF_EXPLORER_ENDPOINT")));
  const defaultCatalogMaxStaleSeconds = catalogMaxStaleSeconds(env, "PROOF_SERVICE_CATALOG_MAX_STALE_SECONDS");
  const controlApiCatalogMaxStaleSeconds =
    catalogMaxStaleSeconds(env, "PROOF_CONTROL_API_SERVICE_CATALOG_MAX_STALE_SECONDS", defaultCatalogMaxStaleSeconds);
  const relayCatalogMaxStaleSeconds =
    catalogMaxStaleSeconds(env, "PROOF_RELAY_SERVICE_CATALOG_MAX_STALE_SECONDS", defaultCatalogMaxStaleSeconds);
  const catalogRefsJson = JSON.stringify({
    controlApi: {
      url: val(env, "PROOF_CONTROL_API_SERVICE_CATALOG_URL", `${controlPlaneUrl}/v1/service-catalogs/control-api`),
      signer: serviceCatalogSigner,
      required: true,
      maxStaleSeconds: controlApiCatalogMaxStaleSeconds
    },
    relays: {
      url: val(env, "PROOF_RELAY_SERVICE_CATALOG_URL", `${controlPlaneUrl}/v1/service-catalogs/relay`),
      signer: serviceCatalogSigner,
      required: true,
      maxStaleSeconds: relayCatalogMaxStaleSeconds
    }
  });
  const certificateAuthorizationToken =
    val(env, "PROOF_CERTIFICATE_AUTHORIZATION_TOKEN") ||
    required(env, "PROOF_CONTROL_PLANE_TOKEN", missing);
  const controlPlaneToken = required(env, "PROOF_CONTROL_PLANE_TOKEN", missing);
  const routeIntentToken = val(env, "PROOF_ROUTE_INTENT_TOKEN", controlPlaneToken);

  const rows: EnvRow[] = [];
  const emit = (group: EnvGroup, key: string, value: string | undefined): void => {
    rows.push({ group, key, value: value ?? "" });
  };

  emit("control", "CHAIN_ID", chainId);
  emit("control", "ACME_EMAIL", required(env, "ACME_EMAIL", missing));
  emit("control", "HUB_ETH_RPC_URL", hubEthRpcUrl);
  emit("control", "HUB_SUBSTRATE_WS_URL", hubSubstrateWsUrl);
  emit("control", "INGRESS_REGISTRY_ADDRESS", registryAddress);
  emit("control", "PROOF_RECORDER_COORDINATOR_ADDRESS", recorderCoordinatorAddress);
  emit("control", "PROOF_QUOTES_ENABLED", "true");
  emit("control", "QUOTE_SIGNER_PRIVATE_KEY", required(env, "PROOF_MAINNET_QUOTE_SIGNER_PRIVATE_KEY", missing));
  emit("control", "PROOF_OPERATOR_RECIPIENT", operatorRecipient);
  emit("control", "PROOF_VALIDATOR_RECIPIENT", required(env, "PROOF_MAINNET_VALIDATOR_RECIPIENT", missing));
  emit("control", "PROOF_TREASURY_RECIPIENT", required(env, "PROOF_MAINNET_TREASURY_RECIPIENT", missing));
  emit("control", "PROOF_QUOTE_DEFAULT_ASSET", defaultAssetAddress);
  emit("control", "PAYMENT_ASSET_ADDRESS", defaultAssetAddress);
  emit("control", "ACCEPTED_ASSET_ADDRESSES", defaultAssetAddress);
  emit("control", "PROOF_QUOTE_PRICE_PER_MINUTE", "10000");
  emit("control", "PROOF_QUOTE_SETUP_FEE", "10000");
  emit("control", "PROOF_QUOTE_VALIDATION_FEE_CAP", "10000");
  emit("control", "PROOF_QUOTE_MIN_LEASE_SECONDS", "600");
  emit("control", "PROOF_QUOTE_DEFAULT_LEASE_SECONDS", "600");
  emit("control", "PROOF_QUOTE_TTL_SECONDS", "600");
  emit("control", "PROOF_QUOTE_MAX_OPERATOR_BPS", "8000");
  emit("control", "PROOF_QUOTE_MAX_VALIDATOR_BPS", "500");
  emit("control", "PROOF_QUOTE_MAX_PROOF_BPS", "2000");
  emit("control", "PROOF_QUOTE_MAX_NATIVE_OVERPAYMENT_BPS", "50");
  emit("control", "PROOF_QUOTE_ENDPOINT_ID_SECRET", required(env, "PROOF_MAINNET_QUOTE_ENDPOINT_ID_SECRET", missing));
  emit("control", "PROOF_NETWORK_MANIFEST_ENABLED", "true");
  emit("control", "PROOF_NETWORK_MANIFEST_CHAIN_NAME", "polkadot-hub");
  emit("control", "PROOF_NETWORK_MANIFEST_SEQUENCE", "10");
  emit("control", "PROOF_NETWORK_MANIFEST_REGISTRY_LABEL", "hub-mainnet-ledger-v1");
  emit("control", "PROOF_NETWORK_MANIFEST_CONTROL_PLANE_URL", controlPlaneUrl);
  emit("control", "PROOF_NETWORK_MANIFEST_QUOTE_SIGNER", required(env, "QUOTE_SIGNER_ADDRESS", missing));
  emit("control", "PROOF_NETWORK_MANIFEST_SIGNING_SCHEME", "substrate-sr25519");
  emit("control", "PROOF_NETWORK_MANIFEST_SIGNING_KEY", required(env, "PROOF_MAINNET_MANIFEST_SIGNING_KEY", missing));
  emit("control", "PROOF_NETWORK_MANIFEST_SIGNER", networkManifestSigner);
  emit("control", "PROOF_NETWORK_MANIFEST_SUPPORTED_ASSETS", `${defaultAssetAddress}:USDC:6:erc20`);
  emit("control", "PROOF_NETWORK_MANIFEST_ETH_RPC_URLS", hubEthRpcUrl);
  emit("control", "PROOF_NETWORK_MANIFEST_SUBSTRATE_RPC_URLS", hubSubstrateWsUrl);
  emit("control", "PROOF_NETWORK_MANIFEST_RELAYS_JSON", JSON.stringify(relays));
  emit("control", "PROOF_NETWORK_MANIFEST_CATALOGS_JSON", catalogRefsJson);
  emit("control", "PROOF_SERVICE_CATALOGS_FILE", "/config/service-catalogs/service-catalogs.signed.json");
  emit("control", "PROOF_SERVICE_CATALOGS_RELOAD_MS", "5000");
  emit("control", "PROOF_SERVICE_CATALOGS_UNSIGNED_JSON", "");
  emit("control", "PROOF_SERVICE_CATALOGS_UNSIGNED_FILE", "");
  emit("control", "PROOF_SERVICE_CATALOG_SIGNING_KEY", "");
  emit("control", "PROOF_SERVICE_CATALOG_SIGNING_SCHEME", "");
  emit("control", "PROOF_SERVICE_CATALOG_SS58_FORMAT", "");
  emit("control", "PROOF_RELAY_A_RECORDER_ADDRESS", required(env, "PROOF_RELAY_A_RECORDER_ADDRESS", missing));
  emit("control", "PROOF_RELAY_B_RECORDER_ADDRESS", required(env, "PROOF_RELAY_B_RECORDER_ADDRESS", missing));
  emit("control", "PROOF_RELAY_C_RECORDER_ADDRESS", required(env, "PROOF_RELAY_C_RECORDER_ADDRESS", missing));
  emit("control", "PROOF_RELAY_A_RECORDER_PRIVATE_KEY", required(env, "PROOF_MAINNET_RELAY_A_RECORDER_PRIVATE_KEY", missing));
  emit("control", "PROOF_RELAY_B_RECORDER_PRIVATE_KEY", required(env, "PROOF_MAINNET_RELAY_B_RECORDER_PRIVATE_KEY", missing));
  emit("control", "PROOF_RELAY_C_RECORDER_PRIVATE_KEY", required(env, "PROOF_MAINNET_RELAY_C_RECORDER_PRIVATE_KEY", missing));
  emit("control", "PROOF_VALIDATION_REPORTS_ENABLED", "true");
  emit("control", "PROOF_VALIDATION_REPORT_STORE_KIND", "sqlite");
  emit("control", "PROOF_RELAY_SQLITE_FILE", "/data/validation-reports/proof-relay.sqlite");
  emit("control", "PROOF_SQLITE_DRIVER", "node:sqlite");
  emit("control", "PROOF_VALIDATION_ALLOWED_SIGNERS", required(env, "PROOF_VALIDATION_ALLOWED_SIGNERS", missing));
  emit("control", "PROOF_VALIDATION_READ_TOKEN", required(env, "PROOF_VALIDATION_READ_TOKEN", missing));
  emit("control", "PROOF_LOG_CREATE_TOKEN", required(env, "PROOF_LOG_CREATE_TOKEN", missing));
  emit("control", "PROOF_DEPLOYMENT_INTENT_STORE_DIR", "/data/deployment-intents");
  emit("control", "PROOF_DEPLOYMENT_INTENT_PEER_BACKFILL_ENABLED", "true");
  emit("control", "PROOF_DEPLOYMENT_INTENT_PEER_BACKFILL_AUTOSTART", "true");
  emit("control", "PROOF_DEPLOYMENT_INTENT_PEER_BACKFILL_INTERVAL_MS", "30000");
  emit("control", "PROOF_DEPLOYMENT_INTENT_PEER_BACKFILL_BATCH_SIZE", "500");
  emit("control", "PROOF_MANAGED_MAILBOX_ENABLED", "true");
  emit("control", "PROOF_MANAGED_MAILBOX_TOKEN", required(env, "PROOF_MANAGED_MAILBOX_TOKEN", missing));
  emit("control", "PROOF_MANAGED_MAILBOX_SQLITE_FILE", "/data/validation-reports/proof-relay.sqlite");
  emit("control", "PROOF_MANAGED_MAILBOX_SQLITE_DRIVER", "node:sqlite");
  emit("control", "PROOF_MANAGED_MAILBOX_PEER_BACKFILL_ENABLED", "true");
  emit("control", "PROOF_MANAGED_MAILBOX_PEER_BACKFILL_AUTOSTART", "true");
  emit("control", "PROOF_MANAGED_MAILBOX_PEER_BACKFILL_INTERVAL_MS", "30000");
  emit("control", "PROOF_MANAGED_MAILBOX_PEER_BACKFILL_BATCH_SIZE", "500");
  emit("control", "PROOF_CERTIFICATE_ISSUANCE_STORE_DIR", "/data/certificate-issuance");
  emit("control", "PROOF_CERTIFICATE_AUTHORIZATION_TOKEN", certificateAuthorizationToken);
  emit("control", "PROOF_ROUTE_INTENT_URL", val(env, "PROOF_ROUTE_INTENT_URL", "http://gateway-agent:18080/route-intents"));
  emit("control", "PROOF_ROUTE_INTENT_TOKEN", routeIntentToken);
  emit("control", "OPERATOR_DOCKER_NETWORK", val(env, "OPERATOR_DOCKER_NETWORK", "switchboard-operator_operator"));
  emit("control", "PROOF_CUSTOMER_HOSTNAME_DNS_RESOLVERS", "system,1.1.1.1,8.8.8.8");
  emit("control", "PROOF_CUSTOMER_HOSTNAME_ACME_DNS01_DELEGATION_SUFFIX", val(env, "SWITCHBOARD_ACME_DELEGATION_HOSTNAME", services.acmeDelegationHostname));
  emit("control", "PROOF_CUSTOMER_HOSTNAME_ATTACH_LIMIT_PER_HOUR", "5");
  emit("control", "PROOF_CUSTOMER_HOSTNAME_ATTACH_LIMIT_PER_DAY", "20");
  emit("control", "PROOF_CUSTOMER_HOSTNAME_CERT_AUTH_COOLDOWN_SECONDS", "86400");
  emit("control", "PROOF_CANONICAL_DNS_MATERIALIZATION_ENABLED", "true");
  emit("control", "PROOF_CANONICAL_DNS_RESOLVERS", "1.1.1.1,8.8.8.8");
  emit("control", "PROOF_CANONICAL_DNS_TTL", "60");
  emit("control", "PROOF_CANONICAL_DNS_MATERIALIZATION_INTERVAL_MS", "15000");
  emit("control", "PROOF_CANONICAL_DNS_MATERIALIZATION_BATCH_SIZE", "50");
  emit("control", "PROOF_PLATFORM_JOBS_JSON", platformJobsJson);
  emit("control", "PROOF_OPERATOR_AVAILABILITY_ENABLED", "true");
  emit("control", "PROOF_OPERATOR_AVAILABILITY_AUTOSTART", "true");
  emit("control", "PROOF_OPERATOR_AVAILABILITY_NETWORK_ID", "polkadot-hub");
  emit("control", "PROOF_OPERATOR_AVAILABILITY_MAX_MANUAL_LOOKBACK_SECONDS", "86400");
  emit("control", "PROOF_OPERATOR_AVAILABILITY_MAX_ASSIGNMENTS_PER_RUN", "10000");
  emit("control", "PROOF_OPERATOR_AVAILABILITY_RUN_TIMEOUT_MS", "10000");
  emit("control", "PROOF_OPERATOR_AVAILABILITY_RETENTION_HOT_REPORT_DAYS", "30");
  emit("control", "PROOF_OPERATOR_AVAILABILITY_RETENTION_HOT_REPORT_MAX_ROWS", "50000");
  emit("control", "PROOF_OPERATOR_AVAILABILITY_RETENTION_HOT_ASSIGNMENT_DAYS", "30");
  emit("control", "PROOF_OPERATOR_AVAILABILITY_RETENTION_HOT_ASSIGNMENT_MAX_ROWS", "50000");
  emit("control", "PROOF_OPERATOR_AVAILABILITY_RETENTION_HOT_CAPABILITY_DAYS", "30");
  emit("control", "PROOF_OPERATOR_AVAILABILITY_RETENTION_HOT_CAPABILITY_MAX_ROWS", "10000");
  emit("control", "PROOF_OPERATOR_CAPABILITIES_ENABLED", "true");
  emit("control", "PROOF_OPERATOR_CAPABILITY_STORE_KIND", "sqlite");
  emit("control", "PROOF_OPERATOR_CAPABILITY_ALLOWED_SIGNERS", required(env, "PROOF_OPERATOR_CAPABILITY_ALLOWED_SIGNERS", missing));
  emit("control", "PROOF_OPERATOR_PROFILES_JSON", operatorProfilesJson({
    operatorId,
    managerIds: operatorManagerIds,
    reportSigner: required(env, "PROOF_OPERATOR_CAPABILITY_ALLOWED_SIGNERS", missing).split(",")[0] ?? "",
    payoutAddress: operatorRecipient
  }));
  emit("control", "PROOF_CONTROL_PLANE_ENABLED", "true");
  emit("control", "PROOF_CONTROL_PLANE_TOKEN", controlPlaneToken);
  emit("control", "PROOF_CONTROL_PLANE_REQUIRE_ACTIVATION_VALIDATION", "true");
  emit("control", "PROOF_CONTROL_PLANE_ACTIVATION_VALIDATION_MAX_AGE_MS", "600000");
  emit("control", "PROOF_CONTROL_PLANE_ALLOW_MANUAL_FULFILLMENT_RECORDING", "false");
  emit("control", "PROOF_SETTLEMENT_REQUIRE_LEADER_FOR_BATCHES", "true");
  emit("control", "PROOF_SETTLEMENT_REQUIRE_LIVE_PEER_STATUS", "false");
  emit("control", "PROOF_FULFILLMENT_SCHEDULER_ENABLED", "false");
  emit("control", "PROOF_FULFILLMENT_SCHEDULER_AUTOSTART", "false");
  emit("control", "PROOF_FULFILLMENT_SCHEDULER_MIN_PERIOD_SECONDS", "14400");
  emit("control", "PROOF_FULFILLMENT_SCHEDULER_ALLOW_SHORT_PERIODS", "false");
  emit("control", "PROOF_FULFILLMENT_SCHEDULER_FINAL_WINDOW_SETTLEMENT_ENABLED", "false");

  emit("operator", "HUB_ETH_RPC_URL", hubEthRpcUrl);
  emit("operator", "INGRESS_REGISTRY_ADDRESS", registryAddress);
  emit("operator", "HUB_WATCH_START_BLOCK", "15174380");
  emit("operator", "HUB_WATCH_MAX_BLOCK_RANGE", "500");
  emit("operator", "HUB_CONFIRMATIONS", "1");
  emit("operator", "PROOF_NETWORK_MANIFEST_URL", `${controlPlaneUrl}/v1/network-manifest`);
  emit("operator", "PROOF_NETWORK_MANIFEST_SIGNER", networkManifestSigner);
  emit("operator", "PROOF_NETWORK_MANIFEST_REFRESH_MS", "60000");
  emit("operator", "OPERATOR_ID", operatorId);
  emit("operator", "GATEWAY_ID", gatewayId);
  emit("operator", "OPERATOR_MANAGER_IDS", operatorManagerIds);
  emit("operator", "ACURAST_NETWORK", "mainnet");
  emit("operator", "ACURAST_RPC", "wss://public-rpc.mainnet.acurast.com");
  emit("operator", "OPERATOR_PUBLIC_ADDRESSES", required(env, "OPERATOR_PUBLIC_ADDRESSES", missing));
  emit("operator", "OPERATOR_REPORT_SEED", required(env, "PROOF_MAINNET_OPERATOR_REPORT_SEED", missing));
  emit("operator", "GATEWAY_AGENT_ROUTE_INTENT_TOKEN", routeIntentToken);
  emit("operator", "ROUTE_INTENT_OUTPUT_TOKEN", routeIntentToken);
  emit("operator", "PROOF_OPERATOR_CAPABILITY_URL", `${controlPlaneUrl}/v1/operator-capabilities`);
  emit("operator", "OPERATOR_PAYOUT_ADDRESS", operatorRecipient);
  emit("operator", "OPERATOR_SUPPORTED_ASSETS", defaultAssetAddress);
  emit("operator", "OPERATOR_FLOOR_PRICE_PER_MINUTE", "10000");

  emit("explorer", "PROOF_EXPLORER_IMAGE", val(env, "PROOF_EXPLORER_IMAGE", "ghcr.io/proof-computer/switchboard/explorer:latest"));
  emit("explorer", "PROOF_EXPLORER_BIND_ADDR", "0.0.0.0");
  emit("explorer", "PROOF_EXPLORER_PORT", "3300");
  emit("explorer", "PROOF_EXPLORER_BLOCKSCOUT_BASE_URL", "https://blockscout.polkadot.io");
  emit("explorer", "PROOF_EXPLORER_REGISTRY_ADDRESS", registryAddress);
  emit("explorer", "PROOF_EXPLORER_CHAIN", "mainnet");
  emit("explorer", "PROOF_EXPLORER_LOOKBACK_HOURS", "24");
  emit("explorer", "PROOF_EXPLORER_NETWORK_MANIFEST_URL", `${controlPlaneUrl}/v1/network-manifest`);
  emit("explorer", "PROOF_EXPLORER_RELAY_READ_TOKEN", required(env, "PROOF_VALIDATION_READ_TOKEN", missing));
  emit("explorer", "PROOF_EXPLORER_PLATFORM_JOBS_JSON", platformJobsJson);

  return { rows, missing: [...new Set(missing)].sort() };
}

async function manifestRelaysJson(cwd: string, env: NodeJS.ProcessEnv): Promise<RelayCatalogInputEntry[]> {
  const envRelays = val(env, "PROOF_NETWORK_MANIFEST_RELAYS_JSON");
  if (envRelays) {
    const parsed = JSON.parse(envRelays) as RelayCatalogInputEntry[];
    if (!Array.isArray(parsed)) {
      throw new Error("PROOF_NETWORK_MANIFEST_RELAYS_JSON must be a JSON array");
    }
    return parsed;
  }
  const store = await readRelayCatalogStore(cwd).catch(() => undefined);
  if (store) {
    return store.entries
      .filter((entry) => (entry.state ?? (entry.active === false ? "disabled" : "active")) === "active")
      .map((entry) => ({
        relayId: entry.relayId,
        apiBaseUrl: entry.apiBaseUrl,
        ...(entry.validationReportUrl ? { validationReportUrl: entry.validationReportUrl } : {}),
        ...(entry.controlPlaneUrl ? { controlPlaneUrl: entry.controlPlaneUrl } : {}),
        active: true
      }));
  }
  return [];
}

function platformJobsJsonFromRelays(relays: RelayCatalogInputEntry[], explorerEndpoint?: string): string {
  const jobs = [
    ...(explorerEndpoint
      ? [{
      serviceId: "proof-explorer-bootstrap",
      kind: "explorer",
      label: "Bootstrap Explorer",
      status: "online",
      endpoint: explorerEndpoint
    }]
      : []),
    ...relays.map((relay) => ({
      serviceId: relay.relayId,
      kind: "relay",
      label: relay.relayId
        .split("-")
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join(" "),
      status: "online",
      endpoint: relay.apiBaseUrl
    }))
  ];
  return JSON.stringify(jobs);
}

function operatorProfilesJson(input: {
  operatorId: string;
  managerIds: string;
  reportSigner: string;
  payoutAddress: string;
}): string {
  return JSON.stringify([
    {
      operatorId: input.operatorId,
      status: "active",
      reportSigners: [input.reportSigner],
      gatewayIds: [],
      managerIds: [input.managerIds],
      maxActiveSessions: 500,
      floorPricePerMinute: "10000",
      payoutAddress: input.payoutAddress
    }
  ]);
}

function serializeEnvRows(rows: EnvRow[]): string {
  return rows.map((row) => `${row.group}\t${row.key}\t${row.value}`).join("\n") + "\n";
}

function val(env: NodeJS.ProcessEnv, key: string, fallback = ""): string {
  const value = env[key];
  return value && value.length > 0 ? value : fallback;
}

function catalogMaxStaleSeconds(env: NodeJS.ProcessEnv, key: string, fallback = DEFAULT_SERVICE_CATALOG_MAX_STALE_SECONDS): number {
  const raw = val(env, key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative integer number of seconds`);
  }
  return parsed;
}

function splitCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function required(env: NodeJS.ProcessEnv, key: string, missing: string[]): string {
  const value = val(env, key);
  if (!value) missing.push(key);
  return value;
}

function requiredValue(value: string | undefined, label: string, missing: string[]): string {
  const normalized = value && value.length > 0 ? value : "";
  if (!normalized) missing.push(label);
  return normalized;
}

function redactedValue(key: string, value: string): string {
  if (!value) return "(empty)";
  return isSensitiveKey(key) ? "<redacted>" : value;
}

function isSensitiveKey(key: string): boolean {
  return /(PRIVATE|SECRET|TOKEN|SEED|SIGNING_KEY|HMAC|PASSWORD)/i.test(key);
}

function requireYes(
  ctx: BootstrapHostContext,
  flags: Map<string, string | boolean>,
  action: string,
  dryRun: boolean
): void {
  if (dryRun) return;
  if (boolFlag(flags, "yes") || ctx.env.SWITCHBOARD_BOOTSTRAP_ASSUME_YES === "true") return;
  throw new Error(`Refusing to run ${action} without --yes`);
}

async function runChecked(
  ctx: BootstrapHostContext,
  command: string,
  args: string[],
  options: { input?: string; dryRun: boolean }
): Promise<BootstrapHostCommandResult | undefined> {
  ctx.io.log(`> ${command} ${args.map(shellQuoteForDisplay).join(" ")}`);
  if (options.dryRun) return undefined;
  const result = await ctx.runner(command, args, { cwd: ctx.cwd, input: options.input });
  if (result.stdout.trim()) ctx.io.log(result.stdout.trimEnd());
  if (result.stderr.trim()) ctx.io.warn(result.stderr.trimEnd());
  if (result.code !== 0) {
    throw new Error(`${command} exited with code ${result.code}`);
  }
  return result;
}

function defaultRunner(
  command: string,
  args: string[],
  options: { cwd: string; input?: string }
): Promise<BootstrapHostCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 0,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
    if (options.input) child.stdin.write(options.input);
    child.stdin.end();
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellQuoteForDisplay(value: string): string {
  return /^[A-Za-z0-9_./:=@,+-]+$/.test(value) ? value : shellQuote(value);
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function integerFlag(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  const value = stringFlag(flags, name);
  if (!value) return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return Number(value);
}
