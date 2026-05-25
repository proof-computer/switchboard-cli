#!/usr/bin/env node
import "dotenv/config";

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { Keyring } from "@polkadot/keyring";
import { u8aToHex } from "@polkadot/util";
import { cryptoWaitReady, mnemonicGenerate, mnemonicValidate } from "@polkadot/util-crypto";
import { ethers } from "ethers";

interface ParsedArgs {
  flags: Map<string, string | boolean>;
}

type ComposeStyle = "docker-compose-plugin" | "docker-compose-standalone";
type OperatorAdmissionMode = "local-only" | "pre-admission" | "admitted";
type OperatorStatusClassification =
  | "local-only"
  | "pre-admission"
  | "admitted"
  | "report-stale"
  | "route-state-unhealthy"
  | "relay-missing";

interface OsRelease {
  id?: string;
  idLike: string[];
  name?: string;
  versionId?: string;
}

interface CommandCheck {
  ok: boolean;
  command: string;
  args: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  reason?: string;
}

interface DockerState {
  docker: CommandCheck;
  compose: CommandCheck;
  composeStyle?: ComposeStyle;
  daemon: CommandCheck;
}

interface PromptIo {
  question(prompt: string): Promise<string | undefined>;
}

interface OperatorSetupConfig {
  projectDir: string;
  composeFile: string;
  envFile: string;
  imageRegistry: string;
  imageTag: string;
  localBuild: boolean;
  publicAddress: string;
  publicAddressMode: "auto" | "static";
  publicPort: number;
  gatewayAgentPort: number;
  gatewayAgentBindAddress?: string;
  gatewayAgentExternallyBound: boolean;
  upstreamAdmissionUrl?: string;
  routeStateUrl?: string;
  routeStateToken?: string;
  routeIntentToken?: string;
  routeIntentTokenGenerated: boolean;
  managerAddress?: string;
  managerIds?: string;
  operatorId?: string;
  processorRefs?: string;
  reportSeed?: string;
  reportSeedGenerated: boolean;
  reportSigner?: ReportSignerMetadata;
  capabilityReportUrl?: string;
  capabilityReportToken?: string;
  gatewayId: string;
  payoutAddress?: string;
  network: string;
  localOnly: boolean;
  prepareAdmission: boolean;
  admissionRequestFile?: string;
  admissionFile?: string;
  admissionBundle?: OperatorAdmissionBundle;
  mode: OperatorAdmissionMode;
  dryRun: boolean;
  skipInstall: boolean;
  skipCompose: boolean;
  assumeYes: boolean;
}

interface OperatorSetupReport {
  version: 1;
  kind: "switchboard.operator.setup";
  checkedAt: string;
  os: {
    platform: NodeJS.Platform;
    arch: string;
    release: string;
    osRelease?: OsRelease;
    supportedInstall: boolean;
  };
  docker: DockerState;
  network: {
    publicAddress: string;
    publicAddressMode: "auto" | "static";
    source: string;
    publicPort: number;
    gatewayAgentPort: number;
    localPortAlreadyOpen: boolean;
    gatewayAgentBindAddress?: string;
    gatewayAgentExternallyBound: boolean;
    upstreamAdmissionUrl?: string;
    routeStateUrl?: string;
  };
  config: {
    projectDir: string;
    composeFile: string;
    envFile: string;
    imageRegistry: string;
    imageTag: string;
    localBuild: boolean;
    gatewayAgentBindAddress?: string;
    gatewayAgentExternallyBound: boolean;
    upstreamAdmissionUrl?: string;
    routeIntentAuthConfigured: boolean;
    routeIntentTokenGenerated: boolean;
    routeStateUrl?: string;
    managerAddress?: string;
    managerIds?: string;
    operatorId?: string;
    processorRefs?: string;
    capabilityReportUrl?: string;
    gatewayId: string;
    payoutAddress?: string;
    reportSigner?: ReportSignerMetadata;
    admissionMode: OperatorAdmissionMode;
    admissionFile?: string;
    admissionRequestFile?: string;
    acurastNetwork: string;
  };
  admissionRequest?: OperatorAdmissionRequest;
  actions: string[];
  warnings: string[];
  composePullCommand?: string[];
  composeCommand?: string[];
}

interface ReportSignerMetadata {
  scheme: "substrate-sr25519";
  address: string;
  publicKey: string;
  ss58Format: number;
}

interface OperatorAdmissionBundle {
  operatorId?: string;
  gatewayId?: string;
  capabilityReportUrl?: string;
  capabilityReportToken?: string;
  routeStateUrl?: string;
  routeStateToken?: string;
  upstreamAdmissionUrl?: string;
  payoutAddress?: string;
  reportSigner?: {
    scheme?: string;
    address?: string;
    signer?: string;
    publicKey?: string;
    ss58Format?: number;
  };
  acceptedSigner?: {
    scheme?: string;
    address?: string;
    signer?: string;
    publicKey?: string;
    ss58Format?: number;
  };
}

interface OperatorAdmissionRequest {
  version: 1;
  kind: "switchboard.operator.admission.request";
  createdAt: string;
  network: string;
  operatorId?: string;
  gatewayId: string;
  managerIds: string[];
  processorAllowlist: {
    count: number;
    sha256?: string;
  };
  publicAddress: {
    value: string;
    mode: "auto" | "static";
    port: number;
  };
  payoutAddress?: string;
  reportSigner: ReportSignerMetadata;
  requestedRelays: {
    capabilityReportUrl?: string;
    routeStateUrl?: string;
    upstreamAdmissionUrl?: string;
  };
}

interface OperatorSetupRuntime {
  generateReportSeed?: () => string;
}

const DEFAULT_ENV_FILE = ".operator-host/operator.env";
const DEFAULT_COMPOSE_FILE = "docker-compose.yaml";
const DEFAULT_DISCOVERY_STATE_FILE = "~/.proof-index/operator-discovery-state.json";
const DEFAULT_OPERATOR_IMAGE_REGISTRY = "ghcr.io/proof-computer/switchboard-gateway";
const DEFAULT_OPERATOR_IMAGE_TAG = "latest";
const DEFAULT_ENVOY_IMAGE = "envoyproxy/envoy:v1.35-latest";
const DEFAULT_VICTORIA_METRICS_IMAGE = "victoriametrics/victoria-metrics:latest";
const DEFAULT_GRAFANA_IMAGE = "grafana/grafana-oss:latest";
const DEFAULT_MAINNET_ACURAST_RPC = "wss://archive.mainnet.acurast.com";
const DEFAULT_MAINNET_REGISTRY_ADDRESS = "0x65d6B76BeC50F46D198fFa3598E381a298025Da0";
const DEFAULT_MAINNET_MANIFEST_URL = "https://control.switchboard.proof.computer/v1/network-manifest";
const DEFAULT_MAINNET_MANIFEST_SIGNER = "5EpwnRzamXpqWo3jW9h4ecSJHL9LBjR6jTMW5Wzw6p9nMTh7";
const DEFAULT_MAINNET_CAPABILITY_REPORT_URL = "https://control.switchboard.proof.computer/v1/operator-capabilities";
const DEFAULT_MAINNET_HUB_ETH_RPC_URL = "https://services.polkadothub-rpc.com/mainnet";
const DEFAULT_MAINNET_HUB_SUBSTRATE_WS_URL = "wss://polkadot-asset-hub-rpc.polkadot.io";
const PACKAGED_OPERATOR_ASSET_DIR = "assets/operator";
const WAN_IP_URL = "https://ifconfig.me/ip";
const WAN_IP_COMMAND = ["curl", "--ipv4", WAN_IP_URL] as const;
const REMOVED_OPERATOR_ENV_KEYS = new Set(["OPERATOR_SLUG"]);
const LEGACY_OPERATOR_IMAGE_PATTERN = /^ghcr\.io\/(?:proof-computer|mooselabs)\/switchboard\/operator:(.+)$/;
const LEGACY_TLS_TEST_UPSTREAM_IMAGE_PATTERN = /^ghcr\.io\/(?:proof-computer|mooselabs)\/switchboard\/tls-test-upstream:(.+)$/;

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (boolFlag(parsed.flags, "help")) {
    printOperatorSetupUsage();
    return;
  }
  await runOperatorSetup(parsed.flags);
}

export async function runOperatorSetup(flags: Map<string, string | boolean>): Promise<void> {
  const report = await setupOperator(flags);
  writeOutput(flags, report, () => printOperatorSetupReport(report));
}

export async function runOperatorStatus(flags: Map<string, string | boolean>): Promise<void> {
  const projectDir = path.resolve(stringFlag(flags, "project-dir") ?? process.cwd());
  const composeFiles = await resolveComposeFiles(projectDir, flags);
  const envFile = path.resolve(projectDir, stringFlag(flags, "env-file") ?? DEFAULT_ENV_FILE);
  const env = await readEnvFileMap(envFile);
  const docker = await checkDocker();
  const psCommand = composePsCommand({ envFile, composeFiles, composeStyle: docker.composeStyle ?? "docker-compose-plugin" });
  const composePs = docker.compose.ok ? await runCaptured(psCommand[0], psCommand.slice(1), { allowFailure: true }) : undefined;
  const gatewayAgentUrl = stringFlag(flags, "gateway-agent-url") ?? process.env.GATEWAY_AGENT_URL ?? `http://127.0.0.1:${env.get("GATEWAY_AGENT_PORT") ?? "18080"}`;
  const timeoutMs = numberFlag(flags, "timeout-ms", 5_000);
  const health = await fetchOptionalJson(new URL("/health", gatewayAgentUrl), timeoutMs);
  const localCapability = await fetchOptionalJson(new URL("/reports/gateway-capability", gatewayAgentUrl), timeoutMs);
  const capabilityToken = resolveEnvSecret(flags, "capability-token-env", "PROOF_OPERATOR_CAPABILITY_TOKEN", env);
  const capabilityUrl =
    stringFlag(flags, "capability-url") ??
    process.env.PROOF_OPERATOR_CAPABILITY_URL ??
    envValue(env, "PROOF_OPERATOR_CAPABILITY_URL");
  const operatorId =
    stringFlag(flags, "operator-id") ??
    process.env.OPERATOR_ID ??
    process.env.SWITCHBOARD_OPERATOR_ID ??
    process.env.PROOF_OPERATOR_ID ??
    envValue(env, "OPERATOR_ID", "SWITCHBOARD_OPERATOR_ID", "PROOF_OPERATOR_ID");
  const gatewayId = stringFlag(flags, "gateway-id") ?? process.env.GATEWAY_ID ?? envValue(env, "GATEWAY_ID");
  const relayCapability = capabilityUrl && operatorId && gatewayId
    ? await fetchRelayCapabilityState({
        capabilityReportUrl: capabilityUrl,
        capabilityReportToken: capabilityToken,
        operatorId,
        gatewayId
      }, timeoutMs)
    : undefined;
  const classification = classifyOperatorStatus({
    env,
    docker,
    health: health.value,
    healthOk: health.ok,
    localCapability: localCapability.value,
    localCapabilityOk: localCapability.ok,
    relayCapability: relayCapability?.value,
    relayCapabilityOk: relayCapability?.ok,
    operatorId,
    gatewayId,
    now: new Date()
  });

  const output = {
    ok: Boolean(docker.docker.ok && docker.compose.ok && docker.daemon.ok && health.ok && operatorStatusHealthy(classification.state)),
    state: classification.state,
    findings: classification.findings,
    projectDir,
    composeFiles,
    envFile,
    docker: {
      ...docker,
      currentUser: currentUsername(),
      userCanAccessDaemon: docker.daemon.ok,
      daemonError: docker.daemon.ok ? undefined : docker.daemon.reason
    },
    compose: {
      ok: composePs ? composePs.exitCode === 0 : false,
      stdout: composePs?.stdout.trim(),
      stderr: composePs?.stderr.trim()
    },
    config: {
      operatorId,
      gatewayId,
      admissionMode: envValue(env, "SWITCHBOARD_OPERATOR_MODE"),
      capabilityUrl,
      routeStateUrl: envValue(env, "GATEWAY_ROUTE_STATE_URL"),
      reportSeedConfigured: Boolean(envValue(env, "OPERATOR_REPORT_SEED")),
      routeStateTokenConfigured: Boolean(envValue(env, "GATEWAY_ROUTE_STATE_TOKEN")),
      capabilityTokenConfigured: Boolean(envValue(env, "PROOF_OPERATOR_CAPABILITY_TOKEN"))
    },
    gatewayAgent: {
      url: gatewayAgentUrl,
      ok: health.ok,
      health: health.value,
      error: health.error
    },
    capability: {
      localOk: localCapability.ok,
      local: localCapability.value,
      localError: localCapability.error,
      relayUrl: capabilityUrl,
      relayOk: relayCapability?.ok,
      relay: relayCapability?.value,
      relayError: relayCapability?.error
    }
  };

  writeOutput(flags, redactSensitive(output), () => printOperatorStatus(output));
}

