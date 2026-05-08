#!/usr/bin/env node
import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { u8aToHex } from "@polkadot/util";
import { decodeAddress, mnemonicGenerate } from "@polkadot/util-crypto";
import { ethers } from "ethers";

import { registerIngressWithRelay } from "../../src/runtime/index.js";
import {
  discoverManagerProcessors,
  selectReadyProcessors,
  type AcurastNetwork,
  type ProcessorInfo
} from "../../src/acurast-manager.js";
import {
  expandedReportProcessors,
  processorRefToId,
  type GatewayCapabilityReport
} from "../../src/operator-capability.js";
import { printOperatorDiscoverUsage, runOperatorDiscover } from "../../scripts/operator/discover.js";
import { printOperatorSetupUsage, runOperatorSetup, runOperatorStatus, runOperatorUpgrade } from "../../scripts/operator/setup.js";
import { getSwitchboardTarget, type SwitchboardTargetConfig } from "../../src/chains.js";
import {
  customerHostnameAttachmentSubstratePayload,
  customerHostnameInstructions,
  lookupDnsProviderHint,
  normalizeCustomerHostnameAttachment,
  signCustomerHostnameAttachment,
  type CustomerHostnameAttachmentPayload
} from "../../src/customer-hostname.js";
import { INGRESS_REGISTRY_NATIVE_PAYMENT_ABI } from "../../src/ingress-contract.js";
import type { NetworkManifest } from "../../src/network-manifest.js";
import { accountFromUri, contractLayerAddress, isReviveAccountMapped, ledgerAccount, signAndSend } from "../../src/polkadot.js";
import { signReportPayload } from "../../src/report-signing.js";
import { validateSwitchboardRoute } from "../../src/route-validation-report.js";
import { discoverServices, resolveControlApiEndpoints } from "../../src/service-discovery.js";
import { runRelayCatalogSetState, runRelayDeploy, runRelayStatus } from "./relay/index.js";
import { runRelaySync } from "./relay/sync.js";
import { runRelayList } from "./relay/list.js";
import { runRelayCatalogBuild } from "./relay/catalog-build-from-specs.js";
import { runRelayDiff } from "./relay/diff.js";
import { runRelayBackfillSpecs } from "./relay/backfill-specs.js";
import { runRelayKeygen } from "./relay/keygen.js";
import { runRelayPickProcessor } from "./relay/pick-processor.js";
import { runRelayScaffold } from "./relay/scaffold.js";
import { runRelayDrain } from "./relay/drain.js";
import { runRelayReplace } from "./relay/replace.js";
import { runRelayRotateKey } from "./relay/rotate-key.js";
import { runRelayDeployments } from "./relay/history.js";
import { runRelayLogs } from "./relay/logs.js";
import { runRelayPromote } from "./relay/promote.js";
import { runRelayWatch } from "./relay/watch.js";
import { runRelayVerify } from "./relay/verify.js";
import { runRelayBudget } from "./relay/budget.js";
import { runRelayWhoami } from "./relay/whoami.js";
import { runRelayDeploymentStatus, runRelayInspect } from "./relay/lifecycle.js";
import { runRelayDnsSubcommand } from "./relay/dns.js";
import { runBootstrapSubcommand } from "./bootstrap/acurast.js";
import {
  runCatalogBuild,
  runCatalogInspect,
  runCatalogSetState,
  runCatalogVerify
} from "./catalog/index.js";
import { contextAddCommand } from "./context/add.js";
import { contextDnsClearCommand, contextDnsSetCommand } from "./context/dns.js";
import { checkMnemonicSeed } from "./preflight/mnemonic-check.js";
import {
  compactId,
  createGroupedDeployTranscriptWriter,
  formatAcuUnits,
  formatRows,
  sectionTitle,
  statusLine,
  switchboardColorEnabled,
  type GroupedDeployTranscriptWriter,
  type OutputRow
} from "./output.js";
import { printOpsUsage, runOpsSubcommand } from "./ops.js";
import {
  DEFAULT_SWITCHBOARD_OPS_PROFILE,
  SWITCHBOARD_OPS_PROFILE_ENV,
  loadContextSecretFile,
  loadSwitchboardOpsProfile,
  normalizeSwitchboardProfileName
} from "./switchboard-home.js";
import {
  PROJECT_STATE_FILE,
  SWITCHBOARD_CLI,
  SWITCHBOARD_CONTEXT_ENV,
  SWITCHBOARD_HOME_ENV,
  SWITCHBOARD_LOCKUP,
  SWITCHBOARD_NAME,
  SWITCHBOARD_PROJECT_CONFIG_FILE,
  SWITCHBOARD_PROJECT_STATE_DIR,
  contextStorePath as switchboardContextStorePath,
  fileExists,
  findProjectRoot as findSwitchboardProjectRoot,
  projectConfigNamesForMessage,
  projectConfigPath as switchboardProjectConfigPath,
  projectStatePath as switchboardProjectStatePath,
  projectStateReadCandidates
} from "./switchboard-paths.js";

export { resolveAcurastScriptRunner } from "./relay/acurast-script-runner.js";

const DEFAULT_CONTROL_PLANE_URL = "https://control.switchboard.proof.computer";
const DEFAULT_ROUTE_INTENT_URL = "http://127.0.0.1:18080/route-intents";
const DEFAULT_MAX_COST_PER_EXECUTION = "100000000000";
const DEFAULT_DEPLOY_DURATION_MINUTES = 60;
const DEFAULT_DEPLOY_SCHEDULE_BUFFER_MINUTES = 10;
const DEFAULT_LAUNCH_DEMO_DURATION_MINUTES = 10;
const DEFAULT_LAUNCH_DEMO_START_DELAY_MS = 180_000;
const DEFAULT_LAUNCH_DEMO_MAX_COST_PER_EXECUTION = "40000000000";
const DEFAULT_LAUNCH_DEMO_PROCESSOR_MAX_AGE_SECONDS = 900;
const DEFAULT_LAUNCH_DEMO_PACKAGE_SPEC = "github:proof-computer/switchboard-express-demo#v0.1.0";
const LAUNCH_DEMO_ENTRYPOINT = "src/server.ts";
const ANSI_ESCAPE_PATTERN = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
export const PROOF_NETWORK_MANIFEST_URL = "https://control.switchboard.proof.computer/v1/network-manifest";
export const PROOF_NETWORK_MANIFEST_SIGNER = "5EpwnRzamXpqWo3jW9h4ecSJHL9LBjR6jTMW5Wzw6p9nMTh7";
export const PROOF_MAINNET_RECORDER_COORDINATOR_ADDRESS = "0xd4dFB4AD9A4a2AfF56CCBe479F661b84947287A5";
const INTERNAL_DEPLOY_RUNNER_SCRIPT = "switchboard:internal:deploy-runner";
const ERC20_METADATA_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
] as const;

const SESSION_STATUS_LABELS = ["None", "Funded", "Registered", "Active", "Refunded", "Cancelled"] as const;

export type CommandName =
  | "project-init"
  | "project-show"
  | "context-list"
  | "context-current"
  | "context-use"
  | "context-set"
  | "context-add"
  | "context-dns-set"
  | "context-dns-clear"
  | "preflight"
  | "claim"
  | "claimable"
  | "session-register"
  | "session-status"
  | "session-refund"
  | "session-refundable"
  | "launch-demo"
  | "deploy"
  | "deployment-status"
  | "hostname-attach"
  | "hostname-remove"
  | "hostname-status"
  | "validator-launch"
  | "operator-setup"
  | "operator-discover"
  | "operator-status"
  | "operator-upgrade"
  | "relay-deploy"
  | "relay-catalog-set-state"
  | "relay-status"
  | "relay-sync"
  | "relay-list"
  | "relay-catalog-build"
  | "relay-diff"
  | "relay-backfill-specs"
  | "relay-keygen"
  | "relay-pick-processor"
  | "relay-scaffold"
  | "relay-drain"
  | "relay-replace"
  | "relay-rotate-key"
  | "relay-deployments"
  | "relay-logs"
  | "relay-promote"
  | "relay-watch"
  | "relay-verify"
  | "relay-budget"
  | "relay-whoami"
  | "relay-inspect"
  | "relay-deployment-status"
  | "relay-dns"
  | "bootstrap"
  | "ops"
  | "catalog-build"
  | "catalog-inspect"
  | "catalog-verify"
  | "catalog-set-state"
  | "help";

interface ParsedArgs {
  command: CommandName;
  flags: Map<string, string | boolean>;
  positionals: string[];
}

export interface CliNetworkConfig {
  manifest?: NetworkManifest;
  manifestUrl: string;
  signer?: string;
  targetName?: string;
  chainId?: string;
  registryAddress?: string;
  relayUrl?: string;
  ethRpcUrl?: string;
  substrateWsUrl?: string;
  defaultAssetAddress?: string;
}

interface SwitchboardProjectConfig {
  project?: string;
  context?: string;
  endpoint?: {
    id?: string;
    hostname?: string;
  };
  acurast?: {
    project?: string;
    network?: string;
    stageDir?: string;
    entrypoint?: string;
  };
  deploy?: {
    hostname?: string;
    hostnameSuffix?: string;
    durationMinutes?: number;
    scheduleBufferMinutes?: number;
    operatorId?: string;
    processor?: string;
    paymentMode?: string;
    quote?: boolean;
  };
}

interface SwitchboardProjectState {
  latestReport?: string;
  latestDeployment?: Record<string, unknown>;
  reports?: Array<Record<string, unknown>>;
}

export interface SwitchboardContext {
  manifestUrl?: string;
  manifestSigner?: string;
  target?: string;
  operatorId?: string;
  relayUrl?: string;
  paymentMode?: string;
  acurastNetwork?: string;
  acurastSeedEnv?: string;
  acurastAddressEnv?: string;
  polkadotSigner?: string;
  polkadotAddress?: string;
  polkadotSeedEnv?: string;
  polkadotAddressEnv?: string;
  polkadotSs58Format?: string;
  ledgerMode?: string;
  ledgerTransport?: string;
  ledgerChain?: string;
  ledgerSlip44?: string;
  ledgerAccount?: string;
  ledgerAddressIndex?: string;
  ledgerMetadataChainId?: string;
  ledgerMetadataUrl?: string;
  developerPrivateKeyEnv?: string;
  cloudflareApiTokenEnv?: string;
}

export interface SwitchboardContextStore {
  current?: string;
  contexts?: Record<string, SwitchboardContext>;
}

interface CliRuntime {
  projectRoot?: string;
  projectConfigPath?: string;
  projectStatePath?: string;
  projectConfig?: SwitchboardProjectConfig;
  projectState?: SwitchboardProjectState;
  contextName?: string;
  context?: SwitchboardContext;
  contextStorePath: string;
}

type CliHubSigner =
  | {
      kind: "evm";
      address: string;
      contractAddress: string;
      wallet: ethers.Wallet;
    }
  | {
      kind: "polkadot";
      address: string;
      contractAddress: string;
      api: ApiPromise;
      account: any;
      substrateWsUrl: string;
      disconnect(): Promise<void>;
    };

export interface AssetDisplay {
  address: string;
  symbol?: string;
  decimals?: number;
}

