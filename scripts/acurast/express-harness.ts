#!/usr/bin/env node
import "dotenv/config";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiPromise, HttpProvider, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import type { KeyringPair } from "@polkadot/keyring/types";
import { walletFromMnemonic, setEnvVars } from "@acurast/sdk/chain";
import { uploadScript } from "@acurast/sdk/ipfs";
import { getFeeAnalysis } from "@acurast/sdk/matcher";
import { cryptoWaitReady, decodeAddress, encodeAddress, mnemonicValidate } from "@polkadot/util-crypto";
import { build } from "esbuild";

type Command = "prepare" | "upload-script" | "estimate-fee" | "deploy-dry-run" | "deploy" | "deploy-direct" | "update-env" | "status" | "inspect";
type DeploymentProfileName = "default" | "smoke";

interface ParsedArgs {
  command: Command;
  flags: Map<string, string | boolean>;
}

interface HarnessConfig {
  rootDir: string;
  stageDir: string;
  projectName: string;
  network: "mainnet" | "canary";
  npmCacheDir: string;
  profile: DeploymentProfile;
  mnemonicEnvName: string;
  addressEnvName?: string;
  mnemonic?: string;
  expectedAddress?: string;
}

interface DeploymentProfile {
  name: DeploymentProfileName;
  startDelayMs: number;
  executionMs: number;
  maxAllowedStartDelayMs: number;
  instantMatchStartDelayMs: number;
  maxCostPerExecution: number;
}

interface DeploymentInspection {
  deploymentId: string;
  origin: string;
  rpcUrl: string;
  chainTimestampIso: string;
  status: unknown;
  registration: unknown;
  schedule?: {
    startTimeIso: string;
    maxStartTimeIso: string;
    endTimeIso: string;
    secondsUntilStart: number;
    secondsUntilMaxStart: number;
    secondsUntilEnd: number;
  };
  executions: Array<{
    index: number;
    status: unknown;
  }>;
  assignments: Array<{
    processor: string;
    assignment: unknown;
    acknowledged: boolean | null;
    nextReportIndex: unknown;
    hasEnvironmentVariables: boolean | null;
    environmentVariableCount: number | null;
  }>;
  eventScan?: DeploymentEventScan;
}

interface DeploymentEventScan {
  fromBlock: number;
  toBlock: number;
  fromTimestampIso: string;
  toTimestampIso: string;
  events: DeploymentChainEvent[];
}

interface DeploymentChainEvent {
  block: number;
  timestampIso: string;
  event: string;
  phase: string;
  dataString: string;
  human: unknown;
}

interface DirectJobRegistration {
  script: string;
  allowedSources?: string[];
  allowOnlyVerifiedSources: boolean;
  schedule: {
    duration: number;
    startTime: number;
    endTime: number;
    interval: number;
    maxStartDelay: number;
  };
  memory: number;
  networkRequests: number;
  storage: number;
  requiredModules: string[];
  mutability: string;
  reuseKeysFrom?: [string, string, number] | null;
  extra: {
    requirements: {
      assignmentStrategy: {
        variant: "Single" | "Competing";
        instantMatch?: Array<{
          source: string;
          startDelay: number;
        }>;
      };
      slots: number;
      reward: number;
      minReputation: number;
      runtime: string;
    };
  };
}

interface DirectDeploymentResult {
  txHash: string;
  jobId: [unknown, number | string];
  deploymentId: string;
}

const rootDir = process.env.SWITCHBOARD_WORK_DIR
  ? path.resolve(process.env.SWITCHBOARD_WORK_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MAINNET_RPC = "wss://archive.mainnet.acurast.com";
const DEFAULT_CANARY_RPC = "wss://canarynet-ws-1.acurast-h-server-2.papers.tech";
const DEFAULT_ACURAST_IPFS_URL = "https://ipfs-proxy.acurast.prod.gke.papers.tech";
const DEFAULT_ACURAST_IPFS_API_KEY = "";
const DIRECT_SCHEDULE_END_ENV = "ACURAST_SCHEDULE_END_MS";
const USE_EXISTING_STAGE_ENV = "ACURAST_USE_EXISTING_STAGE";
const REQUIRE_ENCRYPTED_BUNDLE_ENV = "ACURAST_REQUIRE_ENCRYPTED_BUNDLE";
const ENCRYPTED_BUNDLE_LOADER_MARKER = "Switchboard encrypted Acurast relay bootstrap";

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const config = await loadHarnessConfig(parsed.flags);
  if (parsed.command === "update-env") {
    if (!config.mnemonic) {
      throw new Error(`${credentialEnvNames(config.network).seed.join(" or ")} is required for update-env`);
    }
    await validateAcurastAccount(config);
    const deploymentId = stringFlag(parsed.flags, "deployment-id") ?? process.env.ACURAST_DEPLOYMENT_ID;
    if (!deploymentId) {
      throw new Error("Missing --deployment-id or ACURAST_DEPLOYMENT_ID for update-env");
    }
    await mkdir(config.stageDir, { recursive: true });
    await writeAcurastConfig(config);
    await writeFile(path.join(config.stageDir, ".env"), buildAcurastEnv(config));
    const result = await updateAcurastJobEnvWithSdk(config, deploymentId);
    console.log(result.hash ? `Acurast environment variables set: tx=${result.hash}` : "Acurast environment variables set: no env vars configured");
    return;
  }
  const canUseExistingStage = parsed.command === "deploy-direct" || parsed.command === "upload-script";
  const prepared =
    canUseExistingStage && shouldUseExistingStage(parsed.flags)
      ? await loadExistingAcurastProject(config, {
          requireEncryptedBundle: shouldRequireEncryptedBundle(parsed.flags)
        })
      : await prepareAcurastProject(config);

  if (parsed.command === "prepare") {
    writeOutput(parsed.flags, {
      ok: true,
      action: "prepare",
      ...prepared
    }, () => {
      console.log(`Prepared Acurast project at ${prepared.stageDir}`);
      console.log(`Bundle: ${prepared.bundlePath}`);
      console.log(`Config: ${prepared.acurastConfigPath}`);
      console.log(
        config.mnemonic
          ? `Acurast .env written with ACURAST_MNEMONIC from ${config.mnemonicEnvName}`
          : `Acurast .env not written; set ${credentialEnvNames(config.network).seed.join(" or ")} before fee/deploy commands`
      );
    });
    return;
  }

  if (parsed.command === "upload-script") {
    const scriptIpfs = await resolveDirectScriptIpfs(config, parsed.flags);
    const bundleSha256 = await fileSha256(prepared.bundlePath);
    const output = {
      version: 1,
      kind: "switchboard-validator-script",
      scriptIpfs,
      scriptHash: `sha256:${bundleSha256}`,
      bundleSha256,
      gitSha: process.env.GITHUB_SHA ?? process.env.SWITCHBOARD_GIT_SHA,
      generatedAt: new Date().toISOString(),
      source: {
        repository: process.env.GITHUB_REPOSITORY,
        workflow: process.env.GITHUB_WORKFLOW,
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT
      }
    };
    const manifestPath = path.join(config.stageDir, "validator-script-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(output, null, 2)}\n`);
    writeOutput(parsed.flags, { ok: true, manifestPath, ...output }, () => {
      console.log(`Validator script: ${scriptIpfs}`);
      console.log(`Bundle sha256: ${bundleSha256}`);
      console.log(`Manifest: ${manifestPath}`);
    });
    return;
  }

  if (!config.mnemonic) {
    throw new Error(
      `${credentialEnvNames(config.network).seed.join(" or ")} is required for estimate-fee, deploy-dry-run, and deploy`
    );
  }

  await validateAcurastAccount(config);

  if (parsed.command === "estimate-fee") {
    const estimate = estimateAcurastFeeWithSdk(config);
    writeOutput(parsed.flags, estimate, () => {
      console.log(`Acurast estimate: ${estimate.estimatedFee} ${estimate.currency}`);
      console.log(`Project: ${estimate.projectName}`);
      console.log(`Replicas: ${estimate.replicas}`);
      console.log(`Executions: ${estimate.executions}`);
    });
    return;
  }

  if (parsed.command === "deploy-dry-run") {
    const dryRun = buildAcurastDirectDryRun(config);
    writeOutput(parsed.flags, dryRun, () => {
      console.log("Acurast deploy dry run");
      console.log(`Project: ${dryRun.projectName}`);
      console.log(`Network: ${dryRun.network}`);
      console.log(`Script: ${dryRun.registration.script}`);
      console.log(
        `Schedule: start=${new Date(dryRun.registration.schedule.startTime).toISOString()} end=${new Date(
          dryRun.registration.schedule.endTime
        ).toISOString()}`
      );
    });
    return;
  }

  if (parsed.command === "deploy-direct") {
    if (!boolFlag(parsed.flags, "yes") && process.env.ACURAST_ASSUME_YES !== "true") {
      throw new Error("Refusing to deploy to Acurast without --yes or ACURAST_ASSUME_YES=true");
    }

    await deployDirect(config, parsed.flags);
    return;
  }

  if (parsed.command === "status") {
    const deploymentId = stringFlag(parsed.flags, "deployment-id") ?? process.env.ACURAST_DEPLOYMENT_ID ?? await latestDeploymentId(config);
    await inspectDeploymentCommand(config, parsed.flags, deploymentId);
    return;
  }

  if (parsed.command === "inspect") {
    const deploymentId = stringFlag(parsed.flags, "deployment-id") ?? process.env.ACURAST_DEPLOYMENT_ID ?? await latestDeploymentId(config);
    await inspectDeploymentCommand(config, parsed.flags, deploymentId);
    return;
  }

  if (!boolFlag(parsed.flags, "yes") && process.env.ACURAST_ASSUME_YES !== "true") {
    throw new Error("Refusing to deploy to Acurast without --yes or ACURAST_ASSUME_YES=true");
  }

  auditProjectEnvForRuntime();
  await deployDirect(config, parsed.flags);
}

async function loadHarnessConfig(flags: Map<string, string | boolean>): Promise<HarnessConfig> {
  const network = stringFlag(flags, "network") ?? process.env.ACURAST_NETWORK ?? "canary";
  if (network !== "mainnet" && network !== "canary") {
    throw new Error(`Unsupported Acurast network: ${network}`);
  }

  const stageDir = path.resolve(
    stringFlag(flags, "stage-dir") ?? process.env.ACURAST_STAGE_DIR ?? path.join(rootDir, "dist/acurast/express-webserver")
  );
  const credentials = loadAcurastCredentials(network);

  return {
    rootDir,
    stageDir,
    network,
    projectName: stringFlag(flags, "project") ?? process.env.ACURAST_PROJECT_NAME ?? "switchboard-express",
    npmCacheDir: process.env.NPM_CONFIG_CACHE ?? process.env.npm_config_cache ?? "/tmp/codex-npm-cache",
    profile: deploymentProfile(flags),
    ...credentials
  };
}

function loadAcurastCredentials(network: HarnessConfig["network"]): Pick<
  HarnessConfig,
  "mnemonic" | "expectedAddress" | "mnemonicEnvName" | "addressEnvName"
> {
  const names = credentialEnvNames(network);
  const mnemonic = firstEnv(names.seed);
  const expectedAddress = firstEnv(names.address);

  return {
    mnemonic: mnemonic?.value,
    expectedAddress: expectedAddress?.value,
    mnemonicEnvName: mnemonic?.name ?? names.seed[0],
    addressEnvName: expectedAddress?.name
  };
}

function credentialEnvNames(network: HarnessConfig["network"]): { seed: string[]; address: string[] } {
  const prefix = network === "canary" ? "ACURAST_CANARY" : "ACURAST_MAINNET";
  return {
    seed: [`${prefix}_SEED`, "ACURAST_SEED"],
    address: [`${prefix}_ADDRESS`, "ACURAST_ADDRESS"]
  };
}

function firstEnv(names: string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return { name, value };
    }
  }

  return undefined;
}