export async function runOperatorUpgrade(flags: Map<string, string | boolean>, rl?: readline.Interface): Promise<void> {
  const prompt = createPromptIo(flags, rl);
  const projectDir = path.resolve(stringFlag(flags, "project-dir") ?? process.cwd());
  const composeFiles = await resolveComposeFiles(projectDir, flags);
  const envFile = path.resolve(projectDir, stringFlag(flags, "env-file") ?? DEFAULT_ENV_FILE);
  const dryRun = boolFlag(flags, "dry-run");
  const assumeYes = boolFlag(flags, "yes") || process.env.SWITCHBOARD_ASSUME_YES === "true";
  const keepImageOverride = boolFlag(flags, "keep-image-override") || boolFlag(flags, "keep-image-overrides");
  const docker = await checkDocker();
  if (!docker.docker.ok || !docker.compose.ok) {
    throw new Error("Docker/Compose is not ready; run `switchboard gateway setup` first.");
  }
  const migration = await planOperatorImageMigration(envFile, keepImageOverride);
  const composeStyle = docker.composeStyle ?? "docker-compose-plugin";
  const pullCommand = composePullServicesCommand({
    envFile,
    composeFiles,
    composeStyle,
    services: ["envoy", "victoria-metrics", "grafana", "gateway-agent", "hub-watcher"]
  });
  const upCommand = composeUpCommand({ envFile, composeFiles, composeStyle, build: false });
  const commands = [pullCommand, upCommand];
  if (dryRun) {
    for (const line of migration.plannedMessages) {
      console.log(line);
    }
    for (const command of commands) {
      console.log(command.join(" "));
    }
    return;
  }
  if (!(await confirm(prompt, assumeYes, "Pull current gateway images and recreate the gateway stack?"))) {
    console.log("Operator upgrade skipped.");
    return;
  }
  if (migration.updates) {
    await writeOperatorEnvFile(envFile, migration.updates, projectDir);
    for (const line of migration.appliedMessages) {
      console.log(line);
    }
  }
  await runInteractive(pullCommand[0], pullCommand.slice(1), { cwd: projectDir });
  await runInteractive(upCommand[0], upCommand.slice(1), { cwd: projectDir });
  console.log("Operator stack upgraded.");
}

export async function setupOperator(
  flags: Map<string, string | boolean>,
  rl?: readline.Interface,
  runtime: OperatorSetupRuntime = {}
): Promise<OperatorSetupReport> {
  const prompt = createPromptIo(flags, rl);
  const checkedAt = new Date();
  const projectDir = path.resolve(stringFlag(flags, "project-dir") ?? process.cwd());
  const composeFile = path.resolve(projectDir, stringFlag(flags, "compose-file") ?? DEFAULT_COMPOSE_FILE);
  const envFile = path.resolve(projectDir, stringFlag(flags, "env-file") ?? DEFAULT_ENV_FILE);
  const existingEnv = await readEnvFileMap(envFile);
  const dryRun = boolFlag(flags, "dry-run");
  const skipInstall = boolFlag(flags, "skip-install");
  const localOnly = boolFlag(flags, "local-only");
  const prepareAdmission = boolFlag(flags, "prepare-admission");
  const skipComposeFlag = boolFlag(flags, "skip-compose");
  const assumeYes = boolFlag(flags, "yes") || process.env.SWITCHBOARD_ASSUME_YES === "true";
  const admissionFile = stringFlag(flags, "admission-file")
    ? path.resolve(projectDir, stringFlag(flags, "admission-file")!)
    : undefined;
  const admissionBundle = admissionFile ? await readOperatorAdmissionBundle(admissionFile) : undefined;
  const localBuild = boolFlag(flags, "local-build");
  const imageRegistry = normalizeImageRegistry(
    stringFlag(flags, "image-registry") ??
      process.env.PROOF_OPERATOR_IMAGE_REGISTRY ??
      process.env.PROOF_CONTAINER_REGISTRY ??
      DEFAULT_OPERATOR_IMAGE_REGISTRY
  );
  const imageTag =
    stringFlag(flags, "image-tag") ??
    process.env.PROOF_OPERATOR_IMAGE_TAG ??
    process.env.PROOF_CONTAINER_IMAGE_TAG ??
    DEFAULT_OPERATOR_IMAGE_TAG;
  const publicPort = numberFlag(flags, "public-port", numberEnv("PUBLIC_HTTPS_PORT", 443));
  const gatewayAgentPort = numberFlag(
    flags,
    "gateway-agent-port",
    numberEnv("GATEWAY_AGENT_PORT", numberFromString(envValue(existingEnv, "GATEWAY_AGENT_PORT"), "GATEWAY_AGENT_PORT", 18080))
  );
  const gatewayAgentBindAddress =
    stringFlag(flags, "gateway-agent-bind-address") ??
    process.env.GATEWAY_AGENT_BIND_ADDR ??
    envValue(existingEnv, "GATEWAY_AGENT_BIND_ADDR");
  const gatewayAgentExternallyBound = gatewayAgentBindExposesNetwork(gatewayAgentBindAddress);
  const upstreamAdmissionUrl =
    stringFlag(flags, "upstream-admission-url") ??
    process.env.GATEWAY_UPSTREAM_ADMISSION_URL ??
    envValue(existingEnv, "GATEWAY_UPSTREAM_ADMISSION_URL") ??
    admissionBundle?.upstreamAdmissionUrl ??
    defaultUpstreamAdmissionUrl(gatewayAgentBindAddress, gatewayAgentPort);
  const osRelease = process.platform === "linux" ? await readOsRelease() : undefined;
  const supportedInstall = supportsAptDockerInstall(process.platform, osRelease);
  const warnings: string[] = [];
  const actions: string[] = [];
  const dockerBefore = await checkDocker();
  const wanIp = await resolvePublicAddress(flags, prompt, warnings, existingEnv);
  const publicAddressMode = resolvePublicAddressMode(flags, wanIp.source, existingEnv);
  const manager = await resolveManagerInputs(flags, prompt, warnings, existingEnv);
  const operatorId = resolveOperatorId(flags, existingEnv, admissionBundle);
  const processorRefs = await resolveProcessorRefs(flags, existingEnv, projectDir);
  const reportSeedResolution = await resolveReportSeed({
    flags,
    existingEnv,
    prompt,
    runtime,
    assumeYes
  });
  const reportSeed = reportSeedResolution.seed;
  const reportSigner = reportSeed ? await tryDeriveReportSigner(reportSeed, warnings) : undefined;
  const capabilityReportToken = resolveEnvSecret(
    flags,
    "capability-token-env",
    "PROOF_OPERATOR_CAPABILITY_TOKEN",
    existingEnv,
    admissionBundle?.capabilityReportToken
  );
  const routeStateToken =
    resolveEnvSecret(
      flags,
      "route-state-token-env",
      "GATEWAY_ROUTE_STATE_TOKEN",
      existingEnv,
      admissionBundle?.routeStateToken
    ) || capabilityReportToken;
  const routeIntentTokenResolution = resolveRouteIntentToken({
    flags,
    existingEnv,
    gatewayAgentExternallyBound
  });
  const routeIntentToken = routeIntentTokenResolution.token;
  const gatewayId = sanitizeGatewayId(
    stringFlag(flags, "gateway-id") ??
      process.env.GATEWAY_ID ??
      envValue(existingEnv, "GATEWAY_ID") ??
      admissionBundle?.gatewayId ??
      `${os.hostname() || "operator"}-gateway`
  );
  const routeStateUrl =
    stringFlag(flags, "route-state-url") ??
    process.env.GATEWAY_ROUTE_STATE_URL ??
    envValue(existingEnv, "GATEWAY_ROUTE_STATE_URL") ??
    admissionBundle?.routeStateUrl ??
    (operatorId ? defaultRouteStateUrl(operatorId, gatewayId) : undefined);
  const network = stringFlag(flags, "network") ?? process.env.ACURAST_NETWORK ?? envValue(existingEnv, "ACURAST_NETWORK") ?? "mainnet";
  const capabilityReportUrl =
    stringFlag(flags, "capability-url") ??
    process.env.PROOF_OPERATOR_CAPABILITY_URL ??
    envValue(existingEnv, "PROOF_OPERATOR_CAPABILITY_URL") ??
    admissionBundle?.capabilityReportUrl ??
    (reportSeed && network === "mainnet" ? DEFAULT_MAINNET_CAPABILITY_REPORT_URL : undefined);
  const payoutAddress = resolvePayoutAddress(flags, existingEnv, admissionBundle);
  if (admissionBundle) {
    validateAdmissionBundleSigner(admissionBundle, reportSigner);
  }
  const admissionRequestFile = prepareAdmission
    ? path.resolve(projectDir, stringFlag(flags, "admission-request-file") ?? "operator-admission-request.json")
    : undefined;

  let composeFileReady = await fileExists(composeFile);
  if (!composeFileReady && !localBuild) {
    composeFileReady = await seedPackagedOperatorAssets(projectDir, composeFile, dryRun, actions, warnings);
  }

  if (!composeFileReady && localBuild) {
    warnings.push(
      `Compose file not found at ${composeFile}. Local builds need a repo checkout or --compose-file pointing at a compose file with build contexts.`
    );
  }

  const localPortAlreadyOpen = await localTcpPortOpen(publicPort);
  if (localPortAlreadyOpen) {
    warnings.push(`Local TCP port ${publicPort} is already accepting connections; docker compose may be updating an existing stack or may hit a port conflict.`);
  }

  const config: OperatorSetupConfig = {
    projectDir,
    composeFile,
    envFile,
    imageRegistry,
    imageTag,
    localBuild,
    publicAddress: wanIp.value,
    publicAddressMode,
    publicPort,
    gatewayAgentPort,
    gatewayAgentBindAddress,
    gatewayAgentExternallyBound,
    upstreamAdmissionUrl,
    routeStateUrl,
    routeStateToken,
    routeIntentToken,
    routeIntentTokenGenerated: routeIntentTokenResolution.generated,
    managerAddress: manager.managerAddress,
    managerIds: manager.managerIds,
    operatorId,
    processorRefs,
    reportSeed,
    reportSeedGenerated: reportSeedResolution.generated,
    reportSigner,
    capabilityReportUrl,
    capabilityReportToken,
    gatewayId,
    payoutAddress,
    network,
    localOnly,
    prepareAdmission,
    admissionRequestFile,
    admissionFile,
    admissionBundle,
    mode: localOnly ? "local-only" : prepareAdmission ? "pre-admission" : "admitted",
    dryRun,
    skipInstall,
    skipCompose: skipComposeFlag,
    assumeYes
  };

  const relayAdmissionIssues = relayAdmissionConfigIssues(config);
  if (relayAdmissionIssues.length > 0) {
    const message = relayAdmissionConfigMessage(relayAdmissionIssues);
    if (!localOnly && !prepareAdmission) {
      throw new Error(message);
    }
    warnings.push(`${message} Continuing because ${localOnly ? "--local-only" : "--prepare-admission"} was set.`);
  }

  if (prepareAdmission && !reportSigner) {
    throw new Error(
      "Preparing admission requires a valid sr25519 report seed. Pass --generate-report-seed, set OPERATOR_REPORT_SEED, or pass --operator-report-seed-env <env>."
    );
  }
  if (reportSeed && !reportSigner && !localOnly) {
    throw new Error(
      "OPERATOR_REPORT_SEED must be a valid sr25519 mnemonic or derivation URI for admitted/pre-admission setup. Regenerate one with --generate-report-seed."
    );
  }

  await confirmSharedManagerProcessorScope(config, prompt, warnings);

  let docker = dockerBefore;
  if ((!docker.docker.ok || !docker.compose.ok) && !skipInstall) {
    if (!supportedInstall) {
      warnings.push("Automatic Docker install currently supports apt-based Linux hosts only; install Docker and Compose manually, then rerun setup.");
    } else if (dryRun) {
      actions.push("would install Docker Engine and Docker Compose with apt");
    } else if (await confirm(prompt, assumeYes, "Docker or Docker Compose is missing. Install with sudo apt now?")) {
      await installDockerWithApt();
      actions.push("installed Docker/Compose packages with apt");
      docker = await checkDocker();
    } else {
      warnings.push("Docker install skipped by user.");
    }
  }

  const envUpdates = operatorEnvUpdates(config);
  if (dryRun) {
    actions.push(`would write gateway env file ${envFile}`);
  } else {
    await writeOperatorEnvFile(envFile, envUpdates, projectDir);
    actions.push(`wrote gateway env file ${envFile}`);
  }

  const admissionRequest = prepareAdmission ? buildAdmissionRequest(config, checkedAt) : undefined;
  if (admissionRequest && admissionRequestFile) {
    if (dryRun) {
      actions.push(`would write redacted admission request ${admissionRequestFile}`);
    } else {
      await writeJsonFile(admissionRequestFile, admissionRequest, 0o644);
      actions.push(`wrote redacted admission request ${admissionRequestFile}`);
    }
  }

  const composePullCommand = composePullServicesCommand({
    envFile,
    composeFile,
    composeStyle: docker.composeStyle ?? "docker-compose-plugin",
    services: ["envoy", "victoria-metrics", "grafana", "gateway-agent", "hub-watcher"]
  });
  const composeCommand = composeUpCommand({
    envFile,
    composeFile,
    composeStyle: docker.composeStyle ?? "docker-compose-plugin",
    build: localBuild
  });
  let launchedCompose = false;
  const skipCompose = skipComposeFlag || (prepareAdmission && relayAdmissionIssues.length > 0);
  if (skipCompose) {
    actions.push("skipped docker compose up");
  } else if (!composeFileReady) {
    warnings.push("Skipping compose launch because compose file is missing.");
  } else if (!docker.docker.ok || !docker.compose.ok) {
    warnings.push("Skipping compose launch because Docker/Compose is not ready.");
  } else if (!dryRun && !(await confirm(prompt, assumeYes, `Launch the gateway stack with ${localBuild ? "local Docker builds" : "configured images"}?`))) {
    warnings.push("Compose launch skipped by user.");
  } else if (dryRun) {
    if (!localBuild) {
      actions.push(`would run ${composePullCommand.join(" ")}`);
    }
    actions.push(`would run ${composeCommand.join(" ")}`);
  } else {
    if (!localBuild) {
      await runInteractive(composePullCommand[0], composePullCommand.slice(1), { cwd: projectDir });
      actions.push("pulled gateway stack images from the configured registries");
    }
    await runInteractive(composeCommand[0], composeCommand.slice(1), { cwd: projectDir });
    actions.push("launched gateway stack with docker compose");
    launchedCompose = true;
  }

  if (launchedCompose) {
    await checkCapabilityRegistration(config, actions, warnings);
    await verifyLocalGatewayAfterLaunch(config, actions);
  } else if (config.capabilityReportUrl && config.reportSeed && !dryRun) {
    warnings.push("Skipped relay capability registration check because compose was not launched; run `switchboard gateway discover` after gateway-agent starts.");
  } else if (config.operatorId && !config.reportSeed) {
    warnings.push("Gateway capability submission is not configured; pass --operator-report-seed-env and --capability-url to verify relay/operator allowlist acceptance.");
  }

  if (manager.managerAddress && !manager.managerIds) {
    warnings.push(
      "Manager address was recorded, but current gateway-agent discovery still needs numeric OPERATOR_MANAGER_IDS to advertise processors."
    );
  }

  return {
    version: 1,
    kind: "switchboard.operator.setup",
    checkedAt: checkedAt.toISOString(),
    os: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      osRelease,
      supportedInstall
    },
    docker,
    network: {
      publicAddress: wanIp.value,
      publicAddressMode,
      source: wanIp.source,
      publicPort,
      gatewayAgentPort,
      localPortAlreadyOpen,
      gatewayAgentBindAddress,
      gatewayAgentExternallyBound,
      upstreamAdmissionUrl,
      routeStateUrl
    },
    config: {
      projectDir,
      composeFile,
      envFile,
      imageRegistry,
      imageTag,
      localBuild,
      gatewayAgentBindAddress,
      gatewayAgentExternallyBound,
      upstreamAdmissionUrl,
      routeIntentAuthConfigured: Boolean(routeIntentToken),
      routeIntentTokenGenerated: config.routeIntentTokenGenerated,
      routeStateUrl,
      managerAddress: manager.managerAddress,
      managerIds: manager.managerIds,
      operatorId,
      processorRefs,
      capabilityReportUrl,
      gatewayId,
      payoutAddress,
      reportSigner,
      admissionMode: config.mode,
      admissionFile,
      admissionRequestFile,
      acurastNetwork: network
    },
    admissionRequest,
    actions,
    warnings,
    composePullCommand: localBuild ? undefined : composePullCommand,
    composeCommand
  };
}