const REMOVED_PUBLIC_DEPLOY_FLAGS = [
  "route-activation-mode",
  "route-intent-url",
  "operator-ssh-host",
  "validator-mode",
  "real-validator",
  "skip-validator",
  "activate",
  "record-fulfillment",
  "allow-manual-fulfillment",
  "fulfillment-delay-ms",
  "fulfillment-interval-ms"
];
const REMOVED_PUBLIC_STATUS_FLAGS = [
  "route-intent-url",
  "operator-ssh-host",
  "repair-route",
  "route-id",
  "require-validator"
];
const REMOVED_PROJECT_DEPLOY_FIELDS = [
  "validatorMode",
  "realValidator",
  "activate",
  "recordFulfillment",
  "routeIntentUrl",
  "operatorSshHost"
];
const REMOVED_CONTEXT_FIELDS = [
  "routeIntentUrl",
  "operatorSshHost",
  "controlPlaneTokenEnv"
];
const REMOVED_CONTEXT_SET_FLAGS = [
  "route-intent-url",
  "operator-ssh-host",
  "control-plane-token-env"
];

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const runtime = await loadCliRuntime(parsed.flags, parsed.command);

  if (parsed.command === "operator-discover" && boolFlag(parsed.flags, "help")) {
    printOperatorDiscoverUsage();
    return;
  }

  if (parsed.command === "operator-setup" && boolFlag(parsed.flags, "help")) {
    printOperatorSetupUsage();
    return;
  }

  if (parsed.command === "ops" && boolFlag(parsed.flags, "help")) {
    printOpsUsage();
    return;
  }

  if (parsed.command === "help" || boolFlag(parsed.flags, "help")) {
    printHelp({ advanced: boolFlag(parsed.flags, "advanced") || boolFlag(parsed.flags, "all") });
    return;
  }

  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);

  if (parsed.command === "project-init") {
    await projectInitCommand(flags);
    return;
  }

  if (parsed.command === "project-show") {
    await projectShowCommand(flags, runtime);
    return;
  }

  if (parsed.command === "context-list") {
    await contextListCommand(flags, runtime);
    return;
  }

  if (parsed.command === "context-current") {
    await contextCurrentCommand(flags, runtime);
    return;
  }

  if (parsed.command === "context-use") {
    await contextUseCommand(flags, parsed.positionals);
    return;
  }

  if (parsed.command === "context-set") {
    await contextSetCommand(flags, parsed.positionals);
    return;
  }

  if (parsed.command === "context-add") {
    await contextAddCommand(flags, parsed.positionals);
    return;
  }

  if (parsed.command === "context-dns-set") {
    await contextDnsSetCommand(flags, parsed.positionals);
    return;
  }

  if (parsed.command === "context-dns-clear") {
    await contextDnsClearCommand(flags, parsed.positionals);
    return;
  }

  if (parsed.command === "ops") {
    await runOpsSubcommand({ flags, positionals: parsed.positionals });
    return;
  }

  if (parsed.command === "preflight") {
    await preflightCommand(flags, runtime);
    return;
  }

  if (parsed.command === "claim") {
    await claimCommand(flags);
    return;
  }

  if (parsed.command === "claimable") {
    await claimCommand(flags, { readOnly: true });
    return;
  }

  if (parsed.command === "session-register") {
    await relayRegistrationCommand(flags);
    return;
  }

  if (parsed.command === "session-status") {
    await statusCommand(flags);
    return;
  }

  if (parsed.command === "session-refund") {
    await refundCommand(flags);
    return;
  }

  if (parsed.command === "session-refundable") {
    await refundCommand(flags, { readOnly: true });
    return;
  }

  if (parsed.command === "launch-demo") {
    await launchDemoCommand(flags, runtime);
    return;
  }

  if (parsed.command === "deploy") {
    await deployCommand(flags, runtime);
    return;
  }

  if (parsed.command === "deployment-status") {
    await deploymentStatusCommand(flags);
    return;
  }

  if (parsed.command === "hostname-attach") {
    await hostnameAttachCommand(flags, parsed.positionals);
    return;
  }

  if (parsed.command === "hostname-remove") {
    await hostnameRemoveCommand(flags, parsed.positionals);
    return;
  }

  if (parsed.command === "hostname-status") {
    await hostnameStatusCommand(flags, parsed.positionals);
    return;
  }

  if (parsed.command === "validator-launch") {
    await validatorLaunchCommand(flags, runtime);
    return;
  }

  if (parsed.command === "operator-setup") {
    await runOperatorSetup(flags);
    return;
  }

  if (parsed.command === "operator-status") {
    await runOperatorStatus(flags);
    return;
  }

  if (parsed.command === "operator-upgrade") {
    await runOperatorUpgrade(flags);
    return;
  }

  if (parsed.command === "operator-discover") {
    await runOperatorDiscover(flags);
    return;
  }

  if (parsed.command === "relay-deploy") {
    await runRelayDeploy({ flags, positionals: parsed.positionals });
    return;
  }

  if (parsed.command === "relay-catalog-set-state") {
    await runRelayCatalogSetState({ flags, positionals: parsed.positionals });
    return;
  }

  if (parsed.command === "relay-status") {
    await runRelayStatus({ flags, positionals: parsed.positionals });
    return;
  }

  if (parsed.command === "relay-sync") {
    await runRelaySync({ flags: withDiscoveryDefaults(flags), positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-list") {
    await runRelayList({ flags: withDiscoveryDefaults(flags), positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-catalog-build") {
    await runRelayCatalogBuild({ flags, positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-diff") {
    await runRelayDiff({ flags: withDiscoveryDefaults(flags), positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-backfill-specs") {
    await runRelayBackfillSpecs({ flags: withDiscoveryDefaults(flags), positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-keygen") {
    await runRelayKeygen({ flags, positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-pick-processor") {
    await runRelayPickProcessor({ flags, positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-scaffold") {
    await runRelayScaffold({ flags, positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-drain") {
    await runRelayDrain({ flags, positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-replace") {
    await runRelayReplace({ flags, positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-rotate-key") {
    await runRelayRotateKey({ flags, positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-deployments") {
    await runRelayDeployments({ flags, positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-logs") {
    await runRelayLogs({ flags, positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-promote") {
    await runRelayPromote({ flags, positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-watch") {
    await runRelayWatch({ flags, positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-verify") {
    const result = await runRelayVerify({ flags: withDiscoveryDefaults(flags), positionals: parsed.positionals });
    if (!result.ok) {
      throw new Error(`relay verify ${result.relayId}: ${result.checks.filter((c) => !c.ok).length} check(s) failed`);
    }
    return;
  }
  if (parsed.command === "relay-budget") {
    await runRelayBudget({ flags, positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-whoami") {
    await runRelayWhoami({ flags, positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-inspect") {
    await runRelayInspect({ flags, positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-deployment-status") {
    await runRelayDeploymentStatus({ flags, positionals: parsed.positionals });
    return;
  }
  if (parsed.command === "relay-dns") {
    await runRelayDnsSubcommand({ flags, positionals: parsed.positionals });
    return;
  }

  if (parsed.command === "bootstrap") {
    await runBootstrapSubcommand({ flags, positionals: parsed.positionals });
    return;
  }

  if (parsed.command === "catalog-build") {
    await runCatalogBuild({ flags, positionals: parsed.positionals });
    return;
  }

  if (parsed.command === "catalog-inspect") {
    await runCatalogInspect({ flags, positionals: parsed.positionals });
    return;
  }

  if (parsed.command === "catalog-verify") {
    await runCatalogVerify({ flags, positionals: parsed.positionals });
    return;
  }

  if (parsed.command === "catalog-set-state") {
    await runCatalogSetState({ flags, positionals: parsed.positionals });
    return;
  }

  assert.fail(`Unsupported command: ${parsed.command}`);
}

export function assertNoRemovedPublicCommandFlags(command: CommandName, flags: Map<string, string | boolean>): void {
  const removed =
    command === "launch-demo" || command === "deploy"
      ? REMOVED_PUBLIC_DEPLOY_FLAGS
      : command === "deployment-status"
        ? REMOVED_PUBLIC_STATUS_FLAGS
        : [];
  const present = removed.filter((flag) => flags.has(flag));
  if (present.length > 0) {
    throw new Error(
      `Removed public ${publicCommandLabel(command)} option(s): ${present.map((flag) => `--${flag}`).join(", ")}. ` +
        "Use the relay/bootstrap/catalog/ops admin namespaces with an ops profile for recovery or control-plane operations."
    );
  }
}

function assertNoLegacyPublicRuntimeConfig(command: CommandName, runtime: CliRuntime): void {
  if (!commandLoadsContextSecrets(command) || command === "context-set") {
    return;
  }
  const deploy = runtime.projectConfig?.deploy as Record<string, unknown> | undefined;
  const legacyProjectFields = deploy
    ? REMOVED_PROJECT_DEPLOY_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(deploy, field))
    : [];
  if (legacyProjectFields.length > 0) {
    const source = runtime.projectConfigPath ?? SWITCHBOARD_PROJECT_CONFIG_FILE;
    throw new Error(
      `${source} uses removed deploy field(s): ${legacyProjectFields.join(", ")}. ` +
        "Public deploys are relay-reconciled only; move route repair, validator, activation, and manual fulfillment controls to an ops profile/admin command."
    );
  }

  const context = runtime.context as Record<string, unknown> | undefined;
  const legacyContextFields = context
    ? REMOVED_CONTEXT_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(context, field))
    : [];
  if (legacyContextFields.length > 0) {
    throw new Error(
      `Switchboard context "${runtime.contextName ?? "(current)"}" uses removed field(s): ${legacyContextFields.join(", ")}. ` +
        "Builder contexts must not carry control-plane, operator SSH, or route-intent settings; put admin secrets under ~/.switchboard/ops/<profile>/secrets.env."
    );
  }
}

function assertNoRemovedProjectInitFlags(flags: Map<string, string | boolean>): void {
  const removed = [...REMOVED_PUBLIC_DEPLOY_FLAGS, "operator-project-dir", "operator-route-metadata-file"]
    .filter((flag, index, values) => values.indexOf(flag) === index)
    .filter((flag) => flags.has(flag));
  if (removed.length > 0) {
    throw new Error(
      `Removed project deploy option(s): ${removed.map((flag) => `--${flag}`).join(", ")}. ` +
        "New projects use relay-reconciled deployment defaults; put recovery/admin settings in an ops profile."
    );
  }
}

function assertNoRemovedContextSetFlags(flags: Map<string, string | boolean>): void {
  const removed = REMOVED_CONTEXT_SET_FLAGS.filter((flag) => flags.has(flag));
  if (removed.length > 0) {
    throw new Error(
      `Removed builder context option(s): ${removed.map((flag) => `--${flag}`).join(", ")}. ` +
        "Builder contexts must not store control-plane, route-intent, or operator SSH settings; use `switchboard ops` for admin configuration."
    );
  }
}

function stripRemovedContextFields(context: SwitchboardContext): SwitchboardContext {
  const next = { ...(context as Record<string, unknown>) };
  for (const field of REMOVED_CONTEXT_FIELDS) {
    delete next[field];
  }
  return next as SwitchboardContext;
}

function publicCommandLabel(command: CommandName): string {
  if (command === "deployment-status") {
    return "status";
  }
  return command;
}

async function relayRegistrationCommand(flags: Map<string, string | boolean>) {
  if (!boolFlag(flags, "yes") && optionalEnv("SWITCHBOARD_ASSUME_YES") !== "true") {
    throw new Error("Refusing to relay registration without --yes");
  }

  const target = targetFromFlags(flags);
  const ethRpcUrl = stringFlag(flags, "eth-rpc-url") ?? optionalEnv("HUB_ETH_RPC_URL") ?? optionalEnv("ETH_RPC_URL") ?? target.defaultEthRpcUrl;
  const registryAddress = ethers.getAddress(requiredStringFlag(flags, "registry", "INGRESS_REGISTRY_ADDRESS"));
  const provider = new ethers.JsonRpcProvider(ethRpcUrl);
  const network = await provider.getNetwork();
  if (target.expectedChainId && network.chainId !== target.expectedChainId) {
    throw new Error(`Connected to chain ID ${network.chainId.toString()}, but ${target.name} expects ${target.expectedChainId.toString()}`);
  }

  const registry = new ethers.Contract(registryAddress, INGRESS_REGISTRY_NATIVE_PAYMENT_ABI, provider);
  const sessionId = requiredStringFlag(flags, "session-id", "SESSION_ID");
  const session = await registry.getSession(sessionId);
  if (session.developer.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    throw new Error(`Session ${sessionId} is not funded`);
  }
  if (session.registered) {
    throw new Error(`Session ${sessionId} is already registered`);
  }

  const jobSignerPrivateKey = requiredStringFlag(flags, "job-signer-private-key", "JOB_SIGNER_PRIVATE_KEY");
  const jobSignerAddress = new ethers.Wallet(jobSignerPrivateKey).address;
  if (jobSignerAddress.toLowerCase() !== session.expectedJobSigner.toLowerCase()) {
    throw new Error(`JOB_SIGNER_PRIVATE_KEY resolves to ${jobSignerAddress}, not funded session signer ${session.expectedJobSigner}`);
  }

  if (boolFlag(flags, "local-relay")) {
    throw new Error("--local-relay is not included in the public CLI package; pass --relay-url instead");
  }
  const relayUrl = requiredStringFlag(flags, "relay-url", "RELAY_URL");

  const result = await registerIngressWithRelay({
    relayUrl,
    chainId: network.chainId,
    registryAddress,
    sessionId,
    jobId: session.jobId,
    operatorId: session.operatorId,
    processorId: session.processorId,
    endpointHash: session.endpointHash,
    nonce: session.nextNonce.toString(),
    deadline: stringFlag(flags, "deadline") ?? optionalEnv("DEADLINE") ?? Math.floor(Date.now() / 1000) + 600,
    jobSignerPrivateKey,
    requestTimeoutMs: numberFlag(flags, "request-timeout-ms", "CONTRACT_CALL_TIMEOUT_MS", 120_000)
  });
  const registeredSession = await registry.getSession(sessionId);
  assert.equal(registeredSession.registered, true);

  const output = {
    ok: true,
    action: "session-register",
    target: target.name,
    chainId: network.chainId.toString(),
    ethRpcUrl,
    registryAddress,
    relayUrl,
    registration: result.registration,
    signature: result.signature,
    relayResponse: result.relayResponse,
    session: sessionOutput(registeredSession)
  };

  writeOutput(flags, output, () => printRelayRegistrationResult(output));
}

async function statusCommand(flags: Map<string, string | boolean>) {
  const manifestConfig = await resolveCliNetworkConfig(flags);
  const target = targetFromFlags(flags, manifestConfig);
  const ethRpcUrl = manifestConfig.ethRpcUrl ?? target.defaultEthRpcUrl;
  const registryAddress = ethers.getAddress(manifestConfig.registryAddress ?? requiredStringFlag(flags, "registry", "INGRESS_REGISTRY_ADDRESS"));
  const sessionId = requiredStringFlag(flags, "session-id", "SESSION_ID");
  const provider = new ethers.JsonRpcProvider(ethRpcUrl);
  const network = await provider.getNetwork();
  if (target.expectedChainId && network.chainId !== target.expectedChainId) {
    throw new Error(`Connected to chain ID ${network.chainId.toString()}, but ${target.name} expects ${target.expectedChainId.toString()}`);
  }

  const registry = new ethers.Contract(registryAddress, INGRESS_REGISTRY_NATIVE_PAYMENT_ABI, provider);
  const session = await registry.getSession(sessionId);
  const output = {
    ok: true,
    action: "status",
    target: target.name,
    chainId: network.chainId.toString(),
    ethRpcUrl,
    registryAddress,
    sessionId,
    session: sessionOutput(session)
  };

  writeOutput(flags, output, () => printStatus(output));
}

async function claimCommand(flags: Map<string, string | boolean>, options: { readOnly?: boolean } = {}) {
  const manifestConfig = await resolveCliNetworkConfig(flags);
  const target = targetFromFlags(flags, manifestConfig);
  const ethRpcUrl = manifestConfig.ethRpcUrl ?? target.defaultEthRpcUrl;
  const registryAddress = ethers.getAddress(manifestConfig.registryAddress ?? requiredStringFlag(flags, "registry", "INGRESS_REGISTRY_ADDRESS"));
  const assetAddress = ethers.getAddress(manifestConfig.defaultAssetAddress ?? requiredStringFlag(flags, "asset", "PAYMENT_ASSET_ADDRESS"));
  const provider = new ethers.JsonRpcProvider(ethRpcUrl);
  const network = await provider.getNetwork();
  if (target.expectedChainId && network.chainId !== target.expectedChainId) {
    throw new Error(`Connected to chain ID ${network.chainId.toString()}, but ${target.name} expects ${target.expectedChainId.toString()}`);
  }

  const registry = new ethers.Contract(registryAddress, INGRESS_REGISTRY_NATIVE_PAYMENT_ABI, provider) as any;
  const explicitRecipient = stringFlag(flags, "recipient") ?? stringFlag(flags, "claim-recipient");
  const shouldSubmit = !options.readOnly && (boolFlag(flags, "yes") || optionalEnv("SWITCHBOARD_ASSUME_YES") === "true");
  const signer = explicitRecipient && !shouldSubmit ? undefined : await resolveCliHubSigner(flags, manifestConfig, target);
  const recipient = ethers.getAddress(explicitRecipient ?? signer?.contractAddress ?? "");
  const asset = await assetDisplay(provider, manifestConfig, assetAddress);
  const balance = await registry.claimableBalances(assetAddress, recipient) as bigint;
  const formattedBalance = formatAssetUnits(balance, asset);
  const confirmations = numberFlag(flags, "confirmations", "CONFIRMATIONS", 1);
  const dryRun = !shouldSubmit;

  let estimatedGas: string | undefined;
  if (signer && balance > 0n) {
    estimatedGas = await estimateClaimGas(flags, signer, provider, registryAddress, assetAddress).catch(() => undefined);
  }

  const baseOutput = {
    ok: true,
    action: options.readOnly ? "claimable" : "claim",
    dryRun,
    target: target.name,
    chainId: network.chainId.toString(),
    ethRpcUrl,
    substrateWsUrl: signer?.kind === "polkadot" ? signer.substrateWsUrl : manifestConfig.substrateWsUrl,
    registryAddress,
    asset,
    recipient,
    signer: signer ? signerOutput(signer) : undefined,
    claimable: {
      raw: balance.toString(),
      formatted: formattedBalance
    },
    estimatedGas
  };

  if (dryRun || balance === 0n) {
    await disconnectCliHubSigner(signer);
    writeOutput(flags, baseOutput, () => printClaimResult(baseOutput));
    return;
  }

  if (!signer) {
    throw new Error("Missing signer for claim submission.");
  }

  try {
    assertSignerMatchesRecipient(signer, recipient, "claim recipient");
    const tx = await submitRegistryCall(flags, signer, provider, registryAddress, "claim", [assetAddress], confirmations);
    const balanceAfter = await registry.claimableBalances(assetAddress, recipient) as bigint;
    const output = {
      ...baseOutput,
      dryRun: false,
      tx,
      claimableAfter: {
        raw: balanceAfter.toString(),
        formatted: formatAssetUnits(balanceAfter, asset)
      }
    };
    writeOutput(flags, output, () => printClaimResult(output));
  } finally {
    await disconnectCliHubSigner(signer);
  }
}

async function refundCommand(flags: Map<string, string | boolean>, options: { readOnly?: boolean } = {}) {
  const reportPath = deploymentReportPath(flags);
  const report = reportPath ? (JSON.parse(await readFile(reportPath, "utf8")) as Record<string, any>) : undefined;
  const manifestConfig = await resolveCliNetworkConfig(flags);
  const target = targetFromFlags(flags, manifestConfig);
  const ethRpcUrl = manifestConfig.ethRpcUrl ?? target.defaultEthRpcUrl;
  const registryAddress = ethers.getAddress(manifestConfig.registryAddress ?? requiredStringFlag(flags, "registry", "INGRESS_REGISTRY_ADDRESS"));
  const sessionId = stringFlag(flags, "session-id") ?? stringRecordField(report?.session, "sessionId");
  if (!sessionId) {
    throw new Error("Missing --session-id or --report");
  }

  const provider = new ethers.JsonRpcProvider(ethRpcUrl);
  const network = await provider.getNetwork();
  if (target.expectedChainId && network.chainId !== target.expectedChainId) {
    throw new Error(`Connected to chain ID ${network.chainId.toString()}, but ${target.name} expects ${target.expectedChainId.toString()}`);
  }

  const registry = new ethers.Contract(registryAddress, INGRESS_REGISTRY_NATIVE_PAYMENT_ABI, provider) as any;
  const session = await registry.getSession(sessionId);
  const sessionInfo = sessionOutput(session);
  const asset = await assetDisplay(provider, manifestConfig, ethers.getAddress(session.asset));
  const status = Number(session.status);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const refundPlan = await planRefundAction(flags, registry, sessionId, session, status, nowSeconds);
  const shouldSubmit = !options.readOnly && (boolFlag(flags, "yes") || optionalEnv("SWITCHBOARD_ASSUME_YES") === "true");
  const dryRun = !shouldSubmit;
  const signer = refundPlan.callName && shouldSubmit
    ? await resolveRefundSigner(flags, manifestConfig, target, ethers.getAddress(session.developer))
    : refundPlan.callName
      ? await maybeResolveCliHubSigner(flags, manifestConfig, target)
      : undefined;
  const confirmations = numberFlag(flags, "confirmations", "CONFIRMATIONS", 1);

  let estimatedGas: string | undefined;
  if (refundPlan.callName && signer) {
    estimatedGas = await estimateRegistryCallGas(flags, signer, provider, registryAddress, refundPlan.callName, [sessionId]).catch(() => undefined);
  }

  const remainingRefund = BigInt(session.amountPaid.toString()) - BigInt(session.amountReleased.toString()) - BigInt(session.amountRefunded.toString());
  const baseOutput = {
    ok: refundPlan.eligible,
    action: options.readOnly ? "refundable" : "refund",
    dryRun,
    target: target.name,
    chainId: network.chainId.toString(),
    ethRpcUrl,
    substrateWsUrl: signer?.kind === "polkadot" ? signer.substrateWsUrl : manifestConfig.substrateWsUrl,
    registryAddress,
    reportPath,
    sessionId,
    status: {
      value: status.toString(),
      label: sessionStatusLabel(status)
    },
    developer: sessionInfo.developer,
    asset,
    refundable: {
      raw: remainingRefund.toString(),
      formatted: formatAssetUnits(remainingRefund, asset)
    },
    refund: refundPlan,
    signer: signer ? signerOutput(signer) : undefined,
    estimatedGas,
    session: sessionInfo
  };

  if (dryRun || !refundPlan.eligible || !refundPlan.callName) {
    await disconnectCliHubSigner(signer);
    writeOutput(flags, baseOutput, () => printRefundResult(baseOutput));
    return;
  }

  if (!signer) {
    throw new Error("Missing signer for refund submission.");
  }

  try {
    assertSignerMatchesRecipient(signer, ethers.getAddress(session.developer), "refund developer");
    const tx = await submitRegistryCall(flags, signer, provider, registryAddress, refundPlan.callName, [sessionId], confirmations);
    const sessionAfter = sessionOutput(await registry.getSession(sessionId));
    const output = {
      ...baseOutput,
      dryRun: false,
      tx,
      sessionAfter
    };
    writeOutput(flags, output, () => printRefundResult(output));
  } finally {
    await disconnectCliHubSigner(signer);
  }
}

async function projectInitCommand(flags: Map<string, string | boolean>) {
  assertNoRemovedProjectInitFlags(flags);
  const cwd = path.resolve(stringFlag(flags, "project-dir") ?? process.cwd());
  const configPath = switchboardProjectConfigPath(cwd);
  const force = boolFlag(flags, "force");
  if (!force && (await fileExists(configPath))) {
    throw new Error(`${SWITCHBOARD_PROJECT_CONFIG_FILE} already exists. Pass --force to overwrite.`);
  }

  const projectName = stringFlag(flags, "project") ?? stringFlag(flags, "name") ?? path.basename(cwd);
  const endpointHostname = normalizeHostnameForCli(stringFlag(flags, "endpoint") ?? stringFlag(flags, "hostname"));
  const config: SwitchboardProjectConfig = {
    project: projectName,
    context: stringFlag(flags, "context") ?? switchboardContextEnv(),
    endpoint: endpointHostname
      ? {
          id: stringFlag(flags, "endpoint-id") ?? endpointHostname,
          hostname: endpointHostname
        }
      : undefined,
    acurast: {
      project: stringFlag(flags, "acurast-project") ?? projectName,
      network: stringFlag(flags, "acurast-network") ?? "mainnet",
      stageDir: stringFlag(flags, "acurast-stage-dir"),
      entrypoint: stringFlag(flags, "entrypoint")
    },
    deploy: {
      hostname: endpointHostname,
      durationMinutes: numberFlag(flags, "duration-minutes", "SWITCHBOARD_DEPLOY_DURATION_MINUTES", DEFAULT_DEPLOY_DURATION_MINUTES),
      scheduleBufferMinutes: numberFlag(
        flags,
        "schedule-buffer-minutes",
        "SWITCHBOARD_DEPLOY_SCHEDULE_BUFFER_MINUTES",
        DEFAULT_DEPLOY_SCHEDULE_BUFFER_MINUTES
      ),
      operatorId: stringFlag(flags, "operator-id"),
      processor: stringFlag(flags, "processor"),
      paymentMode: stringFlag(flags, "payment-mode") ?? (boolFlag(flags, "quote") ? "quote" : undefined),
      quote: boolFlag(flags, "quote") || undefined
    }
  };
  pruneUndefined(config);

  await mkdir(path.join(cwd, SWITCHBOARD_PROJECT_STATE_DIR), { recursive: true });
  await writeJsonFile(configPath, config);
  await ensureGitignoreEntries(cwd, [SWITCHBOARD_PROJECT_STATE_DIR]);

  const output = {
    ok: true,
    action: "project-init",
    projectRoot: cwd,
    configPath,
    stateDir: path.join(cwd, SWITCHBOARD_PROJECT_STATE_DIR),
    config
  };
  writeOutput(flags, output, () => {
    console.log("Switchboard project initialized");
    console.log(`Project: ${projectName}`);
    console.log(`Config: ${configPath}`);
    console.log(`State: ${path.join(cwd, SWITCHBOARD_PROJECT_STATE_DIR)}`);
    if (config.context) {
      console.log(`Context: ${config.context}`);
    }
    if (endpointHostname) {
      console.log(`Endpoint: ${endpointHostname}`);
    }
  });
}

async function projectShowCommand(flags: Map<string, string | boolean>, runtime: CliRuntime) {
  const output = {
    ok: Boolean(runtime.projectRoot),
    action: "project-show",
    projectRoot: runtime.projectRoot,
    configPath: runtime.projectConfigPath,
    statePath: runtime.projectStatePath,
    config: runtime.projectConfig,
    state: runtime.projectState,
    contextName: runtime.contextName,
    context: sanitizeContextForOutput(runtime.context)
  };
  writeOutput(flags, output, () => {
    if (!runtime.projectRoot) {
      console.log(`No ${projectConfigNamesForMessage()} found from ${process.cwd()} upward.`);
      return;
    }
    console.log(`${SWITCHBOARD_NAME} project`);
    console.log(`Root: ${runtime.projectRoot}`);
    console.log(`Config: ${runtime.projectConfigPath}`);
    console.log(`Project: ${runtime.projectConfig?.project ?? "unknown"}`);
    console.log(`Context: ${runtime.contextName ?? runtime.projectConfig?.context ?? "none"}`);
    const endpoint = runtime.projectConfig?.endpoint?.hostname ?? stringRecordField(runtime.projectState?.latestDeployment, "hostname");
    if (endpoint) {
      console.log(`Endpoint: ${endpoint}`);
    }
    if (runtime.projectState?.latestReport) {
      console.log(`Latest report: ${runtime.projectState.latestReport}`);
    }
  });
}

async function contextListCommand(flags: Map<string, string | boolean>, runtime: CliRuntime) {
  const store = await readContextStore();
  const names = Object.keys(store.contexts ?? {}).sort();
  const output = {
    ok: true,
    action: "context-list",
    current: store.current,
    projectContext: runtime.projectConfig?.context,
    contexts: names.map((name) => ({
      name,
      current: name === store.current,
      project: name === runtime.projectConfig?.context,
      ...sanitizeContextForOutput(store.contexts?.[name])
    }))
  };
  writeOutput(flags, output, () => {
    if (names.length === 0) {
      console.log("No Switchboard contexts configured.");
      console.log("Create one with `switchboard context add <name>` or `switchboard context set <name> --polkadot-address-env POLKADOT_ADDRESS --polkadot-seed-env POLKADOT_SEED`.");
      return;
    }
    for (const item of output.contexts as Array<Record<string, any>>) {
      const marker = item.current ? "*" : item.project ? "+" : " ";
      console.log(`${marker} ${item.name}`);
      if (item.polkadotSigner) {
        console.log(`    payment signer: ${item.polkadotSigner}`);
      }
      if (item.polkadotAddress) {
        console.log(`    payment address: ${item.polkadotAddress}`);
      }
      if (item.polkadotAddressEnv) {
        console.log(`    payment address env: ${item.polkadotAddressEnv}`);
      }
      if (item.operatorId) {
        console.log(`    operator: ${item.operatorId}`);
      }
    }
  });
}

async function contextCurrentCommand(flags: Map<string, string | boolean>, runtime: CliRuntime) {
  const output = {
    ok: Boolean(runtime.contextName),
    action: "context-current",
    name: runtime.contextName,
    source: runtime.projectConfig?.context === runtime.contextName ? "project" : runtime.contextName ? "global" : undefined,
    context: sanitizeContextForOutput(runtime.context),
    contextStorePath: runtime.contextStorePath
  };
  writeOutput(flags, output, () => {
    if (!runtime.contextName) {
      console.log("No Switchboard context selected.");
      return;
    }
    console.log(`Current context: ${runtime.contextName}`);
    console.log(`Source: ${output.source ?? "unknown"}`);
    console.log(`Store: ${runtime.contextStorePath}`);
  });
}

async function contextUseCommand(flags: Map<string, string | boolean>, positionals: string[]) {
  const name = positionals[2] ?? stringFlag(flags, "context");
  if (!name) {
    throw new Error("Missing context name. Use `switchboard context use <name>`.");
  }
  const store = await readContextStore();
  if (!store.contexts?.[name]) {
    throw new Error(`Unknown context "${name}". Create it with \`switchboard context add ${name}\` or \`switchboard context set ${name} ...\`.`);
  }
  store.current = name;
  await writeContextStore(store);
  writeOutput(flags, { ok: true, action: "context-use", current: name, contextStorePath: contextStorePath() }, () => {
    console.log(`Current Switchboard context: ${name}`);
  });
}

async function contextSetCommand(flags: Map<string, string | boolean>, positionals: string[]) {
  assertNoRemovedContextSetFlags(flags);
  const name = positionals[2] ?? stringFlag(flags, "context");
  if (!name) {
    throw new Error("Missing context name. Use `switchboard context set <name> ...`.");
  }
  const store = await readContextStore();
  const existing = stripRemovedContextFields(store.contexts?.[name] ?? {});
  const next: SwitchboardContext = {
    ...existing,
    manifestUrl: stringFlag(flags, "manifest-url") ?? existing.manifestUrl,
    manifestSigner: stringFlag(flags, "manifest-signer") ?? existing.manifestSigner,
    target: stringFlag(flags, "target") ?? existing.target,
    operatorId: stringFlag(flags, "operator-id") ?? existing.operatorId,
    relayUrl: stringFlag(flags, "relay-url") ?? existing.relayUrl,
    paymentMode: stringFlag(flags, "payment-mode") ?? existing.paymentMode,
    acurastNetwork: stringFlag(flags, "acurast-network") ?? existing.acurastNetwork,
    acurastSeedEnv: stringFlag(flags, "acurast-seed-env") ?? existing.acurastSeedEnv,
    acurastAddressEnv: stringFlag(flags, "acurast-address-env") ?? existing.acurastAddressEnv,
    polkadotSigner: stringFlag(flags, "polkadot-signer") ?? (boolFlag(flags, "ledger") ? "ledger" : undefined) ?? existing.polkadotSigner,
    polkadotAddress: stringFlag(flags, "polkadot-address") ?? existing.polkadotAddress,
    polkadotSeedEnv: stringFlag(flags, "polkadot-seed-env") ?? existing.polkadotSeedEnv,
    polkadotAddressEnv: stringFlag(flags, "polkadot-address-env") ?? existing.polkadotAddressEnv,
    polkadotSs58Format: stringFlag(flags, "polkadot-ss58-format") ?? stringFlag(flags, "ss58-format") ?? existing.polkadotSs58Format,
    ledgerMode: stringFlag(flags, "ledger-mode") ?? existing.ledgerMode,
    ledgerTransport: stringFlag(flags, "ledger-transport") ?? existing.ledgerTransport,
    ledgerChain: stringFlag(flags, "ledger-chain") ?? existing.ledgerChain,
    ledgerSlip44: stringFlag(flags, "ledger-slip44") ?? existing.ledgerSlip44,
    ledgerAccount: stringFlag(flags, "ledger-account") ?? existing.ledgerAccount,
    ledgerAddressIndex: stringFlag(flags, "ledger-address-index") ?? existing.ledgerAddressIndex,
    ledgerMetadataChainId: stringFlag(flags, "ledger-metadata-chain-id") ?? existing.ledgerMetadataChainId,
    ledgerMetadataUrl: stringFlag(flags, "ledger-metadata-url") ?? existing.ledgerMetadataUrl,
    developerPrivateKeyEnv: stringFlag(flags, "developer-private-key-env") ?? existing.developerPrivateKeyEnv,
    cloudflareApiTokenEnv: stringFlag(flags, "cloudflare-api-token-env") ?? existing.cloudflareApiTokenEnv
  };
  pruneUndefined(next);
  store.contexts = {
    ...(store.contexts ?? {}),
    [name]: next
  };
  if (boolFlag(flags, "use") || !store.current) {
    store.current = name;
  }
  await writeContextStore(store);
  writeOutput(flags, { ok: true, action: "context-set", name, current: store.current, context: sanitizeContextForOutput(next) }, () => {
    console.log(`Switchboard context saved: ${name}`);
    if (store.current === name) {
      console.log("Current: yes");
    }
  });
}

async function preflightCommand(flags: Map<string, string | boolean>, runtime: CliRuntime) {
  const checks: Array<{ name: string; ok: boolean; detail?: string; required?: boolean }> = [];
  const addCheck = (name: string, ok: boolean, detail?: string, required = true) => {
    checks.push({ name, ok, detail, required });
  };

  const manifestConfig = await resolveCliNetworkConfig(flags).catch((error) => {
    addCheck("network manifest", false, safeErrorMessage(error));
    return undefined;
  });
  if (manifestConfig) {
    addCheck(
      "network manifest",
      true,
      `${manifestConfig.manifestUrl} sequence=${manifestConfig.manifest?.sequence ?? "unknown"} signer=${manifestConfig.signer ?? "unknown"}`
    );
  }

  const target = targetFromFlags(flags, manifestConfig);
  addCheck("target", true, target.name);
  addCheck("registry", Boolean(manifestConfig?.registryAddress), manifestConfig?.registryAddress ?? "missing INGRESS_REGISTRY_ADDRESS");
  addCheck("control plane", Boolean(manifestConfig?.relayUrl), manifestConfig?.relayUrl ?? "missing RELAY_URL");

  if (manifestConfig?.relayUrl) {
    const relayHealth = await checkHttpJson(new URL("/health", manifestConfig.relayUrl).toString());
    addCheck("control plane health", relayHealth.ok, relayHealth.detail);
  }

  if (manifestConfig?.ethRpcUrl) {
    const rpcCheck = await checkEthRpc(manifestConfig.ethRpcUrl, target.expectedChainId);
    addCheck("Hub ETH RPC", rpcCheck.ok, rpcCheck.detail);
  }
  if (manifestConfig?.substrateWsUrl) {
    const wsCheck = await checkSubstrateWs(manifestConfig.substrateWsUrl);
    addCheck("Hub Substrate RPC", wsCheck.ok, wsCheck.detail);
  }

  const acurastSeed = acurastSeedFromRuntime(runtime);
  const acurastSeedCheck = checkMnemonicSeed(
    acurastSeed,
    contextEnvDetail(runtime, "acurastSeedEnv", "ACURAST_MAINNET_SEED or ACURAST_SEED")
  );
  addCheck("Acurast deploy seed", acurastSeedCheck.ok, acurastSeedCheck.detail);
  addCheck(
    "Acurast deploy address",
    Boolean(acurastAddressFromRuntime(runtime)),
    contextEnvDetail(runtime, "acurastAddressEnv", "ACURAST_MAINNET_ADDRESS or ACURAST_ADDRESS"),
    false
  );

  const paymentMode = stringFlag(flags, "payment-mode") === "public-price" ? "public-price" : "quote";
  if (paymentMode === "quote") {
    const signerKind = polkadotSignerKind(flags);
    addCheck("Polkadot payment signer", true, signerKind);
    if (signerKind === "ledger") {
      const ledgerCheck = await checkPolkadotLedger(flags);
      addCheck("Polkadot Ledger", ledgerCheck.ok, ledgerCheck.detail);
      if (ledgerMode(flags) === "generic") {
        addCheck(
          "Ledger metadata chain",
          Boolean(stringFlag(flags, "ledger-metadata-chain-id") ?? optionalEnv("PROOF_LEDGER_METADATA_CHAIN_ID")),
          "PROOF_LEDGER_METADATA_CHAIN_ID or --ledger-metadata-chain-id"
        );
      }
    } else {
      const polkadotSeed = contextEnv(runtime.context?.polkadotSeedEnv) ?? optionalEnv("POLKADOT_SEED");
      const polkadotSeedCheck = checkMnemonicSeed(
        polkadotSeed,
        contextEnvDetail(runtime, "polkadotSeedEnv", "POLKADOT_SEED")
      );
      addCheck("Polkadot payment seed", polkadotSeedCheck.ok, polkadotSeedCheck.detail);
      addCheck("Polkadot payment address", Boolean(polkadotAddressFromRuntime(runtime)), polkadotAddressDetail(runtime), false);
    }
    addCheck(
      "payment asset",
      Boolean(manifestConfig?.defaultAssetAddress ?? optionalEnv("PAYMENT_ASSET_ADDRESS") ?? optionalEnv("PROOF_QUOTE_DEFAULT_ASSET")),
      manifestConfig?.defaultAssetAddress ?? "PAYMENT_ASSET_ADDRESS or PROOF_QUOTE_DEFAULT_ASSET"
    );
  }

  const runner = await deployRunnerAvailable().catch((error) => ({ ok: false, detail: safeErrorMessage(error) }));
  addCheck("deploy runner", runner.ok, runner.detail);

  const output = {
    ok: checks.every((check) => check.ok || check.required === false),
    action: "preflight",
    project: runtime.projectConfig
      ? {
          root: runtime.projectRoot,
          name: runtime.projectConfig.project,
          endpoint: runtime.projectConfig.endpoint,
          latestReport: runtime.projectState?.latestReport
        }
      : undefined,
    context: runtime.contextName,
    manifest: manifestConfig
      ? {
          url: manifestConfig.manifestUrl,
          signer: manifestConfig.signer,
          sequence: manifestConfig.manifest?.sequence,
          expiresAt: manifestConfig.manifest?.expiresAt
        }
      : undefined,
    target: target.name,
    checks
  };
  writeOutput(flags, output, () => printPreflight(output));
}

interface LaunchDemoCapacitySelection {
  operatorId: string;
  gatewayId: string;
  managerId?: string;
  processor: string;
  processorId: string;
  processors: LaunchDemoProcessorSelection[];
  members: LaunchDemoMemberSelection[];
  reportId: string;
  reportExpiresAt: string;
  publicAddresses: string[];
  activeRouteCount: number;
  routeCapacity: number;
  readiness: ProcessorInfo;
}

interface LaunchDemoProcessorSelection {
  processor: string;
  processorId: string;
  readiness: ProcessorInfo;
}

interface LaunchDemoMemberSelection extends LaunchDemoProcessorSelection {
  memberId: string;
  operatorId: string;
  gatewayId: string;
  managerId?: string;
  reportId: string;
  reportExpiresAt: string;
  publicAddresses: string[];
  activeRouteCount: number;
  routeCapacity: number;
  allocation: Record<string, unknown>;
}

type LaunchDemoGatewayCapabilityReport = GatewayCapabilityReport & {
  gateway: GatewayCapabilityReport["gateway"] & {
    routeStateAvailable?: boolean;
  };
};

interface LaunchDemoCapacityReport {
  receivedAt?: string;
  report: LaunchDemoGatewayCapabilityReport;
}

type LaunchDemoQuotePreview =
  | {
      ok: true;
      asset: string;
      amount: string;
      paidSeconds: string;
      formattedAmount: string;
      lineItemSummary?: string;
      preview: Record<string, unknown>;
    }
  | {
      ok: false;
      error: string;
    };

interface LaunchDemoProject {
  dir: string;
  entrypoint: string;
  packageSpec: string;
}

async function launchDemoCommand(flags: Map<string, string | boolean>, runtime: CliRuntime) {
  if (!boolFlag(flags, "dry-run") && !boolFlag(flags, "yes-spend")) {
    const hint = boolFlag(flags, "yes")
      ? "`--yes` no longer authorizes spending for launch-demo; use `--yes-spend`."
      : "Use `switchboard launch-demo --yes-spend` to confirm spend.";
    throw new Error(`Refusing to launch a paid demo without --yes-spend. ${hint}`);
  }
  for (const flag of ["start-delay-ms", "max-allowed-start-delay-ms", "instant-match-start-delay-ms", "execution-ms"]) {
    if (stringFlag(flags, flag)) {
      throw new Error(`switchboard launch-demo uses a fixed 3 minute Acurast start delay; remove --${flag}`);
    }
  }

  const manifestConfig = await resolveCliNetworkConfig(flags);
  const relayUrl =
    stringFlag(flags, "relay-url") ??
    optionalEnv("SWITCHBOARD_LAUNCH_DEMO_RELAY_URL") ??
    manifestConfig.relayUrl ??
    DEFAULT_CONTROL_PLANE_URL;
  const target = targetFromFlags(flags, manifestConfig);
  const acurastNetwork = launchDemoAcurastNetwork(flags);
  const durationMinutes = numberFlag(
    flags,
    "duration-minutes",
    "SWITCHBOARD_LAUNCH_DEMO_DURATION_MINUTES",
    DEFAULT_LAUNCH_DEMO_DURATION_MINUTES
  );
  if (durationMinutes <= 0) {
    throw new Error("duration-minutes must be a positive integer");
  }
  const paidSeconds = String(durationMinutes * 60);
  const requestedProcessorCount = launchDemoProcessorCount(flags);
  const minReadyProcessors = launchDemoMinReady(flags, requestedProcessorCount);
  const scheduleBufferMinutes = DEFAULT_DEPLOY_SCHEDULE_BUFFER_MINUTES;
  const maxCostPerExecution =
    stringFlag(flags, "max-cost-per-execution") ??
    optionalEnv("ACURAST_MAX_COST_PER_EXECUTION") ??
    DEFAULT_LAUNCH_DEMO_MAX_COST_PER_EXECUTION;
  const ingressEstimate = await fetchLaunchDemoQuotePreview({
    relayUrl,
    assetAddress: manifestConfig.defaultAssetAddress,
    paidSeconds,
    manifestConfig,
    timeoutMs: numberFlag(flags, "quote-preview-timeout-ms", "SWITCHBOARD_LAUNCH_DEMO_QUOTE_PREVIEW_TIMEOUT_MS", 15_000)
  });
  if (!boolFlag(flags, "dry-run") && !ingressEstimate.ok) {
    throw new Error(`Ingress quote preview unavailable: ${ingressEstimate.error}`);
  }

  const selection = await selectLaunchDemoCapacity({
    relayUrl,
    network: acurastNetwork,
    durationMinutes,
    scheduleBufferMinutes,
    processorCount: requestedProcessorCount,
    minReady: minReadyProcessors
  });
  const demoProject = await createLaunchDemoProject(flags);

  const childArgs = [
    INTERNAL_DEPLOY_RUNNER_SCRIPT,
    "--",
    "--yes",
    "--relay-url",
    relayUrl,
    "--operator-id",
    selection.operatorId,
    "--dns",
    "--job-acme",
    "--target",
    target.name,
    "--network",
    acurastNetwork,
    "--max-cost-per-execution",
    maxCostPerExecution,
    "--duration-minutes",
    String(durationMinutes),
    "--schedule-buffer-minutes",
    String(scheduleBufferMinutes),
    "--start-delay-ms",
    String(DEFAULT_LAUNCH_DEMO_START_DELAY_MS),
    "--max-allowed-start-delay-ms",
    String(DEFAULT_LAUNCH_DEMO_START_DELAY_MS),
    "--instant-match-start-delay-ms",
    String(DEFAULT_LAUNCH_DEMO_START_DELAY_MS),
    "--route-activation-mode",
    "relay-reconciled",
    "--validator-mode",
    "skip"
  ];
  if (ingressEstimate.ok) {
    childArgs.push("--expected-quote-amount", ingressEstimate.amount);
  }
  if (selection.managerId) {
    childArgs.push("--manager-id", selection.managerId);
  }
  if (boolFlag(flags, "allow-local-relay") || isPrivateOrLocalUrl(relayUrl)) {
    childArgs.push("--allow-local-relay");
  }
  if (boolFlag(flags, "public-probe-insecure")) {
    childArgs.push("--public-probe-insecure");
  }
  const groupDeployEnabled = selection.members.length > 1;
  const childEnv = {
    ...publicDeployRunnerSafetyEnv(),
    OPERATOR_ID: selection.operatorId,
    GATEWAY_ID: selection.gatewayId,
    ACURAST_MANAGER_ID: selection.managerId,
    SWITCHBOARD_DEPLOY_PROCESSOR: selection.processor,
    SWITCHBOARD_DEPLOY_GATEWAY_ID: selection.gatewayId,
    SWITCHBOARD_DEPLOY_CAPABILITY_REPORT_ID: selection.reportId,
    SWITCHBOARD_DEPLOY_CAPABILITY_REPORT_EXPIRES_AT: selection.reportExpiresAt,
    SWITCHBOARD_DEPLOY_OPERATOR_PUBLIC_ADDRESSES: JSON.stringify(selection.publicAddresses),
    ACURAST_INSTANT_MATCH_PROCESSORS: selection.members.map((member) => member.processor).join(","),
    ACURAST_REPLICAS: groupDeployEnabled ? String(selection.members.length) : undefined,
    SWITCHBOARD_DEPLOY_RELAY_URL: relayUrl,
    SWITCHBOARD_DEPLOY_ROUTE_ACTIVATION_MODE: "relay-reconciled",
    SWITCHBOARD_DEPLOY_VALIDATOR_MODE: "skip",
    SWITCHBOARD_DEPLOY_DURATION_MINUTES: String(durationMinutes),
    SWITCHBOARD_DEPLOY_SCHEDULE_BUFFER_MINUTES: String(scheduleBufferMinutes),
    SWITCHBOARD_DEPLOY_GROUP_MODE: groupDeployEnabled ? "true" : undefined,
    SWITCHBOARD_DEPLOY_GROUP_MEMBERS: groupDeployEnabled ? JSON.stringify(selection.members.map(launchDemoMemberEnv)) : undefined,
    SWITCHBOARD_DEPLOY_EXPECTED_REPLICAS: groupDeployEnabled ? String(selection.members.length) : undefined,
    SWITCHBOARD_DEPLOY_MIN_READY: groupDeployEnabled ? String(minReadyProcessors) : undefined,
    SWITCHBOARD_LAUNCH_DEMO: "true",
    ACURAST_MAX_COST_PER_EXECUTION: maxCostPerExecution,
    ACURAST_START_DELAY_MS: String(DEFAULT_LAUNCH_DEMO_START_DELAY_MS),
    ACURAST_EXECUTION_MS: String((durationMinutes + scheduleBufferMinutes) * 60_000),
    ACURAST_MAX_ALLOWED_START_DELAY_MS: String(DEFAULT_LAUNCH_DEMO_START_DELAY_MS),
    ACURAST_INSTANT_MATCH_START_DELAY_MS: String(DEFAULT_LAUNCH_DEMO_START_DELAY_MS),
    ACURAST_ENTRYPOINT: LAUNCH_DEMO_ENTRYPOINT,
    SWITCHBOARD_WORK_DIR: demoProject.dir,
    SWITCHBOARD_TARGET: target.name,
    SWITCHBOARD_OPERATOR_ID: selection.operatorId,
    INGRESS_REGISTRY_ADDRESS: manifestConfig.registryAddress,
    HUB_ETH_RPC_URL: manifestConfig.ethRpcUrl,
    HUB_SUBSTRATE_WS_URL: manifestConfig.substrateWsUrl,
    CHAIN_ID: manifestConfig.chainId,
    RELAY_URL: relayUrl,
    PROOF_CONTROL_PLANE_URL: relayUrl,
    PAYMENT_ASSET_ADDRESS: manifestConfig.defaultAssetAddress,
    PROOF_QUOTE_DEFAULT_ASSET: manifestConfig.defaultAssetAddress,
    SWITCHBOARD_DEPLOY_EXPECTED_QUOTE_AMOUNT: ingressEstimate.ok ? ingressEstimate.amount : undefined,
    SWITCHBOARD_DEPLOY_COLOR: cliColorEnabled(boolFlag(flags, "json") ? process.stderr : process.stdout) ? "1" : undefined
  };

  if (boolFlag(flags, "dry-run")) {
    const output = {
      ok: true,
      action: "launch-demo-dry-run",
      command: SWITCHBOARD_CLI,
      args: ["launch-demo", "--yes-spend"],
      relayUrl,
      target: target.name,
      acurastNetwork,
      durationMinutes,
      processorCount: selection.processors.length,
      minReadyProcessors,
      fixedStartDelayMs: DEFAULT_LAUNCH_DEMO_START_DELAY_MS,
      scheduleBufferMinutes,
      maxCostPerExecution,
      ingressEstimate,
      selection: launchDemoSelectionOutput(selection),
      demoProject,
      env: childEnv,
      note: "No Acurast deployment, Hub transaction, DNS change, or route mutation was attempted."
    };
    writeOutput(flags, output, () => {
      console.log(sectionTitle("Switchboard launch-demo dry run"));
      printOutputRows([
        { label: "Relay", value: relayUrl },
        { label: "Operator", value: formatOperator(selection.operatorId, selection.gatewayId) },
        { label: "Manager", value: selection.managerId ?? "pinned processor" },
        { label: "Processors", value: formatLaunchDemoProcessors(selection) },
        { label: "HA readiness", value: `${selection.processors.length}/${requestedProcessorCount} selected; min ${minReadyProcessors}` },
        { label: "Lease", value: `${durationMinutes}m` },
        { label: "Start delay", value: "3m" },
        { label: "Ingress estimate", value: formatLaunchDemoQuotePreview(ingressEstimate) },
        { label: "Cost cap", value: formatCostCap(maxCostPerExecution) }
      ]);
      if (!ingressEstimate.ok) {
        console.log(statusLine("warn", "Ingress estimate unavailable", firstLine(ingressEstimate.error)));
      }
      console.log(output.note);
    });
    return;
  }

  await installLaunchDemoProject(demoProject, flags);
  const estimate = await estimateLaunchDemoAcurastCost({
    runtime,
    env: childEnv,
    workDir: demoProject.dir
  });
  if (!boolFlag(flags, "json")) {
    printLaunchDemoStart({
      relayUrl,
      target: target.name,
      acurastNetwork,
      durationMinutes,
      scheduleBufferMinutes,
      maxCostPerExecution,
      selection,
      ingressEstimate,
      estimate,
      minReadyProcessors
    });
  }

  const deployRunner = await resolveDeployRunner(childArgs, childEnv, { workDir: demoProject.dir });
  const result = await runDeployRunner(deployRunner.command, deployRunner.args, {
    env: {
      ...contextRuntimeEnv(runtime),
      ...deployRunner.env
    },
    cwd: deployRunner.cwd,
    childStdoutToStderr: boolFlag(flags, "json"),
    action: "launch-demo",
    json: boolFlag(flags, "json")
  });
  const reportPath = parseDeployReportPath(result.stdout, result.stderr);
  const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, any>;
  const output = deployOutput(report, reportPath, {
    action: "launch-demo",
    relayUrl,
    routeActivationMode: "relay-reconciled",
    certificateMode: "job-acme",
    maxCostPerExecution,
    durationMinutes,
    scheduleBufferMinutes,
    selection: launchDemoSelectionOutput(selection),
    ingressEstimate,
    estimate,
    demoProject
  });
  await saveProjectDeployment(runtime, output);

  writeOutput(flags, output, () => printDeployResult(output));
}

async function createLaunchDemoProject(flags: Map<string, string | boolean>): Promise<LaunchDemoProject> {
  const packageSpec =
    stringFlag(flags, "demo-package") ??
    optionalEnv("SWITCHBOARD_LAUNCH_DEMO_PACKAGE_SPEC") ??
    DEFAULT_LAUNCH_DEMO_PACKAGE_SPEC;
  const dir = await mkdtemp(path.join(tmpdir(), "switchboard-launch-demo-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: `switchboard-launch-demo-${Date.now()}`,
        version: "0.0.0",
        private: true,
        type: "module",
        scripts: {
          start: "node --import tsx src/server.ts"
        },
        dependencies: {
          "@proofcomputer/switchboard-express-demo": packageSpec
        },
        devDependencies: {
          "@types/node": "^24.10.1",
          "tsx": "^4.20.6",
          "typescript": "^5.9.3"
        }
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    path.join(dir, LAUNCH_DEMO_ENTRYPOINT),
    `import { startSwitchboardExpressDemo } from "@proofcomputer/switchboard-express-demo";

void startSwitchboardExpressDemo().catch((error) => {
  console.error(error);
  process.exit(1);
});
`
  );
  await writeFile(path.join(dir, ".gitignore"), "node_modules/\ndist/\n.acurast/\n.switchboard/\n.env\n.env.*\n");
  return { dir, entrypoint: LAUNCH_DEMO_ENTRYPOINT, packageSpec };
}

async function installLaunchDemoProject(project: LaunchDemoProject, flags: Map<string, string | boolean>): Promise<void> {
  if (!boolFlag(flags, "json")) {
    console.log(sectionTitle("Demo project"));
    printOutputRows([
      { label: "Project", value: project.dir },
      { label: "Package", value: project.packageSpec }
    ]);
  }
  const install = await runCliChild("npm", ["install", "--fund=false", "--audit=false"], {
    cwd: project.dir,
    env: {
      npm_config_cache: optionalEnv("npm_config_cache") ?? optionalEnv("NPM_CONFIG_CACHE") ?? path.join(tmpdir(), "switchboard-launch-demo-npm-cache")
    },
    stream: !boolFlag(flags, "json")
  });
  if (install.exitCode !== 0) {
    throw new Error(`Failed to install launch-demo project dependencies in ${project.dir}: ${install.stderr || install.stdout}`);
  }
}

function launchDemoAcurastNetwork(flags: Map<string, string | boolean>): AcurastNetwork {
  const network = stringFlag(flags, "network") ?? optionalEnv("ACURAST_NETWORK") ?? "mainnet";
  if (network !== "mainnet" && network !== "canary") {
    throw new Error(`Unsupported Acurast network: ${network}`);
  }
  return network;
}

function launchDemoProcessorCount(flags: Map<string, string | boolean>): number {
  const count = numberFlag(
    flags,
    "processor-count",
    "SWITCHBOARD_LAUNCH_DEMO_PROCESSOR_COUNT",
    boolFlag(flags, "ha") ? 3 : 1
  );
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("processor-count must be a positive integer");
  }
  return count;
}

function launchDemoMinReady(flags: Map<string, string | boolean>, processorCount: number): number {
  const minReady = numberFlag(flags, "min-ready", "SWITCHBOARD_LAUNCH_DEMO_MIN_READY", processorCount);
  if (!Number.isInteger(minReady) || minReady <= 0) {
    throw new Error("min-ready must be a positive integer");
  }
  if (minReady > processorCount) {
    throw new Error("min-ready cannot exceed processor-count");
  }
  return minReady;
}

async function selectLaunchDemoCapacity(input: {
  relayUrl: string;
  network: AcurastNetwork;
  durationMinutes: number;
  scheduleBufferMinutes: number;
  processorCount: number;
  minReady: number;
}): Promise<LaunchDemoCapacitySelection> {
  const reports = await readLaunchDemoCapabilityReports(input.relayUrl);
  const errors: string[] = [];
  const eligibleReports = reports
    .filter((stored) => {
      const reason = launchDemoReportEligibilityReason(stored.report);
      if (reason) {
        errors.push(`${stored.report.operator.gatewayId}: ${reason}`);
        return false;
      }
      return true;
    })
    .sort((left, right) => {
      const capacityDiff = left.report.gateway.activeRouteCount - right.report.gateway.activeRouteCount;
      if (capacityDiff !== 0) return capacityDiff;
      return Date.parse(right.report.reportedAt) - Date.parse(left.report.reportedAt);
    });
  const durationMs = (input.durationMinutes + input.scheduleBufferMinutes) * 60_000;
  const candidates: LaunchDemoMemberSelection[] = [];

  for (const stored of eligibleReports) {
    const report = stored.report;
    const availableRouteSlots = Math.max(0, report.gateway.routeCapacity - report.gateway.activeRouteCount);
    if (availableRouteSlots <= 0) {
      errors.push(`${report.operator.gatewayId}: route capacity exhausted`);
      continue;
    }
    for (const scope of report.processorScopes) {
      if (scope.kind !== "manager" || !scope.managerId) {
        continue;
      }
      try {
        const allowedProcessors = scope.processors ?? scope.includeProcessors ?? [];
        const allowedIds = new Set(
          allowedProcessors.map((value) => processorRefToId(value)).filter((value): value is string => Boolean(value))
        );
        const excludedIds = new Set(
          (scope.excludeProcessors ?? []).map((value) => processorRefToId(value)).filter((value): value is string => Boolean(value))
        );
        const inventory = await discoverManagerProcessors({
          network: input.network,
          managerId: scope.managerId,
          checkAvailability: true,
          startDelayMs: DEFAULT_LAUNCH_DEMO_START_DELAY_MS,
          durationMs,
          processorFilter: (processors) => {
            const allowed = new Set(allowedProcessors);
            return processors.filter((processor) => {
              const processorId = processorRefToId(processor);
              if (processorId && excludedIds.has(processorId)) {
                return false;
              }
              return allowed.size === 0 || allowed.has(processor) || Boolean(processorId && allowedIds.has(processorId));
            });
          }
        });
        const readyProcessors = selectReadyProcessors(inventory.processors, {
          maxAgeSeconds: DEFAULT_LAUNCH_DEMO_PROCESSOR_MAX_AGE_SECONDS,
          requireAvailability: true,
          limit: Math.min(input.processorCount, availableRouteSlots)
        })
          .map((ready) => {
            const processorId = processorRefToId(ready.processor);
            return processorId ? { processor: ready.processor, processorId, readiness: ready } : undefined;
          })
          .filter((value): value is LaunchDemoProcessorSelection => Boolean(value));
        if (readyProcessors.length === 0) {
          errors.push(`${report.operator.gatewayId}/${scope.managerId}: no fresh available processors`);
          continue;
        }
        for (const ready of readyProcessors) {
          const operatorId = report.operator.operatorId.toLowerCase();
          const member: LaunchDemoMemberSelection = {
            memberId: `member-${candidates.length + 1}`,
            operatorId,
            gatewayId: report.operator.gatewayId,
            managerId: scope.managerId,
            processor: ready.processor,
            processorId: ready.processorId,
            readiness: ready.readiness,
            reportId: report.reportId,
            reportExpiresAt: report.expiresAt,
            publicAddresses: report.gateway.publicAddresses,
            activeRouteCount: report.gateway.activeRouteCount,
            routeCapacity: report.gateway.routeCapacity,
            allocation: launchDemoMemberAllocation({
              operatorId,
              gatewayId: report.operator.gatewayId,
              managerId: scope.managerId,
              processor: ready.processor,
              processorId: ready.processorId,
              reportId: report.reportId,
              reportExpiresAt: report.expiresAt,
              publicAddresses: report.gateway.publicAddresses,
              activeRouteCount: report.gateway.activeRouteCount,
              routeCapacity: report.gateway.routeCapacity
            })
          };
          candidates.push(member);
        }
      } catch (error) {
        errors.push(`${report.operator.gatewayId}/${scope.managerId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const distinctEligibleGateways = new Set(candidates.map((candidate) => candidate.gatewayId));
  if (input.processorCount > 1 && distinctEligibleGateways.size < 2) {
    const reason = errors.length > 0 ? ` Checked: ${errors.slice(0, 5).join("; ")}` : "";
    throw new Error(`launch-demo --ha requires at least two eligible gateways; found ${distinctEligibleGateways.size}.${reason}`);
  }

  if (candidates.length < input.processorCount) {
    const reason = errors.length > 0 ? ` Checked: ${errors.slice(0, 5).join("; ")}` : "";
    throw new Error(`Only ${candidates.length}/${input.processorCount} launch-demo processors are currently available from ${input.relayUrl}.${reason}`);
  }

  const selectedMembers = selectLaunchDemoMembers(candidates, input.processorCount);
  const selectedGateways = new Set(selectedMembers.map((member) => member.gatewayId));
  if (input.processorCount > 1 && selectedGateways.size < 2) {
    throw new Error(`launch-demo --ha requires selected members across at least two gateways; selected ${selectedGateways.size}`);
  }
  if (selectedMembers.length < input.minReady) {
    throw new Error(`Only ${selectedMembers.length}/${input.minReady} launch-demo members could be selected`);
  }
  return launchDemoSelectionFromMembers(selectedMembers);
}

async function selectDeployCapacity(input: {
  relayUrl: string;
  operatorId?: string;
  gatewayId?: string;
}): Promise<LaunchDemoCapacitySelection> {
  const requestedOperatorId = input.operatorId?.toLowerCase();
  const reports = await readLaunchDemoCapabilityReports(input.relayUrl);
  const errors: string[] = [];
  const candidates: LaunchDemoMemberSelection[] = [];

  for (const stored of reports) {
    const report = stored.report;
    if (requestedOperatorId && report.operator.operatorId.toLowerCase() !== requestedOperatorId) {
      continue;
    }
    if (input.gatewayId && report.operator.gatewayId !== input.gatewayId) {
      continue;
    }
    const reason = launchDemoReportEligibilityReason(report);
    if (reason) {
      errors.push(`${report.operator.gatewayId}: ${reason}`);
      continue;
    }

    const processors = expandedReportProcessors(report);
    if (processors.length === 0) {
      errors.push(`${report.operator.gatewayId}: no processors in capability report`);
      continue;
    }
    for (const processor of processors) {
      const operatorId = report.operator.operatorId.toLowerCase();
      const processorRef = processor.address ?? processor.processorId;
      candidates.push({
        memberId: `member-${candidates.length + 1}`,
        operatorId,
        gatewayId: report.operator.gatewayId,
        managerId: processor.managerId,
        processor: processorRef,
        processorId: processor.processorId,
        readiness: {
          processor: processorRef,
          heartbeatMs: Date.now(),
          heartbeatIso: new Date().toISOString(),
          heartbeatAgeSeconds: 0,
          version: "capability-report"
        },
        reportId: report.reportId,
        reportExpiresAt: report.expiresAt,
        publicAddresses: report.gateway.publicAddresses,
        activeRouteCount: report.gateway.activeRouteCount,
        routeCapacity: report.gateway.routeCapacity,
        allocation: launchDemoMemberAllocation({
          operatorId,
          gatewayId: report.operator.gatewayId,
          managerId: processor.managerId,
          processor: processorRef,
          processorId: processor.processorId,
          reportId: report.reportId,
          reportExpiresAt: report.expiresAt,
          publicAddresses: report.gateway.publicAddresses,
          activeRouteCount: report.gateway.activeRouteCount,
          routeCapacity: report.gateway.routeCapacity
        })
      });
    }
  }

  candidates.sort(compareLaunchDemoMembers);
  const selected = candidates[0];
  if (!selected) {
    const request = [
      input.operatorId ? `operator ${input.operatorId}` : undefined,
      input.gatewayId ? `gateway ${input.gatewayId}` : undefined
    ].filter(Boolean).join(" and ") || "available operator capacity";
    const checked = errors.length > 0 ? ` Checked: ${errors.slice(0, 5).join("; ")}` : "";
    throw new Error(`No route-state-capable deploy capacity matched ${request}.${checked}`);
  }
  return launchDemoSelectionFromMembers([{ ...selected, memberId: "member-1" }]);
}

export async function selectPinnedDeployCapacity(input: {
  relayUrl: string;
  operatorId: string;
  processor: string;
}): Promise<LaunchDemoCapacitySelection> {
  const requestedOperatorId = input.operatorId.toLowerCase();
  const requestedProcessorId = processorRefToId(input.processor);
  if (!requestedProcessorId) {
    throw new Error(`Cannot normalize pinned processor ${input.processor}; expected a 32-byte hex processor ID or SS58 processor address.`);
  }

  const reports = await readLaunchDemoCapabilityReports(input.relayUrl);
  const errors: string[] = [];
  const candidates: LaunchDemoMemberSelection[] = [];

  for (const stored of reports) {
    const report = stored.report;
    if (report.operator.operatorId.toLowerCase() !== requestedOperatorId) {
      continue;
    }
    const reason = launchDemoReportEligibilityReason(report);
    if (reason) {
      errors.push(`${report.operator.gatewayId}: ${reason}`);
      continue;
    }
    const processor = expandedReportProcessors(report).find((candidate) => candidate.processorId === requestedProcessorId);
    if (!processor) {
      errors.push(`${report.operator.gatewayId}: pinned processor not in capability report`);
      continue;
    }

    const operatorId = report.operator.operatorId.toLowerCase();
    const member: LaunchDemoMemberSelection = {
      memberId: "member-1",
      operatorId,
      gatewayId: report.operator.gatewayId,
      managerId: processor.managerId,
      processor: input.processor,
      processorId: requestedProcessorId,
      readiness: {
        processor: input.processor,
        heartbeatMs: Date.now(),
        heartbeatIso: new Date().toISOString(),
        heartbeatAgeSeconds: 0,
        version: "capability-report"
      },
      reportId: report.reportId,
      reportExpiresAt: report.expiresAt,
      publicAddresses: report.gateway.publicAddresses,
      activeRouteCount: report.gateway.activeRouteCount,
      routeCapacity: report.gateway.routeCapacity,
      allocation: launchDemoMemberAllocation({
        operatorId,
        gatewayId: report.operator.gatewayId,
        managerId: processor.managerId,
        processor: input.processor,
        processorId: requestedProcessorId,
        reportId: report.reportId,
        reportExpiresAt: report.expiresAt,
        publicAddresses: report.gateway.publicAddresses,
        activeRouteCount: report.gateway.activeRouteCount,
        routeCapacity: report.gateway.routeCapacity
      })
    };
    candidates.push(member);
  }

  candidates.sort(compareLaunchDemoMembers);
  const selected = candidates[0];
  if (!selected) {
    const checked = errors.length > 0 ? ` Checked: ${errors.slice(0, 5).join("; ")}` : "";
    throw new Error(
      `No route-state-capable operator capacity matched pinned operator ${input.operatorId} and processor ${input.processor}.${checked}`
    );
  }
  return launchDemoSelectionFromMembers([selected]);
}

export function selectLaunchDemoMembers(candidates: LaunchDemoMemberSelection[], processorCount: number): LaunchDemoMemberSelection[] {
  if (processorCount > 1 && new Set(candidates.map((candidate) => candidate.gatewayId)).size < 2) {
    throw new Error("launch-demo --ha requires at least two eligible gateways");
  }
  const sorted = [...candidates].sort(compareLaunchDemoMembers);
  const selected: LaunchDemoMemberSelection[] = [];
  const selectedKeys = new Set<string>();
  const selectedGateways = new Set<string>();

  for (const candidate of sorted) {
    if (selected.length >= processorCount) break;
    if (selectedGateways.has(candidate.gatewayId)) continue;
    selected.push(candidate);
    selectedKeys.add(launchDemoMemberKey(candidate));
    selectedGateways.add(candidate.gatewayId);
  }

  for (const candidate of sorted) {
    if (selected.length >= processorCount) break;
    const key = launchDemoMemberKey(candidate);
    if (selectedKeys.has(key)) continue;
    selected.push(candidate);
    selectedKeys.add(key);
  }

  return selected.map((member, index) => ({ ...member, memberId: `member-${index + 1}` }));
}

function compareLaunchDemoMembers(left: LaunchDemoMemberSelection, right: LaunchDemoMemberSelection): number {
  const routeDiff = left.activeRouteCount - right.activeRouteCount;
  if (routeDiff !== 0) return routeDiff;
  const capacityDiff = right.routeCapacity - left.routeCapacity;
  if (capacityDiff !== 0) return capacityDiff;
  const leftAge = numberRecordField(left.readiness, "heartbeatAgeSeconds") ?? Number.MAX_SAFE_INTEGER;
  const rightAge = numberRecordField(right.readiness, "heartbeatAgeSeconds") ?? Number.MAX_SAFE_INTEGER;
  if (leftAge !== rightAge) return leftAge - rightAge;
  return left.processor.localeCompare(right.processor);
}

function launchDemoMemberKey(member: LaunchDemoMemberSelection): string {
  return `${member.gatewayId}:${member.processorId}`;
}

function launchDemoMemberAllocation(input: {
  operatorId: string;
  gatewayId: string;
  managerId?: string;
  processor: string;
  processorId: string;
  reportId: string;
  reportExpiresAt: string;
  publicAddresses: string[];
  activeRouteCount: number;
  routeCapacity: number;
}): Record<string, unknown> {
  return {
    mode: "cli-selected-capability",
    operatorId: input.operatorId,
    gatewayId: input.gatewayId,
    processorId: input.processorId,
    processorAddress: input.processor,
    managerId: input.managerId,
    reportId: input.reportId,
    reportExpiresAt: input.reportExpiresAt,
    publicAddresses: input.publicAddresses,
    activeRouteCount: input.activeRouteCount,
    routeCapacity: input.routeCapacity
  };
}

function launchDemoSelectionFromMembers(members: LaunchDemoMemberSelection[]): LaunchDemoCapacitySelection {
  const first = members[0];
  if (!first) {
    throw new Error("No launch-demo members selected");
  }
  return {
    operatorId: first.operatorId,
    gatewayId: first.gatewayId,
    managerId: first.managerId,
    processor: first.processor,
    processorId: first.processorId,
    processors: members.map((member) => ({
      processor: member.processor,
      processorId: member.processorId,
      readiness: member.readiness
    })),
    members,
    reportId: first.reportId,
    reportExpiresAt: first.reportExpiresAt,
    publicAddresses: first.publicAddresses,
    activeRouteCount: first.activeRouteCount,
    routeCapacity: first.routeCapacity,
    readiness: first.readiness
  };
}

async function readLaunchDemoCapabilityReports(relayUrl: string): Promise<LaunchDemoCapacityReport[]> {
  const url = new URL("/v1/operator-capacity", relayUrl);
  url.searchParams.set("activeOnly", "true");
  url.searchParams.set("limit", "100");
  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    },
    signal: AbortSignal.timeout(15_000)
  });
  const body = await response.text();
  const parsed = body ? parseJsonObject(body) : {};
  if (response.status === 404) {
    return readLegacyLaunchDemoCapabilityReports(relayUrl);
  }
  if (!response.ok || parsed?.ok !== true) {
    throw new Error(`Operator capacity lookup failed (${response.status}): ${body}`);
  }
  const values = Array.isArray(parsed.latest) ? parsed.latest : Array.isArray(parsed.reports) ? parsed.reports : [];
  return values.filter(isLaunchDemoCapacityReport);
}

async function readLegacyLaunchDemoCapabilityReports(relayUrl: string): Promise<LaunchDemoCapacityReport[]> {
  const url = new URL("/v1/operator-capabilities", relayUrl);
  url.searchParams.set("activeOnly", "true");
  url.searchParams.set("limit", "100");
  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    },
    signal: AbortSignal.timeout(15_000)
  });
  const body = await response.text();
  const parsed = body ? parseJsonObject(body) : {};
  if (!response.ok || parsed?.ok !== true) {
    if (response.status === 401) {
      throw new Error(
        "Operator capacity lookup failed: this relay does not expose public capacity discovery and its raw operator inventory requires authorization. Upgrade the relay or target capacity explicitly."
      );
    }
    throw new Error(`Operator capacity lookup failed (${response.status}): ${body}`);
  }
  const values = Array.isArray(parsed.latest) ? parsed.latest : Array.isArray(parsed.reports) ? parsed.reports : [];
  return values.filter(isLaunchDemoCapacityReport);
}

function isLaunchDemoCapacityReport(value: unknown): value is LaunchDemoCapacityReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const report = (value as Record<string, unknown>).report;
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return false;
  }
  const gateway = (report as Record<string, unknown>).gateway;
  return Boolean(gateway && typeof gateway === "object" && !Array.isArray(gateway));
}

export function launchDemoReportEligibilityReason(report: GatewayCapabilityReport): string | undefined {
  if (Date.parse(report.expiresAt) <= Date.now()) {
    return "capability report expired";
  }
  const routeStateAvailable = (report.gateway as Record<string, unknown>).routeStateAvailable === true;
  if (!report.gateway.routeStateUrl && !routeStateAvailable) {
    return "route-state polling unavailable";
  }
  if (report.gateway.routeCapacity <= 0) {
    return "route capacity disabled";
  }
  if (report.gateway.activeRouteCount >= report.gateway.routeCapacity) {
    return "route capacity exhausted";
  }
  const classes = report.gateway.supportedClasses ?? [];
  if (classes.length > 0 && !classes.includes("node-webserver")) {
    return "node-webserver class unsupported";
  }
  return undefined;
}

function launchDemoReportHasCapacity(report: GatewayCapabilityReport): boolean {
  return launchDemoReportEligibilityReason(report) === undefined;
}

async function fetchLaunchDemoQuotePreview(input: {
  relayUrl: string;
  assetAddress?: string;
  paidSeconds: string;
  manifestConfig: CliNetworkConfig;
  timeoutMs: number;
}): Promise<LaunchDemoQuotePreview> {
  if (!input.assetAddress) {
    return { ok: false, error: "network manifest did not publish a default funding asset" };
  }

  let asset: string;
  try {
    asset = ethers.getAddress(input.assetAddress);
  } catch (error) {
    return { ok: false, error: `invalid funding asset ${input.assetAddress}: ${safeErrorMessage(error)}` };
  }

  try {
    const response = await fetch(new URL("/v1/quote-preview", input.relayUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        asset,
        paidSeconds: input.paidSeconds
      }),
      signal: AbortSignal.timeout(input.timeoutMs)
    });
    const body = await response.text();
    const parsed = body ? parseJsonObject(body) : undefined;
    if (!response.ok || parsed?.ok !== true) {
      return {
        ok: false,
        error: `${response.status} ${truncateText(body || response.statusText, 300)}`
      };
    }
    const preview = nestedRecord(parsed, "preview");
    const amount = stringRecordField(preview, "amount");
    const previewAsset = stringRecordField(preview, "asset") ?? asset;
    const paidSeconds = stringRecordField(preview, "paidSeconds") ?? input.paidSeconds;
    if (!preview || !amount) {
      return { ok: false, error: "relay quote preview response was missing preview.amount" };
    }
    const lineItemSummary = formatLaunchDemoQuoteLineItems(preview, previewAsset, input.manifestConfig);
    const formattedAmount = formatLaunchDemoQuoteAmount(amount, previewAsset, input.manifestConfig);
    return {
      ok: true,
      asset: previewAsset,
      amount,
      paidSeconds,
      formattedAmount: lineItemSummary ? `${formattedAmount} (${lineItemSummary})` : formattedAmount,
      lineItemSummary,
      preview
    };
  } catch (error) {
    return { ok: false, error: safeErrorMessage(error) };
  }
}

function formatLaunchDemoQuoteAmount(amount: string, assetAddress: string, manifestConfig: CliNetworkConfig): string {
  try {
    const asset = assetDisplayFromManifest(manifestConfig, assetAddress);
    const formatted = formatAssetUnits(BigInt(amount), asset);
    return formatted ?? `${amount} base units`;
  } catch {
    return `${amount} base units`;
  }
}

function assetDisplayFromManifest(manifestConfig: CliNetworkConfig, assetAddress: string): AssetDisplay {
  const normalized = ethers.getAddress(assetAddress);
  const manifestAsset = manifestConfig.manifest?.supportedAssets?.find((item) => item.address.toLowerCase() === normalized.toLowerCase());
  return {
    address: normalized,
    symbol: manifestAsset?.symbol,
    decimals: manifestAsset?.decimals
  };
}

export function formatLaunchDemoQuoteLineItems(
  preview: Record<string, unknown>,
  assetAddress: string,
  manifestConfig: CliNetworkConfig
): string | undefined {
  const lineItems = preview.lineItems;
  if (!Array.isArray(lineItems)) {
    return undefined;
  }
  const asset = assetDisplayFromManifest(manifestConfig, assetAddress);
  const parts: string[] = [];
  for (const rawItem of lineItems) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      continue;
    }
    const item = rawItem as Record<string, unknown>;
    const label = stringRecordField(item, "label") ?? labelFromLineItemCode(stringRecordField(item, "code"));
    const amount = stringRecordField(item, "amount");
    const detail = stringRecordField(item, "detail");
    if (!label) {
      continue;
    }
    if (item.included === true) {
      parts.push(detail ? `${label} ${detail}` : `${label} included`);
      continue;
    }
    if (!amount || amount === "0") {
      continue;
    }
    const formatted = formatAssetUnits(BigInt(amount), asset) ?? `${amount} base units`;
    parts.push(`${label} ${formatted}`);
  }
  return parts.length > 0 ? parts.slice(0, 4).join("; ") : undefined;
}

function labelFromLineItemCode(code: string | undefined): string | undefined {
  switch (code) {
    case "base_route": return "Base route";
    case "setup_reserve": return "Setup reserve";
    case "validation_cap": return "Validation cap";
    case "dns_tls": return "DNS/TLS";
    case "fair_use_bandwidth": return "Fair-use bandwidth";
    default: return undefined;
  }
}

export function formatLaunchDemoQuotePreview(preview: LaunchDemoQuotePreview): string {
  return preview.ok ? preview.formattedAmount : "not available";
}

async function estimateLaunchDemoAcurastCost(input: {
  runtime: CliRuntime;
  env: Record<string, string | undefined>;
  workDir: string;
}): Promise<{ ok: true; summary?: string; output?: unknown } | { ok: false; error: string }> {
  const env = {
    ...contextRuntimeEnv(input.runtime),
    ...input.env
  };
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    const estimateRunner = await resolveLaunchDemoEstimateRunner(env, { workDir: input.workDir });
    result = await runCliChild(estimateRunner.command, estimateRunner.args, {
      env: estimateRunner.env,
      cwd: estimateRunner.cwd,
      stream: false,
      allowFailure: true
    });
  } catch (error) {
    return { ok: false, error: safeErrorMessage(error) };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: [result.stderr, result.stdout].filter((value) => value.trim().length > 0).join("\n").slice(0, 500)
    };
  }
  const parsed = parseJsonObject(result.stdout.trim());
  return {
    ok: true,
    summary: launchDemoEstimateSummary(parsed ?? result.stdout.trim()),
    output: parsed ?? result.stdout.trim()
  };
}

export async function resolveLaunchDemoEstimateRunner(
  env: Record<string, string | undefined>,
  context: { cwd?: string; currentFile?: string; workDir?: string } = {}
): Promise<{ command: string; args: string[]; env: Record<string, string | undefined>; cwd?: string }> {
  const workDir = path.resolve(context.workDir ?? context.cwd ?? process.cwd());
  const cliRoot = cliPackageRoot(context.currentFile);
  if (await repoScriptAvailable("acurast:estimate-express", { ...context, cwd: cliRoot })) {
    return {
      command: "pnpm",
      args: ["--silent", "acurast:estimate-express", "--", "--json"],
      env: {
        ...env,
        SWITCHBOARD_WORK_DIR: workDir
      },
      cwd: cliRoot
    };
  }

  const currentFile = context.currentFile ?? fileURLToPath(import.meta.url);
  const distDir = path.dirname(currentFile);
  const internalDir = path.join(distDir, "internal");
  const assetsDir = path.join(distDir, "..", "assets");
  const acurastExpress = path.join(internalDir, "acurast-express.js");
  await access(acurastExpress).catch(() => {
    throw new Error("launch-demo requires the packaged Acurast estimate runner. Rebuild or reinstall the Switchboard CLI package.");
  });

  const bundleName = packagedJobBundleName(env.ACURAST_ENTRYPOINT);
  return {
    command: process.execPath,
    args: [acurastExpress, "estimate-fee", "--json"],
    env: {
      ...env,
      SWITCHBOARD_WORK_DIR: workDir,
      SWITCHBOARD_INTERNAL_BIN_DIR: internalDir,
      SWITCHBOARD_PACKAGED_ASSETS_DIR: assetsDir,
      SWITCHBOARD_PREBUILT_JOB_BUNDLE: bundleName ? path.join(assetsDir, "jobs", bundleName, "bundle.cjs") : undefined
    }
  };
}

function packagedJobBundleName(entrypoint: string | undefined): "express-webserver" | "validator-job" | undefined {
  if (!entrypoint) {
    return "express-webserver";
  }
  const normalized = entrypoint.replace(/\\/g, "/");
  if (
    normalized === "express-webserver" ||
    normalized === "src/jobs/express-webserver.ts" ||
    normalized.endsWith("/src/jobs/express-webserver.ts")
  ) {
    return "express-webserver";
  }
  if (
    normalized === "validator-job" ||
    normalized === "src/jobs/validator-job.ts" ||
    normalized.endsWith("/src/jobs/validator-job.ts")
  ) {
    return "validator-job";
  }
  return undefined;
}

function launchDemoEstimateSummary(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return typeof value === "string" && value.length > 0 ? truncateText(value, 160) : undefined;
  }
  const record = value as Record<string, unknown>;
  const cost = stringRecordField(record, "cost") ?? stringRecordField(record, "fee") ?? stringRecordField(record, "estimatedFee");
  const currency = stringRecordField(record, "currency") ?? stringRecordField(record, "token");
  return cost ? `${cost}${currency ? ` ${currency}` : ""}` : truncateText(JSON.stringify(record), 160);
}

function launchDemoSelectionOutput(selection: LaunchDemoCapacitySelection): Record<string, unknown> {
  return {
    operatorId: selection.operatorId,
    gatewayId: selection.gatewayId,
    managerId: selection.managerId,
    processor: selection.processor,
    processorId: selection.processorId,
    processors: selection.processors.map((processor) => ({
      processor: processor.processor,
      processorId: processor.processorId,
      heartbeatAgeSeconds: processor.readiness.heartbeatAgeSeconds,
      availability: processor.readiness.availability
    })),
    members: selection.members.map(launchDemoMemberEnv),
    reportId: selection.reportId,
    reportExpiresAt: selection.reportExpiresAt,
    publicAddresses: selection.publicAddresses,
    activeRouteCount: selection.activeRouteCount,
    routeCapacity: selection.routeCapacity,
    processorHeartbeatAgeSeconds: selection.readiness.heartbeatAgeSeconds,
    processorAvailability: selection.readiness.availability
  };
}

function launchDemoMemberEnv(member: LaunchDemoMemberSelection): Record<string, unknown> {
  return {
    memberId: member.memberId,
    operatorId: member.operatorId,
    gatewayId: member.gatewayId,
    managerId: member.managerId,
    processor: member.processor,
    processorId: member.processorId,
    reportId: member.reportId,
    reportExpiresAt: member.reportExpiresAt,
    publicAddresses: member.publicAddresses,
    activeRouteCount: member.activeRouteCount,
    routeCapacity: member.routeCapacity,
    heartbeatAgeSeconds: member.readiness.heartbeatAgeSeconds,
    availability: member.readiness.availability,
    allocation: member.allocation
  };
}

function formatLaunchDemoProcessors(selection: LaunchDemoCapacitySelection): string {
  if (selection.processors.length === 1) {
    return compactId(selection.processor);
  }
  return selection.processors.map((processor) => compactId(processor.processor)).join(", ");
}

function deployGatewayOverride(flags: Map<string, string | boolean>): string | undefined {
  return (
    stringFlag(flags, "gateway-id") ??
    optionalEnv("SWITCHBOARD_DEPLOY_GATEWAY_ID") ??
    optionalEnv("SWITCHBOARD_GATEWAY_ID") ??
    optionalEnv("GATEWAY_ID")
  );
}

async function deployCommand(flags: Map<string, string | boolean>, runtime: CliRuntime) {
  if (!boolFlag(flags, "yes") && optionalEnv("SWITCHBOARD_ASSUME_YES") !== "true" && optionalEnv("SWITCHBOARD_DEPLOY_ASSUME_YES") !== "true") {
    throw new Error("Refusing to run deployment without --yes");
  }
  if (!stringFlag(flags, "entrypoint") && !optionalEnv("ACURAST_ENTRYPOINT")) {
    throw new Error(
      "switchboard deploy is for project workloads. The bundled demo moved to `switchboard launch-demo --yes-spend`; configure acurast.entrypoint in switchboard.json or pass --entrypoint for project deploys."
    );
  }

  const manifestConfig = await resolveCliNetworkConfig(flags);
  for (const flag of ["hostname", "hostname-suffix", "hostname-suffixes", "domain-pool", "validation-hostname", "certificate-hostnames"]) {
    if (stringFlag(flags, flag)) {
      throw new Error("Canonical deploy hostnames are relay-allocated; use `switchboard hostname add` for customer domains after deploy.");
    }
  }
  const relayUrl =
    stringFlag(flags, "relay-url") ??
    optionalEnv("SWITCHBOARD_DEPLOY_RELAY_URL") ??
    optionalEnv("RELAY_URL") ??
    manifestConfig.relayUrl ??
    DEFAULT_CONTROL_PLANE_URL;
  const durationMinutes = deployDurationMinutes(flags);
  const scheduleBufferMinutes = numberFlag(
    flags,
    "schedule-buffer-minutes",
    "SWITCHBOARD_DEPLOY_SCHEDULE_BUFFER_MINUTES",
    DEFAULT_DEPLOY_SCHEDULE_BUFFER_MINUTES
  );
  if (scheduleBufferMinutes < 0) {
    throw new Error("schedule-buffer-minutes must be a non-negative integer");
  }
  const explicitOperatorId = stringFlag(flags, "operator-id") ?? optionalEnv("SWITCHBOARD_OPERATOR_ID") ?? optionalEnv("OPERATOR_ID");
  const explicitProcessor = stringFlag(flags, "processor") ?? optionalEnv("SWITCHBOARD_DEPLOY_PROCESSOR");
  const explicitGatewayId = deployGatewayOverride(flags);
  const routeActivationMode = "relay-reconciled";
  const shouldSelectPinnedCapacity =
    routeActivationMode === "relay-reconciled" &&
    Boolean(explicitOperatorId) &&
    Boolean(explicitProcessor) &&
    !explicitGatewayId;
  let selection: LaunchDemoCapacitySelection | undefined;
  if (shouldSelectPinnedCapacity && explicitOperatorId && explicitProcessor) {
    selection = await selectPinnedDeployCapacity({
      relayUrl,
      operatorId: explicitOperatorId,
      processor: explicitProcessor
    });
  } else if (routeActivationMode === "relay-reconciled" && explicitOperatorId && !explicitGatewayId) {
    selection = await selectDeployCapacity({
      relayUrl,
      operatorId: explicitOperatorId
    });
  } else if (routeActivationMode === "relay-reconciled" && explicitGatewayId && !explicitOperatorId) {
    selection = await selectDeployCapacity({
      relayUrl,
      gatewayId: explicitGatewayId
    });
  } else if (!explicitOperatorId) {
    selection = await selectLaunchDemoCapacity({
        relayUrl,
        network: stringFlag(flags, "network") === "canary" ? "canary" : "mainnet",
        durationMinutes,
        scheduleBufferMinutes,
        processorCount: 1,
        minReady: 1
    });
  }
  const operatorId = explicitOperatorId ?? selection?.operatorId;
  if (!operatorId) {
    throw new Error("No operator capacity is currently available; pass --operator-id to target a specific operator.");
  }
  const maxCostPerExecution =
    stringFlag(flags, "max-cost-per-execution") ?? optionalEnv("ACURAST_MAX_COST_PER_EXECUTION") ?? DEFAULT_MAX_COST_PER_EXECUTION;
  const certificateMode = stringFlag(flags, "certificate-mode") ?? (boolFlag(flags, "self-signed") ? "self-signed" : "job-acme");
  const selectedGatewayId = explicitGatewayId ?? selection?.gatewayId;
  if (routeActivationMode === "relay-reconciled" && !selectedGatewayId) {
    throw new Error(
      "Relay-reconciled deploys require a route-state-capable gateway allocation; pass --gateway-id or use operator capacity with route-state polling."
    );
  }

  const childArgs = [INTERNAL_DEPLOY_RUNNER_SCRIPT, "--", "--yes", "--relay-url", relayUrl, "--operator-id", operatorId];
  if (!boolFlag(flags, "no-dns")) {
    childArgs.push("--dns");
  }
  if (certificateMode === "job-acme") {
    childArgs.push("--job-acme");
  } else if (certificateMode === "self-signed") {
    childArgs.push("--certificate-mode", "self-signed");
  } else {
    throw new Error(`Unsupported certificate mode: ${certificateMode}`);
  }
  if (boolFlag(flags, "allow-local-relay") || isPrivateOrLocalUrl(relayUrl)) {
    childArgs.push("--allow-local-relay");
  }

  appendForwardedStringFlags(childArgs, flags, [
    "gateway-id",
    "manager-id",
    "payment-amount",
    "lease-seconds",
    "execution-ms",
    "start-delay-ms",
    "max-allowed-start-delay-ms",
    "instant-match-start-delay-ms",
    "run-id",
    "run-dir",
    "port",
    "target",
    "public-probe-mode",
    "network",
    "curl-doh-url",
    "dns-ttl",
    "dns-wait-timeout-ms"
  ]);
  if (selection?.managerId && !stringFlag(flags, "manager-id")) {
    childArgs.push("--manager-id", selection.managerId);
  }
  childArgs.push("--max-cost-per-execution", maxCostPerExecution);
  childArgs.push("--duration-minutes", String(durationMinutes));
  childArgs.push("--schedule-buffer-minutes", String(scheduleBufferMinutes));
  childArgs.push("--route-activation-mode", routeActivationMode);
  childArgs.push("--validator-mode", "skip");
  if (boolFlag(flags, "dns-proxied")) {
    childArgs.push("--dns-proxied");
  }
  if (boolFlag(flags, "public-probe-insecure")) {
    childArgs.push("--public-probe-insecure");
  }
  if (boolFlag(flags, "quote")) {
    childArgs.push("--quote");
  }
  appendForwardedStringFlags(childArgs, flags, ["payment-mode"]);

  const childEnv = {
    ...publicDeployRunnerSafetyEnv(),
    OPERATOR_ID: operatorId,
    GATEWAY_ID: selectedGatewayId,
    SWITCHBOARD_DEPLOY_RELAY_URL: relayUrl,
    SWITCHBOARD_DEPLOY_GATEWAY_ID: selectedGatewayId,
    SWITCHBOARD_DEPLOY_CAPABILITY_REPORT_ID: selection?.reportId,
    SWITCHBOARD_DEPLOY_CAPABILITY_REPORT_EXPIRES_AT: selection?.reportExpiresAt,
    SWITCHBOARD_DEPLOY_OPERATOR_PUBLIC_ADDRESSES: selection ? JSON.stringify(selection.publicAddresses) : undefined,
    SWITCHBOARD_DEPLOY_ROUTE_ACTIVATION_MODE: routeActivationMode,
    SWITCHBOARD_DEPLOY_VALIDATOR_MODE: "skip",
    SWITCHBOARD_DEPLOY_DURATION_MINUTES: String(durationMinutes),
    SWITCHBOARD_DEPLOY_SCHEDULE_BUFFER_MINUTES: String(scheduleBufferMinutes),
    ACURAST_MAX_COST_PER_EXECUTION: maxCostPerExecution,
    SWITCHBOARD_TARGET: targetFromFlags(flags, manifestConfig).name,
    SWITCHBOARD_OPERATOR_ID: operatorId,
    INGRESS_REGISTRY_ADDRESS: manifestConfig.registryAddress,
    HUB_ETH_RPC_URL: manifestConfig.ethRpcUrl,
    HUB_SUBSTRATE_WS_URL: manifestConfig.substrateWsUrl,
    CHAIN_ID: manifestConfig.chainId,
    RELAY_URL: relayUrl,
    PROOF_CONTROL_PLANE_URL: relayUrl,
    PAYMENT_ASSET_ADDRESS: manifestConfig.defaultAssetAddress,
    PROOF_QUOTE_DEFAULT_ASSET: manifestConfig.defaultAssetAddress,
    ACURAST_ENTRYPOINT: stringFlag(flags, "entrypoint") ?? optionalEnv("ACURAST_ENTRYPOINT"),
    SWITCHBOARD_DEPLOY_PROCESSOR: explicitProcessor ?? selection?.processor,
    ACURAST_INSTANT_MATCH_PROCESSORS: explicitProcessor ?? optionalEnv("ACURAST_INSTANT_MATCH_PROCESSORS") ?? selection?.processor,
    ACURAST_MANAGER_ID: stringFlag(flags, "manager-id") ?? optionalEnv("ACURAST_MANAGER_ID") ?? selection?.managerId
  };
  if (boolFlag(flags, "dry-run")) {
    const output = {
      ok: true,
      action: "deploy-dry-run",
      command: SWITCHBOARD_CLI,
      args: ["deploy", "--yes"],
      env: childEnv,
      manifest: {
        url: manifestConfig.manifestUrl,
        signer: manifestConfig.signer,
        sequence: manifestConfig.manifest?.sequence,
        expiresAt: manifestConfig.manifest?.expiresAt
      },
      note: "No Acurast deployment, Hub transaction, DNS change, or route mutation was attempted."
    };
    writeOutput(flags, output, () => {
      console.log(sectionTitle("Switchboard deploy dry run"));
      printOutputRows([
        { label: "Command", value: `${SWITCHBOARD_CLI} deploy --yes` },
        { label: "Relay", value: relayUrl },
        { label: "Operator", value: selection ? formatOperator(selection.operatorId, selection.gatewayId) : compactId(operatorId) },
        { label: "Processor", value: childEnv.SWITCHBOARD_DEPLOY_PROCESSOR ? compactId(childEnv.SWITCHBOARD_DEPLOY_PROCESSOR) : "auto" },
        { label: "Lease", value: `${durationMinutes}m` },
        { label: "Runtime", value: `${durationMinutes + scheduleBufferMinutes}m` },
        { label: "Route", value: routeActivationMode }
      ]);
      console.log(output.note);
    });
    return;
  }

  const deployRunner = await resolveDeployRunner(childArgs, childEnv);
  if (!boolFlag(flags, "json")) {
    printProjectDeployStart({
      relayUrl,
      target: targetFromFlags(flags, manifestConfig).name,
      operatorId,
      processor: childEnv.SWITCHBOARD_DEPLOY_PROCESSOR,
      durationMinutes,
      scheduleBufferMinutes,
      maxCostPerExecution,
      routeActivationMode,
      certificateMode
    });
  }
  const result = await runDeployRunner(deployRunner.command, deployRunner.args, {
    env: {
      ...contextRuntimeEnv(runtime),
      ...deployRunner.env
    },
    childStdoutToStderr: boolFlag(flags, "json"),
    action: "deploy",
    json: boolFlag(flags, "json")
  });
  const reportPath = parseDeployReportPath(result.stdout, result.stderr);
  const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, any>;
  const output = deployOutput(report, reportPath, {
    relayUrl,
    routeActivationMode,
    certificateMode,
    maxCostPerExecution,
    durationMinutes,
    scheduleBufferMinutes
  });
  await saveProjectDeployment(runtime, output);

  writeOutput(flags, output, () => printDeployResult(output));
}

async function validatorLaunchCommand(flags: Map<string, string | boolean>, runtime: CliRuntime) {
  if (!boolFlag(flags, "yes") && optionalEnv("SWITCHBOARD_ASSUME_YES") !== "true") {
    throw new Error("Refusing to launch validator without --yes");
  }
  const manifestConfig = await resolveCliNetworkConfig(flags);
  const relayUrl = stringFlag(flags, "relay-url") ?? manifestConfig.relayUrl ?? DEFAULT_CONTROL_PLANE_URL;
  const seed = stringFlag(flags, "deployer-seed") ?? optionalEnv("ACURAST_MAINNET_SEED") ?? optionalEnv("PROOF_ACURAST_MAINNET_DEPLOYER_SEED");
  if (!seed) {
    throw new Error("Missing --deployer-seed or ACURAST_MAINNET_SEED/PROOF_ACURAST_MAINNET_DEPLOYER_SEED");
  }
  const ss58Format = numberFlag(flags, "ss58-format", "VALIDATOR_REPORT_SS58_FORMAT", 42);
  const deployer = await accountFromUri(seed, ss58Format);
  const intentPayload = {
    deployerAddress: deployer.address,
    requestedCount: numberFlag(flags, "count", "PROOF_VALIDATOR_LAUNCH_COUNT", 1),
    targetNetwork: stringFlag(flags, "acurast-network") ?? runtime.context?.acurastNetwork ?? "mainnet",
    nonce: randomNonce(),
    deadline: String(Math.floor(Date.now() / 1000) + 300)
  };
  const intent = await postSignedJson(new URL("/v1/validator-launch-intents", relayUrl).toString(), intentPayload, {
    domain: "switchboard.validator-launch-intent.v1",
    seed,
    ss58Format
  });
  const intentRecord = intent as Record<string, any>;
  const scriptIpfs = stringRecordField(intentRecord, "validatorScriptIpfs") ?? manifestConfig.manifest?.validators?.launch?.scriptIpfs;
  if (!scriptIpfs) {
    throw new Error("Control plane did not return a validator script IPFS URI");
  }
  const enrollmentMnemonic = mnemonicGenerate(12);
  const enrollmentAccount = await accountFromUri(enrollmentMnemonic, ss58Format);
  const enrollmentPubkey = enrollmentAccount.address;

  if (boolFlag(flags, "dry-run")) {
    writeOutput(flags, { ok: true, intent, scriptIpfs, enrollmentPubkey }, () => {
      console.log("Validator launch dry run");
      console.log(`Intent: ${stringRecordField(intentRecord, "intentId")}`);
      console.log(`Script: ${scriptIpfs}`);
      console.log(`Enrollment pubkey: ${enrollmentPubkey}`);
    });
    return;
  }

  const deployRunner = await resolveAcurastDirectDeployRunner(["--script-ipfs", scriptIpfs], {
    ...contextRuntimeEnv(runtime),
    ACURAST_MAINNET_SEED: seed,
    ACURAST_SCRIPT_IPFS: scriptIpfs,
    ACURAST_ENTRYPOINT: "validator-job",
    PROOF_CONTROL_PLANE_URL: relayUrl,
    PROOF_VALIDATOR_LAUNCH_INTENT_ID: stringRecordField(intentRecord, "intentId"),
    PROOF_VALIDATOR_DEPLOYER_ADDRESS: deployer.address,
    VALIDATOR_ENROLLMENT_SEED: enrollmentMnemonic,
    VALIDATOR_WORK_MODE: "poll",
    VALIDATOR_WORK_POLL: "true"
  });
  const deployResult = await runCliChild(deployRunner.command, deployRunner.args, {
    env: {
      ...deployRunner.env
    },
    childStdoutToStderr: boolFlag(flags, "json")
  });
  const deploymentId = `${deployResult.stdout}\n${deployResult.stderr}`.match(/deploymentId=([A-Za-z0-9:_-]+)/)?.[1];
  if (!deploymentId) {
    throw new Error("Acurast deployment completed but did not print deploymentId=<id>");
  }

  const registrationPayload = {
    deployerAddress: deployer.address,
    acurastJobId: JSON.stringify([{ acurast: deployer.address }, deploymentId]),
    acurastDeploymentId: deploymentId,
    scriptIpfs,
    scriptHash: stringRecordField(intentRecord, "validatorScriptHash"),
    enrollmentPubkey,
    nonce: randomNonce(),
    deadline: String(Math.floor(Date.now() / 1000) + 300)
  };
  const registered = await postSignedJson(
    new URL(`/v1/validator-launch-intents/${encodeURIComponent(requiredStringRecordField(intentRecord, "intentId"))}/deployment`, relayUrl).toString(),
    registrationPayload,
    {
      domain: "switchboard.validator-deployment-registration.v1",
      seed,
      ss58Format
    }
  );
  writeOutput(flags, { ok: true, intent, deploymentId, registered, enrollmentPubkey }, () => {
    console.log("Validator launch registered");
    console.log(`Intent: ${requiredStringRecordField(intentRecord, "intentId")}`);
    console.log(`Deployment: ${deploymentId}`);
    console.log(`Script: ${scriptIpfs}`);
    console.log(`Enrollment pubkey: ${enrollmentPubkey}`);
  });
}

async function deploymentStatusCommand(flags: Map<string, string | boolean>) {
  const reportPath = deploymentReportPath(flags);
  const report = reportPath ? (JSON.parse(await readFile(reportPath, "utf8")) as Record<string, any>) : undefined;
  const manifestConfig = await resolveCliNetworkConfig(flags);
  const target = targetFromFlags(flags, manifestConfig);
  const ethRpcUrl = manifestConfig.ethRpcUrl ?? target.defaultEthRpcUrl;
  const registryAddress = ethers.getAddress(manifestConfig.registryAddress ?? requiredStringFlag(flags, "registry", "INGRESS_REGISTRY_ADDRESS"));
  const sessionId = stringFlag(flags, "session-id") ?? stringRecordField(report?.session, "sessionId");
  if (!sessionId) {
    throw new Error("Missing --session-id or --report");
  }

  const reportHostnames = deploymentReportHostnames(report);
  const hostname = stringFlag(flags, "hostname") ?? reportHostnames.public ?? stringRecordField(report?.session, "hostname");
  const validationHostname =
    stringFlag(flags, "validation-hostname") ??
    reportHostnames.validation ??
    stringRecordField(report?.session, "validationHostname");
  const relayUrl = stringFlag(flags, "relay-url") ?? stringRecordField(report?.relay, "url") ?? optionalEnv("RELAY_URL");

  const provider = new ethers.JsonRpcProvider(ethRpcUrl);
  const network = await provider.getNetwork();
  if (target.expectedChainId && network.chainId !== target.expectedChainId) {
    throw new Error(`Connected to chain ID ${network.chainId.toString()}, but ${target.name} expects ${target.expectedChainId.toString()}`);
  }
  const registry = new ethers.Contract(registryAddress, INGRESS_REGISTRY_NATIVE_PAYMENT_ABI, provider);
  const session = sessionOutput(await registry.getSession(sessionId));

  const deploymentIntentStatus = relayUrl
    ? await readDeploymentIntentStatusFromReport(relayUrl, report).catch((error) => ({
        ok: false,
        error: safeErrorMessage(error)
      }))
    : undefined;
  const deploymentIntent = nestedRecord(deploymentIntentStatus, "intent");
  const route = nestedRecord(deploymentIntent, "route");
  const dnsMaterialization = deploymentIntentDnsMaterialization(report, deploymentIntent);
  const dnsMaterializationStatus = stringRecordField(dnsMaterialization, "status");
  const dnsReadyForPublicChecks = !dnsMaterializationStatus || dnsMaterializationStatus === "propagated";
  const publicChecks = hostname && dnsReadyForPublicChecks ? await runDeploymentPublicChecks(hostname, sessionId) : undefined;
  const controlPlaneValidation =
    relayUrl && hostname
      ? await readControlPlaneValidationReports(relayUrl, { sessionId, hostname }).catch((error) => ({
          ok: false,
          error: safeErrorMessage(error)
        }))
      : undefined;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const routeActive = isRouteActive(route, nowSeconds);
  const validationOk = publicChecks?.validationReport?.success === true;
  const latestValidatorReport = controlPlaneLatestValidationReport(controlPlaneValidation);
  const controlPlaneValidationOk = latestValidatorReport?.success === true;
  const hubRegistered = session.registered === true;
  const hubFunded = session.developer.toLowerCase() !== ethers.ZeroAddress.toLowerCase();
  const publicOk = Boolean(publicChecks?.health.ok && publicChecks.challenge.ok && publicChecks.demoStatus.ok && publicChecks.page.ok);
  const lifecycle = deploymentLifecycleStatus({
    report,
    session,
    route,
    nowSeconds
  });
  const lifecycleOk =
    lifecycle.hubExpired !== true &&
    lifecycle.scheduleEnded !== true &&
    lifecycle.scheduleCoversHubLease !== false &&
    lifecycle.scheduleCoversRoute !== false;
  const overallOk =
    hubFunded &&
    hubRegistered &&
    routeActive &&
    validationOk &&
    publicOk &&
    lifecycleOk;

  const output = {
    ok: overallOk,
    action: "deployment-status",
    target: target.name,
    chainId: network.chainId.toString(),
    registryAddress,
    reportPath,
    hostname,
    validationHostname,
    hostnames: {
      public: hostname,
      validation: validationHostname
    },
    url: hostname ? `https://${hostname}/` : undefined,
    sessionId,
    deploymentId: stringRecordField(report?.deployment, "deploymentId"),
    jobSigner: stringRecordField(report?.session, "jobSigner"),
    processor: stringRecordField(report?.session, "processor"),
    processorId: stringRecordField(report?.session, "processorId"),
    hub: {
      ok: hubFunded && hubRegistered,
      funded: hubFunded,
      registered: hubRegistered,
      expiresAt: session.expiresAt,
      expiresAtIso: secondsToIso(session.expiresAt),
      session
    },
    gateway: {
      ok: routeActive,
      route,
      source: "deployment-intent"
    },
    dnsMaterialization,
    controlPlaneValidation,
    fulfillment: {
      ok: controlPlaneValidationOk,
      required: false,
      latestValidatorReport
    },
    lifecycle,
    validation: publicChecks?.validationReport,
    public: publicChecks,
    recommendation: deploymentStatusRecommendation({
      hubFunded,
      hubRegistered,
      hubExpired: lifecycle.hubExpired === true,
      scheduleEnded: lifecycle.scheduleEnded === true,
      scheduleCoversHubLease:
        typeof lifecycle.scheduleCoversHubLease === "boolean" ? lifecycle.scheduleCoversHubLease : undefined,
      scheduleCoversRoute: typeof lifecycle.scheduleCoversRoute === "boolean" ? lifecycle.scheduleCoversRoute : undefined,
      routeActive,
      validationOk,
      controlPlaneValidationOk,
      dnsMaterializationStatus,
      publicOk,
      hasReport: Boolean(report),
      hasHostname: Boolean(hostname)
    })
  };

  writeOutput(flags, output, () => printDeploymentStatus(output));
}

async function hostnameAttachCommand(flags: Map<string, string | boolean>, positionals: string[]) {
  const reportPath = deploymentReportPath(flags);
  const report = reportPath ? (JSON.parse(await readFile(reportPath, "utf8")) as Record<string, any>) : undefined;
  const manifestConfig = await resolveCliNetworkConfig(flags);
  const relayUrl = stringFlag(flags, "relay-url") ?? stringRecordField(report?.relay, "url") ?? manifestConfig.relayUrl ?? optionalEnv("RELAY_URL") ?? DEFAULT_CONTROL_PLANE_URL;
  const target = targetFromFlags(flags, manifestConfig);
  const registryAddress = ethers.getAddress(manifestConfig.registryAddress ?? requiredStringFlag(flags, "registry", "INGRESS_REGISTRY_ADDRESS"));
  const chainId = BigInt(stringFlag(flags, "chain-id") ?? manifestConfig.chainId ?? optionalEnv("CHAIN_ID") ?? target.expectedChainId?.toString() ?? "0");
  if (chainId === 0n) {
    throw new Error("Missing --chain-id, CHAIN_ID, or a target with an expected chain ID");
  }

  const reportHostnames = deploymentReportHostnames(report);
  const endpointHostname = normalizeHostnameForCli(
    stringFlag(flags, "endpoint") ??
      stringFlag(flags, "endpoint-hostname") ??
      reportHostnames.public ??
      stringRecordField(report?.session, "hostname") ??
      optionalEnv("ENDPOINT_HOSTNAME")
  );
  const customerHostname = normalizeHostnameForCli(
    stringFlag(flags, "customer-hostname") ?? positionalAfterCommand(positionals) ?? optionalEnv("CUSTOMER_HOSTNAME")
  );
  const sessionId = stringFlag(flags, "session-id") ?? stringRecordField(report?.session, "sessionId") ?? optionalEnv("SESSION_ID");
  if (!endpointHostname) {
    throw new Error("Missing --endpoint, --endpoint-hostname, ENDPOINT_HOSTNAME, or --report");
  }
  if (!customerHostname) {
    throw new Error("Missing customer hostname. Use `switchboard hostname add app.example.com` from a project directory, or pass --report <report>.");
  }
  if (!sessionId) {
    throw new Error("Missing --session-id, SESSION_ID, or --report");
  }

  const endpointId = normalizeEndpointIdForCli(stringFlag(flags, "endpoint-id") ?? endpointHostname);
  const tlsMode = customerHostnameTlsModeForCli(flags);
  const certificateValidationMode = customerHostnameCertificateValidationModeForCli(flags);
  const deadline = stringFlag(flags, "deadline") ?? String(Math.floor(Date.now() / 1000) + 600);
  const nonce = stringFlag(flags, "nonce") ?? randomUint256String();
  const attachment = normalizeCustomerHostnameAttachment({
    action: "attachCustomerHostname",
    endpointId,
    endpointHostname,
    customerHostname,
    sessionId,
    nonce,
    deadline
  });
  const dnsProviderHint = lookupDnsProviderHintForCli(customerHostname);
  const signer = await resolveCustomerHostnameSigner(flags, manifestConfig, target, reportSessionDeveloper(report));
  try {
    const signature = await signCustomerHostnameAttachmentForCli(signer, chainId, registryAddress, attachment);
    const response = await postCustomerHostnameAttachment(relayUrl, endpointId, {
      ...attachment,
      tlsMode,
      certificateValidationMode,
      ...signature,
      source: {
        cli: "switchboard hostname add",
        reportPath
      }
    });
    const waitSeconds = numberFlag(flags, "wait-seconds", "PROOF_CUSTOMER_HOSTNAME_WAIT_SECONDS", boolFlag(flags, "wait") ? 300 : 0);
    const output =
      waitSeconds > 0
        ? await waitForCustomerHostname(relayUrl, endpointId, customerHostname, waitSeconds, numberFlag(flags, "poll-seconds", "PROOF_CUSTOMER_HOSTNAME_POLL_SECONDS", 10))
        : response;
    const enrichedOutput = {
      ...output,
      signer: signerOutput(signer),
      dnsProviderHint: await dnsProviderHint
    };

    writeOutput(flags, enrichedOutput, () => printCustomerHostnameResult("attach", enrichedOutput));
  } finally {
    await disconnectCliHubSigner(signer);
  }
}

async function hostnameRemoveCommand(flags: Map<string, string | boolean>, positionals: string[]) {
  const reportPath = deploymentReportPath(flags);
  const report = reportPath ? (JSON.parse(await readFile(reportPath, "utf8")) as Record<string, any>) : undefined;
  const manifestConfig = await resolveCliNetworkConfig(flags);
  const relayUrl = stringFlag(flags, "relay-url") ?? stringRecordField(report?.relay, "url") ?? manifestConfig.relayUrl ?? optionalEnv("RELAY_URL") ?? DEFAULT_CONTROL_PLANE_URL;
  const target = targetFromFlags(flags, manifestConfig);
  const registryAddress = ethers.getAddress(manifestConfig.registryAddress ?? requiredStringFlag(flags, "registry", "INGRESS_REGISTRY_ADDRESS"));
  const chainId = BigInt(stringFlag(flags, "chain-id") ?? manifestConfig.chainId ?? optionalEnv("CHAIN_ID") ?? target.expectedChainId?.toString() ?? "0");
  if (chainId === 0n) {
    throw new Error("Missing --chain-id, CHAIN_ID, or a target with an expected chain ID");
  }

  const reportHostnames = deploymentReportHostnames(report);
  const endpointHostname = normalizeHostnameForCli(
    stringFlag(flags, "endpoint") ??
      stringFlag(flags, "endpoint-hostname") ??
      reportHostnames.public ??
      stringRecordField(report?.session, "hostname") ??
      optionalEnv("ENDPOINT_HOSTNAME")
  );
  const customerHostname = normalizeHostnameForCli(
    stringFlag(flags, "customer-hostname") ?? positionalAfterCommand(positionals) ?? optionalEnv("CUSTOMER_HOSTNAME")
  );
  const sessionId = stringFlag(flags, "session-id") ?? stringRecordField(report?.session, "sessionId") ?? optionalEnv("SESSION_ID");
  if (!endpointHostname) {
    throw new Error("Missing --endpoint, --endpoint-hostname, ENDPOINT_HOSTNAME, or --report");
  }
  if (!customerHostname) {
    throw new Error("Missing customer hostname. Use `switchboard hostname remove app.example.com` from a project directory, or pass --report <report>.");
  }
  if (!sessionId) {
    throw new Error("Missing --session-id, SESSION_ID, or --report");
  }

  const endpointId = normalizeEndpointIdForCli(stringFlag(flags, "endpoint-id") ?? endpointHostname);
  const deadline = stringFlag(flags, "deadline") ?? String(Math.floor(Date.now() / 1000) + 600);
  const nonce = stringFlag(flags, "nonce") ?? randomUint256String();
  const attachment = normalizeCustomerHostnameAttachment({
    action: "removeCustomerHostname",
    endpointId,
    endpointHostname,
    customerHostname,
    sessionId,
    nonce,
    deadline
  });
  const signer = await resolveCustomerHostnameSigner(flags, manifestConfig, target, reportSessionDeveloper(report));
  try {
    const signature = await signCustomerHostnameAttachmentForCli(signer, chainId, registryAddress, attachment);
    const output = await deleteCustomerHostnameAttachment(relayUrl, endpointId, customerHostname, {
      ...attachment,
      ...signature,
      source: {
        cli: "switchboard hostname remove",
        reportPath
      }
    });

    writeOutput(flags, { ...output, signer: signerOutput(signer) }, () => printCustomerHostnameRemovalResult(output));
  } finally {
    await disconnectCliHubSigner(signer);
  }
}

async function hostnameStatusCommand(flags: Map<string, string | boolean>, positionals: string[]) {
  const reportPath = deploymentReportPath(flags);
  const report = reportPath ? (JSON.parse(await readFile(reportPath, "utf8")) as Record<string, any>) : undefined;
  const manifestConfig = await resolveCliNetworkConfig(flags);
  const relayUrl = stringFlag(flags, "relay-url") ?? stringRecordField(report?.relay, "url") ?? manifestConfig.relayUrl ?? optionalEnv("RELAY_URL") ?? DEFAULT_CONTROL_PLANE_URL;
  const routeIntentUrl =
    stringFlag(flags, "route-intent-url") ??
    optionalEnv("PROOF_CUSTOMER_HOSTNAME_ROUTE_INTENT_URL") ??
    optionalEnv("SWITCHBOARD_DEPLOY_ROUTE_INTENT_URL");
  const operatorSshHost =
    stringFlag(flags, "operator-ssh-host") ??
    stringRecordField(report?.operator, "sshHost") ??
    optionalEnv("SWITCHBOARD_DEPLOY_OPERATOR_SSH_HOST");
  const reportHostnames = deploymentReportHostnames(report);
  const endpointHostname = normalizeHostnameForCli(
    stringFlag(flags, "endpoint") ??
      stringFlag(flags, "endpoint-hostname") ??
      reportHostnames.public ??
      stringRecordField(report?.session, "hostname") ??
      optionalEnv("ENDPOINT_HOSTNAME")
  );
  const customerHostname = normalizeHostnameForCli(
    stringFlag(flags, "customer-hostname") ?? positionalAfterCommand(positionals) ?? optionalEnv("CUSTOMER_HOSTNAME")
  );
  if (!endpointHostname && !stringFlag(flags, "endpoint-id")) {
    throw new Error("Missing --endpoint, --endpoint-id, ENDPOINT_HOSTNAME, or --report");
  }
  if (!customerHostname) {
    throw new Error("Missing customer hostname. Use `switchboard hostname status app.example.com --endpoint <endpoint>`.");
  }
  const endpointId = normalizeEndpointIdForCli(stringFlag(flags, "endpoint-id") ?? endpointHostname ?? "");
  const waitSeconds = numberFlag(flags, "wait-seconds", "PROOF_CUSTOMER_HOSTNAME_WAIT_SECONDS", boolFlag(flags, "wait") ? 300 : 0);
  const dnsProviderHint = lookupDnsProviderHintForCli(customerHostname);
  const output =
    waitSeconds > 0
      ? await waitForCustomerHostname(relayUrl, endpointId, customerHostname, waitSeconds, numberFlag(flags, "poll-seconds", "PROOF_CUSTOMER_HOSTNAME_POLL_SECONDS", 10))
      : await getCustomerHostnameStatus(relayUrl, endpointId, customerHostname);
  const readiness =
    output.status === "dns_validated" && !boolFlag(flags, "skip-readiness-checks")
      ? await customerHostnameReadinessChecks({
          customerHostname,
          sessionId: String(output.sessionId ?? ""),
          routeIntentUrl,
          operatorSshHost,
          timeoutMs: numberFlag(flags, "check-timeout-ms", "PROOF_CUSTOMER_HOSTNAME_CHECK_TIMEOUT_MS", 10_000)
        })
      : undefined;
  const enrichedOutput = {
    ...output,
    dnsProviderHint: await dnsProviderHint,
    readiness
  };

  writeOutput(flags, enrichedOutput, () => printCustomerHostnameResult("status", enrichedOutput));
}

async function resolveCliHubSigner(
  flags: Map<string, string | boolean>,
  manifestConfig: CliNetworkConfig,
  target: SwitchboardTargetConfig
): Promise<CliHubSigner> {
  const signerMode = stringFlag(flags, "hub-signer") ?? stringFlag(flags, "signer");
  if (signerMode && signerMode !== "evm" && signerMode !== "polkadot") {
    throw new Error(`Unsupported hub signer "${signerMode}". Expected evm or polkadot.`);
  }

  if (signerMode === "polkadot") {
    return resolvePolkadotHubSigner(flags, manifestConfig, target);
  }
  const privateKey = evmPrivateKeyForClaim(flags);
  if (privateKey && signerMode !== "polkadot") {
    const wallet = new ethers.Wallet(privateKey);
    const address = ethers.getAddress(wallet.address);
    return {
      kind: "evm",
      address,
      contractAddress: address,
      wallet
    };
  }
  if (signerMode === "evm") {
    throw new Error("Missing EVM signer. Pass --claim-private-key, --private-key, or set PROOF_CLAIM_PRIVATE_KEY.");
  }
  if (hasPolkadotSignerConfig(flags)) {
    return resolvePolkadotHubSigner(flags, manifestConfig, target);
  }

  throw new Error("Missing claim/refund signer. Pass --claim-private-key for EVM, or configure --hub-signer polkadot with POLKADOT_SEED/Ledger options.");
}

async function maybeResolveCliHubSigner(
  flags: Map<string, string | boolean>,
  manifestConfig: CliNetworkConfig,
  target: SwitchboardTargetConfig
): Promise<CliHubSigner | undefined> {
  if (evmPrivateKeyForClaim(flags) || hasPolkadotSignerConfig(flags) || stringFlag(flags, "hub-signer") || stringFlag(flags, "signer")) {
    return resolveCliHubSigner(flags, manifestConfig, target);
  }
  return undefined;
}

async function resolveCustomerHostnameSigner(
  flags: Map<string, string | boolean>,
  manifestConfig: CliNetworkConfig,
  target: SwitchboardTargetConfig,
  sessionDeveloper: string | undefined
): Promise<CliHubSigner> {
  const explicitMode = stringFlag(flags, "hub-signer") ?? stringFlag(flags, "signer");
  if (explicitMode) {
    const signer = await resolveCliHubSigner(flags, manifestConfig, target);
    if (sessionDeveloper) {
      assertSignerMatchesRecipient(signer, sessionDeveloper, "customer hostname session developer");
    }
    return signer;
  }

  const privateKey = evmPrivateKeyForRefund(flags);
  if (privateKey) {
    const wallet = new ethers.Wallet(privateKey);
    const address = ethers.getAddress(wallet.address);
    if (!sessionDeveloper || address.toLowerCase() === sessionDeveloper.toLowerCase()) {
      return {
        kind: "evm",
        address,
        contractAddress: address,
        wallet
      };
    }
  }

  const polkadotSigner = await resolveMatchingPolkadotSeedCustomerHostnameSigner(flags, manifestConfig, target, sessionDeveloper);
  if (polkadotSigner) {
    return polkadotSigner;
  }

  if (privateKey && sessionDeveloper) {
    const address = ethers.getAddress(new ethers.Wallet(privateKey).address);
    throw new Error(
      `Configured EVM developer key resolves to ${address}, not customer hostname session developer ${sessionDeveloper}. Configure a native signer whose mapped address matches the session developer, or pass the matching EVM key.`
    );
  }

  throw new Error(
    "Missing customer hostname signer. Configure DEVELOPER_PRIVATE_KEY/EVM_PRIVATE_KEY for EVM-funded sessions, or POLKADOT_SEED/ACURAST_MAINNET_SEED for native-funded sessions."
  );
}

async function resolveMatchingPolkadotSeedCustomerHostnameSigner(
  flags: Map<string, string | boolean>,
  manifestConfig: CliNetworkConfig,
  target: SwitchboardTargetConfig,
  sessionDeveloper: string | undefined
): Promise<Extract<CliHubSigner, { kind: "polkadot" }> | undefined> {
  const candidates = polkadotSeedCandidates(flags);
  if (candidates.length === 0 || stringFlag(flags, "polkadot-signer") === "ledger" || optionalEnv("PROOF_POLKADOT_SIGNER") === "ledger") {
    return undefined;
  }

  const substrateWsUrl = manifestConfig.substrateWsUrl ?? target.defaultSubstrateWsUrl ?? optionalEnv("HUB_SUBSTRATE_WS_URL") ?? optionalEnv("SUBSTRATE_WS_URL");
  if (!substrateWsUrl) {
    return undefined;
  }

  const api = await ApiPromise.create({
    provider: new WsProvider(substrateWsUrl),
    noInitWarn: true
  });
  await api.isReady;

  try {
    const ss58Format = Number(stringFlag(flags, "ss58-format") ?? optionalEnv("POLKADOT_SS58_FORMAT") ?? String(api.registry.chainSS58 ?? 0));
    for (const candidate of candidates) {
      const account = await accountFromUri(candidate.seed, ss58Format);
      if (candidate.address && !samePolkadotAddress(candidate.address, account.address)) {
        continue;
      }
      const mappedAddress = await contractLayerAddress(api, account.address);
      if (sessionDeveloper && mappedAddress.toLowerCase() !== sessionDeveloper.toLowerCase()) {
        continue;
      }
      return {
        kind: "polkadot",
        address: account.address,
        contractAddress: mappedAddress,
        api,
        account,
        substrateWsUrl,
        disconnect: async () => {
          await api.disconnect();
        }
      };
    }
  } catch (error) {
    await api.disconnect().catch(() => undefined);
    throw error;
  }

  await api.disconnect();
  return undefined;
}

function polkadotSeedCandidates(flags: Map<string, string | boolean>): Array<{ seed: string; address?: string }> {
  const candidates: Array<{ seed: string; address?: string }> = [];
  const add = (seed: string | undefined, address?: string) => {
    if (!seed) {
      return;
    }
    if (!candidates.some((candidate) => candidate.seed === seed && candidate.address === address)) {
      candidates.push({ seed, address });
    }
  };
  add(stringFlag(flags, "polkadot-seed"), stringFlag(flags, "polkadot-address"));
  add(optionalEnv("POLKADOT_SEED"), optionalEnv("POLKADOT_ADDRESS"));
  add(optionalEnv("ACURAST_MAINNET_SEED"), optionalEnv("ACURAST_MAINNET_ADDRESS"));
  add(optionalEnv("ACURAST_SEED"), optionalEnv("ACURAST_ADDRESS"));
  return candidates;
}

async function signCustomerHostnameAttachmentForCli(
  signer: CliHubSigner,
  chainId: bigint | number | string,
  registryAddress: string,
  attachment: CustomerHostnameAttachmentPayload
): Promise<{ signatureScheme: "eip712-secp256k1" | "substrate-sr25519"; signer: string; signature: string }> {
  if (signer.kind === "evm") {
    return {
      signatureScheme: "eip712-secp256k1",
      signer: signer.address,
      signature: await signCustomerHostnameAttachment(signer.wallet, chainId, registryAddress, attachment)
    };
  }

  if (typeof signer.account.sign !== "function") {
    throw new Error("Native customer hostname signatures currently require a local POLKADOT_SEED signer; Ledger arbitrary-message signing is not supported yet.");
  }

  return {
    signatureScheme: "substrate-sr25519",
    signer: signer.address,
    signature: u8aToHex(signer.account.sign(customerHostnameAttachmentSubstratePayload(chainId, registryAddress, attachment)))
  };
}

async function resolveRefundSigner(
  flags: Map<string, string | boolean>,
  manifestConfig: CliNetworkConfig,
  target: SwitchboardTargetConfig,
  developer: string
): Promise<CliHubSigner> {
  const explicitMode = stringFlag(flags, "hub-signer") ?? stringFlag(flags, "signer");
  if (explicitMode) {
    const signer = await resolveCliHubSigner(flags, manifestConfig, target);
    assertSignerMatchesRecipient(signer, developer, "refund developer");
    return signer;
  }

  const privateKey = evmPrivateKeyForRefund(flags);
  if (privateKey) {
    const wallet = new ethers.Wallet(privateKey);
    const address = ethers.getAddress(wallet.address);
    if (address.toLowerCase() === developer.toLowerCase()) {
      return {
        kind: "evm",
        address,
        contractAddress: address,
        wallet
      };
    }
  }

  if (hasPolkadotSignerConfig(flags)) {
    const signer = await resolvePolkadotHubSigner(flags, manifestConfig, target);
    if (signer.contractAddress.toLowerCase() === developer.toLowerCase()) {
      return signer;
    }
    await signer.disconnect();
  }

  throw new Error(
    `No configured signer matches refund developer ${developer}. Pass --hub-signer evm with the developer private key, or --hub-signer polkadot with the native account that maps to the developer address.`
  );
}

async function resolvePolkadotHubSigner(
  flags: Map<string, string | boolean>,
  manifestConfig: CliNetworkConfig,
  target: SwitchboardTargetConfig
): Promise<Extract<CliHubSigner, { kind: "polkadot" }>> {
  const substrateWsUrl = manifestConfig.substrateWsUrl ?? target.defaultSubstrateWsUrl ?? requiredStringFlag(flags, "substrate-ws-url", "HUB_SUBSTRATE_WS_URL");
  const api = await ApiPromise.create({
    provider: new WsProvider(substrateWsUrl),
    noInitWarn: true
  });
  await api.isReady;

  try {
    const ss58Format = Number(stringFlag(flags, "ss58-format") ?? optionalEnv("POLKADOT_SS58_FORMAT") ?? String(api.registry.chainSS58 ?? 0));
    const signerKind = polkadotSignerKind(flags);
    const configuredAddress = stringFlag(flags, "polkadot-address") ?? optionalEnv("POLKADOT_ADDRESS");
    const account = signerKind === "ledger"
      ? await ledgerAccount({
          api,
          address: configuredAddress,
          ss58Format,
          mode: ledgerMode(flags),
          transport: ledgerTransport(flags),
          chain: stringFlag(flags, "ledger-chain") ?? optionalEnv("PROOF_LEDGER_CHAIN"),
          slip44: optionalIntegerFlag(flags, "ledger-slip44", "PROOF_LEDGER_SLIP44"),
          accountIndex: integerFlag(flags, "ledger-account", "PROOF_LEDGER_ACCOUNT", 0),
          addressOffset: integerFlag(flags, "ledger-address-index", "PROOF_LEDGER_ADDRESS_INDEX", 0),
          confirmAddress: boolFlag(flags, "ledger-confirm-address"),
          metadataChainId: stringFlag(flags, "ledger-metadata-chain-id") ?? optionalEnv("PROOF_LEDGER_METADATA_CHAIN_ID"),
          metadataUrl: stringFlag(flags, "ledger-metadata-url") ?? optionalEnv("PROOF_LEDGER_METADATA_URL")
        })
      : await accountFromUri(requiredStringFlag(flags, "polkadot-seed", "POLKADOT_SEED"), ss58Format);

    if (configuredAddress && !samePolkadotAddress(configuredAddress, account.address)) {
      throw new Error(`POLKADOT_SEED resolves to ${account.address}, not POLKADOT_ADDRESS ${configuredAddress}`);
    }

    const mappedAddress = await contractLayerAddress(api, account.address);
    return {
      kind: "polkadot",
      address: account.address,
      contractAddress: mappedAddress,
      api,
      account,
      substrateWsUrl,
      disconnect: async () => {
        if ("disconnect" in account && typeof account.disconnect === "function") {
          await account.disconnect().catch(() => undefined);
        }
        await api.disconnect();
      }
    };
  } catch (error) {
    await api.disconnect().catch(() => undefined);
    throw error;
  }
}

async function disconnectCliHubSigner(signer: CliHubSigner | undefined): Promise<void> {
  if (signer?.kind === "polkadot") {
    await signer.disconnect().catch(() => undefined);
  }
}

async function submitRegistryCall(
  flags: Map<string, string | boolean>,
  signer: CliHubSigner,
  provider: ethers.JsonRpcProvider,
  registryAddress: string,
  functionName: string,
  args: unknown[],
  confirmations: number
): Promise<Record<string, unknown>> {
  if (signer.kind === "evm") {
    const registry = new ethers.Contract(registryAddress, INGRESS_REGISTRY_NATIVE_PAYMENT_ABI, signer.wallet.connect(provider)) as any;
    const response = await registry[functionName](...args);
    const receipt = confirmations > 0 ? await response.wait(confirmations) : undefined;
    return {
      signerKind: "evm",
      hash: response.hash,
      blockNumber: receipt?.blockNumber,
      status: receipt?.status?.toString()
    };
  }

  await ensureMappedPolkadotAccount(flags, signer);
  const iface = new ethers.Interface(INGRESS_REGISTRY_NATIVE_PAYMENT_ABI);
  const calldata = iface.encodeFunctionData(functionName, args);
  const { weightLimit, storageDepositLimit } = reviveCallLimits(flags);
  const tx = signer.api.tx.revive.call(registryAddress, "0", weightLimit, storageDepositLimit.toString(), calldata);
  const result = await signAndSend(signer.api, tx, signer.account, numberFlag(flags, "request-timeout-ms", "CONTRACT_CALL_TIMEOUT_MS", 120_000));
  return {
    signerKind: "polkadot",
    hash: result.txHash,
    blockHash: result.blockHash,
    status: result.status,
    events: result.events
  };
}

async function estimateClaimGas(
  flags: Map<string, string | boolean>,
  signer: CliHubSigner,
  provider: ethers.JsonRpcProvider,
  registryAddress: string,
  assetAddress: string
): Promise<string> {
  return estimateRegistryCallGas(flags, signer, provider, registryAddress, "claim", [assetAddress]);
}

async function estimateRegistryCallGas(
  flags: Map<string, string | boolean>,
  signer: CliHubSigner,
  provider: ethers.JsonRpcProvider,
  registryAddress: string,
  functionName: string,
  args: unknown[]
): Promise<string> {
  if (signer.kind === "evm") {
    const registry = new ethers.Contract(registryAddress, INGRESS_REGISTRY_NATIVE_PAYMENT_ABI, signer.wallet.connect(provider)) as any;
    return (await registry[functionName].estimateGas(...args)).toString();
  }
  const iface = new ethers.Interface(INGRESS_REGISTRY_NATIVE_PAYMENT_ABI);
  const calldata = iface.encodeFunctionData(functionName, args);
  const { weightLimit } = reviveCallLimits(flags);
  return `${weightLimit.refTime}/${weightLimit.proofSize}`;
}

async function ensureMappedPolkadotAccount(flags: Map<string, string | boolean>, signer: Extract<CliHubSigner, { kind: "polkadot" }>): Promise<void> {
  if (boolFlag(flags, "no-map-account")) {
    return;
  }
  if (await isReviveAccountMapped(signer.api, signer.contractAddress)) {
    return;
  }
  const tx = signer.api.tx.revive.mapAccount();
  await signAndSend(signer.api, tx, signer.account, numberFlag(flags, "request-timeout-ms", "CONTRACT_CALL_TIMEOUT_MS", 120_000));
}

function reviveCallLimits(flags: Map<string, string | boolean>): { weightLimit: { refTime: string; proofSize: string }; storageDepositLimit: bigint } {
  return {
    storageDepositLimit: BigInt(stringFlag(flags, "storage-deposit-limit") ?? optionalEnv("NATIVE_STORAGE_DEPOSIT_LIMIT") ?? "1000000000000"),
    weightLimit: {
      refTime: BigInt(stringFlag(flags, "ref-time") ?? optionalEnv("NATIVE_REVIVE_REF_TIME") ?? "10000000000").toString(),
      proofSize: BigInt(stringFlag(flags, "proof-size") ?? optionalEnv("NATIVE_REVIVE_PROOF_SIZE") ?? "2000000").toString()
    }
  };
}

async function assetDisplay(provider: ethers.Provider, manifestConfig: CliNetworkConfig, assetAddress: string): Promise<AssetDisplay> {
  const manifestAsset = manifestConfig.manifest?.supportedAssets?.find((item) => item.address.toLowerCase() === assetAddress.toLowerCase());
  const output: AssetDisplay = {
    address: ethers.getAddress(assetAddress),
    symbol: manifestAsset?.symbol,
    decimals: manifestAsset?.decimals
  };
  if (output.symbol && output.decimals !== undefined) {
    return output;
  }
  const token = new ethers.Contract(assetAddress, ERC20_METADATA_ABI, provider) as any;
  const [symbol, decimals] = await Promise.all([
    output.symbol ? Promise.resolve(output.symbol) : token.symbol().catch(() => undefined),
    output.decimals !== undefined ? Promise.resolve(output.decimals) : token.decimals().catch(() => undefined)
  ]);
  return {
    ...output,
    symbol: typeof symbol === "string" ? symbol : output.symbol,
    decimals: decimals === undefined ? output.decimals : Number(decimals)
  };
}

async function planRefundAction(
  flags: Map<string, string | boolean>,
  registry: any,
  sessionId: string,
  session: any,
  status: number,
  nowSeconds: number
): Promise<Record<string, unknown> & { eligible: boolean; callName?: string }> {
  const requested = stringFlag(flags, "refund-reason") ?? stringFlag(flags, "reason");
  if (requested && requested !== "activation-timeout" && requested !== "unfulfilled") {
    throw new Error(`Unsupported refund reason "${requested}". Expected activation-timeout or unfulfilled.`);
  }

  if (status === 4 || status === 5) {
    return { eligible: false, reason: "closed", message: `Session is already ${sessionStatusLabel(status)}.` };
  }
  if (ethers.getAddress(session.developer) === ethers.ZeroAddress) {
    return { eligible: false, reason: "missing-session", message: "Session is not funded." };
  }
  if (requested === "activation-timeout" || (!requested && status !== 3)) {
    const activationDeadline = Number(session.activationDeadline.toString());
    return {
      eligible: nowSeconds > activationDeadline,
      reason: "activation-timeout",
      callName: "refundAfterActivationTimeout",
      activationDeadline: activationDeadline.toString(),
      activationDeadlineIso: unixSecondsToIso(activationDeadline),
      message: nowSeconds > activationDeadline
        ? "Activation timeout refund is available."
        : `Activation timeout refund is available after ${unixSecondsToIso(activationDeadline) ?? activationDeadline.toString()}.`
    };
  }

  const refundAvailableAt = Number((await registry.refundAvailableAt(sessionId)).toString());
  return {
    eligible: nowSeconds > refundAvailableAt,
    reason: "unfulfilled",
    callName: "refundUnfulfilled",
    refundAvailableAt: refundAvailableAt.toString(),
    refundAvailableAtIso: unixSecondsToIso(refundAvailableAt),
    message: nowSeconds > refundAvailableAt
      ? "Unfulfilled-session refund is available."
      : `Unfulfilled-session refund is available after ${unixSecondsToIso(refundAvailableAt) ?? refundAvailableAt.toString()}.`
  };
}

function evmPrivateKeyForClaim(flags: Map<string, string | boolean>): string | undefined {
  return stringFlag(flags, "claim-private-key") ??
    secretFromEnvFlag(flags, "claim-private-key-env") ??
    stringFlag(flags, "private-key") ??
    secretFromEnvFlag(flags, "private-key-env") ??
    optionalEnv("PROOF_CLAIM_PRIVATE_KEY") ??
    optionalEnv("CLAIM_PRIVATE_KEY") ??
    evmPrivateKeyForRefund(flags);
}

function evmPrivateKeyForRefund(flags: Map<string, string | boolean>): string | undefined {
  return stringFlag(flags, "developer-private-key") ??
    secretFromEnvFlag(flags, "developer-private-key-env") ??
    stringFlag(flags, "private-key") ??
    secretFromEnvFlag(flags, "private-key-env") ??
    optionalEnv("DEVELOPER_PRIVATE_KEY") ??
    optionalEnv("EVM_PRIVATE_KEY");
}

function secretFromEnvFlag(flags: Map<string, string | boolean>, flagName: string): string | undefined {
  const envName = stringFlag(flags, flagName);
  return envName ? optionalEnv(envName) : undefined;
}

function hasPolkadotSignerConfig(flags: Map<string, string | boolean>): boolean {
  return Boolean(
    stringFlag(flags, "polkadot-seed") ||
    optionalEnv("POLKADOT_SEED") ||
    stringFlag(flags, "polkadot-address") ||
    optionalEnv("POLKADOT_ADDRESS") ||
    boolFlag(flags, "ledger") ||
    stringFlag(flags, "polkadot-signer") === "ledger" ||
    optionalEnv("PROOF_POLKADOT_SIGNER") === "ledger"
  );
}

function assertSignerMatchesRecipient(signer: CliHubSigner, recipient: string, label: string): void {
  if (signer.contractAddress.toLowerCase() !== recipient.toLowerCase()) {
    throw new Error(`Configured signer resolves to ${signer.contractAddress}, not ${label} ${recipient}`);
  }
}

function signerOutput(signer: CliHubSigner): Record<string, unknown> {
  return signer.kind === "evm"
    ? {
        kind: "evm",
        address: signer.address,
        contractAddress: signer.contractAddress
      }
    : {
        kind: "polkadot",
        address: signer.address,
        contractAddress: signer.contractAddress,
        substrateWsUrl: signer.substrateWsUrl
      };
}

export function formatAssetUnits(amount: bigint, asset: AssetDisplay): string | undefined {
  if (asset.decimals === undefined) {
    return undefined;
  }
  const formatted = ethers.formatUnits(amount, asset.decimals);
  return asset.symbol ? `${formatted} ${asset.symbol}` : formatted;
}

function sessionStatusLabel(status: number): string {
  return SESSION_STATUS_LABELS[status] ?? `Unknown(${status})`;
}

function samePolkadotAddress(left: string, right: string): boolean {
  return u8aToHex(decodeAddress(left)) === u8aToHex(decodeAddress(right));
}

function polkadotSignerKind(flags: Map<string, string | boolean>): "seed" | "ledger" {
  const value = stringFlag(flags, "polkadot-signer") ?? optionalEnv("PROOF_POLKADOT_SIGNER") ?? (boolFlag(flags, "ledger") ? "ledger" : "seed");
  if (value === "seed" || value === "ledger") {
    return value;
  }
  throw new Error(`Unsupported Polkadot signer "${value}". Expected seed or ledger.`);
}

function ledgerMode(flags: Map<string, string | boolean>): "generic" | "legacy" {
  const value = stringFlag(flags, "ledger-mode") ?? optionalEnv("PROOF_LEDGER_MODE") ?? "generic";
  if (value === "generic" || value === "legacy") {
    return value;
  }
  throw new Error(`Unsupported Ledger mode "${value}". Expected generic or legacy.`);
}

function ledgerTransport(flags: Map<string, string | boolean>): "hid" | "webusb" {
  const value = stringFlag(flags, "ledger-transport") ?? optionalEnv("PROOF_LEDGER_TRANSPORT") ?? "hid";
  if (value === "hid" || value === "webusb") {
    return value;
  }
  throw new Error(`Unsupported Ledger transport "${value}". Expected hid or webusb.`);
}

function sessionOutput(session: any) {
  return {
    developer: session.developer,
    asset: session.asset,
    amountPaid: session.amountPaid.toString(),
    serviceAmount: session.serviceAmount?.toString(),
    setupFee: session.setupFee?.toString(),
    validationFeeCap: session.validationFeeCap?.toString(),
    pricePerSecond: session.pricePerSecond?.toString(),
    paidSeconds: session.paidSeconds?.toString(),
    expiresAt: session.expiresAt.toString(),
    quoteId: session.quoteId,
    policyHash: session.policyHash,
    jobId: session.jobId,
    expectedJobSigner: session.expectedJobSigner,
    operatorId: session.operatorId,
    processorId: session.processorId,
    endpointHash: session.endpointHash,
    salt: session.salt,
    operatorRecipient: session.operatorRecipient,
    validatorRecipient: session.validatorRecipient,
    proofRecipient: session.proofRecipient,
    maxOperatorBps: session.maxOperatorBps?.toString(),
    maxValidatorBps: session.maxValidatorBps?.toString(),
    maxProofBps: session.maxProofBps?.toString(),
    registered: Boolean(session.registered),
    nextNonce: session.nextNonce.toString(),
    activatedAt: session.activatedAt?.toString(),
    activationDeadline: session.activationDeadline?.toString(),
    fulfilledUntil: session.fulfilledUntil?.toString(),
    amountReleased: session.amountReleased?.toString(),
    amountAccounted: session.amountAccounted?.toString(),
    setupFeeReleased: session.setupFeeReleased?.toString(),
    validationFeeReleased: session.validationFeeReleased?.toString(),
    amountRefunded: session.amountRefunded?.toString(),
    status: session.status?.toString()
  };
}

function printRelayRegistrationResult(output: any) {
  console.log("Switchboard registration relayed");
  console.log(`Session: ${output.registration.sessionId}`);
  console.log(`Job signer: ${output.registration.jobSigner}`);
  console.log(`Relay URL: ${output.relayUrl}`);
  if (output.relayResponse?.txHash) {
    console.log(`Relay tx: ${output.relayResponse.txHash}`);
  }
  console.log(`Registered: ${output.session.registered}`);
}

function printStatus(output: any) {
  console.log("Switchboard session status");
  console.log(`Session: ${output.sessionId}`);
  console.log(`Developer: ${output.session.developer}`);
  console.log(`Asset: ${output.session.asset}`);
  console.log(`Amount paid: ${output.session.amountPaid}`);
  console.log(`Expires at: ${output.session.expiresAt}`);
  console.log(`Registered: ${output.session.registered}`);
  console.log(`Next nonce: ${output.session.nextNonce}`);
}

function printClaimResult(output: any) {
  console.log(output.action === "claimable" ? "Switchboard claimable rewards" : output.dryRun ? "Switchboard claim preview" : "Switchboard claim");
  console.log(`Recipient: ${output.recipient}`);
  console.log(`Asset: ${output.asset.address}${output.asset.symbol ? ` (${output.asset.symbol})` : ""}`);
  console.log(`Claimable: ${output.claimable.formatted ?? output.claimable.raw}`);
  if (output.signer) {
    console.log(`Signer: ${output.signer.kind} ${output.signer.address}`);
  }
  if (output.estimatedGas) {
    console.log(`Estimated gas/weight: ${output.estimatedGas}`);
  }
  if (output.tx) {
    console.log(`Tx: ${output.tx.hash}`);
    if (output.tx.blockNumber) {
      console.log(`Block: ${output.tx.blockNumber}`);
    }
    if (output.tx.blockHash) {
      console.log(`Block: ${output.tx.blockHash}`);
    }
  } else if (output.claimable.raw === "0") {
    console.log("Nothing to claim.");
  } else if (output.action === "claimable") {
    console.log("Run `switchboard claim --yes` with the matching signer to withdraw.");
  } else if (output.dryRun) {
    console.log("Submit with --yes to claim.");
  }
}

function printRefundResult(output: any) {
  console.log(output.action === "refundable" ? "Switchboard refundable session" : output.dryRun ? "Switchboard refund preview" : "Switchboard refund");
  console.log(`Session: ${output.sessionId}`);
  console.log(`Developer: ${output.developer}`);
  console.log(`Status: ${output.status.label}`);
  console.log(`Asset: ${output.asset.address}${output.asset.symbol ? ` (${output.asset.symbol})` : ""}`);
  console.log(`Refundable: ${output.refundable.formatted ?? output.refundable.raw}`);
  console.log(`Refund path: ${output.refund.reason ?? "none"}`);
  if (output.refund.message) {
    console.log(output.refund.message);
  }
  if (output.signer) {
    console.log(`Signer: ${output.signer.kind} ${output.signer.address}`);
  }
  if (output.estimatedGas) {
    console.log(`Estimated gas/weight: ${output.estimatedGas}`);
  }
  if (output.tx) {
    console.log(`Tx: ${output.tx.hash}`);
    if (output.tx.blockNumber) {
      console.log(`Block: ${output.tx.blockNumber}`);
    }
    if (output.tx.blockHash) {
      console.log(`Block: ${output.tx.blockHash}`);
    }
  } else if (output.action === "refundable" && output.refund.eligible) {
    console.log("Run `switchboard refund --yes` with the developer signer to withdraw.");
  } else if (output.refund.eligible) {
    console.log("Submit with --yes to refund.");
  }
}

function printPreflight(output: any) {
  console.log(output.ok ? "Switchboard preflight: OK" : "Switchboard preflight: needs attention");
  if (output.project) {
    console.log(`Project: ${output.project.name ?? output.project.root}`);
    if (output.project.latestReport) {
      console.log(`Latest report: ${output.project.latestReport}`);
    }
  }
  if (output.context) {
    console.log(`Context: ${output.context}`);
  }
  if (output.manifest) {
    console.log(`Manifest: ${output.manifest.url}`);
    console.log(`Manifest sequence: ${output.manifest.sequence ?? "unknown"}; expires ${output.manifest.expiresAt ?? "unknown"}`);
  }
  for (const check of output.checks ?? []) {
    const required = check.required === false ? "optional" : "required";
    console.log(`${check.ok ? "OK" : "MISSING"} ${check.name} (${required})${check.detail ? `: ${check.detail}` : ""}`);
  }
}

function printLaunchDemoStart(input: {
  relayUrl: string;
  target: string;
  acurastNetwork: AcurastNetwork;
  durationMinutes: number;
  scheduleBufferMinutes: number;
  maxCostPerExecution: string;
  selection: LaunchDemoCapacitySelection;
  ingressEstimate: LaunchDemoQuotePreview;
  estimate: { ok: true; summary?: string } | { ok: false; error: string };
  minReadyProcessors: number;
}) {
  console.log(sectionTitle("Switchboard demo"));
  printOutputRows([
    { label: "Network", value: `${input.target} / Acurast ${input.acurastNetwork}` },
    { label: "Relay", value: input.relayUrl },
    { label: "Operator", value: formatOperator(input.selection.operatorId, input.selection.gatewayId) },
    { label: "Processors", value: formatLaunchDemoProcessors(input.selection) },
    { label: "HA readiness", value: `${input.selection.processors.length} selected; min ${input.minReadyProcessors}` },
    { label: "Capacity", value: `${input.selection.activeRouteCount}/${input.selection.routeCapacity} routes active` },
    { label: "Lease", value: `${input.durationMinutes}m` },
    { label: "Runtime", value: `${input.durationMinutes + input.scheduleBufferMinutes}m` },
    { label: "Start delay", value: "3m" },
    { label: "Ingress estimate", value: formatLaunchDemoQuotePreview(input.ingressEstimate) },
    { label: "Cost cap", value: formatCostCap(input.maxCostPerExecution) },
    { label: "Acurast estimate", value: input.estimate.ok ? input.estimate.summary ?? "available" : "not available" }
  ]);
  if (!input.ingressEstimate.ok) {
    console.log(statusLine("warn", "Ingress estimate unavailable", firstLine(input.ingressEstimate.error)));
  }
  if (!input.estimate.ok) {
    console.log(statusLine("warn", "Acurast estimate unavailable", firstLine(input.estimate.error)));
  }
}

function printProjectDeployStart(input: {
  relayUrl: string;
  target: string;
  operatorId: string;
  processor?: string;
  durationMinutes: number;
  scheduleBufferMinutes: number;
  maxCostPerExecution: string;
  routeActivationMode: string;
  certificateMode: string;
}) {
  console.log(sectionTitle("Switchboard deploy"));
  printOutputRows([
    { label: "Network", value: input.target },
    { label: "Relay", value: input.relayUrl },
    { label: "Operator", value: compactId(input.operatorId) },
    { label: "Processor", value: input.processor ? compactId(input.processor) : "auto" },
    { label: "Hostname", value: "relay allocated" },
    { label: "Lease", value: `${input.durationMinutes}m` },
    { label: "Runtime", value: `${input.durationMinutes + input.scheduleBufferMinutes}m` },
    { label: "Cost cap", value: formatCostCap(input.maxCostPerExecution) },
    { label: "Route", value: input.routeActivationMode },
    { label: "Certificate", value: input.certificateMode }
  ]);
}

function printDeployResult(output: any) {
  console.log("");
  console.log(sectionTitle(output.action === "launch-demo" ? "Demo ready" : "Deployment ready"));
  printOutputRows([
    { label: "URL", value: output.url },
    {
      label: "Hostname",
      value: output.validationHostname && output.validationHostname !== output.hostname ? `${output.hostname} (validation ${output.validationHostname})` : output.hostname
    },
    { label: "Lease", value: output.lifecycle?.durationMinutes ? `${output.lifecycle.durationMinutes}m` : undefined },
    {
      label: "Runtime",
      value: typeof output.lifecycle?.executionMs === "number" ? `${Math.round(output.lifecycle.executionMs / 60_000)}m` : undefined
    },
    { label: "Operator", value: formatOperator(output.operatorId, stringRecordField(output.selection, "gatewayId")) },
    { label: "Processor", value: compactId(output.processor) },
    { label: "Deployment", value: output.deploymentId },
    { label: "Session", value: compactId(output.sessionId) },
    { label: "Job signer", value: compactId(output.jobSigner) },
    { label: "Route", value: output.route?.activationMode },
    { label: "Upstream", value: output.route?.upstream },
    { label: "DNS", value: deployDnsSummary(output) },
    { label: "Funding tx", value: compactId(output.fundingTx) },
    { label: "Registration tx", value: compactId(output.registrationTx) },
    { label: "Report", value: output.reportPath }
  ]);
  if (output.ha?.enabled) {
    console.log("");
    console.log(sectionTitle("HA members"));
    printHaMemberTable(output.ha.members ?? []);
  }
  if (output.action === "launch-demo" && output.url) {
    console.log("");
    console.log(statusLine("ok", "Open the URL to see the live Acurast-hosted app."));
  }
}

function printHaMemberTable(members: Array<Record<string, unknown>>): void {
  const rows = members.map((member) => ({
    Member: stringRecordField(member, "member") ?? "",
    Gateway: stringRecordField(member, "gatewayId") ?? "",
    Processor: compactId(stringRecordField(member, "processor") ?? stringRecordField(member, "processorId")),
    Claimed: booleanRecordField(member, "claimed") ? "yes" : "pending",
    Funded: booleanRecordField(member, "funded") ? "yes" : "pending",
    Registered: booleanRecordField(member, "registered") ? "yes" : "pending",
    Route: booleanRecordField(member, "routeActive") ? "active" : "pending"
  }));
  if (rows.length === 0) {
    console.log("No HA members reported.");
    return;
  }
  const headers = Object.keys(rows[0]);
  const widths = Object.fromEntries(headers.map((header) => [header, Math.max(header.length, ...rows.map((row) => String(row[header as keyof typeof row]).length))]));
  console.log(headers.map((header) => header.padEnd(widths[header])).join("  "));
  for (const row of rows) {
    console.log(headers.map((header) => String(row[header as keyof typeof row]).padEnd(widths[header])).join("  "));
  }
}

function printOutputRows(rows: OutputRow[]): void {
  for (const line of formatRows(rows)) {
    console.log(line);
  }
}

function formatOperator(operatorId: unknown, gatewayId?: unknown): string {
  const operator = compactId(operatorId);
  const gateway = typeof gatewayId === "string" && gatewayId.length > 0 ? gatewayId : undefined;
  if (gateway && operator) {
    return `${gateway} (${operator})`;
  }
  return gateway ?? operator;
}

function deployDnsSummary(output: any): string | undefined {
  const dns = output.dnsMaterialization;
  if (!dns || typeof dns !== "object") {
    return undefined;
  }
  const status = stringRecordField(dns, "status") ?? "unknown";
  const hostname = stringRecordField(dns, "hostname") ?? output.hostname;
  const targetIp = stringRecordField(dns, "targetIp");
  return `${status}${targetIp ? ` ${hostname} -> ${targetIp}` : ""}`;
}

function firstLine(value: string): string {
  return truncateText(value.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? value.trim(), 180);
}

function formatCostCap(raw: string): string {
  const formatted = formatAcuUnits(raw);
  return formatted === raw ? formatted : `${formatted} per execution`;
}

function printDeploymentStatus(output: any) {
  console.log(output.ok ? "Switchboard status: OK" : "Switchboard status: needs attention");
  if (output.url) {
    console.log(`URL: ${output.url}`);
  }
  if (output.validationHostname) {
    console.log(`Validation hostname: ${output.validationHostname}`);
  }
  console.log(`Session: ${output.sessionId}`);
  if (output.deploymentId) {
    console.log(`Deployment: ${output.deploymentId}`);
  }
  console.log(`Hub: ${output.hub.ok ? "registered" : "not ready"}; expires ${output.hub.expiresAtIso ?? output.hub.expiresAt}`);
  const route = output.gateway.route;
  console.log(`Gateway route: ${output.gateway.ok ? "active" : "missing/inactive"}`);
  if (route?.upstreamHost && route?.upstreamPort) {
    console.log(`Route upstream: ${route.upstreamHost}:${route.upstreamPort}`);
  }
  if (output.lifecycle) {
    const lease = output.lifecycle.hubExpiresAtIso ?? output.lifecycle.hubExpiresAt;
    const routeExpiry = output.lifecycle.routeExpiresAtIso ?? output.lifecycle.routeExpiresAt;
    const scheduleEnd = output.lifecycle.scheduleEndIso ?? output.lifecycle.scheduleEnd;
    if (lease || routeExpiry || scheduleEnd) {
      console.log(
        `Lifecycle: lease=${lease ?? "unknown"} route=${routeExpiry ?? "unknown"} scheduleEnd=${scheduleEnd ?? "unknown"}`
      );
    }
    if (output.lifecycle.scheduleEnded) {
      console.log("Acurast schedule: ended");
    } else if (output.lifecycle.scheduleCoversHubLease === false || output.lifecycle.scheduleCoversRoute === false) {
      console.log("Acurast schedule: shorter than ingress lease/route");
    }
  }
  if (output.dnsMaterialization) {
    const dns = output.dnsMaterialization;
    console.log(`DNS materialization: ${dns.status ?? "unknown"}${dns.targetIp ? ` ${dns.hostname ?? output.hostname} -> ${dns.targetIp}` : ""}`);
    if (dns.status === "failed" && dns.lastError) {
      console.log(`DNS materialization error: ${dns.lastError}`);
    }
  }
  if (output.validation) {
    const tls = output.validation.tls?.ok ? "tls=ok" : `tls=${output.validation.tls?.error ?? "failed"}`;
    const challenge = output.validation.checks?.challengeNonce && output.validation.checks?.challengeSession ? "challenge=ok" : "challenge=failed";
    console.log(
      `Route validation: ${output.validation.success ? "ok" : output.validation.failureReason ?? "failed"}; ${tls} ${challenge} latency=${output.validation.latencyMs}ms`
    );
  }
  if (output.controlPlaneValidation) {
    if (output.controlPlaneValidation.ok === false) {
      console.log(`Validator report: unavailable (${output.controlPlaneValidation.error})`);
    } else if (!output.controlPlaneValidation.latest) {
      console.log("Validator report: none recorded");
    } else {
      const latest = output.controlPlaneValidation.latest;
      const report = latest.report ?? {};
      const signature = report.signature;
      console.log(
        `Validator report: ${report.success ? "ok" : report.failureReason ?? "failed"}; signer=${signature?.signer ?? latest.signer ?? "unknown"} received=${latest.receivedAt ?? "unknown"}`
      );
    }
  }
  if (output.fulfillment) {
    console.log(`Fulfillment evidence: ${output.fulfillment.ok ? "complete" : "pending"}`);
  }
  if (output.public) {
    console.log(`DNS: ${output.public.dns.ok ? output.public.dns.addresses.join(", ") : output.public.dns.error}`);
    console.log(`Health: ${output.public.health.ok ? "ok" : output.public.health.error ?? output.public.health.status}`);
    console.log(`Challenge: ${output.public.challenge.ok ? "ok" : output.public.challenge.error ?? output.public.challenge.status}`);
    console.log(`Demo page: ${output.public.page.ok ? "ok" : output.public.page.error ?? output.public.page.status}`);
    if (output.public.demoStatus.registration || output.public.demoStatus.certificate) {
      console.log(`Job state: registration=${output.public.demoStatus.registration ?? "unknown"} certificate=${output.public.demoStatus.certificate ?? "unknown"}`);
    }
  }
  if (output.recommendation) {
    console.log(`Next: ${output.recommendation}`);
  }
  if (output.reportPath) {
    console.log(`Report: ${output.reportPath}`);
  }
}

function printCustomerHostnameResult(action: "attach" | "status", output: any) {
  console.log(
    output.status === "removed"
      ? "Switchboard customer hostname: removed"
      : output.ok
        ? "Switchboard customer hostname: ready"
        : "Switchboard customer hostname: waiting for DNS"
  );
  console.log(`Hostname: ${output.customerHostname}`);
  console.log(`Endpoint: ${output.endpointHostname}`);
  console.log(`Session: ${output.sessionId}`);
  console.log(`Status: ${output.status}`);
  if (action === "attach") {
    console.log("Use policy: only attach domains you control. No illegal content, attacks, abuse, phishing, spam, malware, or platform evasion.");
  }
  const instruction = output.instructions?.summary ?? customerHostnameInstructions(output.customerHostname, output.endpointHostname).summary;
  console.log(`Traffic DNS: ${instruction}`);
  printDnsProviderHint(output.dnsProviderHint);
  if (output.dns?.results) {
    for (const result of output.dns.results) {
      const chain = Array.isArray(result.chain) ? result.chain.join(" -> ") : "unknown";
      console.log(`Resolver ${result.resolver}: ${result.ok ? "ok" : result.error ?? "pending"} (${chain})`);
    }
  }
  if (output.certificate) {
    const authorization =
      output.certificate.authorization === "not_required"
        ? "not required"
        : output.certificate.authorized
          ? "ready"
          : "pending";
    console.log(`Certificate authorization: ${authorization}`);
  }
  printCustomerHostnameTls(output.tls);
  printCustomerHostnameCertificateValidation(output.certificateValidation);
  printCustomerHostnameRouteIntent(output.routeIntent);
  printCustomerHostnameReadiness(output.readiness);
  printCustomerHostnameNextSteps(output.nextSteps);
  if (action === "attach" && output.status !== "dns_validated") {
    console.log(`Check again: switchboard hostname status ${output.customerHostname} --endpoint ${output.endpointHostname}`);
  }
}

function printCustomerHostnameTls(tls: any) {
  if (!tls || typeof tls !== "object") {
    return;
  }
  if (tls.mode === "byo-certificate") {
    console.log("TLS mode: BYO certificate");
    console.log("TLS owner: developer-managed; PROOF will not request or renew certificates for this hostname");
    return;
  }
  if (tls.mode === "proof-acme") {
    console.log("TLS mode: PROOF ACME");
  }
}

function printCustomerHostnameCertificateValidation(validation: any) {
  if (!validation || typeof validation !== "object") {
    return;
  }
  const instructions = validation.instructions && typeof validation.instructions === "object" ? validation.instructions : undefined;
  const mode =
    validation.mode === "dns01-manual"
      ? "manual DNS TXT"
      : validation.mode === "dns01-cname-delegation"
        ? "_acme-challenge CNAME delegation"
        : String(validation.mode ?? "unknown");
  console.log(`Certificate validation: ${mode}`);
  if (instructions && typeof instructions.summary === "string") {
    console.log(`Certificate DNS: ${instructions.summary}`);
  }
  const challenge = validation.dns01Challenge && typeof validation.dns01Challenge === "object" ? validation.dns01Challenge : undefined;
  if (challenge && typeof challenge.name === "string" && typeof challenge.value === "string") {
    console.log(`Manual TXT challenge: ${challenge.name} TXT "${challenge.value}"`);
  }
}

function printCustomerHostnameNextSteps(nextSteps: unknown) {
  if (!Array.isArray(nextSteps) || nextSteps.length === 0) {
    return;
  }
  console.log("Next:");
  nextSteps
    .filter((step): step is string => typeof step === "string" && step.length > 0)
    .forEach((step, index) => {
      console.log(`  ${index + 1}. ${step}`);
    });
}

function printCustomerHostnameRemovalResult(output: any) {
  console.log("Switchboard customer hostname: removed");
  console.log(`Hostname: ${output.customerHostname}`);
  console.log(`Endpoint: ${output.endpointHostname}`);
  console.log(`Session: ${output.sessionId}`);
  console.log(`Status: ${output.status}`);
  printCustomerHostnameTls(output.tls);
  if (output.certificate) {
    console.log(`Certificate authorization: ${output.certificate.authorized ? "still authorized" : "removed"}`);
  }
  printCustomerHostnameRouteIntent(output.routeIntent);
  if (Array.isArray(output.nextSteps) && output.nextSteps.length > 0) {
    console.log(`Next: ${output.nextSteps[0]}`);
  }
}

function printCustomerHostnameRouteIntent(routeIntent: any) {
  if (!routeIntent || typeof routeIntent !== "object" || routeIntent.configured === false) {
    return;
  }
  if (routeIntent.removed) {
    const routeId = typeof routeIntent.routeId === "string" ? ` (${routeIntent.routeId})` : "";
    console.log(`Control-plane route intent: customer SNI removed${routeId}`);
    return;
  }
  if (routeIntent.includesCustomerHostname) {
    const routeId = typeof routeIntent.routeId === "string" ? ` (${routeIntent.routeId})` : "";
    console.log(`Control-plane route intent: includes customer SNI${routeId}`);
    return;
  }
  const reason = typeof routeIntent.error === "string" ? routeIntent.error : "pending";
  console.log(`Control-plane route intent: waiting (${reason})`);
}

function printCustomerHostnameReadiness(readiness: any) {
  if (!readiness || typeof readiness !== "object") {
    return;
  }
  const route = readiness.route && typeof readiness.route === "object" ? readiness.route : undefined;
  if (route?.checked) {
    const routeId = typeof route.routeId === "string" ? ` (${route.routeId})` : "";
    const reason = route.ok ? `ok${routeId}` : route.error ?? "pending";
    console.log(`Gateway customer SNI: ${reason}`);
  }
  const https = readiness.https && typeof readiness.https === "object" ? readiness.https : undefined;
  if (https?.checked) {
    console.log(`Job certificate: ${https.jobCertificateIssued ? "issued for hostname" : "pending"}`);
    const reason = https.challengeOk ? "ok" : https.error ?? https.report?.failureReason ?? "failed";
    console.log(`HTTPS challenge: ${reason}`);
  }
}

function printDnsProviderHint(hint: any) {
  if (!hint || typeof hint !== "object") {
    return;
  }
  if (typeof hint.zone === "string" && hint.zone) {
    console.log(`DNS zone: ${hint.zone}`);
  }
  if (Array.isArray(hint.nameServers) && hint.nameServers.length > 0) {
    console.log(`Name servers: ${formatCompactList(hint.nameServers, 4)}`);
  }
  if (hint.provider && typeof hint.provider === "object" && typeof hint.provider.loginUrl === "string") {
    const name = typeof hint.provider.name === "string" ? hint.provider.name : "DNS provider";
    console.log(`DNS control panel: ${name} - ${hint.provider.loginUrl}`);
    return;
  }
  if (Array.isArray(hint.nameServers) && hint.nameServers.length > 0) {
    console.log("DNS control panel: Open your DNS host for the zone above.");
    return;
  }
  if (typeof hint.error === "string" && hint.error) {
    console.log(`DNS provider: could not infer (${hint.error})`);
  }
}

function formatCompactList(values: string[], maxItems: number): string {
  const selected = values.slice(0, maxItems);
  const remaining = values.length - selected.length;
  return remaining > 0 ? `${selected.join(", ")} +${remaining} more` : selected.join(", ");
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function truncateText(value: string, maxLength = 240): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
}

function deployOutput(
  report: Record<string, any>,
  reportPath: string,
  defaults: {
    action?: string;
    relayUrl: string;
    routeActivationMode: string;
    certificateMode: string;
    maxCostPerExecution: string;
    durationMinutes: number;
    scheduleBufferMinutes: number;
    selection?: Record<string, unknown>;
    ingressEstimate?: LaunchDemoQuotePreview;
    estimate?: Record<string, unknown> | { ok: boolean; error?: string; summary?: string; output?: unknown };
    demoProject?: LaunchDemoProject;
  }
) {
  const reportHostnames = deploymentReportHostnames(report);
  const hostname = reportHostnames.public ?? stringRecordField(report.session, "hostname");
  const validationHostname = reportHostnames.validation ?? stringRecordField(report.session, "validationHostname");
  const publicProbe = report.publicProbe && typeof report.publicProbe === "object" ? report.publicProbe : undefined;
  const dnsMaterialization = deploymentIntentDnsMaterialization(report);
  const group = report.deploymentIntentGroup && typeof report.deploymentIntentGroup === "object"
    ? report.deploymentIntentGroup as Record<string, unknown>
    : undefined;
  const groupMembers = Array.isArray(group?.members)
    ? group.members.filter((member): member is Record<string, unknown> => Boolean(member && typeof member === "object" && !Array.isArray(member)))
    : [];
  return {
    ok: report.ok === true,
    action: defaults.action ?? "deploy",
    url: hostname ? `https://${hostname}/` : undefined,
    hostname,
    validationHostname,
    hostnames: {
      public: hostname,
      validation: validationHostname
    },
    deploymentId: stringRecordField(report.deployment, "deploymentId"),
    deploymentTx: stringRecordField(report.deployment, "txHash"),
    sessionId: stringRecordField(report.session, "sessionId"),
    jobId: stringRecordField(report.session, "jobId"),
    jobSigner: stringRecordField(report.session, "jobSigner"),
    operatorId: stringRecordField(report.session, "operatorId"),
    processor: stringRecordField(report.session, "processor"),
    processorId: stringRecordField(report.session, "processorId"),
    relayUrl: stringRecordField(report.relay, "url") ?? defaults.relayUrl,
    certificateMode: defaults.certificateMode,
    maxCostPerExecution: defaults.maxCostPerExecution,
    lifecycle: {
      durationMinutes: numberRecordField(report.lifecycle, "durationMinutes") ?? defaults.durationMinutes,
      leaseSeconds: numberRecordField(report.lifecycle, "leaseSeconds"),
      paymentAmount: stringRecordField(report.lifecycle, "paymentAmount"),
      nativePricePerSecond: stringRecordField(report.lifecycle, "nativePricePerSecond"),
      executionMs: numberRecordField(report.lifecycle, "executionMs"),
      scheduleBufferMinutes: numberRecordField(report.lifecycle, "scheduleBufferMinutes") ?? defaults.scheduleBufferMinutes,
      schedule: report.lifecycle && typeof report.lifecycle === "object" ? (report.lifecycle as Record<string, any>).schedule : undefined,
      hubExpiresAt: stringRecordField(report.lifecycle, "hubExpiresAt")
    },
    fundingTx: stringRecordField(report.funding, "txHash"),
    registrationTx: knownTxHash(stringRecordField(report.registration, "txHash")),
    route: {
      activationMode: defaults.routeActivationMode,
      upstream: stringRecordField(report.operator, "upstream"),
      publicProbeNonce: publicProbe ? stringRecordField(publicProbe, "nonce") : undefined
    },
    dns: report.dns,
    dnsMaterialization,
    selection: defaults.selection,
    ha: group
      ? {
          enabled: true,
          groupId: stringRecordField(group, "groupId"),
          endpointHostname: hostname,
          expectedReplicas: numberRecordField(group, "expectedReplicas"),
          minReady: numberRecordField(group, "minReady"),
          readyReplicas: groupMembers.filter((member) => stringRecordField(member, "sessionId")).length,
          members: groupMembers.map((member, index) => {
            const funding = member.funding && typeof member.funding === "object" ? member.funding as Record<string, unknown> : undefined;
            const registration = member.registration && typeof member.registration === "object" ? member.registration as Record<string, unknown> : undefined;
            const route = member.route && typeof member.route === "object" ? member.route as Record<string, unknown> : undefined;
            return {
              member: stringRecordField(member, "memberId") ?? `member-${index + 1}`,
              intentId: stringRecordField(member, "intentId"),
              gatewayId: stringRecordField(member, "gatewayId"),
              operatorId: stringRecordField(member, "operatorId"),
              processor: stringRecordField(member, "processor"),
              processorId: stringRecordField(member, "processorId"),
              sessionId: stringRecordField(member, "sessionId"),
              runtimeSigner: stringRecordField(member, "runtimeSigner"),
              claimed: Boolean(stringRecordField(member, "runtimeSigner")),
              funded: stringRecordField(funding, "txHash") ? true : stringRecordField(funding, "status") === "funded",
              registered: Boolean(stringRecordField(registration, "txHash") || stringRecordField(member, "sessionId")),
              routeActive: stringRecordField(route, "status") === "active"
            };
          })
        }
      : undefined,
    ingressEstimate: defaults.ingressEstimate,
    estimate: defaults.estimate,
    demoProject: defaults.demoProject,
    reportPath,
    runDir: stringRecordField(report.artifacts, "runDir")
  };
}

async function readGatewayRouteStatusReport(
  routeIntentUrl: string,
  operatorSshHost: string | undefined,
  filters: { sessionId: string; hostname?: string }
): Promise<Record<string, any>> {
  const url = gatewayAgentUrl(routeIntentUrl, "/reports/route-status");
  url.searchParams.set("sessionId", filters.sessionId);
  if (filters.hostname) {
    url.searchParams.set("hostname", filters.hostname);
  }
  return gatewayAgentJson("GET", url.toString(), operatorSshHost);
}

async function readControlPlaneValidationReports(
  relayUrl: string,
  filters: { sessionId: string; hostname?: string }
): Promise<Record<string, any>> {
  const url = new URL("/v1/validation-reports", relayUrl);
  url.searchParams.set("sessionId", filters.sessionId);
  url.searchParams.set("limit", "1");
  if (filters.hostname) {
    url.searchParams.set("hostname", filters.hostname);
  }
  const response = await fetch(url, {
    headers: validationReadHeaders()
  });
  const body = await response.text();
  if (!response.ok) {
    const parsed = parseJsonObject(body);
    if (response.status === 429 && parsed?.error === "customer_hostname_rate_limited") {
      const retry = typeof parsed.retryAfterSeconds === "number" ? `${Math.ceil(parsed.retryAfterSeconds / 60)} minutes` : "later";
      const resetAt = typeof parsed.resetAt === "string" ? ` (${parsed.resetAt})` : "";
      throw new Error(`Hostname change limit reached. Try again in ${retry}${resetAt}.`);
    }
    throw new Error(`${response.status} ${body}`);
  }
  return JSON.parse(body) as Record<string, any>;
}

async function readDeploymentIntentStatusFromReport(
  relayUrl: string,
  report: Record<string, any> | undefined
): Promise<Record<string, any> | undefined> {
  const deploymentIntent = nestedRecord(report, "deploymentIntent");
  const intentId = stringRecordField(deploymentIntent, "intentId");
  const cliToken = stringNestedField(deploymentIntent, "localSecret", "cliToken");
  if (!intentId || !cliToken) {
    return undefined;
  }

  const response = await fetch(new URL(`/v1/deployment-intents/${encodeURIComponent(intentId)}`, relayUrl), {
    headers: {
      authorization: `Bearer ${cliToken}`
    },
    signal: AbortSignal.timeout(15_000)
  });
  const body = await response.text();
  const parsed = body ? parseJsonObject(body) : {};
  if (!response.ok || parsed?.ok !== true) {
    throw new Error(`Deployment intent status failed: ${response.status} ${body}`);
  }
  return parsed;
}

function deploymentIntentDnsMaterialization(
  report: Record<string, any> | undefined,
  intent?: Record<string, unknown>
): Record<string, unknown> | undefined {
  return (
    nestedRecord(intent, "dns") ??
    nestedRecord(report, "dnsMaterialization") ??
    nestedRecord(nestedRecord(report, "deploymentIntent"), "dns") ??
    nestedRecord(nestedRecord(nestedRecord(report, "deploymentIntent"), "intent"), "dns")
  );
}

async function postCustomerHostnameAttachment(
  relayUrl: string,
  endpointId: string,
  payload: Record<string, unknown>
): Promise<Record<string, any>> {
  const url = new URL(`/v1/endpoints/${encodeURIComponent(endpointId)}/customer-hostnames`, relayUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${body}`);
  }
  return JSON.parse(body) as Record<string, any>;
}

function customerHostnameTlsModeForCli(flags: Map<string, string | boolean>): string {
  const configured =
    stringFlag(flags, "tls-mode") ??
    (boolFlag(flags, "byo-tls") || boolFlag(flags, "byo-certificate") ? "byo-certificate" : undefined);
  if (!configured || configured === "proof-acme" || configured === "acme" || configured === "managed") {
    return "proof-acme";
  }
  if (configured === "byo" || configured === "byo-tls" || configured === "byo-certificate") {
    return "byo-certificate";
  }
  throw new Error(`Unsupported customer hostname TLS mode: ${configured}`);
}

function customerHostnameCertificateValidationModeForCli(flags: Map<string, string | boolean>): string {
  const configured =
    stringFlag(flags, "certificate-validation-mode") ??
    stringFlag(flags, "dns01-mode") ??
    (boolFlag(flags, "manual-dns01") || boolFlag(flags, "manual-txt") ? "manual" : undefined);
  if (!configured || configured === "cname" || configured === "delegated" || configured === "dns01-cname-delegation") {
    return "dns01-cname-delegation";
  }
  if (configured === "manual" || configured === "txt" || configured === "dns01-manual") {
    return "dns01-manual";
  }
  throw new Error(`Unsupported customer hostname certificate validation mode: ${configured}`);
}

async function deleteCustomerHostnameAttachment(
  relayUrl: string,
  endpointId: string,
  customerHostname: string,
  payload: Record<string, unknown>
): Promise<Record<string, any>> {
  const url = new URL(
    `/v1/endpoints/${encodeURIComponent(endpointId)}/customer-hostnames/${encodeURIComponent(customerHostname)}`,
    relayUrl
  );
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${body}`);
  }
  return JSON.parse(body) as Record<string, any>;
}

async function lookupDnsProviderHintForCli(customerHostname: string, timeoutMs = 2500): Promise<Record<string, any>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookupDnsProviderHint(customerHostname),
      new Promise<Record<string, any>>((resolve) => {
        timeout = setTimeout(
          () =>
            resolve({
              nameServers: [],
              error: `NS lookup timed out after ${timeoutMs}ms`
            }),
          timeoutMs
        );
      })
    ]);
  } catch (error) {
    return {
      nameServers: [],
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function getCustomerHostnameStatus(
  relayUrl: string,
  endpointId: string,
  customerHostname: string
): Promise<Record<string, any>> {
  const url = new URL(
    `/v1/endpoints/${encodeURIComponent(endpointId)}/customer-hostnames/${encodeURIComponent(customerHostname)}`,
    relayUrl
  );
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${body}`);
  }
  return JSON.parse(body) as Record<string, any>;
}

async function waitForCustomerHostname(
  relayUrl: string,
  endpointId: string,
  customerHostname: string,
  waitSeconds: number,
  pollSeconds: number
): Promise<Record<string, any>> {
  const deadline = Date.now() + waitSeconds * 1000;
  let latest: Record<string, any> | undefined;
  while (Date.now() <= deadline) {
    latest = await getCustomerHostnameStatus(relayUrl, endpointId, customerHostname);
    if (latest.status === "dns_validated") {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, pollSeconds) * 1000));
  }
  return latest ?? (await getCustomerHostnameStatus(relayUrl, endpointId, customerHostname));
}

async function customerHostnameReadinessChecks(input: {
  customerHostname: string;
  sessionId: string;
  routeIntentUrl?: string;
  operatorSshHost?: string;
  timeoutMs: number;
}): Promise<Record<string, any>> {
  const [route, https] = await Promise.all([
    input.routeIntentUrl
      ? customerHostnameRouteReadiness(input.routeIntentUrl, input.operatorSshHost, input.sessionId, input.customerHostname)
      : Promise.resolve({
          checked: false,
          reason: "route-intent-url-not-configured"
        }),
    customerHostnameHttpsReadiness(input.customerHostname, input.sessionId, input.timeoutMs)
  ]);

  return {
    route,
    https
  };
}

async function customerHostnameRouteReadiness(
  routeIntentUrl: string,
  operatorSshHost: string | undefined,
  sessionId: string,
  customerHostname: string
): Promise<Record<string, any>> {
  try {
    const report = await readGatewayRouteStatusReport(routeIntentUrl, operatorSshHost, {
      sessionId,
      hostname: customerHostname
    });
    const routes = Array.isArray(report.routes) ? report.routes : [];
    const route = routes.find((item) => routeHostnames(item).includes(customerHostname.toLowerCase())) ?? routes[0];
    const includesCustomerSni = Boolean(route && routeHostnames(route).includes(customerHostname.toLowerCase()));
    return {
      checked: true,
      ok: includesCustomerSni && route?.observed?.configured === true,
      includesCustomerSni,
      configured: route?.observed?.configured,
      routeId: stringRecordField(route, "routeId"),
      report
    };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      error: safeErrorMessage(error)
    };
  }
}

async function customerHostnameHttpsReadiness(
  customerHostname: string,
  sessionId: string,
  timeoutMs: number
): Promise<Record<string, any>> {
  try {
    const report = await validateSwitchboardRoute({
      sessionId,
      hostname: customerHostname,
      validatorId: "switchboard-customer-hostname-cli",
      timeoutMs
    });
    return {
      checked: true,
      ok: report.success,
      tlsOk: report.checks.tls,
      healthOk: report.checks.health,
      challengeOk: report.checks.challengeNonce && report.checks.challengeSession,
      jobCertificateIssued: customerHostnameCertificateIssued(report, customerHostname),
      report
    };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      error: safeErrorMessage(error)
    };
  }
}

function customerHostnameCertificateIssued(report: Record<string, any>, customerHostname: string): boolean {
  const normalized = customerHostname.toLowerCase();
  const statusJson = report.http?.status?.json;
  const certificateHostnames = [
    ...stringArrayNestedField(statusJson, "public", "certificateHostnames"),
    ...stringArrayNestedField(statusJson, "certificate", "hostnames"),
    ...objectArrayNestedField(statusJson, "certificate", "certificates")
      .map((item) => stringRecordField(item, "hostname"))
      .filter((item): item is string => Boolean(item)),
    ...stringArrayRecordField(report.tls?.certificate, "subjectAltNames")
  ].map((hostname) => hostname.toLowerCase());
  if (certificateHostnames.includes(normalized)) {
    return true;
  }
  const certificateState = stringNestedField(statusJson, "certificate", "state");
  const tlsSubjectAltName = stringRecordField(report.tls?.certificate, "subjectAltName")?.toLowerCase() ?? "";
  return certificateState === "issued" && tlsSubjectAltName.includes(`dns:${normalized}`);
}

function validationReadHeaders(): Record<string, string> | undefined {
  const token = optionalEnv("PROOF_VALIDATION_READ_TOKEN");
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

function controlPlaneLatestValidationReport(controlPlaneValidation: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!controlPlaneValidation || controlPlaneValidation.ok === false) {
    return undefined;
  }
  const latest = controlPlaneValidation.latest;
  return latest && typeof latest === "object" && latest.report && typeof latest.report === "object"
    ? (latest.report as Record<string, any>)
    : undefined;
}

async function gatewayAgentJson(
  method: "GET" | "POST",
  routeIntentUrl: string,
  operatorSshHost: string | undefined,
  body?: Record<string, unknown>
): Promise<Record<string, any>> {
  const bodyText = body ? `${JSON.stringify(body)}\n` : undefined;
  if (isLocalOperatorUrl(routeIntentUrl) && operatorSshHost) {
    const remoteCommand = [
      "curl -sS --fail-with-body",
      "-X",
      method,
      body ? "-H 'content-type: application/json' --data-binary @-" : undefined,
      shellSingleQuote(routeIntentUrl)
    ]
      .filter(Boolean)
      .join(" ");
    const result = await runCliChild("ssh", ["-F", "/dev/null", "-o", "BatchMode=yes", operatorSshHost, remoteCommand], {
      input: bodyText,
      stream: false,
      allowFailure: true
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `gateway-agent ${method} failed`);
    }
    return JSON.parse(result.stdout) as Record<string, any>;
  }

  const response = await fetch(routeIntentUrl, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: bodyText
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`gateway-agent ${method} failed: ${response.status} ${responseBody}`);
  }
  return JSON.parse(responseBody) as Record<string, any>;
}

function gatewayAgentUrl(routeIntentUrl: string, pathname: string): URL {
  const url = new URL(routeIntentUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url;
}

function deploymentReportHostnames(report: Record<string, any> | undefined): { public?: string; validation?: string } {
  const hostnames = report?.hostnames && typeof report.hostnames === "object" ? (report.hostnames as Record<string, unknown>) : undefined;
  return {
    public: typeof hostnames?.public === "string" ? hostnames.public : undefined,
    validation: typeof hostnames?.validation === "string" ? hostnames.validation : undefined
  };
}

function reportSessionDeveloper(report: Record<string, any> | undefined): string | undefined {
  const funding = report?.funding;
  const session = funding && typeof funding === "object" ? (funding as Record<string, unknown>).session : undefined;
  const account = funding && typeof funding === "object" ? (funding as Record<string, unknown>).account : undefined;
  const quote = funding && typeof funding === "object" ? (funding as Record<string, unknown>).quote : undefined;
  return (
    stringRecordField(session, "developer") ??
    stringRecordField(account, "contractLayerAddress") ??
    stringRecordField(quote, "developer")
  );
}

function routeHostnames(route: Record<string, any>): string[] {
  const values = [
    stringRecordField(route, "hostname"),
    stringRecordField(route, "publicHostname"),
    stringRecordField(route, "validationHostname"),
    ...stringArrayRecordField(route, "customerHostnames"),
    ...stringArrayRecordField(route.hostnames, "serverNames")
  ];
  return [...new Set(values.filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase()))];
}

function isRouteActive(route: Record<string, any> | undefined, nowSeconds: number): boolean {
  if (!route) {
    return false;
  }
  const status = stringRecordField(route, "status");
  const expiresAtRaw = route.expiresAt;
  const expiresAt = typeof expiresAtRaw === "number" ? expiresAtRaw : Number(expiresAtRaw);
  if (Number.isFinite(expiresAt)) {
    return expiresAt > nowSeconds && (!status || status === "active");
  }
  return status === "active";
}

function deploymentLifecycleStatus(input: {
  report?: Record<string, any>;
  session: Record<string, string | boolean>;
  route?: Record<string, any>;
  nowSeconds: number;
}): Record<string, unknown> {
  const hubExpiresAt = unixSecondsField(input.session, "expiresAt");
  const routeExpiresAt = unixSecondsField(input.route, "expiresAt");
  const schedule = deploymentSchedule(input.report);
  const scheduleStart = unixSecondsField(schedule, "startUnixSeconds");
  const scheduleEnd = unixSecondsField(schedule, "endUnixSeconds");
  const scheduleCoversHubLease = scheduleEnd !== undefined && hubExpiresAt !== undefined ? scheduleEnd > hubExpiresAt : undefined;
  const scheduleCoversRoute = scheduleEnd !== undefined && routeExpiresAt !== undefined ? scheduleEnd > routeExpiresAt : undefined;

  return {
    nowUnixSeconds: input.nowSeconds,
    nowIso: new Date(input.nowSeconds * 1000).toISOString(),
    durationMinutes: numberRecordField(input.report?.lifecycle, "durationMinutes"),
    leaseSeconds: numberRecordField(input.report?.lifecycle, "leaseSeconds"),
    paymentAmount: stringRecordField(input.report?.lifecycle, "paymentAmount"),
    nativePricePerSecond: stringRecordField(input.report?.lifecycle, "nativePricePerSecond"),
    executionMs: numberRecordField(input.report?.lifecycle, "executionMs"),
    scheduleBufferMinutes: numberRecordField(input.report?.lifecycle, "scheduleBufferMinutes"),
    hubExpiresAt,
    hubExpiresAtIso: unixSecondsToIso(hubExpiresAt),
    hubExpired: hubExpiresAt !== undefined ? hubExpiresAt <= input.nowSeconds : undefined,
    routeExpiresAt,
    routeExpiresAtIso: unixSecondsToIso(routeExpiresAt),
    routeExpired: routeExpiresAt !== undefined ? routeExpiresAt <= input.nowSeconds : undefined,
    scheduleStart,
    scheduleStartIso: stringRecordField(schedule, "startIso") ?? unixSecondsToIso(scheduleStart),
    scheduleEnd,
    scheduleEndIso: stringRecordField(schedule, "endIso") ?? unixSecondsToIso(scheduleEnd),
    scheduleStarted: scheduleStart !== undefined ? scheduleStart <= input.nowSeconds : undefined,
    scheduleEnded: scheduleEnd !== undefined ? scheduleEnd <= input.nowSeconds : undefined,
    scheduleCoversHubLease,
    scheduleCoversRoute
  };
}

function deploymentSchedule(report: Record<string, any> | undefined): Record<string, unknown> | undefined {
  const lifecycleSchedule =
    report?.lifecycle && typeof report.lifecycle === "object" && report.lifecycle.schedule && typeof report.lifecycle.schedule === "object"
      ? (report.lifecycle.schedule as Record<string, unknown>)
      : undefined;
  if (lifecycleSchedule) {
    return lifecycleSchedule;
  }

  const output = stringRecordField(report?.deployment, "output");
  if (!output) {
    return undefined;
  }
  const match = output.match(/Direct deploy schedule: start=([^\s]+) end=([^\s]+)/);
  if (!match) {
    return undefined;
  }
  const startMs = Date.parse(match[1]);
  const endMs = Date.parse(match[2]);
  return {
    startIso: match[1],
    endIso: match[2],
    startUnixSeconds: Number.isFinite(startMs) ? Math.floor(startMs / 1000) : undefined,
    endUnixSeconds: Number.isFinite(endMs) ? Math.floor(endMs / 1000) : undefined
  };
}

async function runDeploymentPublicChecks(hostname: string, sessionId: string): Promise<Record<string, any>> {
  const validationReport = await validateSwitchboardRoute({
    sessionId,
    hostname,
    validatorId: "switchboard-cli",
    ...validatorReportSigningConfig()
  });

  return {
    validationReport,
    dns: validationReport.dns,
    health: validationReport.http.health,
    challenge: {
      ...validationReport.http.challenge,
      ok: validationReport.checks.challengeNonce && validationReport.checks.challengeSession,
      nonce: validationReport.nonce,
      matched: validationReport.checks.challengeNonce && validationReport.checks.challengeSession,
      response: validationReport.http.challenge.response
    },
    demoStatus: {
      ...validationReport.http.status,
      registration: validationReport.http.status.registration,
      certificate: validationReport.http.status.certificate,
      challengeCount: validationReport.http.status.challengeCount
    },
    page: {
      ...validationReport.http.page,
      ok: validationReport.http.page.matched,
      matched: validationReport.http.page.matched
    }
  };
}

function validatorReportSigningConfig() {
  const seed = optionalEnv("VALIDATOR_REPORT_SEED") ?? optionalEnv("PROOF_VALIDATOR_REPORT_SEED");
  if (seed) {
    return {
      signingKey: seed,
      signingScheme: "substrate-sr25519" as const,
      signingSs58Format: optionalNumberEnv("VALIDATOR_REPORT_SS58_FORMAT") ?? optionalNumberEnv("PROOF_VALIDATOR_REPORT_SS58_FORMAT")
    };
  }

  const privateKey = optionalEnv("VALIDATOR_REPORT_PRIVATE_KEY") ?? optionalEnv("PROOF_VALIDATOR_REPORT_PRIVATE_KEY");
  return privateKey
    ? {
        signingKey: privateKey,
        signingScheme: "eip191-secp256k1" as const
      }
    : {};
}

function deploymentStatusRecommendation(input: {
  hubFunded: boolean;
  hubRegistered: boolean;
  hubExpired: boolean;
  scheduleEnded: boolean;
  scheduleCoversHubLease?: boolean;
  scheduleCoversRoute?: boolean;
  routeActive: boolean;
  validationOk: boolean;
  controlPlaneValidationOk: boolean;
  dnsMaterializationStatus?: string;
  publicOk: boolean;
  hasReport: boolean;
  hasHostname: boolean;
}): string {
  if (!input.hubFunded) {
    return "Fund the ingress session, then wait for the job to register.";
  }
  if (!input.hubRegistered) {
    return "The session is funded but not registered; check job runtime logs and relay registration.";
  }
  if (input.hubExpired) {
    return "The Hub lease has expired; deploy and fund a new session, then attach it to the endpoint.";
  }
  if (input.scheduleEnded) {
    return "The Acurast job schedule has ended; redeploy with a longer --duration-minutes value before using this endpoint.";
  }
  if (input.scheduleCoversHubLease === false || input.scheduleCoversRoute === false) {
    return "The Acurast schedule ends before the ingress lease or route; redeploy with --duration-minutes so the job outlives the paid route.";
  }
  if (!input.routeActive) {
    return "Canonical route is not active yet; wait for deployment-intent route reconciliation or inspect relay/control-plane route state.";
  }
  if (!input.hasHostname) {
    return "Provide --hostname or --report to run public endpoint checks.";
  }
  if (input.dnsMaterializationStatus && input.dnsMaterializationStatus !== "propagated") {
    if (input.dnsMaterializationStatus === "failed") {
      return "Canonical DNS materialization failed; inspect the deployment intent DNS error on the control plane.";
    }
    return "Canonical DNS is still being materialized by the control plane; wait for DNS status propagated before rerunning public checks.";
  }
  if (!input.validationOk) {
    return "Route validation failed; inspect DNS, TLS certificate, public challenge response, and validator probe details.";
  }
  if (!input.publicOk) {
    return "Route is active but public checks failed; inspect DNS, certificate state, gateway reachability, job schedule, and Acurast runtime health.";
  }
  return "No action needed.";
}

function secondsToIso(value: string | undefined): string | undefined {
  if (!value || !/^[0-9]+$/.test(value)) {
    return undefined;
  }
  return unixSecondsToIso(Number(value));
}

function unixSecondsToIso(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return new Date(value * 1000).toISOString();
}

export function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLocalOperatorUrl(rawUrl: string): boolean {
  const hostname = new URL(rawUrl).hostname;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stringRecordField(record: unknown, name: string): string | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const value = (record as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function knownTxHash(value: string | undefined): string | undefined {
  return value && value.toLowerCase() !== "unknown" ? value : undefined;
}

function requiredStringRecordField(record: unknown, name: string): string {
  const value = stringRecordField(record, name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function stringArrayRecordField(record: unknown, name: string): string[] {
  if (!record || typeof record !== "object") {
    return [];
  }
  const value = (record as Record<string, unknown>)[name];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function nestedRecord(record: unknown, name: string): Record<string, unknown> | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  const value = (record as Record<string, unknown>)[name];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringNestedField(record: unknown, parent: string, name: string): string | undefined {
  return stringRecordField(nestedRecord(record, parent), name);
}

function stringArrayNestedField(record: unknown, parent: string, name: string): string[] {
  return stringArrayRecordField(nestedRecord(record, parent), name);
}

function objectArrayNestedField(record: unknown, parent: string, name: string): Array<Record<string, unknown>> {
  const parentRecord = nestedRecord(record, parent);
  if (!parentRecord) {
    return [];
  }
  const value = parentRecord[name];
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function numberRecordField(record: unknown, name: string): number | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const value = (record as Record<string, unknown>)[name];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanRecordField(record: unknown, name: string): boolean {
  if (!record || typeof record !== "object") {
    return false;
  }
  return (record as Record<string, unknown>)[name] === true;
}

function unixSecondsField(record: unknown, name: string): number | undefined {
  const parsed = numberRecordField(record, name);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function appendForwardedStringFlags(childArgs: string[], flags: Map<string, string | boolean>, names: string[]): void {
  for (const name of names) {
    const value = stringFlag(flags, name);
    if (value) {
      childArgs.push(`--${name}`, value);
    }
  }
}

async function runCliChild(
  command: string,
  args: string[],
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    childStdoutToStderr?: boolean;
    transcriptWriter?: GroupedDeployTranscriptWriter;
    stream?: boolean;
    allowFailure?: boolean;
    input?: string;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...Object.fromEntries(Object.entries(options.env ?? {}).filter(([, value]) => value !== undefined))
      },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    const childStdin = child.stdin;
    if (!childStdout || !childStderr || (options.input !== undefined && !childStdin)) {
      reject(new Error(`Failed to open stdio pipes for ${command}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    const stream = options.stream ?? true;
    childStdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (stream) {
        const target = options.childStdoutToStderr ? process.stderr : process.stdout;
        if (options.transcriptWriter) {
          options.transcriptWriter.write(text, target);
        } else {
          target.write(text);
        }
      }
    });
    childStderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (stream) {
        if (options.transcriptWriter) {
          options.transcriptWriter.write(text, process.stderr);
        } else {
          process.stderr.write(text);
        }
      }
    });
    if (options.input !== undefined) {
      childStdin?.end(options.input);
    }
    child.on("error", (error) => {
      options.transcriptWriter?.flush();
      reject(error);
    });
    child.on("close", (code) => {
      options.transcriptWriter?.flush();
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) {
        const error = new Error(`${command} ${args.join(" ")} failed with ${exitCode}`) as Error & {
          stdout?: string;
          stderr?: string;
          exitCode?: number;
        };
        error.stdout = stdout;
        error.stderr = stderr;
        error.exitCode = exitCode;
        reject(error);
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

async function runDeployRunner(
  command: string,
  args: string[],
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    childStdoutToStderr?: boolean;
    action: "launch-demo" | "deploy";
    json: boolean;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!options.json) {
    console.log("");
    console.log(sectionTitle("Deployment progress"));
  }
  try {
    const transcriptWriter = options.json ? undefined : createGroupedDeployTranscriptWriter();
    return await runCliChild(command, args, {
      env: options.env,
      cwd: options.cwd,
      childStdoutToStderr: options.childStdoutToStderr,
      transcriptWriter
    });
  } catch (error) {
    if (!options.json) {
      await printDeployFailureSummary(error, options.action);
      markErrorOutputHandled(error);
    }
    throw error;
  }
}

function parseDeployReportPath(stdout: string, stderr: string): string {
  const match = stripAnsi(`${stdout}\n${stderr}`).match(/\[switchboard-deploy\] report=(.+)/);
  if (!match) {
    throw new Error("Deployment completed but did not print a switchboard-deploy report path");
  }
  return match[1].trim();
}

function parseDeployFailureReportPath(stdout: string | undefined, stderr: string | undefined): string | undefined {
  return stripAnsi(`${stdout ?? ""}\n${stderr ?? ""}`).match(/\[switchboard-deploy\] failure report=(.+)/)?.[1]?.trim();
}

async function printDeployFailureSummary(error: unknown, action: "launch-demo" | "deploy"): Promise<void> {
  const stdout = typeof (error as { stdout?: unknown })?.stdout === "string" ? (error as { stdout: string }).stdout : undefined;
  const stderr = typeof (error as { stderr?: unknown })?.stderr === "string" ? (error as { stderr: string }).stderr : undefined;
  const failureReport = parseDeployFailureReportPath(stdout, stderr);
  const message = error instanceof Error ? error.message : String(error);
  const lower = `${message}\n${stdout ?? ""}\n${stderr ?? ""}`.toLowerCase();
  const summary = deployFailureSummary(lower);

  console.error("");
  console.error(sectionTitle(action === "launch-demo" ? "Demo did not complete" : "Deploy did not complete", process.stderr));
  for (const line of formatRows([
    { label: "Last stage", value: summary.stage },
    { label: "Impact", value: summary.impact },
    { label: "Next step", value: failureReport ? "Use the report path below when reporting or resuming this run." : "Rerun with the same context or inspect the deploy output above." },
    { label: "Report", value: failureReport }
  ])) {
    console.error(line);
  }
}

export function deployFailureSummary(lower: string): { stage: string; impact: string } {
  if (lower.includes("quote funding") || lower.includes("fund-native-asset-quote") || lower.includes("fundwithassetquote") || lower.includes("quote request")) {
    return {
      stage: "Funding the Hub session",
      impact: "The Acurast job was submitted and claimed, but Switchboard funding did not complete before route setup."
    };
  }
  if (lower.includes("timed out waiting for public route") || lower.includes("public https route") || lower.includes("public route")) {
    return {
      stage: "Verifying the public HTTPS route",
      impact: "The route was created, but the public gateway did not become reachable before the route timeout."
    };
  }
  if (lower.includes("canonical dns") || lower.includes("dns materialization")) {
    return {
      stage: "Publishing canonical DNS",
      impact: "The job was claimed, but the relay did not publish or observe the canonical DNS record in time."
    };
  }
  if (lower.includes("deployment intent claim") || lower.includes("intent claimed")) {
    return {
      stage: "Claiming the deployment intent",
      impact: "The runtime did not confirm ownership of the deployment intent before the deploy runner stopped."
    };
  }
  if (lower.includes("runtime-observation") || lower.includes("did not call the register")) {
    return {
      stage: "Waiting for runtime registration",
      impact: "The Acurast job did not call Switchboard registration before the registration timeout."
    };
  }
  if (lower.includes("on-chain registration") || lower.includes("registered on hub")) {
    return {
      stage: "Confirming Hub registration",
      impact: "Funding completed, but the Hub registration was not observed before the deploy runner stopped."
    };
  }
  if (lower.includes("route activation") || lower.includes("route reconciled") || lower.includes("activated route")) {
    return {
      stage: "Activating the public route",
      impact: "The job registered, but Switchboard did not finish route activation before the timeout."
    };
  }
  if (lower.includes("acurast")) {
    return {
      stage: "Submitting the Acurast job",
      impact: "The deploy runner stopped before Switchboard could observe a ready Acurast runtime."
    };
  }
  return {
    stage: "Running the deployment",
    impact: "The deploy runner exited before Switchboard could produce a ready route."
  };
}

function markErrorOutputHandled(error: unknown): void {
  if (error && typeof error === "object") {
    (error as { switchboardOutputHandled?: boolean }).switchboardOutputHandled = true;
  }
}

function errorOutputHandled(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { switchboardOutputHandled?: boolean }).switchboardOutputHandled);
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function cliColorEnabled(stream: NodeJS.WriteStream): boolean {
  return switchboardColorEnabled(stream);
}

function envColorEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function envColorDisabled(value: string | undefined): boolean {
  return value === "0" || value?.toLowerCase() === "false";
}

function isPrivateOrLocalUrl(rawUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return false;
  }

  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") {
    return true;
  }
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  return a === 10 || a === 127 || a === 169 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function writeOutput(flags: Map<string, string | boolean>, value: unknown, printHuman: () => void) {
  if (boolFlag(flags, "json")) {
    console.log(JSON.stringify(sanitizeOutputValue(value), null, 2));
    return;
  }

  printHuman();
}

export function sanitizeOutputValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeOutputValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveOutputKey(key) && typeof nested === "string" && nested.length > 0) {
      output[key] = "[redacted]";
    } else {
      output[key] = sanitizeOutputValue(nested);
    }
  }
  return output;
}

function isSensitiveOutputKey(key: string): boolean {
  if (/env(name)?$/i.test(key)) {
    return false;
  }
  return /token|secret|private.?key|password|authorization|mnemonic|(^|_)seed($|_)|hmac|encryption.?key/i.test(key);
}

function randomNonce(): string {
  return randomBytes(16).toString("hex");
}

async function postSignedJson(
  url: string,
  payload: Record<string, unknown>,
  options: { domain: string; seed: string; ss58Format: number }
): Promise<unknown> {
  const signature = await signReportPayload(options.seed, options.domain, payload, {
    scheme: "substrate-sr25519",
    ss58Format: options.ss58Format
  });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      ...payload,
      signature
    })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${body.slice(0, 1000)}`);
  }
  return JSON.parse(body);
}

function deploymentReportPath(flags: Map<string, string | boolean>): string | undefined {
  return stringFlag(flags, "report") ?? optionalEnv("SWITCHBOARD_REPORT") ?? optionalEnv("SWITCHBOARD_DEPLOY_REPORT");
}

/**
 * Populate manifest-url and manifest-signer in a flags map with the
 * standard fallback chain used by resolveCliNetworkConfig: existing flag
 * value (set explicitly or by context) → env → production constants.
 * Used by relay/catalog admin commands that need discovery defaults.
 */
function withDiscoveryDefaults(flags: Map<string, string | boolean>): Map<string, string | boolean> {
  const next = new Map(flags);
  if (!next.has("manifest-url")) {
    next.set("manifest-url", optionalEnv("PROOF_NETWORK_MANIFEST_URL") ?? PROOF_NETWORK_MANIFEST_URL);
  }
  if (!next.has("manifest-signer")) {
    next.set("manifest-signer", optionalEnv("PROOF_NETWORK_MANIFEST_SIGNER") ?? PROOF_NETWORK_MANIFEST_SIGNER);
  }
  return next;
}

export async function resolveCliNetworkConfig(flags: Map<string, string | boolean>): Promise<CliNetworkConfig> {
  const manifestUrl = stringFlag(flags, "manifest-url") ?? optionalEnv("PROOF_NETWORK_MANIFEST_URL") ?? PROOF_NETWORK_MANIFEST_URL;
  const expectedSigner =
    stringFlag(flags, "manifest-signer") ?? optionalEnv("PROOF_NETWORK_MANIFEST_SIGNER") ?? PROOF_NETWORK_MANIFEST_SIGNER;
  const discovery = await discoverServices({
    manifestUrlCandidates: [manifestUrl],
    expectedManifestSigner: expectedSigner,
    allowExpiredManifest: boolFlag(flags, "allow-expired-manifest"),
    allowExpiredCatalogs: boolFlag(flags, "allow-expired-manifest")
  });
  const manifest = discovery.manifest;
  const activeRegistry = manifest.registries.active[0];
  const controlApiUrl = resolveControlApiEndpoints(discovery)[0];
  const activeRelay =
    manifest.relays?.find((relay) => (relay.active ?? true) && relay.controlPlaneUrl) ??
    manifest.relays?.find((relay) => (relay.active ?? true) && relay.apiBaseUrl);
  return {
    manifest,
    manifestUrl: discovery.manifestUrl,
    signer: discovery.manifestSigner,
    targetName: manifest.chain.name,
    chainId: manifest.chain.chainId,
    registryAddress: stringFlag(flags, "registry") ?? activeRegistry?.address ?? optionalEnv("INGRESS_REGISTRY_ADDRESS"),
    relayUrl:
      stringFlag(flags, "relay-url") ??
      controlApiUrl ??
      manifest.controlPlane?.apiBaseUrl ??
      activeRelay?.controlPlaneUrl ??
      activeRelay?.apiBaseUrl ??
      optionalEnv("RELAY_URL") ??
      optionalEnv("PROOF_CONTROL_PLANE_URL"),
    ethRpcUrl: stringFlag(flags, "eth-rpc-url") ?? manifest.rpc?.eth?.[0] ?? optionalEnv("HUB_ETH_RPC_URL") ?? optionalEnv("ETH_RPC_URL"),
    substrateWsUrl:
      stringFlag(flags, "substrate-ws-url") ??
      manifest.rpc?.substrate?.[0] ??
      optionalEnv("HUB_SUBSTRATE_WS_URL") ??
      optionalEnv("SUBSTRATE_WS_URL"),
    defaultAssetAddress:
      stringFlag(flags, "asset") ??
      manifest.supportedAssets?.[0]?.address ??
      optionalEnv("PAYMENT_ASSET_ADDRESS") ??
      optionalEnv("PROOF_QUOTE_DEFAULT_ASSET")
  };
}

async function checkHttpJson(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json"
      }
    });
    const body = await response.text();
    return {
      ok: response.ok,
      detail: response.ok ? `${response.status}` : `${response.status} ${body.slice(0, 240)}`
    };
  } catch (error) {
    return { ok: false, detail: safeErrorMessage(error) };
  }
}

async function checkEthRpc(rpcUrl: string, expectedChainId?: bigint): Promise<{ ok: boolean; detail: string }> {
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const network = await provider.getNetwork();
    const ok = expectedChainId === undefined || network.chainId === expectedChainId;
    return {
      ok,
      detail: `chainId=${network.chainId.toString()}${expectedChainId ? ` expected=${expectedChainId.toString()}` : ""}`
    };
  } catch (error) {
    return { ok: false, detail: safeErrorMessage(error) };
  }
}

async function checkSubstrateWs(substrateWsUrl: string): Promise<{ ok: boolean; detail: string }> {
  let api: ApiPromise | undefined;
  try {
    api = await ApiPromise.create({ provider: new WsProvider(substrateWsUrl), noInitWarn: true });
    await api.isReady;
    const chain = await api.rpc.system.chain();
    return { ok: true, detail: chain.toString() };
  } catch (error) {
    return { ok: false, detail: safeErrorMessage(error) };
  } finally {
    await api?.disconnect().catch(() => undefined);
  }
}

async function checkPolkadotLedger(flags: Map<string, string | boolean>): Promise<{ ok: boolean; detail: string }> {
  let account: Awaited<ReturnType<typeof ledgerAccount>> | undefined;
  try {
    account = await ledgerAccount({
      api: undefined as any,
      address: stringFlag(flags, "polkadot-address") ?? optionalEnv("POLKADOT_ADDRESS"),
      ss58Format: Number(stringFlag(flags, "ss58-format") ?? optionalEnv("POLKADOT_SS58_FORMAT") ?? "42"),
      mode: ledgerMode(flags),
      transport: ledgerTransport(flags),
      chain: stringFlag(flags, "ledger-chain") ?? optionalEnv("PROOF_LEDGER_CHAIN"),
      slip44: optionalIntegerFlag(flags, "ledger-slip44", "PROOF_LEDGER_SLIP44"),
      accountIndex: integerFlag(flags, "ledger-account", "PROOF_LEDGER_ACCOUNT", 0),
      addressOffset: integerFlag(flags, "ledger-address-index", "PROOF_LEDGER_ADDRESS_INDEX", 0),
      confirmAddress: boolFlag(flags, "ledger-confirm-address"),
      metadataChainId: stringFlag(flags, "ledger-metadata-chain-id") ?? optionalEnv("PROOF_LEDGER_METADATA_CHAIN_ID"),
      metadataUrl: stringFlag(flags, "ledger-metadata-url") ?? optionalEnv("PROOF_LEDGER_METADATA_URL")
    });
    return { ok: true, detail: account.address };
  } catch (error) {
    return { ok: false, detail: safeErrorMessage(error) };
  } finally {
    await account?.disconnect().catch(() => undefined);
  }
}

async function deployRunnerAvailable(): Promise<{ ok: boolean; detail: string }> {
  if (await repoScriptAvailable(INTERNAL_DEPLOY_RUNNER_SCRIPT)) {
    return { ok: true, detail: "repo deploy runner" };
  }
  const currentFile = fileURLToPath(import.meta.url);
  const deployRunner = path.join(path.dirname(currentFile), "internal", "switchboard-deploy.js");
  await access(deployRunner);
  return { ok: true, detail: "packaged deploy runner" };
}

async function resolveDeployRunner(
  repoChildArgs: string[],
  childEnv: Record<string, string | undefined>,
  context: { workDir?: string; currentFile?: string } = {}
): Promise<{ command: string; args: string[]; env: Record<string, string | undefined>; cwd?: string }> {
  const workDir = path.resolve(context.workDir ?? process.cwd());
  const cliRoot = cliPackageRoot(context.currentFile);
  const repoScript = (await repoScriptAvailable(INTERNAL_DEPLOY_RUNNER_SCRIPT, { cwd: cliRoot, currentFile: context.currentFile }))
    ? INTERNAL_DEPLOY_RUNNER_SCRIPT
    : undefined;
  if (repoScript) {
    return {
      command: "pnpm",
      args: ["--silent", repoScript, ...repoChildArgs.slice(1)],
      env: {
        ...childEnv,
        SWITCHBOARD_WORK_DIR: workDir
      },
      cwd: cliRoot
    };
  }

  const currentFile = context.currentFile ?? fileURLToPath(import.meta.url);
  const distDir = path.dirname(currentFile);
  const internalDir = path.join(distDir, "internal");
  const deployRunner = path.join(internalDir, "switchboard-deploy.js");
  const assetsDir = path.join(distDir, "..", "assets");
  await access(deployRunner).catch(() => {
    throw new Error(
      "deploy requires the packaged deploy runner. Rebuild or reinstall the Switchboard CLI package."
    );
  });

  return {
    command: process.execPath,
    args: [deployRunner, ...repoChildArgs.slice(2)],
    env: {
      ...childEnv,
      SWITCHBOARD_WORK_DIR: workDir,
      SWITCHBOARD_INTERNAL_BIN_DIR: internalDir,
      SWITCHBOARD_PACKAGED_ASSETS_DIR: assetsDir
    }
  };
}

async function resolveAcurastDirectDeployRunner(
  args: string[],
  env: Record<string, string | undefined>
): Promise<{ command: string; args: string[]; env: Record<string, string | undefined> }> {
  if (await repoScriptAvailable("acurast:deploy-express:direct")) {
    return {
      command: "pnpm",
      args: ["acurast:deploy-express:direct", "--", ...args],
      env
    };
  }

  const currentFile = fileURLToPath(import.meta.url);
  const distDir = path.dirname(currentFile);
  const internalDir = path.join(distDir, "internal");
  const assetsDir = path.join(distDir, "..", "assets");
  const acurastExpress = path.join(internalDir, "acurast-express.js");
  await access(acurastExpress).catch(() => {
    throw new Error("validator launch requires the packaged Acurast deploy runner. Rebuild or reinstall the Switchboard CLI package.");
  });

  return {
    command: process.execPath,
    args: [acurastExpress, "deploy-direct", ...args],
    env: {
      ...env,
      SWITCHBOARD_WORK_DIR: process.cwd(),
      SWITCHBOARD_INTERNAL_BIN_DIR: internalDir,
      SWITCHBOARD_PACKAGED_ASSETS_DIR: assetsDir,
      SWITCHBOARD_PREBUILT_JOB_BUNDLE: path.join(assetsDir, "jobs", "validator-job", "bundle.cjs")
    }
  };
}

async function repoScriptAvailable(
  scriptName: string,
  context: { cwd?: string; currentFile?: string } = {}
): Promise<boolean> {
  if (!isSourceCliEntrypoint(context.currentFile ?? fileURLToPath(import.meta.url))) {
    return false;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(await readFile(path.join(context.cwd ?? process.cwd(), "package.json"), "utf8"));
  } catch {
    return false;
  }
  return typeof parsed?.scripts?.[scriptName] === "string";
}

function isSourceCliEntrypoint(currentFile: string): boolean {
  return currentFile.replace(/\\/g, "/").endsWith("/cli/src/index.ts");
}

function cliPackageRoot(currentFile: string = fileURLToPath(import.meta.url)): string {
  const normalized = currentFile.replace(/\\/g, "/");
  if (normalized.endsWith("/cli/src/index.ts")) {
    return path.resolve(path.dirname(currentFile), "../..");
  }
  return path.resolve(path.dirname(currentFile), "..");
}

async function assertRepoScriptAvailable(scriptName: string, context: string): Promise<void> {
  let parsed: any;
  try {
    parsed = JSON.parse(await readFile("package.json", "utf8"));
  } catch {
    throw new Error(`${context} Could not find package.json in ${process.cwd()}.`);
  }

  if (!parsed?.scripts || typeof parsed.scripts[scriptName] !== "string") {
    throw new Error(`${context} package.json does not define the ${scriptName} script in ${process.cwd()}.`);
  }
}

async function loadCliRuntime(flags: Map<string, string | boolean>, command?: CommandName): Promise<CliRuntime> {
  const projectMatch = boolFlag(flags, "no-project")
    ? undefined
    : await findSwitchboardProjectRoot(path.resolve(stringFlag(flags, "project-dir") ?? process.cwd()));
  const projectRoot = projectMatch?.root;
  const projectConfigPath = projectMatch?.configPath;
  const projectStatePath = projectMatch?.statePath;
  const projectConfig = projectConfigPath ? await readJsonFile<SwitchboardProjectConfig>(projectConfigPath) : undefined;
  const projectState = projectRoot ? await readFirstProjectState(projectRoot) : undefined;
  const store = await readContextStore();
  const contextName = stringFlag(flags, "context") ?? switchboardContextEnv() ?? projectConfig?.context ?? store.current;
  const context = contextName ? store.contexts?.[contextName] : undefined;
  if (contextName && context && commandLoadsContextSecrets(command)) {
    await loadContextSecretFile(contextName);
  }
  if (commandLoadsOpsProfile(command)) {
    await loadSwitchboardOpsProfile({
      profile: opsProfileFromFlags(flags),
      overrideConfigEnv: true
    });
  }
  const mayCreateContext =
    command === "project-init" ||
    command === "context-set" ||
    command === "context-use" ||
    command === "context-add" ||
    command === "ops";
  if (contextName && !context && !mayCreateContext && (stringFlag(flags, "context") || projectConfig?.context === contextName)) {
    throw new Error(`Unknown Switchboard context "${contextName}". Create it with \`switchboard context add ${contextName}\` or \`switchboard context set ${contextName} ...\`.`);
  }

  return {
    projectRoot,
    projectConfigPath,
    projectStatePath,
    projectConfig,
    projectState,
    contextName,
    context,
    contextStorePath: contextStorePath()
  };
}

function commandLoadsOpsProfile(command: CommandName | undefined): boolean {
  if (!command) return false;
  return (
    command === "ops" ||
    command === "bootstrap" ||
    command === "operator-setup" ||
    command === "operator-discover" ||
    command === "catalog-build" ||
    command === "catalog-inspect" ||
    command === "catalog-verify" ||
    command === "catalog-set-state" ||
    command.startsWith("relay-")
  );
}

function commandLoadsContextSecrets(command: CommandName | undefined): boolean {
  if (!command) return false;
  return !(
    command === "ops" ||
    command === "bootstrap" ||
    command === "operator-setup" ||
    command === "operator-discover" ||
    command === "catalog-build" ||
    command === "catalog-inspect" ||
    command === "catalog-verify" ||
    command === "catalog-set-state" ||
    command.startsWith("relay-")
  );
}

function opsProfileFromFlags(flags: Map<string, string | boolean>): string {
  return normalizeSwitchboardProfileName(
    stringFlag(flags, "ops-profile") ??
      stringFlag(flags, "profile") ??
      optionalEnv(SWITCHBOARD_OPS_PROFILE_ENV) ??
      DEFAULT_SWITCHBOARD_OPS_PROFILE
  );
}

async function readFirstProjectState(projectRoot: string): Promise<SwitchboardProjectState | undefined> {
  for (const candidate of await projectStateReadCandidates(projectRoot)) {
    const state = await readJsonFile<SwitchboardProjectState>(candidate).catch(() => undefined);
    if (state) {
      return state;
    }
  }
  return undefined;
}

function switchboardContextEnv(): string | undefined {
  return optionalEnv(SWITCHBOARD_CONTEXT_ENV);
}

function applyRuntimeDefaults(
  flags: Map<string, string | boolean>,
  runtime: CliRuntime,
  command: CommandName
): Map<string, string | boolean> {
  const output = new Map(flags);
  const setString = (name: string, value: string | number | undefined) => {
    if (!output.has(name) && value !== undefined && String(value).length > 0) {
      output.set(name, String(value));
    }
  };
  const setBool = (name: string, value: boolean | undefined) => {
    if (!output.has(name) && value === true) {
      output.set(name, true);
    }
  };

  const project = runtime.projectConfig;
  const deploy = project?.deploy;
  const useProjectDeployDefaults = command === "deploy" || command === "deployment-status";
  setString("context", runtime.contextName);
  setString("endpoint", project?.endpoint?.hostname);
  setString("endpoint-hostname", project?.endpoint?.hostname);
  setString("endpoint-id", project?.endpoint?.id);
  if (useProjectDeployDefaults) {
    setString("duration-minutes", deploy?.durationMinutes);
    setString("schedule-buffer-minutes", deploy?.scheduleBufferMinutes);
    setString("operator-id", deploy?.operatorId);
    setString("processor", deploy?.processor);
    setString("payment-mode", deploy?.paymentMode);
    setBool("quote", deploy?.quote);
  }
  if (!output.has("report") && runtime.projectState?.latestReport && runtime.projectRoot) {
    output.set("report", resolveProjectPath(runtime.projectRoot, runtime.projectState.latestReport));
  }
  setString("project", project?.acurast?.project);
  setString("network", project?.acurast?.network);
  setString("stage-dir", project?.acurast?.stageDir ? resolveProjectPath(runtime.projectRoot, project.acurast.stageDir) : undefined);
  if (useProjectDeployDefaults) {
    setString("entrypoint", project?.acurast?.entrypoint ? resolveProjectPath(runtime.projectRoot, project.acurast.entrypoint) : undefined);
  }

  const context = runtime.context;
  setString("manifest-url", context?.manifestUrl);
  setString("manifest-signer", context?.manifestSigner);
  setString("target", context?.target);
  if (useProjectDeployDefaults) {
    setString("operator-id", context?.operatorId);
  }
  setString("relay-url", context?.relayUrl);
  setString("payment-mode", context?.paymentMode);
  setString("network", context?.acurastNetwork);
  setString("polkadot-signer", context?.polkadotSigner);
  setString("polkadot-seed", contextEnv(context?.polkadotSeedEnv));
  setString("polkadot-address", polkadotAddressFromRuntime(runtime));
  setString("ss58-format", context?.polkadotSs58Format);
  setString("ledger-mode", context?.ledgerMode);
  setString("ledger-transport", context?.ledgerTransport);
  setString("ledger-chain", context?.ledgerChain);
  setString("ledger-slip44", context?.ledgerSlip44);
  setString("ledger-account", context?.ledgerAccount);
  setString("ledger-address-index", context?.ledgerAddressIndex);
  setString("ledger-metadata-chain-id", context?.ledgerMetadataChainId);
  setString("ledger-metadata-url", context?.ledgerMetadataUrl);
  const developerPrivateKey = developerPrivateKeyFromRuntime(runtime);
  if (developerPrivateKey && !output.has("developer-private-key")) {
    output.set("developer-private-key", developerPrivateKey);
  }

  return output;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function contextStorePath(): string {
  return switchboardContextStorePath();
}

export async function readContextStore(): Promise<SwitchboardContextStore> {
  const filePath = contextStorePath();
  if (await fileExists(filePath)) {
    const parsed = await readJsonFile<SwitchboardContextStore>(filePath);
    return {
      current: parsed.current,
      contexts: parsed.contexts ?? {}
    };
  }
  return { contexts: {} };
}

export async function writeContextStore(store: SwitchboardContextStore): Promise<void> {
  await writeJsonFile(contextStorePath(), {
    current: store.current,
    contexts: store.contexts ?? {}
  });
}

export function sanitizeContextForOutput(context: SwitchboardContext | undefined): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }
  return { ...stripRemovedContextFields(context) };
}

function contextEnv(envName: string | undefined): string | undefined {
  return envName ? optionalEnv(envName) : undefined;
}

function contextEnvDetail(runtime: CliRuntime, key: keyof SwitchboardContext, fallback: string): string {
  const envName = runtime.context?.[key];
  return typeof envName === "string" && envName.length > 0 ? `${envName} via context ${runtime.contextName}` : fallback;
}

function polkadotAddressDetail(runtime: CliRuntime): string {
  if (runtime.context?.polkadotAddressEnv) {
    return `${runtime.context.polkadotAddressEnv} via context ${runtime.contextName}`;
  }
  if (runtime.context?.polkadotAddress) {
    return `${runtime.context.polkadotAddress} via context ${runtime.contextName}`;
  }
  return "POLKADOT_ADDRESS";
}

function acurastSeedFromRuntime(runtime: CliRuntime): string | undefined {
  return contextEnv(runtime.context?.acurastSeedEnv) ?? optionalEnv("ACURAST_MAINNET_SEED") ?? optionalEnv("ACURAST_SEED");
}

function acurastAddressFromRuntime(runtime: CliRuntime): string | undefined {
  return contextEnv(runtime.context?.acurastAddressEnv) ?? optionalEnv("ACURAST_MAINNET_ADDRESS") ?? optionalEnv("ACURAST_ADDRESS");
}

function polkadotAddressFromRuntime(runtime: CliRuntime): string | undefined {
  return contextEnv(runtime.context?.polkadotAddressEnv) ?? runtime.context?.polkadotAddress ?? optionalEnv("POLKADOT_ADDRESS");
}

function developerPrivateKeyFromRuntime(runtime: CliRuntime): string | undefined {
  return contextEnv(runtime.context?.developerPrivateKeyEnv) ?? optionalEnv("DEVELOPER_PRIVATE_KEY") ?? optionalEnv("EVM_PRIVATE_KEY");
}

function cloudflareApiTokenFromRuntime(runtime: CliRuntime): string | undefined {
  return contextEnv(runtime.context?.cloudflareApiTokenEnv) ?? optionalEnv("CLOUDFLARE_API_TOKEN");
}

function contextRuntimeEnv(runtime: CliRuntime): Record<string, string | undefined> {
  return {
    ACURAST_MAINNET_SEED: acurastSeedFromRuntime(runtime),
    ACURAST_MAINNET_ADDRESS: acurastAddressFromRuntime(runtime),
    POLKADOT_SEED: contextEnv(runtime.context?.polkadotSeedEnv) ?? optionalEnv("POLKADOT_SEED"),
    POLKADOT_ADDRESS: polkadotAddressFromRuntime(runtime),
    POLKADOT_SS58_FORMAT: runtime.context?.polkadotSs58Format ?? optionalEnv("POLKADOT_SS58_FORMAT"),
    PROOF_POLKADOT_SIGNER: runtime.context?.polkadotSigner ?? optionalEnv("PROOF_POLKADOT_SIGNER"),
    PROOF_LEDGER_MODE: runtime.context?.ledgerMode ?? optionalEnv("PROOF_LEDGER_MODE"),
    PROOF_LEDGER_TRANSPORT: runtime.context?.ledgerTransport ?? optionalEnv("PROOF_LEDGER_TRANSPORT"),
    PROOF_LEDGER_CHAIN: runtime.context?.ledgerChain ?? optionalEnv("PROOF_LEDGER_CHAIN"),
    PROOF_LEDGER_SLIP44: runtime.context?.ledgerSlip44 ?? optionalEnv("PROOF_LEDGER_SLIP44"),
    PROOF_LEDGER_ACCOUNT: runtime.context?.ledgerAccount ?? optionalEnv("PROOF_LEDGER_ACCOUNT"),
    PROOF_LEDGER_ADDRESS_INDEX: runtime.context?.ledgerAddressIndex ?? optionalEnv("PROOF_LEDGER_ADDRESS_INDEX"),
    PROOF_LEDGER_METADATA_CHAIN_ID: runtime.context?.ledgerMetadataChainId ?? optionalEnv("PROOF_LEDGER_METADATA_CHAIN_ID"),
    PROOF_LEDGER_METADATA_URL: runtime.context?.ledgerMetadataUrl ?? optionalEnv("PROOF_LEDGER_METADATA_URL"),
    DEVELOPER_PRIVATE_KEY: developerPrivateKeyFromRuntime(runtime),
    CLOUDFLARE_API_TOKEN: cloudflareApiTokenFromRuntime(runtime)
  };
}

function publicDeployRunnerSafetyEnv(): Record<string, string> {
  return {
    PROOF_CONTROL_PLANE_TOKEN: "",
    SWITCHBOARD_CONTROL_TOKEN: "",
    SWITCHBOARD_DEPLOY_ROUTE_INTENT_URL: "",
    SWITCHBOARD_DEPLOY_ROUTE_ACTIVATION_MODE: "relay-reconciled",
    SWITCHBOARD_DEPLOY_VALIDATOR_MODE: "skip",
    SWITCHBOARD_DEPLOY_ACTIVATE: "",
    SWITCHBOARD_DEPLOY_RECORD_FULFILLMENT: "",
    SWITCHBOARD_DEPLOY_ALLOW_MANUAL_FULFILLMENT: ""
  };
}

async function saveProjectDeployment(runtime: CliRuntime, output: Record<string, any>): Promise<void> {
  if (!runtime.projectRoot || !runtime.projectStatePath) {
    return;
  }
  const reportPath = typeof output.reportPath === "string" ? projectRelativePath(runtime.projectRoot, output.reportPath) : undefined;
  const latestDeployment = {
    reportPath,
    hostname: output.hostname,
    validationHostname: output.validationHostname,
    url: output.url,
    deploymentId: output.deploymentId,
    sessionId: output.sessionId,
    jobId: output.jobId,
    jobSigner: output.jobSigner,
    relayUrl: output.relayUrl,
    updatedAt: new Date().toISOString()
  };
  pruneUndefined(latestDeployment);
  const previous = runtime.projectState ?? {};
  const reports = [
    latestDeployment,
    ...(previous.reports ?? []).filter((item) => item.reportPath !== reportPath)
  ].slice(0, 20);
  await writeJsonFile(runtime.projectStatePath, {
    ...previous,
    latestReport: reportPath ?? previous.latestReport,
    latestDeployment,
    reports
  });
}

function resolveProjectPath(projectRoot: string | undefined, value: string): string {
  if (!projectRoot || path.isAbsolute(value)) {
    return value;
  }
  return path.join(projectRoot, value);
}

function projectRelativePath(projectRoot: string, value: string): string {
  const absolute = path.resolve(value);
  const relative = path.relative(projectRoot, absolute);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : absolute;
}

async function ensureGitignoreEntries(projectRoot: string, entries: string[]): Promise<void> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const existing = (await readFile(gitignorePath, "utf8").catch(() => "")) as string;
  const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((entry) => !lines.has(entry));
  if (missing.length === 0) {
    return;
  }
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(gitignorePath, `${existing}${prefix}\n# Switchboard CLI\n${missing.join("\n")}\n`);
}

export function pruneUndefined(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) {
      delete (value as Record<string, unknown>)[key];
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      pruneUndefined(item);
      if (Object.keys(item as Record<string, unknown>).length === 0) {
        delete (value as Record<string, unknown>)[key];
      }
    }
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (arg.startsWith("--")) {
      const withoutPrefix = arg.slice(2);
      if (withoutPrefix.startsWith("no-")) {
        flags.set(withoutPrefix, true);
        continue;
      }

      const equalsIndex = withoutPrefix.indexOf("=");
      if (equalsIndex >= 0) {
        flags.set(withoutPrefix.slice(0, equalsIndex), withoutPrefix.slice(equalsIndex + 1));
        continue;
      }

      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        flags.set(withoutPrefix, next);
        index += 1;
      } else {
        flags.set(withoutPrefix, true);
      }
      continue;
    }

    positionals.push(arg);
  }

  return {
    command: normalizeCommand(positionals),
    flags,
    positionals
  };
}

function normalizeCommand(positionals: string[]): CommandName {
  if (positionals.length === 0) {
    return "help";
  }
  if (positionals.length === 1) {
    const [value] = positionals;
    if (value === "help") {
      return "help";
    }
    if (value === "init") {
      return "project-init";
    }
    if (value === "project") {
      return "project-show";
    }
    if (value === "context") {
      return "context-current";
    }
    if (value === "preflight") {
      return "preflight";
    }
    if (value === "claim") {
      return "claim";
    }
    if (value === "claimable") {
      return "claimable";
    }
    if (value === "refund") {
      return "session-refund";
    }
    if (value === "refundable") {
      return "session-refundable";
    }
    if (value === "launch-demo") {
      return "launch-demo";
    }
    if (value === "deploy") {
      return "deploy";
    }
    if (value === "status") {
      return "deployment-status";
    }
    if (value === "ops") {
      return "ops";
    }
  }
  if (positionals.length >= 1 && positionals[0] === "ops") {
    return "ops";
  }
  if (positionals.length >= 1 && positionals[0] === "bootstrap") {
    return "bootstrap";
  }
  if (positionals.length >= 2 && positionals[0] === "project" && positionals[1] === "init") {
    return "project-init";
  }
  if (positionals.length >= 2 && positionals[0] === "project" && positionals[1] === "show") {
    return "project-show";
  }
  if (positionals.length >= 2 && positionals[0] === "context" && (positionals[1] === "list" || positionals[1] === "ls")) {
    return "context-list";
  }
  if (positionals.length >= 2 && positionals[0] === "context" && positionals[1] === "current") {
    return "context-current";
  }
  if (positionals.length >= 2 && positionals[0] === "context" && positionals[1] === "use") {
    return "context-use";
  }
  if (positionals.length >= 2 && positionals[0] === "context" && positionals[1] === "add") {
    return "context-add";
  }
  if (positionals.length >= 3 && positionals[0] === "context" && positionals[1] === "dns" && positionals[2] === "set") {
    return "context-dns-set";
  }
  if (
    positionals.length >= 3 &&
    positionals[0] === "context" &&
    positionals[1] === "dns" &&
    (positionals[2] === "clear" || positionals[2] === "remove" || positionals[2] === "rm")
  ) {
    return "context-dns-clear";
  }
  if (positionals.length >= 2 && positionals[0] === "context" && positionals[1] === "set") {
    return "context-set";
  }
  if (
    positionals.length === 2 &&
    positionals[0] === "session" &&
    positionals[1] === "register"
  ) {
    return "session-register";
  }
  if (positionals.length === 2 && positionals[0] === "session" && positionals[1] === "status") {
    return "session-status";
  }
  if (positionals.length === 2 && positionals[0] === "session" && positionals[1] === "refund") {
    return "session-refund";
  }
  if (positionals.length === 2 && positionals[0] === "session" && positionals[1] === "refundable") {
    return "session-refundable";
  }
  if (positionals.length >= 2 && positionals[0] === "hostname" && positionals[1] === "add") {
    return "hostname-attach";
  }
  if (positionals.length >= 2 && positionals[0] === "hostname" && positionals[1] === "remove") {
    return "hostname-remove";
  }
  if (positionals.length >= 2 && positionals[0] === "hostname" && positionals[1] === "status") {
    return "hostname-status";
  }
  if (positionals.length === 2 && positionals[0] === "operator" && positionals[1] === "discover") {
    return "operator-discover";
  }
  if (positionals.length === 2 && positionals[0] === "operator" && positionals[1] === "status") {
    return "operator-status";
  }
  if (positionals.length === 2 && positionals[0] === "operator" && positionals[1] === "upgrade") {
    return "operator-upgrade";
  }
  if (positionals.length === 2 && positionals[0] === "operator" && positionals[1] === "setup") {
    return "operator-setup";
  }
  if (positionals.length === 2 && positionals[0] === "validator" && positionals[1] === "launch") {
    return "validator-launch";
  }
  if (positionals.length >= 2 && positionals[0] === "relay" && positionals[1] === "deploy") {
    return "relay-deploy";
  }
  if (
    positionals.length >= 3 &&
    positionals[0] === "relay" &&
    positionals[1] === "catalog" &&
    (positionals[2] === "set-state" || positionals[2] === "state")
  ) {
    return "relay-catalog-set-state";
  }
  if (
    positionals.length >= 3 &&
    positionals[0] === "relay" &&
    positionals[1] === "dns" &&
    (positionals[2] === "plan" ||
      positionals[2] === "apply" ||
      positionals[2] === "verify" ||
      positionals[2] === "remove")
  ) {
    return "relay-dns";
  }
  if (positionals.length >= 2 && positionals[0] === "relay" && positionals[1] === "status") {
    return "relay-status";
  }
  if (positionals.length === 1 && positionals[0] === "relay") {
    return "help";
  }
  if (positionals.length === 1 && positionals[0] === "catalog") {
    return "help";
  }
  if (positionals.length >= 2 && positionals[0] === "relay") {
    const verb = positionals[1];
    if (verb === "sync") return "relay-sync";
    if (verb === "list" || verb === "ls") return "relay-list";
    if (verb === "diff") return "relay-diff";
    if (verb === "backfill-specs") return "relay-backfill-specs";
    if (verb === "keygen") return "relay-keygen";
    if (verb === "pick-processor") return "relay-pick-processor";
    if (verb === "scaffold") return "relay-scaffold";
    if (verb === "drain") return "relay-drain";
    if (verb === "replace") return "relay-replace";
    if (verb === "rotate-key") return "relay-rotate-key";
    if (verb === "deployments") return "relay-deployments";
    if (verb === "logs") return "relay-logs";
    if (verb === "promote") return "relay-promote";
    if (verb === "watch") return "relay-watch";
    if (verb === "verify") return "relay-verify";
    if (verb === "budget") return "relay-budget";
    if (verb === "whoami") return "relay-whoami";
    if (verb === "inspect") return "relay-inspect";
    if (verb === "deployment-status") return "relay-deployment-status";
    if (
      positionals.length >= 3 &&
      verb === "catalog" &&
      positionals[2] === "build"
    ) {
      return "relay-catalog-build";
    }
  }
  if (positionals.length >= 2 && positionals[0] === "catalog") {
    if (positionals[1] === "build") return "catalog-build";
    if (positionals[1] === "inspect") return "catalog-inspect";
    if (positionals[1] === "verify") return "catalog-verify";
    if (positionals[1] === "set-state") return "catalog-set-state";
  }

  throw new Error(`Unknown command: ${positionals.join(" ")}`);
}

function targetFromFlags(flags: Map<string, string | boolean>, manifestConfig?: CliNetworkConfig): SwitchboardTargetConfig {
  return getSwitchboardTarget(
    stringFlag(flags, "target") ??
    manifestConfig?.targetName ??
    optionalEnv("SWITCHBOARD_TARGET") ??
    "polkadot-hub"
  );
}

function deployDurationMinutes(flags: Map<string, string | boolean>): number {
  const raw =
    stringFlag(flags, "duration-minutes") ??
    stringFlag(flags, "lease-minutes") ??
    optionalEnv("SWITCHBOARD_DEPLOY_DURATION_MINUTES") ??
    String(DEFAULT_DEPLOY_DURATION_MINUTES);
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error("duration-minutes must be a positive integer");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("duration-minutes must be a positive integer");
  }
  return parsed;
}

export function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

export function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function positionalAfterCommand(positionals: string[]): string | undefined {
  return positionals.length > 2 ? positionals[2] : undefined;
}

function normalizeHostnameForCli(value: string | undefined): string | undefined {
  return value ? value.trim().replace(/\.$/, "").toLowerCase() : undefined;
}

function normalizeEndpointIdForCli(value: string): string {
  return value.trim().replace(/\.$/, "").toLowerCase();
}

function randomUint256String(): string {
  return BigInt(ethers.hexlify(ethers.randomBytes(32))).toString();
}

function requiredStringFlag(flags: Map<string, string | boolean>, flagName: string, envName: string): string {
  const value = stringFlag(flags, flagName) ?? optionalEnv(envName);
  if (!value) {
    throw new Error(`Missing --${flagName} or ${envName}`);
  }

  return value;
}

function optionalIntegerFlag(flags: Map<string, string | boolean>, flagName: string, envName: string): number | undefined {
  const value = stringFlag(flags, flagName) ?? optionalEnv(envName);
  return value ? parseIntegerFlagValue(flagName, value) : undefined;
}

function integerFlag(flags: Map<string, string | boolean>, flagName: string, envName: string, fallback: number): number {
  return optionalIntegerFlag(flags, flagName, envName) ?? fallback;
}

function numberFlag(flags: Map<string, string | boolean>, flagName: string, envName: string, fallback: number): number {
  const value = stringFlag(flags, flagName) ?? optionalEnv(envName);
  if (!value) {
    return fallback;
  }

  return parseIntegerFlagValue(flagName, value);
}

function parseIntegerFlagValue(flagName: string, value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${flagName} must be a non-negative integer`);
  }

  return Number(value);
}

function optionalNumberEnv(name: string): number | undefined {
  const value = optionalEnv(name);
  if (!value) {
    return undefined;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return Number(value);
}

export function printHelp(options: { advanced?: boolean } = {}) {
  const advanced = options.advanced === true;
  const advancedCommands = advanced
    ? `
Advanced session commands:
  session register
          Sign and relay registration for a funded session.
  session status
          Read raw Hub session state.
  session refund
          Refund an eligible unactivated or unfulfilled developer session.
  session refundable
          Check whether a developer session has an available refund.

PROOF ops commands:
  ops init|show|paths|env [profile]
          Manage CLI-owned ops config and secrets under ~/.switchboard/ops/.

Validator commands:
  validator launch
          Request validator admission, deploy the approved Acurast validator
          script, and register the job.

Admin catalog commands:
  catalog build|inspect|verify|set-state
          Build, inspect, verify, or update signed service catalog artifacts.

Admin relay commands:
  bootstrap acurast plan|deploy|use|endpoint|status|publish-catalog|publish-manifest|teardown
  bootstrap host plan|sync|catalog|env|deploy|status|logs
  relay sync|list|diff|backfill-specs|keygen|scaffold|pick-processor
  relay drain|replace|rotate-key|deployments|logs|promote|watch|verify
  relay budget|whoami|inspect|deployment-status|deploy|status
  relay catalog build|set-state
  relay dns plan|apply|verify|remove
          Internal relay and bootstrap operations. These load the selected
          ops profile and keep builder context secrets separate.
`
    : `
PROOF-required and admin commands are hidden from the default help.
Run \`switchboard --help --advanced\` to list them.
`;

  console.log(`switchboard
${SWITCHBOARD_LOCKUP}

Public beta deployer commands:
  init
          Create switchboard.json and .switchboard/ in the current project.
  project show
          Show the current directory project config, latest deployment, and context.
  context add [name]
          Interactive wizard for developer/payment context setup.
          Pass --no-balance-check to skip network calls.
  context dns set cloudflare --token-env <NAME>
          Attach a DNS provider API token by env-var name.
  context dns clear [provider]
          Detach a DNS provider from the context.
  context list | context current | context use <name> | context set <name>
          Manage named developer/payment/beta-access contexts.
  preflight
          Check manifest, RPCs, credentials, payment, DNS, and deploy readiness.
  launch-demo
          Launch the bundled demo on current live operator capacity.
  deploy
          Deploy a project workload from switchboard.json or --entrypoint.
  status
          Diagnose a deployment from its report.
  claimable
          Check released operator, validator, or PROOF rewards without submitting.
  claim
          Inspect and withdraw released operator, validator, or PROOF rewards.
  refundable
          Check whether a developer session has an available refund.
  refund
          Refund an eligible unactivated or unfulfilled developer session.
  hostname add <hostname>
          Add a customer CNAME to an endpoint with a developer signature.
  hostname remove <hostname>
          Remove a customer CNAME from an endpoint and gateway route.
  hostname status <hostname>
          Check customer CNAME validation and certificate authorization status.
  operator setup
          Prepare host Docker/Compose config and launch an operator stack.
  operator discover
          Check manager-scoped operator readiness and suggest env config.
  operator status
          Show local compose, gateway-agent, and relay capability registration state.
  operator upgrade
          Pull current operator images and recreate the Docker Compose stack.
${advancedCommands}
Common flags:
  --project-dir <path>             Project directory, defaults to current directory/ancestor
  --context <name>                 Named identity/access context
  --no-project                     Ignore switchboard.json and .switchboard state
  --target <name>                  revive-local, polkadot-hub-testnet, polkadot-hub
  --registry <address>             IngressRegistry contract address
  --eth-rpc-url <url>              Hub Ethereum JSON-RPC URL
  --substrate-ws-url <url>         Hub Substrate WebSocket URL
  --polkadot-signer <mode>         seed (default) or ledger
  --hub-signer <mode>              evm or polkadot for claim/refund transactions
  --polkadot-address <address>     Native account used for USDC quote funding
  --polkadot-seed <uri>            Native account seed for USDC quote funding
  --ledger                         Alias for --polkadot-signer ledger
  --ledger-mode <mode>             generic (Polkadot app) or legacy (Statemint app)
  --ledger-account <n>             Ledger account index, default 0
  --ledger-address-index <n>       Ledger address index, default 0
  --ledger-metadata-chain-id <id>  Zondax metadata-service chain ID for generic signing
  --ledger-metadata-url <url>      Generic app metadata service URL
  --job-signer-address <address>   Expected job signer for the funded session
  --session-label <label>          Derive session/job IDs from a label
  --session-id <bytes32>           Explicit derived session ID
  --session-salt <bytes32>         Explicit session salt for deterministic ID derivation
  --job-id <bytes32>               Explicit job ID
  --operator-id <bytes32>          Explicit operator ID
  --processor-id <bytes32>         Explicit processor ID
  --endpoint-hostname <hostname>   Hostname bound into endpointHash
  --json                           Machine-readable output
  --manifest-url <url>             Default ${PROOF_NETWORK_MANIFEST_URL}
  --manifest-signer <signer>       Expected signed manifest signer
  --allow-expired-manifest         Accept an expired manifest for diagnostics only
  --yes                            Required for deploy, claim/refund, and session register
  --relay-url <url>                Relay API URL for session register

Claim and refund:
  switchboard claimable --recipient <address>
  switchboard claim --recipient <address>
  switchboard claim --claim-private-key-env OPERATOR_CLAIM_PRIVATE_KEY --yes
  switchboard refundable --session-id <bytes32>
  switchboard refund --session-id <bytes32>
${advanced ? "  switchboard session refund --session-id <bytes32> --yes\n" : ""}  switchboard refund --session-id <bytes32> --yes
  claimable and refundable are read-only checks, even if --yes is present.
  claim withdraws claimableBalances(asset, msg.sender) for operator, validator,
  and PROOF reward recipients. refund calls the session-specific developer
  refund path: refundAfterActivationTimeout or refundUnfulfilled.
  --asset <address>                Asset to claim, default first manifest asset
  --recipient <address>            Read claimable balance without a signer
  --claim-private-key <key>        EVM reward-recipient private key
  --claim-private-key-env <env>    Env var containing EVM reward key
  --private-key <key>              Generic EVM key for claim/refund
  --refund-reason <reason>         activation-timeout or unfulfilled
  --storage-deposit-limit <n>      Native revive.call storage deposit limit
  --ref-time <n>                   Native revive.call refTime limit
  --proof-size <n>                 Native revive.call proofSize limit
  --no-map-account                 Do not submit revive.mapAccount first

Project config:
  switchboard init --project <name> --endpoint <hostname> --context <name>
  switchboard project show
  Directory-local config is stored in switchboard.json. Deployment state,
  latest report pointers, and local caches are stored in .switchboard/.

Contexts:
  switchboard context add mainnet
  switchboard context set mainnet --use --polkadot-address-env POLKADOT_ADDRESS --polkadot-seed-env POLKADOT_SEED
  switchboard context set ledger --use --polkadot-signer ledger --polkadot-address <address> --ledger-account 0
  switchboard context use mainnet
  Contexts live in ~/.switchboard/contexts.json by default and store env var
  names for secrets, not secret values. The CLI also auto-loads
  ~/.switchboard/secrets/<context>.env when the selected context exists.
  Override with SWITCHBOARD_HOME or SWITCHBOARD_CONTEXT_SECRET_FILE.
  --acurast-seed-env <env>         Env var containing the Acurast deploy seed
  --acurast-address-env <env>      Env var containing the expected Acurast address
  --polkadot-seed-env <env>        Env var containing the Polkadot payment seed
  --polkadot-address-env <env>     Env var containing the Polkadot payment address
  --polkadot-address <address>     Store non-secret Polkadot payment address directly
  --polkadot-ss58-format <n>       Store preferred ss58 format for local native seed signing
  --ledger-chain <chain>           Ledger chain key, default polkadot or statemint legacy
  --ledger-slip44 <n>              Generic Ledger slip44, default 354
  --developer-private-key-env <env> Env var containing the EVM developer key
  --cloudflare-api-token-env <env> Env var containing DNS authority token

${advanced ? `Ops profiles:
  switchboard ops init mainnet --domain switchboard.proof.computer
  switchboard ops show mainnet
  switchboard ops paths mainnet --context mainnet
  Ops config lives in ~/.switchboard/ops/<profile>/config.json and secrets
  in ~/.switchboard/ops/<profile>/secrets.env. Use --ops-profile <name> or
  SWITCHBOARD_OPS_PROFILE to select a profile for relay/catalog/operator admin
  commands. Managed ops commands treat the profile config as authoritative for
  non-secret config; explicit command flags still win, and non-empty shell
  secrets are preserved over blank secret-file placeholders.

` : ""}
Customer hostnames:
  switchboard hostname add app.example.com --developer-private-key <key>
  switchboard hostname remove app.example.com --developer-private-key <key>
  switchboard hostname status app.example.com
  The CLI looks up NS records and prints the likely DNS control-panel link.
  --endpoint <hostname>            Canonical PROOF endpoint, defaults from --report
  --endpoint-id <id>               Stable endpoint ID, defaults to endpoint hostname
  --customer-hostname <hostname>   Alternative to positional hostname
  --tls-mode <mode>                proof-acme (default) or byo-certificate
  --byo-tls                        Alias for --tls-mode byo-certificate
  --manual-dns01                   Use manual _acme-challenge TXT instead of CNAME delegation
  --certificate-validation-mode <mode>
                                  dns01-cname-delegation (default) or dns01-manual
  --developer-private-key <key>    EVM developer key matching the funded session
  --hub-signer <mode>              evm or polkadot; auto-detects matching signer when possible
  --polkadot-seed <uri>            Native signer seed for sessions funded from a mapped Polkadot account
  --polkadot-address <address>     Expected native signer address
  --chain-id <id>                  EIP-712 chain ID, default from target/CHAIN_ID
  --wait                           Poll until DNS validates, default 300 seconds
  --wait-seconds <n>               Explicit wait duration
  --poll-seconds <n>               Poll interval, default 10
  --route-intent-url <url>         Gateway route-intent API for customer SNI status
  --operator-ssh-host <host>       SSH host when the route-intent API is on the operator
  --check-timeout-ms <n>           HTTPS readiness timeout, default 10000
  --skip-readiness-checks          Only show relay DNS/certificate authorization state

Operator setup:
  switchboard operator setup --manager-address <address> --manager-id <id>
  --management-address <address>   Alias for --manager-address
  --public-address <ip-or-host>    Default fetched with curl --ipv4 https://ifconfig.me/ip
  --env-file <path>                Default .operator-host/operator.env
  --image-registry <registry/ns>   Default ghcr.io/proof-computer/switchboard-gateway
  --image-tag <tag>                Default latest
  --skip-install                   Do not install Docker/Compose if missing
  --skip-compose                   Write config but do not launch compose
  --route-state-url <url>          Default control-plane route-state polling URL when OPERATOR_ID is known
  --local-build                    Build local repo images instead of pulling prebuilt images
  --dry-run                        Print checks and planned actions only

Operator discover:
  switchboard operator discover --manager-id <id> --public-address <ip-or-host>
  --gateway-agent-url <url>        Default http://127.0.0.1:18080
  --available                      Check Acurast schedule conflicts; enabled by default
  --skip-availability              Skip existing-job/schedule conflict checks
  --limit <n>                      Test next n processors not checked recently
  --smoke-hostname <hostname>      Temporarily route and TLS-probe this SNI name
  --state-file <path>              Operator-local discovery state file
  --ready-ttl-ms <ms>              Recent-ready TTL for cached readiness
  --recent-check-ttl-ms <ms>       Recent-check TTL for --limit
  --no-state                       Do not read or write discovery state
  --write-env <path>               Write suggested operator env values

Operator status and upgrade:
  switchboard operator status
  switchboard operator upgrade --yes
  --project-dir <path>             Operator project directory
  --compose-file <path[,path...]>  Compose file(s), default docker-compose.yaml
  --env-file <path>                Env file, default .operator-host/operator.env
  --gateway-agent-url <url>        Status check URL, default http://127.0.0.1:18080
  --capability-url <url>           Relay capability lookup URL
  --dry-run                        For upgrade, print docker compose commands only
  --keep-image-override            For upgrade, keep old/custom image env overrides

Launch demo:
  switchboard launch-demo --yes-spend
  --yes-spend                      Required; spends ACU and the configured Hub payment asset
  --dry-run                        Print selected capacity and planned config without side effects
  Relay                            Default ${DEFAULT_CONTROL_PLANE_URL} from the signed manifest/control plane
  Operator/manager/processor       Auto-selected from live operator capacity
  --duration-minutes <minutes>     Default ${DEFAULT_LAUNCH_DEMO_DURATION_MINUTES}
  --ha                             Request a 3-processor HA endpoint group
  --processor-count <n>            Number of processors to launch for HA, default 1 or 3 with --ha
  --min-ready <n>                  Minimum successful replicas required, default processor-count
  Ingress estimate                 Previewed before Acurast deploy/funding
  Acurast start delay              Fixed 3 minutes
  --max-cost-per-execution <n>     Default ${DEFAULT_LAUNCH_DEMO_MAX_COST_PER_EXECUTION}

Deploy defaults:
  --yes                            Required; spends ACU and the configured Hub payment asset
  --dry-run                        Print the deploy runner command without side effects
  --entrypoint <path>              Required unless switchboard.json has acurast.entrypoint
  Canonical hostname               Relay-allocated under ingress.<tld>
  --relay-url <url>                Default ${DEFAULT_CONTROL_PLANE_URL}
  Operator/manager/processor       Auto-selected from live operator capacity unless pinned
  --operator-id <bytes32>          Pin to one operator ID
  --processor <account>            Pin to one Acurast processor
  --duration-minutes <minutes>     Default ${DEFAULT_DEPLOY_DURATION_MINUTES}; derives lease seconds and job runtime
  --lease-minutes <minutes>        Alias for --duration-minutes
  --schedule-buffer-minutes <n>    Extra runtime beyond lease, default ${DEFAULT_DEPLOY_SCHEDULE_BUFFER_MINUTES}
  --quote                          Default; fund through a signed deployment-intent quote
  --payment-mode <mode>            quote only
  --report <path>                  Deployment report JSON to diagnose
${advanced ? "  --execution-ms <ms>              Override derived Acurast job runtime\n" : ""}
`);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  const currentFile = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(currentFile);
  } catch {
    return path.resolve(process.argv[1]) === currentFile;
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    if (!errorOutputHandled(error)) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[switchboard] ${message}`);
    }
    process.exitCode = 1;
  });
}