async function prepareAcurastProject(config: HarnessConfig) {
  const prebuiltBundle = prebuiltJobBundlePath();
  const bundlePath = path.join(config.stageDir, "dist/bundle.cjs");
  const acurastConfigPath = path.join(config.stageDir, "acurast.json");
  const switchboardBuildConfig = await readSwitchboardBuildConfig();
  const skipBundleBuild = process.env.SWITCHBOARD_SKIP_BUNDLE_BUILD === "true";
  await rm(path.join(config.stageDir, "dist"), { recursive: true, force: true });
  await rm(path.join(config.stageDir, ".acurast"), { recursive: true, force: true });
  await mkdir(path.dirname(bundlePath), { recursive: true });

  if (skipBundleBuild) {
    // Validator launches deploy a control-plane-approved ipfs:// script. The
    // public CLI intentionally does not ship the private validator bundle.
  } else if (prebuiltBundle) {
    assertPrebuiltRuntimeBootstrapEnv(switchboardBuildConfig);
    await copyFile(prebuiltBundle, bundlePath);
  } else {
    try {
      await build({
        entryPoints: [path.resolve(config.rootDir, process.env.ACURAST_ENTRYPOINT ?? "src/server.ts")],
        outfile: bundlePath,
        bundle: true,
        platform: "node",
        target: "node24",
        format: "cjs",
        sourcemap: false,
        minify: true,
        legalComments: "none",
        define: {
          __SWITCHBOARD_BUILD_CONFIG__: JSON.stringify(switchboardBuildConfig)
        },
        logLevel: "silent"
      });
    } catch (error) {
      if (isTopLevelAwaitBuildError(error)) {
        throw new Error(
          "Acurast NodeJSWithBundle loads project bundles with require(); top-level await is not supported. Wrap startup in an async function and call it without top-level await."
        );
      }
      throw error;
    }
  }

  await writeAcurastConfig(config);
  auditProjectEnvForRuntime();
  await assertNoSecretValuesInUploadArtifacts([...(skipBundleBuild ? [] : [bundlePath]), acurastConfigPath]);

  const envPath = path.join(config.stageDir, ".env");
  if (config.mnemonic || process.env.ACURAST_IPFS_URL || process.env.ACURAST_IPFS_API_KEY) {
    await writeFile(envPath, buildAcurastEnv(config));
  }

  return {
    stageDir: config.stageDir,
    bundlePath,
    acurastConfigPath,
    envPath: config.mnemonic || process.env.ACURAST_IPFS_URL || process.env.ACURAST_IPFS_API_KEY ? envPath : undefined,
    projectName: config.projectName,
    network: config.network,
    profile: config.profile.name
  };
}