export function printOperatorSetupUsage(): void {
  console.log(`Usage: switchboard gateway setup [options]

Checks the host, prepares gateway env config, and launches the local Docker
Compose gateway stack. By default setup pulls prebuilt images from the
configured registry; use --local-build when developing from a repo checkout.

Options:
  --manager-address <address>      Acurast manager/management account address to record
  --management-address <address>   Alias for --manager-address
  --manager-id <id[,id...]>        Numeric Acurast manager ID(s) used by current gateway-agent discovery
  --management-id <id[,id...]>     Alias for --manager-id
  --operator-id <0xbytes32>        Optional Hub operator ID for hub-watcher filtering/reporting
  --processor <ref[,ref...]>       Site-specific Acurast processor include list for OPERATOR_PROCESSORS
  --processors <ref[,ref...]>      Alias for --processor
  --processor-file <path>          Read processor include list from JSON, CSV, or newline text
  --payout-address <0xaddress>     Operator payout recipient to advertise in capability reports
  --operator-report-seed-env <env> Env var containing the gateway capability report seed
  --generate-report-seed           Generate and store a new local sr25519 BIP-39 report seed
  --capability-url <url>           Gateway capability report POST URL
  --capability-token-env <env>     Env var containing the optional capability report bearer token
  --route-state-token-env <env>    Env var containing the route-state bearer token; defaults to capability token
  --prepare-admission              Write a redacted operator-admission-request.json and skip live launch until admitted
  --admission-request-file <path>  Admission request output path, default operator-admission-request.json
  --admission-file <path>          PROOF-issued admission bundle with relay URLs/tokens and accepted signer
  --public-address <ip-or-host>    Gateway WAN/public address; default fetched with ${WAN_IP_COMMAND.join(" ")}
  --public-address-mode <mode>     auto or static; auto is used when setup auto-detects the WAN IP
  --public-port <port>             Public HTTPS port, default PUBLIC_HTTPS_PORT or 443
  --gateway-agent-bind-address <addr>
                                  Bind address for gateway-agent route API, default 127.0.0.1
  --gateway-agent-port <port>      Gateway-agent API port, default GATEWAY_AGENT_PORT or 18080
  --upstream-admission-url <url>   URL relay profiles should use for signed gateway upstream admissions
  --route-state-url <url>          Gateway route-state polling URL, default control.switchboard.proof.computer when --operator-id is set
  --route-intent-token-env <env>   Env var containing the gateway route-intent bearer token
  --project-dir <path>             Repo/project directory, default cwd
  --compose-file <path[,path...]>  Compose file(s) relative to project dir, default ${DEFAULT_COMPOSE_FILE}
  --env-file <path>                Compose env file relative to project dir, default ${DEFAULT_ENV_FILE}
  --image-registry <registry/ns>   Operator image registry namespace, default ${DEFAULT_OPERATOR_IMAGE_REGISTRY}
  --image-tag <tag>                Image tag, default ${DEFAULT_OPERATOR_IMAGE_TAG}
  --gateway-id <id>                Gateway ID, default <hostname>-gateway
  --network <mainnet|canary>       Acurast network, default ACURAST_NETWORK or mainnet
  --skip-install                   Do not install Docker/Compose if missing
  --skip-compose                   Write config but do not launch compose
  --local-build                    Build local repo images instead of pulling prebuilt images
  --local-only                     Allow setup without relay admission/reporting material
  --no-build                       Deprecated; default setup already uses prebuilt images
  --dry-run                        Print checks and planned actions without changing the host
  --yes                            Accept install/launch prompts
  --json                           Print JSON report

Upgrade-only:
  --keep-image-override            Do not migrate old default operator image refs to switchboard-gateway

Examples:
  switchboard gateway setup
  switchboard gateway setup --manager-address 5... --manager-id <manager-id> --generate-report-seed --prepare-admission
  switchboard gateway setup --admission-file operator-admission.json --yes`);
}

export function parseOsRelease(input: string): OsRelease {
  const fields = new Map<string, string>();
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex);
    const value = unquoteOsReleaseValue(line.slice(equalsIndex + 1));
    fields.set(key, value);
  }

  return {
    id: fields.get("ID"),
    idLike: (fields.get("ID_LIKE") ?? "").split(/\s+/).filter(Boolean),
    name: fields.get("NAME"),
    versionId: fields.get("VERSION_ID")
  };
}

export function mergeOperatorEnv(existing: string, updates: Record<string, string | undefined>): string {
  const cleanUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined)
  ) as Record<string, string>;
  const seen = new Set<string>();
  const lines = existing.length > 0 ? existing.replace(/\r\n/g, "\n").split("\n") : [];
  const output: string[] = [];
  for (const line of lines) {
    const parsed = parseEnvAssignment(line);
    if (parsed && REMOVED_OPERATOR_ENV_KEYS.has(parsed.key) && !(parsed.key in cleanUpdates)) {
      continue;
    }
    if (parsed && parsed.key in cleanUpdates) {
      seen.add(parsed.key);
      output.push(`${parsed.key}=${cleanUpdates[parsed.key]}`);
      continue;
    }
    output.push(line);
  }

  for (const [key, value] of Object.entries(cleanUpdates)) {
    if (!seen.has(key)) {
      output.push(`${key}=${value}`);
    }
  }

  while (output.length > 0 && output[output.length - 1] === "") {
    output.pop();
  }
  return `${output.join("\n")}\n`;
}

export function composeUpCommand(input: {
  envFile: string;
  composeFile?: string;
  composeFiles?: string[];
  composeStyle: ComposeStyle;
  build: boolean;
}): string[] {
  const files = normalizedComposeFiles(input);
  if (input.composeStyle === "docker-compose-standalone") {
    return [
      "docker-compose",
      "--env-file",
      input.envFile,
      ...composeFileArgs(files),
      "up",
      "-d",
      input.build ? "--build" : "--no-build"
    ];
  }

  return [
    "docker",
    "compose",
    "--env-file",
    input.envFile,
    ...composeFileArgs(files),
    "up",
    "-d",
    input.build ? "--build" : "--no-build"
  ];
}

export function composePullServicesCommand(input: {
  envFile: string;
  composeFile?: string;
  composeFiles?: string[];
  composeStyle: ComposeStyle;
  services: string[];
}): string[] {
  const files = normalizedComposeFiles(input);
  const base =
    input.composeStyle === "docker-compose-standalone"
      ? ["docker-compose", "--env-file", input.envFile, ...composeFileArgs(files)]
      : ["docker", "compose", "--env-file", input.envFile, ...composeFileArgs(files)];

  return [...base, "pull", ...input.services];
}

export function composePsCommand(input: {
  envFile: string;
  composeFile?: string;
  composeFiles?: string[];
  composeStyle: ComposeStyle;
}): string[] {
  const files = normalizedComposeFiles(input);
  const base =
    input.composeStyle === "docker-compose-standalone"
      ? ["docker-compose", "--env-file", input.envFile, ...composeFileArgs(files)]
      : ["docker", "compose", "--env-file", input.envFile, ...composeFileArgs(files)];
  return [...base, "ps"];
}

async function resolveComposeFiles(projectDir: string, flags: Map<string, string | boolean>): Promise<string[]> {
  const explicit = stringFlag(flags, "compose-file");
  if (explicit) {
    return explicit
      .split(",")
      .map((file) => file.trim())
      .filter(Boolean)
      .map((file) => path.resolve(projectDir, file));
  }

  return [path.resolve(projectDir, DEFAULT_COMPOSE_FILE)];
}

function normalizedComposeFiles(input: { composeFile?: string; composeFiles?: string[] }): string[] {
  const files = input.composeFiles ?? (input.composeFile ? [input.composeFile] : []);
  if (files.length === 0) {
    throw new Error("At least one compose file is required.");
  }
  return files;
}

function composeFileArgs(composeFiles: string[]): string[] {
  return composeFiles.flatMap((composeFile) => ["-f", composeFile]);
}

async function readEnvFileMap(envFile: string): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  try {
    const input = await readFile(envFile, "utf8");
    for (const line of input.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) {
        continue;
      }
      values.set(match[1], match[2]);
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
  return values;
}

async function fetchOptionalJson(
  url: URL,
  timeoutMs: number,
  init: RequestInit = {}
): Promise<{ ok: boolean; value?: unknown; error?: string; status?: number }> {
  try {
    const response = await fetchWithTimeout(url, { method: "GET", ...init }, timeoutMs);
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, error: `${response.status} ${text}` };
    }
    return { ok: true, status: response.status, value: text ? JSON.parse(text) : undefined };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readOperatorAdmissionBundle(file: string): Promise<OperatorAdmissionBundle> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read --admission-file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseOperatorAdmissionBundle(parsed);
}

export function parseOperatorAdmissionBundle(input: unknown): OperatorAdmissionBundle {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Admission file must be a JSON object.");
  }
  const record = input as Record<string, unknown>;
  const capability = record.capability && typeof record.capability === "object" && !Array.isArray(record.capability)
    ? record.capability as Record<string, unknown>
    : {};
  const routeState = record.routeState && typeof record.routeState === "object" && !Array.isArray(record.routeState)
    ? record.routeState as Record<string, unknown>
    : {};
  const upstreamAdmission = record.upstreamAdmission && typeof record.upstreamAdmission === "object" && !Array.isArray(record.upstreamAdmission)
    ? record.upstreamAdmission as Record<string, unknown>
    : {};
  const reportSigner = signerMetadataFromUnknown(record.reportSigner);
  const acceptedSigner = signerMetadataFromUnknown(record.acceptedSigner ?? record.signer);
  const bundle: OperatorAdmissionBundle = {
    operatorId: stringField(record, "operatorId"),
    gatewayId: stringField(record, "gatewayId"),
    capabilityReportUrl:
      stringField(record, "capabilityReportUrl") ??
      stringField(record, "capabilityUrl") ??
      stringField(capability, "url"),
    capabilityReportToken:
      stringField(record, "capabilityReportToken") ??
      stringField(record, "capabilityToken") ??
      stringField(capability, "token") ??
      stringField(capability, "bearerToken"),
    routeStateUrl: stringField(record, "routeStateUrl") ?? stringField(routeState, "url"),
    routeStateToken:
      stringField(record, "routeStateToken") ??
      stringField(routeState, "token") ??
      stringField(routeState, "bearerToken"),
    upstreamAdmissionUrl:
      stringField(record, "upstreamAdmissionUrl") ??
      stringField(upstreamAdmission, "url"),
    payoutAddress: stringField(record, "payoutAddress"),
    reportSigner,
    acceptedSigner
  };
  const missing: string[] = [];
  if (!bundle.operatorId) missing.push("operatorId");
  if (!bundle.gatewayId) missing.push("gatewayId");
  if (!bundle.capabilityReportUrl) missing.push("capability.url");
  if (!bundle.capabilityReportToken) missing.push("capability.token");
  if (!bundle.routeStateUrl) missing.push("routeState.url");
  if (!bundle.routeStateToken) missing.push("routeState.token");
  if (!signerMetadataUsable(bundle.acceptedSigner ?? bundle.reportSigner)) missing.push("acceptedSigner");
  if (missing.length > 0) {
    throw new Error(`Admission file is missing required field(s): ${missing.join(", ")}`);
  }
  validateUrl(bundle.capabilityReportUrl, "capability.url");
  validateUrl(bundle.routeStateUrl, "routeState.url");
  if (bundle.operatorId && !/^0x[0-9a-fA-F]{64}$/.test(bundle.operatorId)) {
    throw new Error("Admission file operatorId must be a 0x-prefixed bytes32 value.");
  }
  return bundle;
}

function signerMetadataUsable(input: OperatorAdmissionBundle["reportSigner"]): boolean {
  return Boolean(input && (input.address || input.signer) && input.publicKey);
}

function signerMetadataFromUnknown(input: unknown): OperatorAdmissionBundle["reportSigner"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  return {
    scheme: stringField(record, "scheme"),
    address: stringField(record, "address"),
    signer: stringField(record, "signer"),
    publicKey: stringField(record, "publicKey"),
    ss58Format: typeof record.ss58Format === "number" ? record.ss58Format : undefined
  };
}

function validateAdmissionBundleSigner(bundle: OperatorAdmissionBundle, derived: ReportSignerMetadata | undefined): void {
  const accepted = bundle.acceptedSigner ?? bundle.reportSigner;
  if (!accepted || !derived) {
    return;
  }
  const acceptedAddress = accepted.address ?? accepted.signer;
  if (acceptedAddress && acceptedAddress !== derived.address) {
    throw new Error(`Admission file accepted signer ${acceptedAddress} does not match local report signer ${derived.address}.`);
  }
  if (accepted.publicKey && accepted.publicKey.toLowerCase() !== derived.publicKey.toLowerCase()) {
    throw new Error("Admission file accepted signer public key does not match the local report seed.");
  }
}