async function loadExistingAcurastProject(
  config: HarnessConfig,
  options: { requireEncryptedBundle: boolean }
) {
  const bundlePath = path.join(config.stageDir, "dist/bundle.cjs");
  const acurastConfigPath = path.join(config.stageDir, "acurast.json");
  const envPath = path.join(config.stageDir, ".env");

  await assertReadableFile(bundlePath, "staged Acurast bundle");
  await assertReadableFile(acurastConfigPath, "staged Acurast config");
  if (options.requireEncryptedBundle) {
    await assertStagedBundleIsEncryptedLoader(bundlePath);
  }

  return {
    stageDir: config.stageDir,
    bundlePath,
    acurastConfigPath,
    envPath: (await fileExists(envPath)) ? envPath : undefined,
    projectName: config.projectName,
    network: config.network,
    profile: config.profile.name
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertReadableFile(filePath: string, label: string): Promise<void> {
  try {
    await stat(filePath);
  } catch {
    throw new Error(`${label} is missing at ${filePath}`);
  }
}

async function assertStagedBundleIsEncryptedLoader(bundlePath: string): Promise<void> {
  const content = await readFile(bundlePath, "utf8");
  const requiredMarkers = [
    ENCRYPTED_BUNDLE_LOADER_MARKER,
    "SWITCHBOARD_CODE_CIPHERTEXT_B64",
    "SWITCHBOARD_CODE_PLAINTEXT_SHA256"
  ];
  const missing = requiredMarkers.filter((marker) => !content.includes(marker));
  if (missing.length > 0) {
    throw new Error(
      `Refusing to upload unencrypted Acurast relay bundle: ${path.basename(bundlePath)} is missing encrypted loader marker(s): ${missing.join(", ")}`
    );
  }

  const plaintextMarkers = [
    "__SWITCHBOARD_BUILD_CONFIG__",
    "registerIngressWithRelay",
    "maybeRegisterIngress",
    "PLAINTEXT_RELAY_BUNDLE_MARKER"
  ];
  const leakedMarkers = plaintextMarkers.filter((marker) => content.includes(marker));
  if (leakedMarkers.length > 0) {
    throw new Error(
      `Refusing to upload unencrypted Acurast relay bundle: ${path.basename(bundlePath)} still contains plaintext marker(s): ${leakedMarkers.join(", ")}`
    );
  }
}

async function fileSha256(filePath: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function assertNoSecretValuesInUploadArtifacts(paths: string[]): Promise<void> {
  const secretKeys = unique([
    ...listEnv("ACURAST_SECRET_SCAN_KEYS"),
    "RELAYER_PRIVATE_KEY",
    "EVM_PRIVATE_KEY",
    "DEVELOPER_PRIVATE_KEY",
    "PRIVATE_KEY",
    "QUOTE_SIGNER_PRIVATE_KEY",
    "CLOUDFLARE_API_TOKEN",
    "PROOF_CONTROL_PLANE_TOKEN",
    "PROOF_VALIDATION_READ_TOKEN",
    "PROOF_NETWORK_MANIFEST_SIGNING_KEY",
    "SWITCHBOARD_CONTROL_TOKEN",
    "SWITCHBOARD_CODE_KEY",
    "ACURAST_SEED",
    "ACURAST_MAINNET_SEED",
    "ACURAST_CANARY_SEED",
    "ACURAST_IPFS_API_KEY"
  ]);
  const presentSecrets = unique([
    ...secretKeys,
    ...Object.keys(process.env).filter((key) => isSecretLikeEnvName(key))
  ])
    .map((key) => ({ key, value: process.env[key] }))
    .filter((item): item is { key: string; value: string } => Boolean(item.value && item.value.length >= 8));
  if (presentSecrets.length === 0) {
    return;
  }

  const leaks: string[] = [];
  for (const artifactPath of paths) {
    const contents = await readFile(artifactPath, "utf8");
    for (const secret of presentSecrets) {
      if (contents.includes(secret.value)) {
        leaks.push(`${secret.key} in ${artifactPath}`);
      }
    }
  }

  if (leaks.length > 0) {
    throw new Error(`Refusing to upload Acurast bundle with secret value(s): ${leaks.join(", ")}`);
  }
}

function isSecretLikeEnvName(name: string): boolean {
  if (["PATH", "OLDPWD", "PWD", "SHELL", "SHLVL", "TERM", "USER"].includes(name)) {
    return false;
  }
  return [
    /(^|_)PRIVATE_KEY$/,
    /(^|_)SEED$/,
    /(^|_)MNEMONIC$/,
    /(^|_)TOKEN$/,
    /(^|_)API_KEY$/,
    /(^|_)HMAC_KEY$/,
    /(^|_)ENCRYPTION_KEY$/,
    /^ACME_EAB_/,
    /^CLOUDFLARE_/,
    /^PROOF_.*_(SECRET|TOKEN|KEY|SEED)$/,
    /^SWITCHBOARD_.*_(SECRET|TOKEN|KEY|SEED)$/,
    /^ACURAST_.*_(SEED|TOKEN|KEY)$/
  ].some((pattern) => pattern.test(name));
}

async function readSwitchboardBuildConfig(): Promise<string> {
  if (process.env.SWITCHBOARD_BUILD_CONFIG_FILE) {
    return readFile(process.env.SWITCHBOARD_BUILD_CONFIG_FILE, "utf8");
  }
  return process.env.SWITCHBOARD_BUILD_CONFIG ?? "";
}

function assertPrebuiltRuntimeBootstrapEnv(rawConfig: string): void {
  const buildConfig = parseSwitchboardBuildConfig(rawConfig);
  const buildConfigHasIntent = Boolean(buildConfig?.SWITCHBOARD_RELAY_URL || buildConfig?.SWITCHBOARD_INTENT_ID);
  const runtimeConfigProvided = Boolean(process.env.SWITCHBOARD_CONFIG);
  if (!buildConfigHasIntent || runtimeConfigProvided) {
    return;
  }

  const requiredRuntimeEnv = [
    "SWITCHBOARD_RELAY_URL",
    "SWITCHBOARD_INTENT_ID",
    "SWITCHBOARD_INTENT_TOKEN"
  ];
  const missing = requiredRuntimeEnv.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      [
        "Prebuilt Acurast job bundles cannot read SWITCHBOARD_BUILD_CONFIG_FILE at runtime.",
        `Set these values as encrypted Acurast env vars before deploy: ${missing.join(", ")}.`
      ].join(" ")
    );
  }
}

function parseSwitchboardBuildConfig(rawConfig: string): Record<string, string> | undefined {
  if (!rawConfig.trim()) {
    return undefined;
  }
  try {
    const json = rawConfig.trim().startsWith("{")
      ? rawConfig
      : Buffer.from(rawConfig, "base64").toString("utf8");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)])
    );
  } catch {
    return undefined;
  }
}

function buildAcurastConfig(config: HarnessConfig) {
  const processorWhitelist = listEnv("ACURAST_PROCESSOR_WHITELIST");
  const instantMatch = listEnv("ACURAST_INSTANT_MATCH_PROCESSORS").map((processor) => ({
    processor,
    maxAllowedStartDelayInMs: numberEnv("ACURAST_INSTANT_MATCH_START_DELAY_MS", config.profile.instantMatchStartDelayMs)
  }));

  return {
    projects: {
      [config.projectName]: {
        projectName: config.projectName,
        fileUrl: "dist/bundle.cjs",
        network: config.network,
        onlyAttestedDevices: booleanEnv("ACURAST_ONLY_ATTESTED_DEVICES", true),
        startAt: {
          msFromNow: numberEnv("ACURAST_START_DELAY_MS", config.profile.startDelayMs)
        },
        assignmentStrategy:
          instantMatch.length > 0
            ? {
                type: "Single",
                instantMatch
              }
            : {
                type: "Single"
              },
        execution: {
          type: "onetime",
          maxExecutionTimeInMs: numberEnv("ACURAST_EXECUTION_MS", config.profile.executionMs)
        },
        maxAllowedStartDelayInMs: numberEnv("ACURAST_MAX_ALLOWED_START_DELAY_MS", config.profile.maxAllowedStartDelayMs),
        usageLimit: {
          maxMemory: numberEnv("ACURAST_MAX_MEMORY", 0),
          maxNetworkRequests: numberEnv("ACURAST_MAX_NETWORK_REQUESTS", 0),
          maxStorage: numberEnv("ACURAST_MAX_STORAGE", 0)
        },
        numberOfReplicas: numberEnv("ACURAST_REPLICAS", 1),
        requiredModules: listEnv("ACURAST_REQUIRED_MODULES"),
        minProcessorReputation: numberEnv("ACURAST_MIN_PROCESSOR_REPUTATION", 0),
        maxCostPerExecution: numberEnv("ACURAST_MAX_COST_PER_EXECUTION", config.profile.maxCostPerExecution),
        includeEnvironmentVariables: projectEnvKeys(),
        processorWhitelist,
        mutability: process.env.ACURAST_MUTABILITY ?? "Immutable",
        enableDevtools: booleanEnv("ACURAST_ENABLE_DEVTOOLS", false)
      }
    }
  };
}

function estimateAcurastFeeWithSdk(config: HarnessConfig): Record<string, unknown> {
  const project = (buildAcurastConfig(config).projects as any)[config.projectName];
  const analysis = getFeeAnalysis(project);
  const estimatedFee = analysis.maxTotalCostCACU.toString();
  return {
    ok: true,
    mode: "acurast-sdk",
    projectName: config.projectName,
    network: config.network,
    estimatedFee,
    fee: estimatedFee,
    cost: estimatedFee,
    currency: "cACU",
    executions: analysis.numberOfExecutions.toString(),
    replicas: analysis.numberOfReplicas.toString(),
    totalRuns: analysis.totalRuns.toString(),
    maxCostPerExecution: analysis.maxCostPerExecution.toString(),
    maxCostPerExecutionCACU: analysis.maxCostPerExecutionCACU.toString(),
    maxTotalCostCACU: analysis.maxTotalCostCACU.toString(),
    suggestedCostPerExecution: analysis.suggestedCostPerExecution.toString()
  };
}

function buildAcurastDirectDryRun(config: HarnessConfig): Record<string, any> {
  const scriptIpfs = process.env.ACURAST_SCRIPT_IPFS?.startsWith("ipfs://")
    ? process.env.ACURAST_SCRIPT_IPFS
    : "ipfs://dry-run-script";
  const registration = buildDirectJobRegistration(config, scriptIpfs, Date.now());
  return {
    ok: true,
    mode: "acurast-sdk-dry-run",
    projectName: config.projectName,
    network: config.network,
    registration,
    envKeys: projectEnvKeys()
  };
}

async function deployDirect(config: HarnessConfig, flags: Map<string, string | boolean>): Promise<void> {
  const scriptIpfs = await resolveDirectScriptIpfs(config, flags);
  const rpcUrl = rpcForNetwork(config.network);
  const api = await ApiPromise.create({ provider: providerForRpc(rpcUrl), noInitWarn: true });
  const deploymentTime = new Date();

  try {
    const chainTimestampMs = Number((await (api.query as any).timestamp.now()).toJSON());
    const registration = buildDirectJobRegistration(config, scriptIpfs, chainTimestampMs);
    await applyDirectScheduleEndEnv(config, registration.schedule.endTime);
    const origin = config.expectedAddress ?? (await deriveAcurastAddress(config));
    const signer = await deriveAcurastSigner(config);

    console.log(`Direct deploy RPC: ${rpcUrl}`);
    console.log(`Direct deploy origin: ${origin}`);
    console.log(
      `Direct deploy schedule: start=${new Date(registration.schedule.startTime).toISOString()} end=${new Date(
        registration.schedule.endTime
      ).toISOString()}`
    );

    const result = await submitDirectDeployment(
      api,
      signer,
      registration,
      numberFlag(flags, "submit-timeout-ms", numberEnv("ACURAST_SUBMIT_TIMEOUT_MS", 120_000))
    );
    await storeDirectDeployment(config, deploymentTime, registration, result.jobId);
    console.log(`Direct deploy registered: deploymentId=${result.deploymentId} tx=${result.txHash}`);

    if (projectEnvKeys().length > 0) {
      await waitForProcessorAcknowledgement(
        api,
        result.jobId,
        registration.extra.requirements.slots,
        numberFlag(flags, "ack-timeout-ms", numberEnv("ACURAST_ACK_TIMEOUT_MS", 240_000)),
        numberFlag(flags, "ack-interval-ms", numberEnv("ACURAST_ACK_INTERVAL_MS", 10_000))
      );
    }
    if (!boolFlag(flags, "skip-env") && projectEnvKeys().length > 0) {
      const envResult = await updateAcurastJobEnvWithSdk(config, result.deploymentId);
      console.log(envResult.hash ? `Direct deploy env tx: ${envResult.hash}` : "Direct deploy env: no env vars configured");
    }
  } finally {
    await api.disconnect();
  }
}