function validateUrl(value: string | undefined, label: string): void {
  if (!value) {
    return;
  }
  try {
    new URL(value);
  } catch {
    throw new Error(`Admission file ${label} must be a valid URL.`);
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringRecordField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function envValue(env: Map<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env.get(name);
    if (value && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function firstCsv(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

async function resolvePublicAddress(
  flags: Map<string, string | boolean>,
  prompt: PromptIo,
  warnings: string[],
  existingEnv: Map<string, string>
): Promise<{ value: string; source: string }> {
  const flagValue = stringFlag(flags, "public-address");
  if (flagValue) {
    return { value: flagValue, source: "flag" };
  }
  const envPublicAddress = firstCsv(process.env.OPERATOR_PUBLIC_ADDRESSES ?? process.env.GATEWAY_PUBLIC_ADDRESSES);
  if (envPublicAddress) {
    return { value: envPublicAddress, source: "env" };
  }
  const filePublicAddress = firstCsv(envValue(existingEnv, "OPERATOR_PUBLIC_ADDRESSES", "GATEWAY_PUBLIC_ADDRESSES"));
  if (filePublicAddress) {
    return { value: filePublicAddress, source: "env-file" };
  }

  try {
    const ip = await fetchWanIpWithCurl(numberFlag(flags, "wan-timeout-ms", 5_000));
    const trimmed = ip.trim();
    if (trimmed.length > 0) {
      return { value: trimmed, source: WAN_IP_COMMAND.join(" ") };
    }
  } catch (error) {
    warnings.push(`WAN IP lookup through ${WAN_IP_COMMAND.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const prompted = await promptRequired(prompt, "Gateway WAN/public IP or hostname");
  return { value: prompted, source: "prompt" };
}

function resolvePublicAddressMode(
  flags: Map<string, string | boolean>,
  publicAddressSource: string,
  existingEnv: Map<string, string>
): "auto" | "static" {
  const mode = stringFlag(flags, "public-address-mode") ?? process.env.OPERATOR_PUBLIC_ADDRESS_MODE ?? envValue(existingEnv, "OPERATOR_PUBLIC_ADDRESS_MODE");
  if (mode === "auto" || mode === "static") {
    return mode;
  }
  if (mode) {
    throw new Error("--public-address-mode must be auto or static");
  }
  return publicAddressSource === WAN_IP_COMMAND.join(" ") ? "auto" : "static";
}

async function resolveManagerInputs(
  flags: Map<string, string | boolean>,
  prompt: PromptIo,
  warnings: string[],
  existingEnv: Map<string, string>
): Promise<{ managerAddress?: string; managerIds?: string }> {
  let managerAddress =
    stringFlag(flags, "manager-address") ??
    stringFlag(flags, "management-address") ??
    process.env.OPERATOR_MANAGER_ADDRESS ??
    process.env.ACURAST_MANAGER_ADDRESS ??
    process.env.ACURAST_MANAGEMENT_ADDRESS ??
    envValue(existingEnv, "OPERATOR_MANAGER_ADDRESS", "ACURAST_MANAGER_ADDRESS", "ACURAST_MANAGEMENT_ADDRESS");
  let managerIds =
    stringFlag(flags, "manager-id") ??
    stringFlag(flags, "management-id") ??
    process.env.OPERATOR_MANAGER_IDS ??
    process.env.OPERATOR_MANAGER_ID ??
    process.env.ACURAST_MANAGER_ID ??
    envValue(existingEnv, "OPERATOR_MANAGER_IDS", "OPERATOR_MANAGER_ID", "ACURAST_MANAGER_ID");

  if (!managerAddress && !managerIds) {
    const value = await promptRequired(prompt, "Acurast manager address or numeric manager ID");
    if (isManagerIdList(value)) {
      managerIds = value;
    } else {
      managerAddress = value;
    }
  }

  if (managerAddress && !managerIds) {
    warnings.push("Address-only manager setup is recorded, but numeric manager ID input is still needed by the current gateway-agent.");
    const value = await promptOptional(prompt, "Numeric Acurast manager ID(s), comma-separated, blank to fill later");
    if (value) {
      if (!isManagerIdList(value)) {
        throw new Error("manager-id must be one or more numeric IDs separated by commas");
      }
      managerIds = value;
    }
  }

  if (managerIds && !isManagerIdList(managerIds)) {
    throw new Error("manager-id must be one or more numeric IDs separated by commas");
  }

  return { managerAddress, managerIds };
}

function operatorEnvUpdates(config: OperatorSetupConfig): Record<string, string | undefined> {
  const imagePrefix = config.localBuild ? "proof" : config.imageRegistry;
  const operatorImage = `${imagePrefix}/gateway:${config.localBuild ? "dev" : config.imageTag}`;
  const tlsTestUpstreamImage = `${imagePrefix}/tls-test-upstream:${config.localBuild ? "dev" : config.imageTag}`;
  const mainnet = config.network === "mainnet";
  return {
    PUBLIC_HTTPS_PORT: String(config.publicPort),
    ENVOY_IMAGE: process.env.ENVOY_IMAGE ?? DEFAULT_ENVOY_IMAGE,
    VICTORIA_METRICS_IMAGE: process.env.VICTORIA_METRICS_IMAGE ?? DEFAULT_VICTORIA_METRICS_IMAGE,
    GRAFANA_IMAGE: process.env.GRAFANA_IMAGE ?? DEFAULT_GRAFANA_IMAGE,
    GATEWAY_AGENT_IMAGE: operatorImage,
    HUB_WATCHER_IMAGE: operatorImage,
    TLS_TEST_UPSTREAM_IMAGE: tlsTestUpstreamImage,
    GATEWAY_ID: config.gatewayId,
    OPERATOR_MANAGER_ADDRESS: config.managerAddress,
    OPERATOR_MANAGER_IDS: config.managerIds,
    OPERATOR_ID: config.operatorId,
    OPERATOR_PROCESSORS: config.processorRefs,
    OPERATOR_REPORT_SEED: config.reportSeed,
    OPERATOR_REPORT_SS58_FORMAT: config.reportSigner ? String(config.reportSigner.ss58Format) : undefined,
    OPERATOR_PAYOUT_ADDRESS: config.payoutAddress,
    PROOF_OPERATOR_CAPABILITY_URL: config.capabilityReportUrl,
    PROOF_OPERATOR_CAPABILITY_TOKEN: config.capabilityReportToken,
    GATEWAY_AGENT_PORT: String(config.gatewayAgentPort),
    GATEWAY_AGENT_BIND_ADDR: config.gatewayAgentBindAddress,
    GATEWAY_UPSTREAM_ADMISSION_URL: config.upstreamAdmissionUrl,
    GATEWAY_ROUTE_STATE_URL: config.routeStateUrl,
    GATEWAY_ROUTE_STATE_TOKEN: config.routeStateToken,
    GATEWAY_AGENT_ROUTE_INTENT_TOKEN: config.routeIntentToken,
    ROUTE_INTENT_OUTPUT_URL: process.env.ROUTE_INTENT_OUTPUT_URL ?? "http://gateway-agent:18080/internal/route-intents",
    ROUTE_INTENT_OUTPUT_TOKEN: config.routeIntentToken,
    OPERATOR_PUBLIC_ADDRESSES: config.publicAddress,
    OPERATOR_PUBLIC_ADDRESS_MODE: config.publicAddressMode,
    OPERATOR_WAN_IP_URL: process.env.OPERATOR_WAN_IP_URL ?? WAN_IP_URL,
    OPERATOR_WAN_IP_POLL_INTERVAL_MS: process.env.OPERATOR_WAN_IP_POLL_INTERVAL_MS ?? "60000",
    OPERATOR_WAN_IP_TIMEOUT_MS: process.env.OPERATOR_WAN_IP_TIMEOUT_MS ?? "5000",
    OPERATOR_PROCESSOR_DISCOVERY_ENABLED: "true",
    OPERATOR_PROCESSOR_MAX_AGE_SECONDS: process.env.OPERATOR_PROCESSOR_MAX_AGE_SECONDS ?? "1800",
    OPERATOR_PROCESSOR_DISCOVERY_CHECK_AVAILABILITY: "true",
    OPERATOR_DISCOVERY_STATE_FILE: DEFAULT_DISCOVERY_STATE_FILE,
    SWITCHBOARD_OPERATOR_MODE: config.mode,
    ACURAST_NETWORK: config.network,
    ACURAST_RPC: process.env.ACURAST_RPC ?? (mainnet ? DEFAULT_MAINNET_ACURAST_RPC : undefined),
    HUB_CHAIN_PROFILE: mainnet ? "polkadot-hub" : (process.env.HUB_CHAIN_PROFILE ?? process.env.SWITCHBOARD_TARGET),
    HUB_CHAIN_ID: mainnet ? "420420419" : (process.env.HUB_CHAIN_ID ?? process.env.CHAIN_ID),
    HUB_ETH_RPC_URL: mainnet ? DEFAULT_MAINNET_HUB_ETH_RPC_URL : process.env.HUB_ETH_RPC_URL,
    HUB_SUBSTRATE_WS_URL: mainnet ? DEFAULT_MAINNET_HUB_SUBSTRATE_WS_URL : process.env.HUB_SUBSTRATE_WS_URL,
    INGRESS_REGISTRY_ADDRESS: mainnet ? DEFAULT_MAINNET_REGISTRY_ADDRESS : process.env.INGRESS_REGISTRY_ADDRESS,
    PROOF_NETWORK_MANIFEST_URL: mainnet ? DEFAULT_MAINNET_MANIFEST_URL : process.env.PROOF_NETWORK_MANIFEST_URL,
    PROOF_NETWORK_MANIFEST_SIGNER: mainnet ? DEFAULT_MAINNET_MANIFEST_SIGNER : process.env.PROOF_NETWORK_MANIFEST_SIGNER
  };
}

export async function planOperatorImageMigration(
  envFile: string,
  keepImageOverride: boolean
): Promise<{
  updates?: Record<string, string>;
  plannedMessages: string[];
  appliedMessages: string[];
}> {
  if (keepImageOverride) {
    return {
      plannedMessages: ["Keeping existing operator image overrides."],
      appliedMessages: []
    };
  }

  const env = await readEnvFileMap(envFile);
  const updates: Record<string, string> = {};
  const plannedMessages: string[] = [];
  const appliedMessages: string[] = [];
  for (const key of ["GATEWAY_AGENT_IMAGE", "HUB_WATCHER_IMAGE"] as const) {
    const value = env.get(key);
    const next = value ? migrateLegacyGatewayImage(value) : undefined;
    if (!next || next === value) {
      continue;
    }
    updates[key] = next;
    plannedMessages.push(`would migrate ${key} from ${value} to ${next}`);
    appliedMessages.push(`Migrated ${key} from ${value} to ${next}`);
  }

  const tlsValue = env.get("TLS_TEST_UPSTREAM_IMAGE");
  const migratedTls = tlsValue ? migrateLegacyTlsTestUpstreamImage(tlsValue) : undefined;
  if (migratedTls && migratedTls !== tlsValue) {
    updates.TLS_TEST_UPSTREAM_IMAGE = migratedTls;
    plannedMessages.push(`would migrate TLS_TEST_UPSTREAM_IMAGE from ${tlsValue} to ${migratedTls}`);
    appliedMessages.push(`Migrated TLS_TEST_UPSTREAM_IMAGE from ${tlsValue} to ${migratedTls}`);
  }

  return {
    updates: Object.keys(updates).length > 0 ? updates : undefined,
    plannedMessages,
    appliedMessages
  };
}

export function migrateLegacyGatewayImage(value: string): string | undefined {
  const match = value.match(LEGACY_OPERATOR_IMAGE_PATTERN);
  return match ? `${DEFAULT_OPERATOR_IMAGE_REGISTRY}/gateway:${match[1]}` : undefined;
}

export function migrateLegacyTlsTestUpstreamImage(value: string): string | undefined {
  const match = value.match(LEGACY_TLS_TEST_UPSTREAM_IMAGE_PATTERN);
  return match ? `${DEFAULT_OPERATOR_IMAGE_REGISTRY}/tls-test-upstream:${match[1]}` : undefined;
}

async function verifyLocalGatewayAfterLaunch(config: OperatorSetupConfig, actions: string[]): Promise<void> {
  if (config.mode !== "admitted") {
    return;
  }
  const gatewayAgentUrl = process.env.GATEWAY_AGENT_URL ?? `http://127.0.0.1:${process.env.GATEWAY_AGENT_PORT ?? "18080"}`;
  const health = await fetchJsonWithRetry(new URL("/health", gatewayAgentUrl), 10_000);
  const localCapability = await fetchJsonWithRetry(new URL("/reports/gateway-capability", gatewayAgentUrl), 10_000);
  const issues = localGatewayVerificationIssues(config, health, localCapability);
  if (issues.length > 0) {
    throw new Error(
      [
        "Operator stack launched but local gateway verification failed.",
        `Issues: ${issues.join("; ")}.`,
        `Next: run \`switchboard gateway status --project-dir ${config.projectDir}\` and inspect gateway-agent logs.`
      ].join(" ")
    );
  }
  actions.push("verified local gateway health, route-state, signer, public address, and processor scope");
}

function localGatewayVerificationIssues(config: OperatorSetupConfig, health: unknown, localCapability: unknown): string[] {
  const issues: string[] = [];
  const healthRecord = asRecord(health);
  if (healthRecord?.reportSigningEnabled !== true) {
    issues.push("gateway-agent health does not report signing enabled");
  }
  const routeState = asRecord(healthRecord?.routeState);
  if (config.routeStateUrl && routeState?.enabled !== true) {
    issues.push("route-state polling is not enabled");
  }
  if (config.routeStateUrl && routeState?.healthy !== true) {
    issues.push("route-state polling is not healthy");
  }

  const signed = asRecord(localCapability);
  const report = asRecord(signed?.report);
  const operator = asRecord(report?.operator);
  const gateway = asRecord(report?.gateway);
  if (config.operatorId && stringRecordField(operator, "operatorId")?.toLowerCase() !== config.operatorId.toLowerCase()) {
    issues.push("local capability report operatorId does not match env");
  }
  if (stringRecordField(operator, "gatewayId") !== config.gatewayId) {
    issues.push("local capability report gatewayId does not match env");
  }
  const signature = asRecord(signed?.signature);
  if (config.reportSigner && stringRecordField(signature, "signer") !== config.reportSigner.address) {
    issues.push("local capability report signer does not match local report seed");
  }
  const publicAddresses = Array.isArray(gateway?.publicAddresses) ? gateway.publicAddresses.map(String) : [];
  if (config.publicAddress && !publicAddresses.includes(config.publicAddress)) {
    issues.push("local capability report public address does not match env");
  }
  const includeCount = splitCsv(config.processorRefs).length;
  if (includeCount > 0) {
    const healthProcessorDiscovery = asRecord(healthRecord?.processorDiscovery);
    const includeProcessors = Array.isArray(healthProcessorDiscovery?.includeProcessors)
      ? healthProcessorDiscovery.includeProcessors
      : [];
    if (includeProcessors.length !== includeCount) {
      issues.push(`gateway-agent processor include count ${includeProcessors.length} does not match env count ${includeCount}`);
    }
  }
  return issues;
}

async function checkCapabilityRegistration(
  config: OperatorSetupConfig,
  actions: string[],
  warnings: string[]
): Promise<void> {
  if (!config.operatorId || !config.reportSeed || !config.capabilityReportUrl) {
    if (config.operatorId && !config.reportSeed) {
      warnings.push("Skipped relay capability registration check because OPERATOR_REPORT_SEED is not configured.");
    }
    return;
  }

  const gatewayAgentUrl = process.env.GATEWAY_AGENT_URL ?? `http://127.0.0.1:${process.env.GATEWAY_AGENT_PORT ?? "18080"}`;
  let signedReport: unknown;
  try {
    signedReport = await fetchJsonWithRetry(new URL("/reports/gateway-capability", gatewayAgentUrl), 10_000);
  } catch (error) {
    warnings.push(
      `Could not verify relay capability registration: gateway-agent report endpoint was not ready (${error instanceof Error ? error.message : String(error)}).`
    );
    return;
  }

  try {
    const response = await fetchWithTimeout(config.capabilityReportUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authorizationHeaders(config.capabilityReportToken)
      },
      body: JSON.stringify(signedReport)
    }, 10_000);
    const body = await response.text();
    const warning = capabilityRegistrationWarning(response.status, body);
    if (warning) {
      if (config.mode === "admitted") {
        throw new Error(`${warning} Next: run \`switchboard gateway status --project-dir ${config.projectDir}\`.`);
      }
      warnings.push(warning);
      return;
    }
    actions.push(response.status === 409 ? "relay already had this gateway capability report" : "verified relay accepted gateway capability report");
  } catch (error) {
    const message = `Could not verify relay capability registration: ${error instanceof Error ? error.message : String(error)}`;
    if (config.mode === "admitted") {
      throw new Error(`${message}. Next: run \`switchboard gateway status --project-dir ${config.projectDir}\` for the doctor output.`);
    }
    warnings.push(message);
    return;
  }

  if (config.mode !== "admitted") {
    return;
  }
  const relayState = await fetchRelayCapabilityState(config, 10_000, { activeOnly: true });
  if (!relayState.ok || !relayCapabilityIncludesGateway(relayState.value, config.operatorId, config.gatewayId)) {
    throw new Error(
      `Relay accepted the capability submission but did not return this operatorId + gatewayId in capability state. Next: run \`switchboard gateway status --project-dir ${config.projectDir}\`.`
    );
  }
}

async function fetchRelayCapabilityState(
  config: { capabilityReportUrl?: string; capabilityReportToken?: string; operatorId?: string; gatewayId?: string },
  timeoutMs: number,
  options: { activeOnly?: boolean } = {}
): Promise<{ ok: boolean; value?: unknown; error?: string; status?: number }> {
  if (!config.capabilityReportUrl || !config.operatorId || !config.gatewayId) {
    return { ok: false, error: "capability URL, operatorId, and gatewayId are required" };
  }
  const url = new URL(config.capabilityReportUrl);
  url.searchParams.set("operatorId", config.operatorId);
  url.searchParams.set("gatewayId", config.gatewayId);
  url.searchParams.set("limit", "1");
  if (options.activeOnly) {
    url.searchParams.set("activeOnly", "true");
  }
  return fetchOptionalJson(url, timeoutMs, {
    headers: authorizationHeaders(config.capabilityReportToken)
  });
}

function relayCapabilityIncludesGateway(value: unknown, operatorId: string | undefined, gatewayId: string | undefined): boolean {
  if (!operatorId || !gatewayId) {
    return false;
  }
  const record = asRecord(value);
  const latest = Array.isArray(record?.latest) ? record.latest : [];
  const reports = Array.isArray(record?.reports) ? record.reports : [];
  return [...latest, ...reports].some((item) => {
    const itemRecord = asRecord(item);
    const report = asRecord(itemRecord?.report);
    const operator = asRecord(report?.operator);
    return stringRecordField(operator, "operatorId")?.toLowerCase() === operatorId.toLowerCase() &&
      stringRecordField(operator, "gatewayId") === gatewayId;
  });
}

function authorizationHeaders(token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function relayAdmissionConfigIssues(config: {
  network: string;
  operatorId?: string;
  gatewayId?: string;
  reportSeed?: string;
  capabilityReportUrl?: string;
  capabilityReportToken?: string;
  routeStateUrl?: string;
  routeStateToken?: string;
}): string[] {
  if (config.network !== "mainnet") {
    return [];
  }
  const missing: string[] = [];
  if (!config.operatorId) {
    missing.push("--operator-id or SWITCHBOARD_OPERATOR_ID/PROOF_OPERATOR_ID");
  }
  if (!config.gatewayId) {
    missing.push("--gateway-id or GATEWAY_ID");
  }
  if (!config.reportSeed) {
    missing.push("--operator-report-seed-env or OPERATOR_REPORT_SEED");
  }
  if (!config.capabilityReportUrl) {
    missing.push("--capability-url or PROOF_OPERATOR_CAPABILITY_URL");
  }
  if (!config.capabilityReportToken) {
    missing.push("--capability-token-env or PROOF_OPERATOR_CAPABILITY_TOKEN");
  }
  if (!config.routeStateUrl) {
    missing.push("--route-state-url or GATEWAY_ROUTE_STATE_URL");
  }
  if (!config.routeStateToken) {
    missing.push("--route-state-token-env, GATEWAY_ROUTE_STATE_TOKEN, or a capability token");
  }
  return missing;
}

export function relayAdmissionConfigMessage(missing: string[]): string {
  return [
    "Mainnet gateway setup is missing relay admission/reporting configuration.",
    "A gateway launched without this material can be locally healthy but absent from relay capacity.",
    `Missing: ${missing.join("; ")}.`,
    "Pass the missing values, use --prepare-admission to create an admission request, or use --local-only for lab installs."
  ].join(" ");
}

async function confirmSharedManagerProcessorScope(
  config: OperatorSetupConfig,
  prompt: PromptIo,
  warnings: string[]
): Promise<void> {
  const managerIds = splitCsv(config.managerIds);
  const sharedManagerIds = managerIds.filter((id) => id === "9470");
  if (config.localOnly || config.processorRefs || sharedManagerIds.length === 0) {
    return;
  }
  const message =
    `Manager ID ${sharedManagerIds.join(",")} is shared; without --processor/--processor-file this gateway can advertise the whole manager fleet.`;
  warnings.push(`${message} Pass an explicit processor allowlist before third-party or multi-site admission.`);
  if (await confirm(prompt, config.assumeYes, "Continue without an explicit processor allowlist?")) {
    return;
  }
  throw new Error(`${message} Refusing setup. Pass --processor-file <path>, --processor <refs>, or --local-only.`);
}

function buildAdmissionRequest(config: OperatorSetupConfig, createdAt: Date): OperatorAdmissionRequest {
  if (!config.reportSigner) {
    throw new Error("Cannot build admission request without a derived report signer.");
  }
  const processors = splitCsv(config.processorRefs);
  return {
    version: 1,
    kind: "switchboard.operator.admission.request",
    createdAt: createdAt.toISOString(),
    network: config.network,
    operatorId: config.operatorId,
    gatewayId: config.gatewayId,
    managerIds: splitCsv(config.managerIds),
    processorAllowlist: {
      count: processors.length,
      sha256: processors.length > 0 ? sha256Hex(processors.join("\n")) : undefined
    },
    publicAddress: {
      value: config.publicAddress,
      mode: config.publicAddressMode,
      port: config.publicPort
    },
    payoutAddress: config.payoutAddress,
    reportSigner: config.reportSigner,
    requestedRelays: {
      capabilityReportUrl: config.capabilityReportUrl,
      routeStateUrl: config.routeStateUrl,
      upstreamAdmissionUrl: config.upstreamAdmissionUrl
    }
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function capabilityRegistrationWarning(status: number, body: string): string | undefined {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  if (status === 409) {
    return undefined;
  }
  let error: string | undefined;
  let reason: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; reason?: unknown; signer?: unknown; managerIds?: unknown; gatewayId?: unknown };
    error = typeof parsed.error === "string" ? parsed.error : undefined;
    reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
    const details = [
      typeof parsed.signer === "string" ? `signer=${parsed.signer}` : undefined,
      typeof parsed.gatewayId === "string" ? `gatewayId=${parsed.gatewayId}` : undefined,
      Array.isArray(parsed.managerIds) ? `managerIds=${parsed.managerIds.join(",")}` : undefined
    ].filter(Boolean).join(" ");
    if (details) {
      reason = [reason, details].filter(Boolean).join("; ");
    }
  } catch {
    reason = body.trim().slice(0, 300) || undefined;
  }
  const label = error ?? `http_${status}`;
  if (
    status === 403 ||
    label === "operator_not_authorized" ||
    label === "operator_not_active" ||
    label === "operator_report_signer_not_authorized" ||
    label === "gateway_not_authorized" ||
    label === "manager_scope_not_authorized"
  ) {
    return `Relay rejected this operator capability report (${label}${reason ? `: ${reason}` : ""}); check the control-plane operator allowlist/signers/manager scope.`;
  }
  return `Relay did not accept this operator capability report (${status}${error ? ` ${error}` : ""}${reason ? `: ${reason}` : ""}).`;
}

function normalizeImageRegistry(value: string): string {
  return value.replace(/\/+$/, "");
}

async function writeOperatorEnvFile(envFile: string, updates: Record<string, string | undefined>, projectDir: string): Promise<void> {
  const existing = await readEnvFileOrTemplate(envFile, projectDir);
  const next = mergeOperatorEnv(existing, updates);
  await mkdir(path.dirname(envFile), { recursive: true });
  await writeFile(envFile, next, { encoding: "utf8", mode: 0o600 });
  await chmod(envFile, 0o600);
}

async function writeJsonFile(file: string, value: unknown, mode: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
}

async function seedPackagedOperatorAssets(
  projectDir: string,
  composeFile: string,
  dryRun: boolean,
  actions: string[],
  warnings: string[]
): Promise<boolean> {
  const composeSeeded = await writePackagedOperatorAssetIfMissing({
    assetName: "docker-compose.yaml",
    targetFile: composeFile,
    label: "gateway compose file",
    dryRun,
    actions,
    warnings,
    required: true
  });

  await writePackagedOperatorAssetIfMissing({
    assetName: "operator.env.example",
    targetFile: path.join(projectDir, "docker", "operator.env.example"),
    label: "gateway env template",
    dryRun,
    actions,
    warnings,
    required: false
  });

  await writePackagedOperatorAssetIfMissing({
    assetName: "routes.example.json",
    targetFile: path.join(projectDir, "docker", "operator", "routes.example.json"),
    label: "operator route metadata template",
    dryRun,
    actions,
    warnings,
    required: false
  });

  await writePackagedOperatorAssetIfMissing({
    assetName: "envoy.yaml",
    targetFile: path.join(projectDir, "docker", "envoy", "envoy.yaml"),
    label: "gateway Envoy config",
    dryRun,
    actions,
    warnings,
    required: false
  });

  await writePackagedOperatorAssetIfMissing({
    assetName: "promscrape.yml",
    targetFile: path.join(projectDir, "docker", "victoria-metrics", "promscrape.yml"),
    label: "gateway VictoriaMetrics scrape config",
    dryRun,
    actions,
    warnings,
    required: false
  });

  await writePackagedOperatorAssetIfMissing({
    assetName: "grafana-victoria-metrics.yml",
    targetFile: path.join(projectDir, "docker", "grafana", "provisioning", "datasources", "victoria-metrics.yml"),
    label: "gateway Grafana datasource config",
    dryRun,
    actions,
    warnings,
    required: false
  });

  return composeSeeded;
}

async function writePackagedOperatorAssetIfMissing(input: {
  assetName: string;
  targetFile: string;
  label: string;
  dryRun: boolean;
  actions: string[];
  warnings: string[];
  required: boolean;
}): Promise<boolean> {
  if (await fileExists(input.targetFile)) {
    return true;
  }

  const content = await readPackagedOperatorAsset(input.assetName);
  if (content === undefined) {
    const message = `Packaged ${input.label} asset ${input.assetName} was not found.`;
    if (input.required) {
      input.warnings.push(message);
    }
    return false;
  }

  if (input.dryRun) {
    input.actions.push(`would write packaged ${input.label} ${input.targetFile}`);
    return true;
  }

  await mkdir(path.dirname(input.targetFile), { recursive: true });
  await writeFile(input.targetFile, content, "utf8");
  input.actions.push(`wrote packaged ${input.label} ${input.targetFile}`);
  return true;
}

async function readEnvFileOrTemplate(envFile: string, projectDir: string): Promise<string> {
  try {
    return await readFile(envFile, "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const template = path.join(projectDir, "docker", "operator.env.example");
  try {
    return await readFile(template, "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const packagedTemplate = await readPackagedOperatorAsset("operator.env.example");
  if (packagedTemplate !== undefined) {
    return packagedTemplate;
  }
  return "";
}

async function readPackagedOperatorAsset(assetName: string): Promise<string | undefined> {
  for (const candidate of packagedOperatorAssetCandidates(assetName)) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }
  return undefined;
}

function packagedOperatorAssetCandidates(assetName: string): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(moduleDir, "..", PACKAGED_OPERATOR_ASSET_DIR, assetName),
    path.join(moduleDir, "..", "..", PACKAGED_OPERATOR_ASSET_DIR, assetName),
    path.join(process.cwd(), PACKAGED_OPERATOR_ASSET_DIR, assetName),
    path.join(moduleDir, "..", "..", "packages", "switchboard-cli", PACKAGED_OPERATOR_ASSET_DIR, assetName),
    path.join(process.cwd(), "packages", "switchboard-cli", PACKAGED_OPERATOR_ASSET_DIR, assetName)
  ];
}

async function checkDocker(): Promise<DockerState> {
  const docker = await commandCheck("docker", ["--version"]);
  const composePlugin = docker.ok ? await commandCheck("docker", ["compose", "version"]) : failedCheck("docker", ["compose", "version"], "docker missing");
  if (composePlugin.ok) {
    return {
      docker,
      compose: composePlugin,
      composeStyle: "docker-compose-plugin",
      daemon: docker.ok ? await commandCheck("docker", ["info"]) : failedCheck("docker", ["info"], "docker missing")
    };
  }

  const composeStandalone = await commandCheck("docker-compose", ["version"]);
  return {
    docker,
    compose: composeStandalone,
    composeStyle: composeStandalone.ok ? "docker-compose-standalone" : undefined,
    daemon: docker.ok ? await commandCheck("docker", ["info"]) : failedCheck("docker", ["info"], "docker missing")
  };
}

async function installDockerWithApt(): Promise<void> {
  await runInteractive("sudo", ["apt-get", "update"]);
  await runInteractive("sudo", ["apt-get", "install", "-y", "docker.io"]);
  const composeV2 = await runInteractive("sudo", ["apt-get", "install", "-y", "docker-compose-v2"], { allowFailure: true });
  if (composeV2 !== 0) {
    const composePlugin = await runInteractive("sudo", ["apt-get", "install", "-y", "docker-compose-plugin"], { allowFailure: true });
    if (composePlugin !== 0) {
      await runInteractive("sudo", ["apt-get", "install", "-y", "docker-compose"]);
    }
  }
  await runInteractive("sudo", ["systemctl", "enable", "--now", "docker"], { allowFailure: true });
}

function supportsAptDockerInstall(platform: NodeJS.Platform, osRelease: OsRelease | undefined): boolean {
  if (platform !== "linux" || !osRelease) {
    return false;
  }
  const ids = [osRelease.id, ...osRelease.idLike].filter(Boolean).map((item) => item!.toLowerCase());
  return ids.includes("debian") || ids.includes("ubuntu");
}

async function readOsRelease(): Promise<OsRelease | undefined> {
  try {
    return parseOsRelease(await readFile("/etc/os-release", "utf8"));
  } catch {
    return undefined;
  }
}

async function commandCheck(command: string, args: string[]): Promise<CommandCheck> {
  const result = await runCaptured(command, args, { allowFailure: true });
  return {
    ok: result.exitCode === 0,
    command,
    args,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exitCode: result.exitCode,
    reason: result.exitCode === 0 ? undefined : result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
  };
}

function failedCheck(command: string, args: string[], reason: string): CommandCheck {
  return { ok: false, command, args, reason };
}

async function runCaptured(
  command: string,
  args: string[],
  options: { allowFailure?: boolean } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (options.allowFailure) {
        resolve({ stdout, stderr: error.message, exitCode: 127 });
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} failed with ${exitCode}`));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

async function runInteractive(
  command: string,
  args: string[],
  options: { cwd?: string; allowFailure?: boolean } = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} failed with ${exitCode}`));
        return;
      }
      resolve(exitCode);
    });
  });
}

async function fetchWanIpWithCurl(timeoutMs: number): Promise<string> {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const result = await runCaptured("curl", ["--ipv4", "--max-time", String(timeoutSeconds), WAN_IP_URL], {
    allowFailure: true
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `curl exited with ${result.exitCode}`);
  }
  const ip = result.stdout.trim().split(/\s+/)[0] ?? "";
  if (!ip) {
    throw new Error("empty response");
  }
  return ip;
}

async function fetchJsonWithRetry(url: URL, timeoutMs: number): Promise<unknown> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetchWithTimeout(url, { method: "GET" }, Math.min(2_000, timeoutMs));
      if (!response.ok) {
        throw new Error(`${response.status} ${await response.text()}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchWithTimeout(url: string | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function localTcpPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function createPromptIo(flags: Map<string, string | boolean>, rl?: readline.Interface): PromptIo {
  if (rl) {
    return {
      question: (prompt) => rl.question(prompt)
    };
  }

  const enabled = shouldPrompt(flags);
  return {
    async question(prompt) {
      if (!enabled) {
        return undefined;
      }
      const promptRl = readline.createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await promptRl.question(prompt);
      } finally {
        promptRl.close();
      }
    }
  };
}

async function confirm(prompt: PromptIo, assumeYes: boolean, question: string): Promise<boolean> {
  if (assumeYes) {
    return true;
  }
  const answer = await prompt.question(`${question} [y/N] `);
  if (answer === undefined) {
    return false;
  }
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

async function promptRequired(prompt: PromptIo, label: string): Promise<string> {
  const value = await promptOptional(prompt, label);
  if (!value) {
    throw new Error(`Missing ${label}; pass a flag for non-interactive setup`);
  }
  return value;
}

async function promptOptional(prompt: PromptIo, label: string): Promise<string | undefined> {
  const answer = await prompt.question(`${label}: `);
  if (answer === undefined) {
    return undefined;
  }
  const value = answer.trim();
  return value.length > 0 ? value : undefined;
}

export function shouldPrompt(flags: Map<string, string | boolean>): boolean {
  return (
    !boolFlag(flags, "json") &&
    !boolFlag(flags, "yes") &&
    process.env.SWITCHBOARD_ASSUME_YES !== "true" &&
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stderr.isTTY)
  );
}

function isManagerIdList(value: string): boolean {
  return value.split(",").every((item) => /^[0-9]+$/.test(item.trim()) && item.trim().length > 0);
}

async function resolveProcessorRefs(
  flags: Map<string, string | boolean>,
  existingEnv: Map<string, string>,
  projectDir: string
): Promise<string | undefined> {
  const inlineValue = stringFlag(flags, "processor") ?? stringFlag(flags, "processors");
  const fileValue = stringFlag(flags, "processor-file")
    ? await readProcessorFile(path.resolve(projectDir, stringFlag(flags, "processor-file")!))
    : undefined;
  const value = inlineValue ?? fileValue ?? process.env.OPERATOR_PROCESSORS ?? envValue(existingEnv, "OPERATOR_PROCESSORS");
  if (!value) {
    return undefined;
  }
  const refs = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (refs.length === 0) {
    return undefined;
  }
  return refs.join(",");
}

async function readProcessorFile(file: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`Could not read --processor-file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item)).join(",");
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["processors", "includeProcessors", "operatorProcessors"]) {
        const value = record[key];
        if (Array.isArray(value)) {
          return value.map((item) => String(item)).join(",");
        }
      }
    }
  } catch {
    // Fall through to text parsing.
  }
  return trimmed.split(/[\s,]+/).filter(Boolean).join(",");
}