async function resolveDirectScriptIpfs(config: HarnessConfig, flags: Map<string, string | boolean>): Promise<string> {
  const explicit = stringFlag(flags, "script-ipfs") ?? process.env.ACURAST_SCRIPT_IPFS;
  if (explicit) {
    if (!explicit.startsWith("ipfs://")) {
      throw new Error("ACURAST_SCRIPT_IPFS/--script-ipfs must start with ipfs://");
    }
    return explicit;
  }

  if (shouldRequireEncryptedBundle(flags)) {
    await assertStagedBundleIsEncryptedLoader(path.join(config.stageDir, "dist/bundle.cjs"));
  }

  const script = await uploadScript(
    { file: path.join(config.stageDir, "dist/bundle.cjs") },
    {
      endpoint: process.env.ACURAST_IPFS_URL ?? DEFAULT_ACURAST_IPFS_URL,
      apiKey: process.env.ACURAST_IPFS_API_KEY ?? DEFAULT_ACURAST_IPFS_API_KEY
    }
  );
  if (!script.startsWith("ipfs://")) {
    throw new Error(`Acurast SDK upload returned an invalid script URI: ${script}`);
  }
  return script;
}

async function latestStagedScriptIpfs(config: HarnessConfig): Promise<string | undefined> {
  const deployDir = path.join(config.stageDir, ".acurast/deploy");
  let files: string[];
  try {
    files = await readdir(deployDir);
  } catch {
    return undefined;
  }

  const candidates = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const fullPath = path.join(deployDir, file);
        const details = await stat(fullPath);
        return { fullPath, mtimeMs: details.mtimeMs };
      })
  );
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const candidate of candidates) {
    const parsed = JSON.parse(await readFile(candidate.fullPath, "utf8")) as { registration?: { script?: unknown } };
    const script = parsed.registration?.script;
    if (typeof script === "string" && script.startsWith("ipfs://")) {
      return script;
    }
  }

  return undefined;
}

async function writeAcurastConfig(config: HarnessConfig): Promise<void> {
  await mkdir(config.stageDir, { recursive: true });
  await writeFile(path.join(config.stageDir, "acurast.json"), `${JSON.stringify(buildAcurastConfig(config), null, 2)}\n`);
}

async function applyDirectScheduleEndEnv(config: HarnessConfig, scheduleEndMs: number): Promise<void> {
  process.env[DIRECT_SCHEDULE_END_ENV] = String(scheduleEndMs);
  await writeAcurastConfig(config);
  if (config.mnemonic) {
    await writeFile(path.join(config.stageDir, ".env"), buildAcurastEnv(config));
  }
}

function buildDirectJobRegistration(
  config: HarnessConfig,
  scriptIpfs: string,
  chainTimestampMs: number
): DirectJobRegistration {
  const acurastConfig = buildAcurastConfig(config).projects[config.projectName] as any;
  const startTime = chainTimestampMs + numberEnv("ACURAST_START_DELAY_MS", config.profile.startDelayMs);
  const duration = numberEnv("ACURAST_EXECUTION_MS", config.profile.executionMs);
  const endTime = startTime + duration + 1;
  const interval = endTime - startTime;
  const instantMatch = (acurastConfig.assignmentStrategy.instantMatch ?? []) as Array<{
    processor: string;
    maxAllowedStartDelayInMs: number;
  }>;

  return {
    script: scriptIpfs,
    allowedSources: acurastConfig.processorWhitelist.length > 0 ? acurastConfig.processorWhitelist : undefined,
    allowOnlyVerifiedSources: acurastConfig.onlyAttestedDevices,
    schedule: {
      duration,
      startTime,
      endTime,
      interval,
      maxStartDelay: acurastConfig.maxAllowedStartDelayInMs
    },
    memory: acurastConfig.usageLimit.maxMemory,
    networkRequests: acurastConfig.usageLimit.maxNetworkRequests,
    storage: acurastConfig.usageLimit.maxStorage,
    requiredModules: acurastConfig.requiredModules,
    mutability: acurastConfig.mutability,
    reuseKeysFrom: acurastConfig.reuseKeysFrom,
    extra: {
      requirements: {
        assignmentStrategy:
          acurastConfig.assignmentStrategy.type === "Single"
            ? {
                variant: "Single",
                instantMatch: instantMatch.map((item) => ({
                  source: item.processor,
                  startDelay: item.maxAllowedStartDelayInMs
                }))
              }
            : { variant: "Competing" },
        slots: acurastConfig.numberOfReplicas,
        reward: acurastConfig.maxCostPerExecution,
        minReputation: acurastConfig.minProcessorReputation,
        runtime: acurastConfig.runtime ?? "NodeJSWithBundle"
      }
    }
  };
}

async function deriveAcurastSigner(config: HarnessConfig): Promise<KeyringPair> {
  if (!config.mnemonic) {
    throw new Error("Cannot derive deployment signer without an Acurast mnemonic");
  }

  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  return keyring.addFromMnemonic(config.mnemonic);
}

async function submitDirectDeployment(
  api: ApiPromise,
  signer: KeyringPair,
  registration: DirectJobRegistration,
  timeoutMs: number
): Promise<DirectDeploymentResult> {
  const tx = (api.tx as any).acurastMarketplace.deploy(
    createDirectRegistrationType(api, registration),
    api.createType("AcurastCommonScriptMutability", registration.mutability),
    registration.reuseKeysFrom
      ? api.createType("Option<(AcurastCommonMultiOrigin, u128)>", [
          api.createType("AcurastCommonMultiOrigin", { acurast: registration.reuseKeysFrom[1] }),
          api.createType("u128", registration.reuseKeysFrom[2])
        ])
      : api.createType("Option<(AcurastCommonMultiOrigin, u128)>", undefined),
    api.createType("Option<Vec<(u8, u128, u128)>>", [])
  );

  let unsubscribe: (() => void) | undefined;
  let settled = false;

  return new Promise<DirectDeploymentResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe?.();
      reject(new Error(`Timed out waiting for direct deployment submission after ${timeoutMs}ms`));
    }, timeoutMs);

    tx.signAndSend(signer, { nonce: -1 }, ({ status, events, txHash, dispatchError }: any) => {
      console.log(`Direct deploy tx status: ${status.type} ${txHash.toHex()}`);

      if (dispatchError) {
        clearTimeout(timer);
        unsubscribe?.();
        settled = true;
        reject(dispatchErrorToError(api, dispatchError));
        return;
      }

      const jobIds = events
        .filter((event: any) => event.event.section === "acurast" && event.event.method === "JobRegistrationStoredV2")
        .map((event: any) => event.event.data[0].toJSON() as [unknown, number | string]);

      if (jobIds.length > 0) {
        clearTimeout(timer);
        unsubscribe?.();
        settled = true;
        const jobId = jobIds[0];
        const deploymentId = String(jobId[1]);
        resolve({
          txHash: txHash.toHex(),
          jobId,
          deploymentId
        });
      }
    })
      .then((unsub: () => void) => {
        unsubscribe = unsub;
      })
      .catch((error: unknown) => {
        if (settled) {
          return;
        }
        clearTimeout(timer);
        settled = true;
        reject(error);
      });
  });
}

function createDirectRegistrationType(api: ApiPromise, job: DirectJobRegistration): unknown {
  const script = `0x${Buffer.from(new TextEncoder().encode(job.script)).toString("hex")}`;
  const assignmentStrategy =
    job.extra.requirements.assignmentStrategy.variant === "Single"
      ? api.createType("PalletAcurastMarketplaceAssignmentStrategy", {
          single: job.extra.requirements.assignmentStrategy.instantMatch
            ? api.createType(
                "Option<Vec<PalletAcurastMarketplacePlannedExecution>>",
                job.extra.requirements.assignmentStrategy.instantMatch.map((item) => ({
                  source: api.createType("AccountId", item.source),
                  startDelay: api.createType("u64", String(item.startDelay))
                }))
              )
            : api.createType("Option<bool>", undefined)
        })
      : api.createType("PalletAcurastMarketplaceAssignmentStrategy", { competing: "" });

  return api.createType("AcurastCommonJobRegistration", {
    script: api.createType("Bytes", script),
    allowedSources: job.allowedSources
      ? api.createType("Option<Vec<AccountId>>", job.allowedSources)
      : api.createType("Option<Vec<AccountId>>", undefined),
    allowOnlyVerifiedSources: job.allowOnlyVerifiedSources,
    schedule: {
      duration: api.createType("u64", job.schedule.duration),
      startTime: api.createType("u64", job.schedule.startTime),
      endTime: api.createType("u64", job.schedule.endTime),
      interval: api.createType("u64", job.schedule.interval),
      maxStartDelay: api.createType("u64", job.schedule.maxStartDelay)
    },
    memory: api.createType("u32", job.memory),
    networkRequests: api.createType("u32", job.networkRequests),
    storage: api.createType("u32", job.storage),
    requiredModules: api.createType("Vec<AcurastCommonJobModule>", job.requiredModules),
    extra: api.createType("PalletAcurastMarketplaceRegistrationExtra", {
      requirements: api.createType("PalletAcurastMarketplaceJobRequirements", {
        assignmentStrategy,
        slots: api.createType("u8", job.extra.requirements.slots),
        reward: api.createType("u128", job.extra.requirements.reward),
        minReputation: job.extra.requirements.minReputation
          ? api.createType("Option<u128>", job.extra.requirements.minReputation)
          : api.createType("Option<u128>", undefined),
        processorVersion: api.createType("Option<PalletAcurastMarketplaceProcessorVersionRequirements>", undefined),
        instantMatch: api.createType("Option<bool>", undefined),
        runtime: api.createType("PalletAcurastMarketplaceRuntime", job.extra.requirements.runtime)
      })
    })
  });
}

function dispatchErrorToError(api: ApiPromise, dispatchError: any): Error {
  if (dispatchError.isModule) {
    const decoded = api.registry.findMetaError(dispatchError.asModule);
    return new Error(`${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`);
  }

  return new Error(dispatchError.toHuman?.() ?? dispatchError.toString());
}

async function storeDirectDeployment(
  config: HarnessConfig,
  deploymentTime: Date,
  registration: DirectJobRegistration,
  jobId: [unknown, number | string]
): Promise<void> {
  const deployDir = path.join(config.stageDir, ".acurast/deploy");
  const deploymentId = String(jobId[1]);
  const fileName = path.join(deployDir, `${config.projectName}-${deploymentTime.getTime()}-${deploymentId}.json`);
  await mkdir(deployDir, { recursive: true });
  await writeFile(
    fileName,
    `${JSON.stringify(
      {
        deployedAt: deploymentTime.toISOString(),
        assignments: [],
        status: "init",
        config: (buildAcurastConfig(config).projects as any)[config.projectName],
        registration,
        deploymentId: jobId
      },
      null,
      2
    )}\n`
  );
}