function resolveOperatorId(
  flags: Map<string, string | boolean>,
  existingEnv: Map<string, string>,
  admissionBundle: OperatorAdmissionBundle | undefined
): string | undefined {
  const value =
    stringFlag(flags, "operator-id") ??
    process.env.OPERATOR_ID ??
    process.env.SWITCHBOARD_OPERATOR_ID ??
    process.env.PROOF_OPERATOR_ID ??
    envValue(existingEnv, "OPERATOR_ID", "SWITCHBOARD_OPERATOR_ID", "PROOF_OPERATOR_ID") ??
    admissionBundle?.operatorId;
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("operator-id must be a 0x-prefixed bytes32 value");
  }
  return normalized;
}

function resolveEnvSecret(
  flags: Map<string, string | boolean>,
  flagName: string,
  directEnvName: string,
  existingEnv: Map<string, string>,
  fallback?: string
): string | undefined {
  const envName = stringFlag(flags, flagName);
  if (envName) {
    const value = process.env[envName];
    if (!value) {
      throw new Error(`${flagName} references unset env var ${envName}`);
    }
    return value;
  }
  const value = process.env[directEnvName] ?? envValue(existingEnv, directEnvName) ?? fallback;
  return value && value.length > 0 ? value : undefined;
}

function resolveRouteIntentToken(input: {
  flags: Map<string, string | boolean>;
  existingEnv: Map<string, string>;
  gatewayAgentExternallyBound: boolean;
}): { token?: string; generated: boolean } {
  const fromExplicitEnv = resolveEnvSecret(
    input.flags,
    "route-intent-token-env",
    "GATEWAY_AGENT_ROUTE_INTENT_TOKEN",
    input.existingEnv,
    process.env.ROUTE_INTENT_OUTPUT_TOKEN ?? envValue(input.existingEnv, "ROUTE_INTENT_OUTPUT_TOKEN")
  );
  if (fromExplicitEnv) {
    return { token: fromExplicitEnv, generated: false };
  }
  if (!input.gatewayAgentExternallyBound) {
    return { generated: false };
  }
  return { token: generateRouteIntentToken(), generated: true };
}

function generateRouteIntentToken(): string {
  return `sb_rt_${randomBytes(32).toString("base64url")}`;
}

async function resolveReportSeed(input: {
  flags: Map<string, string | boolean>;
  existingEnv: Map<string, string>;
  prompt: PromptIo;
  runtime: OperatorSetupRuntime;
  assumeYes: boolean;
}): Promise<{ seed?: string; generated: boolean }> {
  const existing = resolveEnvSecret(input.flags, "operator-report-seed-env", "OPERATOR_REPORT_SEED", input.existingEnv);
  if (existing) {
    return { seed: existing, generated: false };
  }
  if (boolFlag(input.flags, "generate-report-seed")) {
    return { seed: generateReportSeed(input.runtime), generated: true };
  }
  if (await confirm(input.prompt, false, "No OPERATOR_REPORT_SEED was found. Generate a new local sr25519 report seed?")) {
    return { seed: generateReportSeed(input.runtime), generated: true };
  }
  return { generated: false };
}

function generateReportSeed(runtime: OperatorSetupRuntime): string {
  const seed = runtime.generateReportSeed ? runtime.generateReportSeed() : mnemonicGenerate(12);
  if (!mnemonicValidate(seed)) {
    throw new Error("Generated report seed is not a valid BIP-39 mnemonic.");
  }
  return seed;
}