async function waitForProcessorAcknowledgement(
  api: ApiPromise,
  jobId: [unknown, number | string],
  expectedAcknowledgements: number,
  timeoutMs: number,
  intervalMs: number
): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    const acknowledgements = await acknowledgedProcessors(api, jobId);
    console.log(
      `Direct deploy acknowledgements: ${acknowledgements.acknowledged}/${expectedAcknowledgements} assigned=${acknowledgements.assigned}`
    );
    if (acknowledgements.acknowledged >= expectedAcknowledgements) {
      return;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for processor acknowledgement after ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

async function acknowledgedProcessors(
  api: ApiPromise,
  jobId: [unknown, number | string]
): Promise<{ assigned: number; acknowledged: number }> {
  const market = (api.query as any).acurastMarketplace;
  const assignedProcessors = await market.assignedProcessors.entries(jobId);
  let acknowledged = 0;

  for (const [key] of assignedProcessors) {
    const processor = key.args[1].toString();
    const assignment = await market.storedMatches(processor, jobId);
    const assignmentJson = assignment.toJSON() as { acknowledged?: unknown } | null;
    if (assignmentJson?.acknowledged === true) {
      acknowledged += 1;
    }
  }

  return { assigned: assignedProcessors.length, acknowledged };
}

function deploymentProfile(flags: Map<string, string | boolean>): DeploymentProfile {
  const name = stringFlag(flags, "profile") ?? process.env.ACURAST_DEPLOYMENT_PROFILE ?? "default";
  if (name === "default") {
    return {
      name,
      startDelayMs: 300_000,
      executionMs: 3_600_000,
      maxAllowedStartDelayMs: 600_000,
      instantMatchStartDelayMs: 600_000,
      maxCostPerExecution: 20_000_000_000
    };
  }

  if (name === "smoke") {
    return {
      name,
      startDelayMs: 300_000,
      executionMs: 300_000,
      maxAllowedStartDelayMs: 120_000,
      instantMatchStartDelayMs: 120_000,
      maxCostPerExecution: 40_000_000_000
    };
  }

  throw new Error(`Unsupported Acurast deployment profile: ${name}`);
}

function buildAcurastEnv(config: HarnessConfig): string {
  const env = new Map<string, string>();
  const compactEnv = process.env.ACURAST_COMPACT_ENV === "true";
  const buildConfig = Boolean(process.env.SWITCHBOARD_BUILD_CONFIG || process.env.SWITCHBOARD_BUILD_CONFIG_FILE);
  env.set("ACURAST_MNEMONIC", config.mnemonic ?? "");
  if (!compactEnv || process.env.PORT) {
    env.set("PORT", process.env.PORT ?? "3000");
  }
  if (!compactEnv || process.env.SWITCHBOARD_HOST) {
    env.set("SWITCHBOARD_HOST", process.env.SWITCHBOARD_HOST ?? "0.0.0.0");
  }
  if (process.env.SWITCHBOARD_AUTO_REGISTER || !compactEnv || !buildConfig) {
    env.set("SWITCHBOARD_AUTO_REGISTER", process.env.SWITCHBOARD_AUTO_REGISTER ?? "false");
  }
  if (process.env.SESSION_ID || (!compactEnv && !process.env.SWITCHBOARD_CONFIG)) {
    env.set("SESSION_ID", process.env.SESSION_ID ?? "acurast-harness-session");
  }

  for (const key of projectEnvKeys()) {
    const value = process.env[key];
    if (value) {
      env.set(key, value);
    }
  }

  if (process.env.ACURAST_RPC) {
    env.set("ACURAST_RPC", process.env.ACURAST_RPC);
  }
  if (process.env.ACURAST_CANARY_RPC) {
    env.set("ACURAST_CANARY_RPC", process.env.ACURAST_CANARY_RPC);
  }
  if (process.env.ACURAST_IPFS_URL) {
    env.set("ACURAST_IPFS_URL", process.env.ACURAST_IPFS_URL);
  }
  if (process.env.ACURAST_IPFS_API_KEY) {
    env.set("ACURAST_IPFS_API_KEY", process.env.ACURAST_IPFS_API_KEY);
  }

  return `${Array.from(env.entries())
    .map(([key, value]) => `${key}=${quoteEnv(value)}`)
    .join("\n")}\n`;
}

function projectEnvKeys(): string[] {
  const compactEnv = process.env.ACURAST_COMPACT_ENV === "true";
  const buildConfig = Boolean(process.env.SWITCHBOARD_BUILD_CONFIG || process.env.SWITCHBOARD_BUILD_CONFIG_FILE);
  const explicitKeys = listEnv("ACURAST_INCLUDE_ENV").map((key) => {
    if (!process.env[key]) {
      throw new Error(`${key} is listed in ACURAST_INCLUDE_ENV but is not set`);
    }
    return key;
  });
  if (process.env.ACURAST_EXPLICIT_ENV_ONLY === "true") {
    return unique(explicitKeys);
  }
  const baseKeys = [];
  if (process.env.SWITCHBOARD_AUTO_REGISTER || !compactEnv || !buildConfig) {
    baseKeys.push("SWITCHBOARD_AUTO_REGISTER");
  }
  if (!compactEnv || process.env.PORT) {
    baseKeys.unshift("PORT");
  }
  if (!compactEnv || process.env.SWITCHBOARD_HOST) {
    const insertAt = baseKeys[0] === "PORT" ? 1 : 0;
    baseKeys.splice(insertAt, 0, "SWITCHBOARD_HOST");
  }
  if (process.env.SESSION_ID || (!compactEnv && !process.env.SWITCHBOARD_CONFIG)) {
    baseKeys.push("SESSION_ID");
  }
  const optionalKeys = [
    "DEPLOYMENT_ID",
    "JOB_ID",
    "RELAY_URL",
    "CHAIN_ID",
    "INGRESS_REGISTRY_ADDRESS",
    "OPERATOR_ID",
    "PROCESSOR_ID",
    "ENDPOINT_HOSTNAME",
    "NONCE",
    "DEADLINE",
    "CONTRACT_CALL_TIMEOUT_MS",
    "JOB_SIGNER_PRIVATE_KEY",
    "SWITCHBOARD_CONFIG",
    // SWITCHBOARD_BUILD_CONFIG intentionally omitted: esbuild inlines it
    // into the bundle as __SWITCHBOARD_BUILD_CONFIG__, so shipping it as a
    // setEnvironments env var is redundant and the JSON routinely exceeds the
    // chain's envValueMaxSize=1024 cap, deterministically panicking the
    // runtime in TaggedTransactionQueue_validate_transaction.
    "SWITCHBOARD_SIGNER_SMOKE",
    "SWITCHBOARD_REGISTRATION_RETRY_MS",
    "SWITCHBOARD_REGISTRATION_MAX_ATTEMPTS",
    "SWITCHBOARD_EXIT_AFTER_MS",
    // SWITCHBOARD_TLS_{CERT,KEY}_PEM[_BASE64] intentionally omitted:
    // PEM-encoded TLS material always exceeds the chain plaintext cap
    // (~996 bytes after AES-GCM overhead), so it cannot ride
    // setEnvironments today. The relay job's consumer-side reads in
    // the packaged Switchboard job entrypoints
    // remain — they will be populated at runtime by the planned secrets
    // service (see docs/knowledge/raw-inputs/2026-05-03-acurast-runtime-
    // secrets-service-direction.md).
    "SWITCHBOARD_CERTIFICATE_MODE",
    "SWITCHBOARD_CERTIFICATE_REQUEST_TIMEOUT_MS",
    "SWITCHBOARD_RELAY_DIAGNOSTICS",
    "SWITCHBOARD_RELAY_DIAGNOSTICS_TIMEOUT_MS",
    "SWITCHBOARD_CONTROL_TOKEN",
    DIRECT_SCHEDULE_END_ENV
  ].filter((key) => process.env[key]);
  return unique([
    ...baseKeys,
    ...optionalKeys,
    ...explicitKeys
  ]);
}

// Acurast mainnet runtime caps on `acurast.setEnvironments`. Submitting a
// payload that violates any of these deterministically traps the chain
// runtime in TaggedTransactionQueue_validate_transaction (wasm unreachable),
// burning the schedule slot. Pre-flight locally so the failure is loud and
// reversible. Caps confirmed against mainnet runtime (specVersion=12) on
// 2026-05-03 via `api.consts.acurast`.
const ACURAST_RUNTIME_MAX_ENV_VARS = 10;
const ACURAST_RUNTIME_ENV_KEY_MAX = 32;
const ACURAST_RUNTIME_ENV_VALUE_MAX = 1024;
// AES-256-GCM overhead added by the SDK before submission: 12-byte IV +
// 16-byte auth tag. So the plaintext ceiling is 1024 - 28 = 996 bytes.
const ACURAST_AES_GCM_OVERHEAD = 28;
const ACURAST_RUNTIME_PLAINTEXT_MAX = ACURAST_RUNTIME_ENV_VALUE_MAX - ACURAST_AES_GCM_OVERHEAD;

function auditAcurastEnvSubmission(keys: string[], source: string): void {
  const violations: string[] = [];
  if (keys.length > ACURAST_RUNTIME_MAX_ENV_VARS) {
    violations.push(
      `count ${keys.length} > maxEnvVars=${ACURAST_RUNTIME_MAX_ENV_VARS} (drop optional keys, or move secrets to a runtime fetch)`
    );
  }
  for (const key of keys) {
    const keyBytes = Buffer.byteLength(key, "utf8");
    if (keyBytes > ACURAST_RUNTIME_ENV_KEY_MAX) {
      violations.push(`key "${key}" is ${keyBytes} bytes > envKeyMaxSize=${ACURAST_RUNTIME_ENV_KEY_MAX}`);
    }
    const value = process.env[key] ?? "";
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (valueBytes > ACURAST_RUNTIME_PLAINTEXT_MAX) {
      violations.push(
        `value for "${key}" is ${valueBytes} bytes > plaintext cap ${ACURAST_RUNTIME_PLAINTEXT_MAX} (envValueMaxSize=${ACURAST_RUNTIME_ENV_VALUE_MAX} minus AES-GCM overhead ${ACURAST_AES_GCM_OVERHEAD})`
      );
    }
  }
  if (violations.length > 0) {
    const lines = [
      `Refusing to submit setEnvironments (source: ${source}): payload exceeds Acurast runtime caps.`,
      ...violations.map((v) => `  - ${v}`),
      "These caps are BoundedVec types in the runtime; exceeding them traps wasm",
      "during validate_transaction and silently burns the schedule slot."
    ];
    throw new Error(lines.join("\n"));
  }
}

function auditProjectEnvForRuntime(): void {
  auditAcurastEnvSubmission(projectEnvKeys(), "harness projectEnvKeys()");
}

async function readDeploymentEnvKeys(config: HarnessConfig, deploymentId: string): Promise<string[]> {
  const record = await readDeploymentRecord(config, deploymentId);
  if (!record) {
    return [];
  }
  const keys = record.config?.includeEnvironmentVariables;
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
}

async function auditDeploymentEnvForRuntime(config: HarnessConfig, deploymentId: string): Promise<void> {
  const keys = await readDeploymentEnvKeys(config, deploymentId);
  if (keys.length === 0) {
    return;
  }
  auditAcurastEnvSubmission(keys, `deployment file for ${deploymentId}`);
}

interface StoredDirectDeployment {
  deploymentId?: unknown;
  registration?: DirectJobRegistration;
  config?: {
    includeEnvironmentVariables?: unknown;
  };
}

async function readDeploymentRecord(config: HarnessConfig, deploymentId: string): Promise<StoredDirectDeployment | undefined> {
  const deployDir = path.join(config.stageDir, ".acurast/deploy");
  let files: string[];
  try {
    files = await readdir(deployDir);
  } catch {
    return undefined;
  }
  const filename = files.find((file) => file.endsWith(`-${deploymentId}.json`));
  if (!filename) {
    return undefined;
  }
  return JSON.parse(await readFile(path.join(deployDir, filename), "utf8")) as StoredDirectDeployment;
}

async function updateAcurastJobEnvWithSdk(config: HarnessConfig, deploymentId: string): Promise<{ hash?: string }> {
  await auditDeploymentEnvForRuntime(config, deploymentId);
  const keys = await readDeploymentEnvKeys(config, deploymentId);
  if (keys.length === 0) {
    return {};
  }
  if (!config.mnemonic) {
    throw new Error("Cannot update Acurast env vars without an Acurast mnemonic");
  }
  const record = await readDeploymentRecord(config, deploymentId);
  const jobId = await deploymentJobIdForSdk(config, deploymentId, record);
  const wallet = await walletFromMnemonic(config.mnemonic, { name: "switchboard-cli" });
  return setEnvVars({
    id: jobId,
    envVars: keys.map((key) => ({ key, value: projectEnvValue(key) }))
  } as any, {
    wallet,
    rpcEndpoint: rpcForNetwork(config.network)
  });
}

async function deploymentJobIdForSdk(
  config: HarnessConfig,
  deploymentId: string,
  record: StoredDirectDeployment | undefined
): Promise<[{ acurast: string }, number]> {
  const stored = record?.deploymentId;
  if (Array.isArray(stored) && stored.length >= 2) {
    const origin = stored[0] as Record<string, unknown>;
    const acurast = typeof origin?.acurast === "string" ? origin.acurast : undefined;
    const sequence = Number(stored[1]);
    if (acurast && Number.isSafeInteger(sequence)) {
      return [{ acurast }, sequence];
    }
  }
  const sequence = Number(deploymentId);
  if (!Number.isSafeInteger(sequence)) {
    throw new Error(`deployment-id must be a safe numeric Acurast job sequence for SDK env update: ${deploymentId}`);
  }
  const origin = process.env.ACURAST_DEPLOYMENT_ORIGIN ?? config.expectedAddress ?? await deriveAcurastAddress(config);
  return [{ acurast: origin }, sequence];
}

function projectEnvValue(key: string): string {
  switch (key) {
    case "PORT":
      return process.env.PORT ?? "3000";
    case "SWITCHBOARD_HOST":
      return process.env.SWITCHBOARD_HOST ?? "0.0.0.0";
    case "SWITCHBOARD_AUTO_REGISTER":
      return process.env.SWITCHBOARD_AUTO_REGISTER ?? "false";
    case "SESSION_ID":
      return process.env.SESSION_ID ?? "acurast-harness-session";
    default:
      return process.env[key] ?? "";
  }
}

function prebuiltJobBundlePath(): string | undefined {
  if (process.env.SWITCHBOARD_PREBUILT_JOB_BUNDLE) {
    return path.resolve(process.env.SWITCHBOARD_PREBUILT_JOB_BUNDLE);
  }
  return undefined;
}

function isTopLevelAwaitBuildError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /top-level await/i.test(message);
}

async function validateAcurastAccount(config: HarnessConfig): Promise<void> {
  if (!config.mnemonic || !mnemonicValidate(config.mnemonic)) {
    throw new Error("ACURAST_SEED must be a valid mnemonic phrase");
  }
  if (!config.expectedAddress) {
    return;
  }

  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  const pair = keyring.addFromMnemonic(config.mnemonic);
  const derivedPublicKey = decodeAddress(pair.address);
  const expectedPublicKey = decodeAddress(config.expectedAddress);
  if (!Buffer.from(derivedPublicKey).equals(Buffer.from(expectedPublicKey))) {
    throw new Error(`ACURAST_SEED does not derive ACURAST_ADDRESS ${config.expectedAddress}`);
  }
}

async function latestDeploymentId(config: HarnessConfig): Promise<string> {
  const deployDir = path.join(config.stageDir, ".acurast/deploy");
  let files: string[];
  try {
    files = await readdir(deployDir);
  } catch {
    throw new Error("No staged Acurast deployments found; pass --deployment-id <id>");
  }

  const candidates = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const fullPath = path.join(deployDir, file);
        const details = await stat(fullPath);
        return { file, fullPath, mtimeMs: details.mtimeMs };
      })
  );
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const candidate of candidates) {
    const parsed = JSON.parse(await readFile(candidate.fullPath, "utf8")) as { deploymentId?: unknown };
    const deploymentId = parsed.deploymentId;
    if (Array.isArray(deploymentId) && deploymentId.length >= 2) {
      return String(deploymentId[1]);
    }

    const filenameMatch = candidate.file.match(/-(\d+)\.json$/);
    if (filenameMatch) {
      return filenameMatch[1];
    }
  }

  throw new Error("No registered Acurast deployment ID found; pass --deployment-id <id>");
}

async function inspectDeploymentCommand(
  config: HarnessConfig,
  flags: Map<string, string | boolean>,
  deploymentId: string
): Promise<void> {
  const pollIntervalMs = numberFlag(flags, "interval-ms", 30_000);
  const timeoutMs = boolFlag(flags, "watch") ? numberFlag(flags, "timeout-ms", 900_000) : 0;
  const startedAt = Date.now();

  while (true) {
    const inspection = await inspectDeployment(
      config,
      deploymentId,
      numberFlag(flags, "executions", 1),
      boolFlag(flags, "watch") || boolFlag(flags, "events")
    );
    writeOutput(flags, inspection, () => printDeploymentInspection(inspection));

    if (!boolFlag(flags, "watch") || deploymentInspectionHasReport(inspection)) {
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      console.log(`Timed out waiting for execution report after ${timeoutMs}ms`);
      return;
    }

    await sleep(pollIntervalMs);
  }
}

async function inspectDeployment(
  config: HarnessConfig,
  deploymentId: string,
  executionCount: number,
  includeEvents = false
): Promise<DeploymentInspection> {
  if (!/^[0-9]+$/.test(deploymentId)) {
    throw new Error("deployment-id must be a numeric Acurast job sequence");
  }

  const originAddress = process.env.ACURAST_DEPLOYMENT_ORIGIN ?? config.expectedAddress ?? await deriveAcurastAddress(config);
  const sequence = Number(deploymentId);
  const origin = { acurast: originAddress };
  const jobId = [origin, sequence];
  const rpcUrl = rpcForNetwork(config.network);
  const api = await ApiPromise.create({ provider: providerForRpc(rpcUrl), noInitWarn: true });

  try {
    const market = (api.query as any).acurastMarketplace;
    const acurast = (api.query as any).acurast;
    const chainTimestampMs = Number((await (api.query as any).timestamp.now()).toJSON());
    const registration = await acurast.storedJobRegistration(origin, sequence);
    const registrationJson = registration.toJSON();
    const status = await market.storedJobStatus(origin, sequence);
    const assignments = await assignmentInspections(api, jobId);
    const executions = await Promise.all(
      Array.from({ length: executionCount }, async (_, index) => ({
        index,
        status: (await market.storedJobExecutionStatus(jobId, index)).toJSON()
      }))
    );
    const eventScan = includeEvents
      ? await scanDeploymentEvents(api, originAddress, sequence, registrationJson, chainTimestampMs)
      : undefined;

    return {
      deploymentId,
      origin: originAddress,
      rpcUrl,
      chainTimestampIso: new Date(chainTimestampMs).toISOString(),
      status: status.toJSON(),
      registration: registrationJson,
      schedule: scheduleInspection(registrationJson, chainTimestampMs),
      executions,
      assignments,
      eventScan
    };
  } finally {
    await api.disconnect();
  }
}

async function scanDeploymentEvents(
  api: ApiPromise,
  originAddress: string,
  sequence: number,
  registration: unknown,
  chainTimestampMs: number
): Promise<DeploymentEventScan> {
  const finalizedHash = await api.rpc.chain.getFinalizedHead();
  const finalizedHeader = await api.rpc.chain.getHeader(finalizedHash);
  const finalizedBlock = finalizedHeader.number.toNumber();
  const schedule = (registration as { schedule?: { startTime?: unknown; endTime?: unknown } } | null)?.schedule;
  const startTime = numericCodecJson(schedule?.startTime);
  const endTime = numericCodecJson(schedule?.endTime);
  let scanStartMs = Math.max(0, (startTime ?? chainTimestampMs) - 120_000);
  let scanEndMs = chainTimestampMs;

  if (endTime !== null) {
    scanEndMs = Math.min(chainTimestampMs, endTime + 600_000);
  }
  if (scanEndMs < scanStartMs) {
    scanStartMs = Math.max(0, scanEndMs - 120_000);
    scanEndMs = chainTimestampMs;
  }

  const fromBlock = Math.min(finalizedBlock, await firstBlockAtOrAfterTimestamp(api, scanStartMs, finalizedBlock));
  const toBlock = Math.min(finalizedBlock, await firstBlockAtOrAfterTimestamp(api, scanEndMs, finalizedBlock));
  const aliases = addressAliases(originAddress);
  const sequenceNeedles = [String(sequence), commaFormat(sequence)];
  const events: DeploymentChainEvent[] = [];
  const eventScanConcurrency = 8;
  let nextBlock = fromBlock;

  await Promise.all(Array.from({ length: eventScanConcurrency }, async () => {
    while (nextBlock <= toBlock) {
      const block = nextBlock;
      nextBlock += 1;
      const hash = await api.rpc.chain.getBlockHash(block);
      const apiAt = await api.at(hash);
      const timestampMs = Number((await (apiAt.query as any).timestamp.now()).toJSON());
      const records = await (apiAt.query as any).system.events();

      for (const record of records) {
        const event = record.event;
        if (event.section !== "acurast" && event.section !== "acurastMarketplace") {
          continue;
        }

        const dataString = event.data.toString();
        const human = event.toHuman();
        const searchable = `${event.section}.${event.method} ${dataString} ${JSON.stringify(human)}`;
        if (!sequenceNeedles.some((needle) => searchable.includes(needle))) {
          continue;
        }
        if (!aliases.some((alias) => searchable.includes(alias))) {
          continue;
        }

        events.push({
          block,
          timestampIso: new Date(timestampMs).toISOString(),
          event: `${event.section}.${event.method}`,
          phase: record.phase.toString(),
          dataString,
          human
        });
      }
    }
  }));
  events.sort((left, right) => left.block - right.block || left.event.localeCompare(right.event));

  return {
    fromBlock,
    toBlock,
    fromTimestampIso: new Date(await timestampAtBlock(api, fromBlock)).toISOString(),
    toTimestampIso: new Date(await timestampAtBlock(api, toBlock)).toISOString(),
    events
  };
}