async function tryDeriveReportSigner(seed: string, warnings: string[]): Promise<ReportSignerMetadata | undefined> {
  try {
    return await deriveReportSigner(seed);
  } catch (error) {
    warnings.push(`Could not derive sr25519 report signer from OPERATOR_REPORT_SEED: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export async function deriveReportSigner(seed: string, ss58Format = 42): Promise<ReportSignerMetadata> {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519", ss58Format });
  const pair = keyring.addFromUri(seed);
  return {
    scheme: "substrate-sr25519",
    address: pair.address,
    publicKey: u8aToHex(pair.publicKey),
    ss58Format
  };
}

function resolvePayoutAddress(
  flags: Map<string, string | boolean>,
  existingEnv: Map<string, string>,
  admissionBundle: OperatorAdmissionBundle | undefined
): string | undefined {
  const value =
    stringFlag(flags, "payout-address") ??
    process.env.OPERATOR_PAYOUT_ADDRESS ??
    envValue(existingEnv, "OPERATOR_PAYOUT_ADDRESS") ??
    admissionBundle?.payoutAddress;
  if (!value) {
    return undefined;
  }
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error("--payout-address must be a valid 0x-prefixed EVM address");
  }
}

function sanitizeGatewayId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "operator-gateway";
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function defaultRouteStateUrl(operatorId: string, gatewayId: string): string {
  return `https://control.switchboard.proof.computer/v1/operators/${encodeURIComponent(operatorId.toLowerCase())}/gateways/${encodeURIComponent(gatewayId)}/route-state`;
}

function parseEnvAssignment(line: string): { key: string } | undefined {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  return match ? { key: match[1] } : undefined;
}

function unquoteOsReleaseValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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

function numberFromString(value: string | undefined, name: string, fallback: number): number {
  if (!value) {
    return fallback;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(value);
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

function gatewayAgentBindExposesNetwork(bindAddress: string | undefined): boolean {
  const normalized = (bindAddress ?? "127.0.0.1").trim().toLowerCase();
  if (!normalized || normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return false;
  }
  return true;
}

function defaultUpstreamAdmissionUrl(bindAddress: string | undefined, port: number): string | undefined {
  if (!gatewayAgentBindExposesNetwork(bindAddress)) {
    return undefined;
  }
  const normalized = (bindAddress ?? "").trim();
  if (!normalized || normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]") {
    return undefined;
  }
  const host = net.isIP(normalized) === 6 && !normalized.startsWith("[") ? `[${normalized}]` : normalized;
  return `http://${host}:${port}/v1/upstream-admissions`;
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function parseArgs(args: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const withoutPrefix = arg.slice(2);
    if (withoutPrefix.startsWith("no-")) {
      flags.set(withoutPrefix, true);
      continue;
    }
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
  }

  return { flags };
}

function writeOutput(flags: Map<string, string | boolean>, value: unknown, printHuman: () => void) {
  if (boolFlag(flags, "json")) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  printHuman();
}

export function classifyOperatorStatus(input: {
  env: Map<string, string>;
  docker: DockerState;
  health: unknown;
  healthOk: boolean;
  localCapability: unknown;
  localCapabilityOk: boolean;
  relayCapability?: unknown;
  relayCapabilityOk?: boolean;
  operatorId?: string;
  gatewayId?: string;
  now: Date;
}): { state: OperatorStatusClassification; findings: string[] } {
  const findings: string[] = [];
  if (!input.docker.docker.ok) findings.push("docker CLI is not available");
  if (!input.docker.compose.ok) findings.push("Docker Compose is not available");
  if (input.docker.docker.ok && !input.docker.daemon.ok) findings.push("current user cannot access the Docker daemon");

  const configuredMode = envValue(input.env, "SWITCHBOARD_OPERATOR_MODE");
  const admissionIssues = relayAdmissionConfigIssues({
    network: envValue(input.env, "ACURAST_NETWORK") ?? "mainnet",
    operatorId: input.operatorId,
    gatewayId: input.gatewayId,
    reportSeed: envValue(input.env, "OPERATOR_REPORT_SEED"),
    capabilityReportUrl: envValue(input.env, "PROOF_OPERATOR_CAPABILITY_URL"),
    capabilityReportToken: envValue(input.env, "PROOF_OPERATOR_CAPABILITY_TOKEN"),
    routeStateUrl: envValue(input.env, "GATEWAY_ROUTE_STATE_URL"),
    routeStateToken: envValue(input.env, "GATEWAY_ROUTE_STATE_TOKEN") ?? envValue(input.env, "PROOF_OPERATOR_CAPABILITY_TOKEN")
  });
  if (configuredMode === "local-only") {
    return { state: "local-only", findings };
  }
  if (configuredMode === "pre-admission" || admissionIssues.length > 0) {
    findings.push(...admissionIssues.map((item) => `missing ${item}`));
    return { state: admissionIssues.length > 0 ? "pre-admission" : "pre-admission", findings };
  }

  const healthRecord = asRecord(input.health);
  const routeState = asRecord(healthRecord?.routeState);
  if (input.healthOk && routeState?.enabled === true && routeState.healthy === false) {
    findings.push("local gateway route-state polling is unhealthy");
    return { state: "route-state-unhealthy", findings };
  }
  const localReport = asRecord(asRecord(input.localCapability)?.report);
  const localGateway = asRecord(localReport?.gateway);
  if (input.localCapabilityOk && localGateway?.routeStateHealthy === false) {
    findings.push("local capability report marks route-state unhealthy");
    return { state: "route-state-unhealthy", findings };
  }

  const latest = latestRelayCapability(input.relayCapability, input.operatorId, input.gatewayId);
  if (!input.relayCapabilityOk || !latest) {
    findings.push("relay does not currently return this operatorId + gatewayId capability report");
    return { state: "relay-missing", findings };
  }
  const latestReport = asRecord(asRecord(latest)?.report);
  const expiresAt = stringRecordField(latestReport, "expiresAt");
  if (expiresAt && Date.parse(expiresAt) <= input.now.getTime()) {
    findings.push(`relay capability report expired at ${expiresAt}`);
    return { state: "report-stale", findings };
  }
  const latestGateway = asRecord(latestReport?.gateway);
  if (latestGateway?.routeStateHealthy === false) {
    findings.push("relay latest capability report marks route-state unhealthy");
    return { state: "route-state-unhealthy", findings };
  }
  return { state: "admitted", findings };
}

function operatorStatusHealthy(state: OperatorStatusClassification): boolean {
  return state === "local-only" || state === "pre-admission" || state === "admitted";
}

function currentUsername(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}

function latestRelayCapability(value: unknown, operatorId: string | undefined, gatewayId: string | undefined): unknown {
  const record = asRecord(value);
  const candidates = [
    ...(Array.isArray(record?.latest) ? record.latest : []),
    ...(Array.isArray(record?.reports) ? [...record.reports].reverse() : [])
  ];
  if (!operatorId || !gatewayId) {
    return candidates[0];
  }
  return candidates.find((item) => {
    const report = asRecord(asRecord(item)?.report);
    const operator = asRecord(report?.operator);
    return stringRecordField(operator, "operatorId")?.toLowerCase() === operatorId.toLowerCase() &&
      stringRecordField(operator, "gatewayId") === gatewayId;
  });
}

function redactSensitive(value: unknown, key = ""): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (sensitiveKey(key)) {
    return typeof value === "boolean" ? value : "[redacted]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [entryKey, redactSensitive(entryValue, entryKey)])
    );
  }
  return value;
}

function sensitiveKey(key: string): boolean {
  return /token|seed|secret|private.?key|password|authorization|bearer/i.test(key);
}

function printOperatorStatus(report: {
  ok: boolean;
  state: OperatorStatusClassification;
  findings: string[];
  projectDir: string;
  composeFiles: string[];
  envFile: string;
  docker: DockerState & { currentUser?: string; userCanAccessDaemon?: boolean; daemonError?: string };
  compose: { ok: boolean; stdout?: string; stderr?: string };
  config: {
    operatorId?: string;
    gatewayId?: string;
    admissionMode?: string;
    capabilityUrl?: string;
    routeStateUrl?: string;
    reportSeedConfigured: boolean;
    routeStateTokenConfigured: boolean;
    capabilityTokenConfigured: boolean;
  };
  gatewayAgent: { url: string; ok: boolean; health?: unknown; error?: string };
  capability: { localOk: boolean; local?: unknown; localError?: string; relayUrl?: string; relayOk?: boolean; relay?: unknown; relayError?: string };
}): void {
  console.log(`Gateway status: ${report.state}${report.ok ? "" : " (needs attention)"}`);
  console.log(`Docker: ${report.docker.docker.ok ? "ok" : "missing"}; Compose: ${report.docker.compose.ok ? "ok" : "missing"}`);
  if (report.docker.docker.ok) {
    console.log(`Docker daemon access: ${report.docker.userCanAccessDaemon ? "ok" : `blocked for ${report.docker.currentUser ?? "current user"}`}`);
    if (report.docker.daemonError) {
      console.log(`Docker daemon error: ${report.docker.daemonError}`);
    }
  }
  console.log(`Env file: ${report.envFile}`);
  console.log(`Compose files: ${report.composeFiles.join(", ")}`);
  console.log(`Operator ID: ${report.config.operatorId ?? "not configured"}`);
  console.log(`Gateway ID: ${report.config.gatewayId ?? "not configured"}`);
  console.log(`Admission mode: ${report.config.admissionMode ?? "inferred"}`);
  console.log(`Compose: ${report.compose.ok ? "ok" : "not ready"}`);
  if (report.compose.stdout) {
    console.log(report.compose.stdout);
  }
  if (report.compose.stderr) {
    console.log(`Compose stderr: ${report.compose.stderr}`);
  }
  console.log(`Gateway agent: ${report.gatewayAgent.ok ? "ok" : "not ready"} (${report.gatewayAgent.url})`);
  if (report.gatewayAgent.error) {
    console.log(`Gateway agent error: ${report.gatewayAgent.error}`);
  }
  console.log(`Local capability report: ${report.capability.localOk ? "ok" : "not ready"}`);
  if (report.capability.localError) {
    console.log(`Local capability error: ${report.capability.localError}`);
  }
  if (report.capability.relayUrl) {
    console.log(`Relay capability lookup: ${report.capability.relayOk ? "ok" : "not accepted/found"} (${report.capability.relayUrl})`);
    if (report.capability.relayError) {
      console.log(`Relay capability error: ${report.capability.relayError}`);
    }
  } else {
    console.log("Relay capability lookup: skipped (PROOF_OPERATOR_CAPABILITY_URL is not configured)");
  }
  if (report.findings.length > 0) {
    console.log("");
    console.log("Findings:");
    for (const finding of report.findings) {
      console.log(`- ${finding}`);
    }
  }
  if (!report.ok) {
    console.log("");
    console.log(`Next: switchboard gateway status --project-dir ${report.projectDir} --json`);
  }
}

function printOperatorSetupReport(report: OperatorSetupReport): void {
  console.log(`Gateway setup ${report.config.gatewayId}`);
  console.log(`OS: ${report.os.osRelease?.name ?? report.os.platform} ${report.os.osRelease?.versionId ?? report.os.release} (${report.os.arch})`);
  console.log(`Docker: ${report.docker.docker.ok ? "ok" : "missing"}; Compose: ${report.docker.compose.ok ? "ok" : "missing"}`);
  console.log(`Public address: ${report.network.publicAddress}:${report.network.publicPort} (${report.network.source}, ${report.network.publicAddressMode})`);
  if (report.network.gatewayAgentBindAddress) {
    console.log(`Gateway-agent bind address: ${report.network.gatewayAgentBindAddress}`);
  }
  console.log(`Gateway-agent route-intent auth: ${report.config.routeIntentAuthConfigured ? "configured" : "not configured"}`);
  if (report.config.routeIntentTokenGenerated) {
    console.log("Gateway-agent route-intent token: generated and stored in the env file");
  }
  if (report.network.upstreamAdmissionUrl) {
    console.log(`Upstream admission URL: ${report.network.upstreamAdmissionUrl}`);
  } else if (report.network.gatewayAgentExternallyBound) {
    console.log("Upstream admission URL: not inferred; pass --upstream-admission-url for relay profile onboarding");
  }
  if (report.network.routeStateUrl) {
    console.log(`Route-state URL: ${report.network.routeStateUrl}`);
  }
  if (report.config.managerAddress) {
    console.log(`Manager address: ${report.config.managerAddress}`);
  }
  if (report.config.managerIds) {
    console.log(`Manager IDs: ${report.config.managerIds}`);
  }
  if (report.config.operatorId) {
    console.log(`Operator ID: ${report.config.operatorId}`);
  }
  if (report.config.processorRefs) {
    console.log(`Processors: ${report.config.processorRefs.split(",").length} explicit include(s)`);
  }
  if (report.config.payoutAddress) {
    console.log(`Payout address: ${report.config.payoutAddress}`);
  }
  if (report.config.reportSigner) {
    console.log(`Report signer: ${report.config.reportSigner.address}`);
    console.log(`Report signer public key: ${report.config.reportSigner.publicKey}`);
  }
  console.log(`Admission mode: ${report.config.admissionMode}`);
  if (report.config.admissionRequestFile) {
    console.log(`Admission request: ${report.config.admissionRequestFile}`);
  }
  console.log(`Env file: ${report.config.envFile}`);
  console.log(`Compose file: ${report.config.composeFile}`);
  console.log(
    report.config.localBuild
      ? "Images: local build"
      : `Images: ${report.config.imageRegistry}/gateway:${report.config.imageTag}`
  );
  if (report.actions.length > 0) {
    console.log("");
    console.log("Actions:");
    for (const action of report.actions) {
      console.log(`- ${action}`);
    }
  }
  if (report.warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of report.warnings) {
      console.log(`- ${warning}`);
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "ENOENT");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  /(?:^|[/\\])setup\.ts$/.test(process.argv[1])
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[gateway:setup] ${message}`);
    process.exitCode = 1;
  });
}