async function firstBlockAtOrAfterTimestamp(api: ApiPromise, timestampMs: number, upperBlock: number): Promise<number> {
  let low = 0;
  let high = upperBlock;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const midTimestamp = await timestampAtBlock(api, mid);
    if (midTimestamp < timestampMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

async function timestampAtBlock(api: ApiPromise, block: number): Promise<number> {
  const hash = await api.rpc.chain.getBlockHash(block);
  const apiAt = await api.at(hash);
  return Number((await (apiAt.query as any).timestamp.now()).toJSON());
}

function addressAliases(address: string): string[] {
  try {
    const decoded = decodeAddress(address);
    return Array.from(new Set([
      address,
      encodeAddress(decoded, 0),
      encodeAddress(decoded, 42),
      encodeAddress(decoded, 63)
    ]));
  } catch {
    return [address];
  }
}

function commaFormat(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

async function assignmentInspections(api: ApiPromise, jobId: unknown[]): Promise<DeploymentInspection["assignments"]> {
  const market = (api.query as any).acurastMarketplace;
  const acurast = (api.query as any).acurast;
  const assignedProcessors = await market.assignedProcessors.entries(jobId);

  return Promise.all(
    assignedProcessors.map(async ([key]: any) => {
      const processor = key.args[1].toString();
      const assignment = await market.storedMatches(processor, jobId);
      const nextReportIndex = await market.nextReportIndex(jobId, processor);
      const environmentVariables = await acurast.executionEnvironment(jobId, processor);
      const environmentJson = environmentVariables.toJSON() as { variables?: unknown[] } | null;
      const assignmentJson = assignment.toJSON() as { acknowledged?: unknown } | null;

      return {
        processor,
        assignment: assignmentJson,
        acknowledged: typeof assignmentJson?.acknowledged === "boolean" ? assignmentJson.acknowledged : null,
        nextReportIndex: nextReportIndex.toJSON(),
        hasEnvironmentVariables: environmentVariables.isSome,
        environmentVariableCount: Array.isArray(environmentJson?.variables) ? environmentJson.variables.length : null
      };
    })
  );
}

function scheduleInspection(registration: unknown, chainTimestampMs: number): DeploymentInspection["schedule"] {
  const schedule = (registration as { schedule?: { startTime?: unknown; endTime?: unknown; maxStartDelay?: unknown } } | null)?.schedule;
  const startTime = numericCodecJson(schedule?.startTime);
  const endTime = numericCodecJson(schedule?.endTime);
  const maxStartDelay = numericCodecJson(schedule?.maxStartDelay);
  if (startTime === null || endTime === null || maxStartDelay === null) {
    return undefined;
  }

  const maxStartTime = startTime + maxStartDelay;
  return {
    startTimeIso: new Date(startTime).toISOString(),
    maxStartTimeIso: new Date(maxStartTime).toISOString(),
    endTimeIso: new Date(endTime).toISOString(),
    secondsUntilStart: Math.ceil((startTime - chainTimestampMs) / 1000),
    secondsUntilMaxStart: Math.ceil((maxStartTime - chainTimestampMs) / 1000),
    secondsUntilEnd: Math.ceil((endTime - chainTimestampMs) / 1000)
  };
}

function numericCodecJson(value: unknown): number | null {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return Number(value);
  }

  return null;
}

async function deriveAcurastAddress(config: HarnessConfig): Promise<string> {
  if (!config.mnemonic) {
    throw new Error("Cannot derive deployment origin without an Acurast mnemonic");
  }

  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  return keyring.addFromMnemonic(config.mnemonic).address;
}

function printDeploymentInspection(inspection: DeploymentInspection): void {
  console.log(`Deployment: ${inspection.deploymentId}`);
  console.log(`Origin: ${inspection.origin}`);
  console.log(`RPC: ${inspection.rpcUrl}`);
  console.log(`Chain time: ${inspection.chainTimestampIso}`);
  if (inspection.schedule) {
    console.log(
      `Schedule: start=${inspection.schedule.startTimeIso} maxStart=${inspection.schedule.maxStartTimeIso} end=${inspection.schedule.endTimeIso}`
    );
    console.log(
      `Remaining: start=${inspection.schedule.secondsUntilStart}s maxStart=${inspection.schedule.secondsUntilMaxStart}s end=${inspection.schedule.secondsUntilEnd}s`
    );
  }
  console.log(`Job status: ${JSON.stringify(inspection.status)}`);
  for (const execution of inspection.executions) {
    console.log(`Execution ${execution.index}: ${JSON.stringify(execution.status)}`);
  }
  if (inspection.assignments.length === 0) {
    console.log("Assignments: []");
  } else {
    console.log("Assignments:");
    for (const assignment of inspection.assignments) {
      console.log(
        [
          `- ${assignment.processor}`,
          `ack=${String(assignment.acknowledged)}`,
          `nextReportIndex=${JSON.stringify(assignment.nextReportIndex)}`,
          `env=${assignment.hasEnvironmentVariables ? assignment.environmentVariableCount ?? "present" : "none"}`
        ].join(" ")
      );
    }
  }

  if (inspection.eventScan) {
    console.log(
      `Acurast events: ${inspection.eventScan.events.length} match(es) blocks ${inspection.eventScan.fromBlock}-${inspection.eventScan.toBlock}`
    );
    for (const event of inspection.eventScan.events) {
      console.log(`- [${event.timestampIso} #${event.block}] ${event.event} ${event.dataString}`);
    }
  }
}

function deploymentInspectionHasReport(inspection: DeploymentInspection): boolean {
  const nextReportIndexAdvanced = inspection.assignments.some((assignment) => {
    const value = assignment.nextReportIndex;
    return typeof value === "number" ? value > 0 : value !== null && value !== undefined && value !== 0 && value !== "0";
  });

  if (nextReportIndexAdvanced) {
    return true;
  }

  return inspection.eventScan?.events.some((event) => (
    event.event === "acurastMarketplace.ReportedV2" ||
    event.event === "acurastMarketplace.ExecutionSuccess" ||
    event.event === "acurastMarketplace.ExecutionFailure"
  )) ?? false;
}

function rpcForNetwork(network: HarnessConfig["network"]): string {
  if (network === "mainnet") {
    return process.env.ACURAST_RPC ?? DEFAULT_MAINNET_RPC;
  }

  return process.env.ACURAST_CANARY_RPC ?? DEFAULT_CANARY_RPC;
}

function providerForRpc(rpcUrl: string): WsProvider | HttpProvider {
  return rpcUrl.startsWith("http://") || rpcUrl.startsWith("https://") ? new HttpProvider(rpcUrl) : new WsProvider(rpcUrl);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of Object.keys(sanitized)) {
    if (key.toLowerCase().startsWith("npm_config_")) {
      delete sanitized[key];
    }
  }
  delete sanitized.ACURAST_SEED;
  delete sanitized.ACURAST_ADDRESS;
  delete sanitized.ACURAST_CANARY_SEED;
  delete sanitized.ACURAST_CANARY_ADDRESS;
  delete sanitized.ACURAST_MAINNET_SEED;
  delete sanitized.ACURAST_MAINNET_ADDRESS;
  delete sanitized.POLKADOT_SEED;
  delete sanitized.JOB_SIGNER_PRIVATE_KEY;
  delete sanitized.DEPLOYER_PRIVATE_KEY;
  delete sanitized.DEVELOPER_PRIVATE_KEY;
  delete sanitized.RELAYER_PRIVATE_KEY;
  delete sanitized.EVM_PRIVATE_KEY;
  return sanitized;
}

function parseArgs(args: string[]): ParsedArgs {
  let command: Command | undefined;
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const withoutPrefix = arg.slice(2);
      const [name, inlineValue] = withoutPrefix.split("=", 2);
      if (inlineValue !== undefined) {
        flags.set(name, inlineValue);
        continue;
      }
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        flags.set(name, next);
        index += 1;
      } else {
        flags.set(name, true);
      }
      continue;
    }

    if (!command) {
      command = normalizeCommand(arg);
      continue;
    }

    throw new Error(`Unexpected positional argument: ${arg}`);
  }

  return {
    command: command ?? "prepare",
    flags
  };
}

function normalizeCommand(value: string): Command {
  if (
    value === "prepare" ||
    value === "upload-script" ||
    value === "estimate-fee" ||
    value === "deploy-dry-run" ||
    value === "deploy" ||
    value === "deploy-direct" ||
    value === "update-env" ||
    value === "status" ||
    value === "inspect"
  ) {
    return value;
  }

  throw new Error(`Unknown Acurast harness command: ${value}`);
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function shouldUseExistingStage(flags: Map<string, string | boolean>): boolean {
  return boolFlag(flags, "use-existing-stage") || process.env[USE_EXISTING_STAGE_ENV] === "true";
}

function shouldRequireEncryptedBundle(flags: Map<string, string | boolean>): boolean {
  return boolFlag(flags, "require-encrypted-bundle") || process.env[REQUIRE_ENCRYPTED_BUNDLE_ENV] === "true";
}

function jsonOutput(flags: Map<string, string | boolean>): boolean {
  return boolFlag(flags, "json");
}

function writeOutput<T>(flags: Map<string, string | boolean>, output: T, text: () => void) {
  if (jsonOutput(flags)) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  text();
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return Number(value);
}

function numberFlag(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  const value = stringFlag(flags, name);
  if (!value) {
    return fallback;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return Number(value);
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function quoteEnv(value: string): string {
  return JSON.stringify(value);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[acurast:express] ${message}`);
  process.exitCode = 1;
});
