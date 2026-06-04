#!/usr/bin/env node
import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { realpathSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { CUSTOM_TYPES, RequiredModules } from "@acurast/sdk/types";
import { u8aToHex } from "@polkadot/util";
import { decodeAddress, mnemonicGenerate } from "@polkadot/util-crypto";
import { ethers } from "ethers";

import {
  SwitchboardDeployWorkflow,
  buildAcurastDeployRequiredAction,
  buildAcurastGroupDeployRequiredAction,
  launchDemoWorkflowInput,
  redactDeployWorkflowSnapshot,
  type AcurastGroupDeployReceiptPayload,
  type SwitchboardCapacitySelection,
  type SwitchboardGroupMemberSelection,
  type SwitchboardDeployWorkflowAdapters,
  type SwitchboardDeployWorkflowEvent,
  type SwitchboardDeployWorkflowInput,
  type SwitchboardDeployWorkflowSnapshot,
  type WorkflowActionReceipt,
  type WorkflowRequiredAction
} from "../../../switchboard-sdk/src/workflows.js";
import { registerIngressWithRelay } from "../../../switchboard-sdk/src/index.js";
import type { QuoteResponse } from "../../../switchboard-sdk/src/funding.js";
import { SwitchboardControlPlaneClient, type DeploymentIntentBootstrap, type DeploymentIntentGroupBootstrap } from "../../../switchboard-sdk/src/control-plane.js";
import {
  discoverManagerProcessors,
  rpcForAcurastNetwork,
  selectReadyProcessors,
  type AcurastNetwork,
  type ProcessorInfo
} from "../../src/acurast-manager.js";
import {
  expandedReportProcessors,
  processorRefToId,
  publicIpv4Address,
  type GatewayCapabilityReport,
  type ProcessorScope
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
import {
  runRelayCatalogSetState,
  runRelayDeploy,
  runRelayStatus,
  type RunRelayCatalogSetStateOptions
} from "./relay/index.js";
import { runRelaySync, type RunRelaySyncOptions } from "./relay/sync.js";
import { runRelayList } from "./relay/list.js";
import { runRelayCatalogBuild, type RunRelayCatalogBuildOptions } from "./relay/catalog-build-from-specs.js";
import { runRelayDiff } from "./relay/diff.js";
import { runRelayBackfillSpecs } from "./relay/backfill-specs.js";
import { runRelayKeygen, type RunRelayKeygenOptions } from "./relay/keygen.js";
import { runRelayPickProcessor, type RunRelayPickProcessorOptions } from "./relay/pick-processor.js";
import { runRelayScaffold, type RunRelayScaffoldOptions } from "./relay/scaffold.js";
import { runRelayDrain } from "./relay/drain.js";
import { runRelayReplace } from "./relay/replace.js";
import { runRelayRotateKey } from "./relay/rotate-key.js";
import { runRelayDeployments } from "./relay/history.js";
import { runRelayLogs } from "./relay/logs.js";
import { runRelayPromote } from "./relay/promote.js";
import { runRelayWatch, type RunRelayWatchOptions } from "./relay/watch.js";
import { runRelayVerify } from "./relay/verify.js";
import { runRelayBudget } from "./relay/budget.js";
import { runRelayWhoami } from "./relay/whoami.js";
import { runRelayDeploymentStatus, runRelayInspect, type RelayLifecycleArgs } from "./relay/lifecycle.js";
import { runRelayDnsSubcommand, type RelayDnsSubcommandArgs } from "./relay/dns.js";
import { runBootstrapSubcommand } from "./bootstrap/acurast.js";
import {
  runCatalogBuild,
  runCatalogInspect,
  runCatalogSetState,
  runCatalogVerify
} from "./catalog/index.js";
import { contextAddCommand } from "./context/add.js";
import { contextDnsClearCommand, contextDnsSetCommand } from "./context/dns.js";
import { checkMnemonicSeed, checkSeedAddressMatch } from "./preflight/mnemonic-check.js";
import {
  DEFAULT_ACURAST_IPFS_API_KEY,
  DEFAULT_ACURAST_IPFS_URL,
  submitAcurastSingleReplicaWithSdk,
  type AcurastSdkSubmitActionPayload
} from "./acurast-submit-adapter.js";
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
  SWITCHBOARD_CONTEXT_SECRET_FILE_ENV,
  SWITCHBOARD_OPS_PROFILE_ENV,
  loadContextSecretFile,
  loadSwitchboardOpsProfile,
  normalizeSwitchboardProfileName,
  switchboardHomePaths
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
const RUNTIME_DEFAULT_FLAG_PREFIX = "__runtime-default:";
const DEFAULT_LAUNCH_DEMO_DURATION_MINUTES = 10;
const DEFAULT_LAUNCH_DEMO_START_DELAY_MS = 180_000;
const DEFAULT_LAUNCH_DEMO_MAX_COST_PER_EXECUTION = "40000000000";
const DEFAULT_LAUNCH_DEMO_PROCESSOR_MAX_AGE_SECONDS = 900;
const DEFAULT_LAUNCH_DEMO_PACKAGE_SPEC = "github:proof-computer/switchboard-express-demo#v0.1.10";
const MIN_LAUNCH_DEMO_RUNTIME_VERSION = "0.1.10";
const MIN_LAUNCH_DEMO_SDK_VERSION = "0.1.4";
const LAUNCH_DEMO_ENTRYPOINT = "src/server.ts";
const SSH_TEMPLATE_NAME = "ssh";
const SSH_TEMPLATE_DISTRO = "ubuntu";
const SSH_TEMPLATE_ENTRYPOINT = "acurast.sh";
const SSH_TEMPLATE_BOOTSTRAP = "switchboard-cargo-bootstrap.sh";
const SSH_TEMPLATE_BOOTSTRAP_PY = "switchboard-cargo-bootstrap.py";
const SSH_TEMPLATE_STUNNEL_CONFIG = "stunnel.conf";
const SSH_TEMPLATE_GETIFADDRS_OVERRIDE = "getifaddrs_override.c";
const SSH_TEMPLATE_AUTHORIZED_KEYS = "authorized_keys";
const SSH_TEMPLATE_AUTHORIZED_KEYS_EXAMPLE = "authorized_keys.example";
const SSH_TEMPLATE_BRIDGE_DIAGNOSTIC_COMMAND = "switchboard-cargo-bridge-doctor";
const SSH_AUTH_KEYS_ENV = "SSH_AUTH_KEYS";
const ACURAST_SCRIPT_RUNTIME = "script";
const ACURAST_NODE_RUNTIME = "node";
export const ACURAST_UBUNTU_SCRIPT_IMAGE_URL = "https://github.com/termux/proot-distro/releases/download/v4.30.1/ubuntu-questing-aarch64-pd-v4.30.1.tar.xz";
export const ACURAST_UBUNTU_SCRIPT_IMAGE_SHA256 = "5ab35b90cd9a9f180656261ba400a135c4c01c2da4b74522118342f985c2d328";
const ANSI_ESCAPE_PATTERN = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
export const PROOF_NETWORK_MANIFEST_URL = "https://control.switchboard.proof.computer/v1/network-manifest";
export const PROOF_NETWORK_MANIFEST_SIGNER = "5EpwnRzamXpqWo3jW9h4ecSJHL9LBjR6jTMW5Wzw6p9nMTh7";
export const PROOF_MAINNET_RECORDER_COORDINATOR_ADDRESS = "0xd4dFB4AD9A4a2AfF56CCBe479F661b84947287A5";
const INTERNAL_DEPLOY_RUNNER_SCRIPT = "switchboard:internal:deploy-runner";
const DEPLOY_WORKFLOW_SNAPSHOT_FILE = "switchboard-deploy-workflow.snapshot.json";
const DEPLOY_WORKFLOW_PRIVATE_SNAPSHOT_FILE = "switchboard-deploy-workflow.private.json";
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
  | "deploy-status"
  | "deploy-doctor"
  | "deploy-resume"
  | "deployment-status"
  | "hostname-attach"
  | "hostname-remove"
  | "hostname-status"
  | "validator-launch"
  | "validator-script"
  | "gateway-setup"
  | "gateway-discover"
  | "gateway-status"
  | "gateway-upgrade"
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
  controlApiUrls?: string[];
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
    runtime?: string;
    stageDir?: string;
    entrypoint?: string;
    scriptImage?: {
      url?: string;
      sha256?: string;
    };
    scriptFiles?: string[];
  };
  ssh?: {
    distro?: string;
    authorizedKeysFile?: string;
    user?: string;
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

export interface CliRuntime {
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
  "hostname",
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
const ACURAST_IPFS_UPLOAD_ENV_VARS = ["ACURAST_IPFS_URL", "ACURAST_IPFS_API_KEY"] as const;
type AcurastIpfsUploadEnvName = (typeof ACURAST_IPFS_UPLOAD_ENV_VARS)[number];

export async function runSwitchboardCli(argv: readonly string[] = process.argv.slice(2), runtimeOverride?: CliRuntime): Promise<void> {
  const parsed = parseArgs([...argv]);
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);

  if (parsed.command === "gateway-discover" && boolFlag(parsed.flags, "help")) {
    printOperatorDiscoverUsage();
    return;
  }

  if (parsed.command === "gateway-setup" && boolFlag(parsed.flags, "help")) {
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
    await contextUseCommand(flags, parsed.positionals, runtime);
    return;
  }

  if (parsed.command === "context-set") {
    await contextSetCommand(flags, parsed.positionals, runtime);
    return;
  }

  if (parsed.command === "context-add") {
    await contextAddCommand(flags, parsed.positionals, runtime);
    return;
  }

  if (parsed.command === "context-dns-set") {
    await contextDnsSetCommand(flags, parsed.positionals, runtime);
    return;
  }

  if (parsed.command === "context-dns-clear") {
    await contextDnsClearCommand(flags, parsed.positionals, runtime);
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

  if (parsed.command === "deploy-status") {
    await deployWorkflowStatusCommand(flags, runtime);
    return;
  }

  if (parsed.command === "deploy-doctor") {
    await deployDoctorCommand(flags, runtime);
    return;
  }

  if (parsed.command === "deploy-resume") {
    await deployWorkflowResumeCommand(flags, runtime);
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

  if (parsed.command === "validator-script") {
    await validatorScriptCommand(flags);
    return;
  }

  if (parsed.command === "gateway-setup") {
    await runOperatorSetup(flags);
    return;
  }

  if (parsed.command === "gateway-status") {
    await runOperatorStatus(flags);
    return;
  }

  if (parsed.command === "gateway-upgrade") {
    await runOperatorUpgrade(flags);
    return;
  }

  if (parsed.command === "gateway-discover") {
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
  if (commandRejectsProjectEndpoint(command) && runtime.projectConfig?.endpoint) {
    const source = runtime.projectConfigPath ?? SWITCHBOARD_PROJECT_CONFIG_FILE;
    throw new Error(
      `${source} uses removed project field: endpoint. ` +
        "Canonical PROOF endpoints are allocated during deploy; remove endpoint from switchboard.json and attach customer domains after deploy with `switchboard hostname add`."
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
  const removed = [...REMOVED_PUBLIC_DEPLOY_FLAGS, "operator-project-dir", "operator-route-metadata-file", "endpoint", "hostname", "endpoint-id"]
    .filter((flag, index, values) => values.indexOf(flag) === index)
    .filter((flag) => flags.has(flag));
  if (removed.length > 0) {
    const endpointFlags = removed.filter((flag) => flag === "endpoint" || flag === "hostname" || flag === "endpoint-id");
    if (endpointFlags.length > 0) {
      throw new Error(
        `Removed project deploy option(s): ${endpointFlags.map((flag) => `--${flag}`).join(", ")}. ` +
          "Canonical PROOF endpoints are allocated during deploy; attach customer domains after deploy with `switchboard hostname add`."
      );
    }
    throw new Error(
      `Removed project deploy option(s): ${removed.map((flag) => `--${flag}`).join(", ")}. ` +
        "New projects use relay-reconciled deployment defaults; put recovery/admin settings in an ops profile."
    );
  }
}

function commandRejectsProjectEndpoint(command: CommandName): boolean {
  return command === "preflight" || command === "deploy" || command === "launch-demo";
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

  const template = stringFlag(flags, "template");
  if (template && template !== SSH_TEMPLATE_NAME) {
    throw new Error(`Unsupported project template: ${template}. Supported templates: ${SSH_TEMPLATE_NAME}`);
  }
  if (template === SSH_TEMPLATE_NAME) {
    await projectInitSshTemplateCommand(flags, { cwd, configPath, force });
    return;
  }

  const projectName = stringFlag(flags, "project") ?? stringFlag(flags, "name") ?? path.basename(cwd);
  const config: SwitchboardProjectConfig = {
    project: projectName,
    context: stringFlag(flags, "context") ?? switchboardContextEnv(),
    acurast: {
      project: stringFlag(flags, "acurast-project") ?? projectName,
      network: stringFlag(flags, "acurast-network") ?? "mainnet",
      stageDir: stringFlag(flags, "acurast-stage-dir"),
      entrypoint: stringFlag(flags, "entrypoint")
    },
    deploy: {
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
  });
}

async function projectInitSshTemplateCommand(
  flags: Map<string, string | boolean>,
  options: { cwd: string; configPath: string; force: boolean }
): Promise<void> {
  const distro = stringFlag(flags, "distro") ?? SSH_TEMPLATE_DISTRO;
  if (distro !== SSH_TEMPLATE_DISTRO) {
    throw new Error(`Unsupported SSH template distro: ${distro}. Supported distros: ${SSH_TEMPLATE_DISTRO}`);
  }

  const projectName = stringFlag(flags, "project") ?? stringFlag(flags, "name") ?? path.basename(options.cwd);
  const authorizedKeysSource = stringFlag(flags, "ssh-public-key-file");
  const config: SwitchboardProjectConfig = {
    project: projectName,
    context: stringFlag(flags, "context") ?? switchboardContextEnv(),
    acurast: {
      project: stringFlag(flags, "acurast-project") ?? projectName,
      network: stringFlag(flags, "acurast-network") ?? "mainnet",
      runtime: ACURAST_SCRIPT_RUNTIME,
      stageDir: stringFlag(flags, "acurast-stage-dir") ?? "dist/acurast/ssh",
      entrypoint: SSH_TEMPLATE_ENTRYPOINT,
      scriptImage: {
        url: ACURAST_UBUNTU_SCRIPT_IMAGE_URL,
        sha256: ACURAST_UBUNTU_SCRIPT_IMAGE_SHA256
      },
      scriptFiles: [
        SSH_TEMPLATE_ENTRYPOINT,
        SSH_TEMPLATE_BOOTSTRAP,
        SSH_TEMPLATE_BOOTSTRAP_PY,
        SSH_TEMPLATE_STUNNEL_CONFIG,
        SSH_TEMPLATE_GETIFADDRS_OVERRIDE
      ]
    },
    ssh: {
      distro,
      authorizedKeysFile: SSH_TEMPLATE_AUTHORIZED_KEYS,
      user: "root"
    },
    deploy: {
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

  await mkdir(options.cwd, { recursive: true });
  await mkdir(path.join(options.cwd, SWITCHBOARD_PROJECT_STATE_DIR), { recursive: true });
  await writeJsonFile(options.configPath, config);
  await writeTemplateFile(path.join(options.cwd, SSH_TEMPLATE_ENTRYPOINT), sshTemplateEntrypoint(), options.force, 0o755);
  await writeTemplateFile(path.join(options.cwd, SSH_TEMPLATE_BOOTSTRAP), sshTemplateBootstrap(), options.force, 0o755);
  await writeTemplateFile(path.join(options.cwd, SSH_TEMPLATE_BOOTSTRAP_PY), sshTemplateBootstrapPython(), options.force, 0o755);
  await writeTemplateFile(path.join(options.cwd, SSH_TEMPLATE_STUNNEL_CONFIG), sshTemplateStunnelConfig(), options.force);
  await writeTemplateFile(path.join(options.cwd, SSH_TEMPLATE_GETIFADDRS_OVERRIDE), sshTemplateGetifaddrsOverride(), options.force);
  await writeTemplateFile(path.join(options.cwd, SSH_TEMPLATE_AUTHORIZED_KEYS_EXAMPLE), sshAuthorizedKeysExample(), options.force);
  if (authorizedKeysSource) {
    const keys = await readAuthorizedKeysFile(path.resolve(authorizedKeysSource));
    await writeTemplateFile(path.join(options.cwd, SSH_TEMPLATE_AUTHORIZED_KEYS), `${keys}\n`, options.force);
  }
  await ensureGitignoreEntries(options.cwd, [SWITCHBOARD_PROJECT_STATE_DIR, "dist/", ".acurast/", ".env", ".env.*"]);

  const files = [
    SWITCHBOARD_PROJECT_CONFIG_FILE,
    SSH_TEMPLATE_ENTRYPOINT,
    SSH_TEMPLATE_BOOTSTRAP,
    SSH_TEMPLATE_BOOTSTRAP_PY,
    SSH_TEMPLATE_STUNNEL_CONFIG,
    SSH_TEMPLATE_GETIFADDRS_OVERRIDE,
    SSH_TEMPLATE_AUTHORIZED_KEYS_EXAMPLE,
    authorizedKeysSource ? SSH_TEMPLATE_AUTHORIZED_KEYS : undefined
  ].filter((item): item is string => Boolean(item));
  const output = {
    ok: true,
    action: "project-init",
    template: SSH_TEMPLATE_NAME,
    distro,
    projectRoot: options.cwd,
    configPath: options.configPath,
    stateDir: path.join(options.cwd, SWITCHBOARD_PROJECT_STATE_DIR),
    files,
    config,
    next: [
      `cd ${options.cwd}`,
      `switchboard deploy --dry-run --json`,
      `switchboard deploy --yes`
    ]
  };
  writeOutput(flags, output, () => {
    console.log("Switchboard SSH project initialized");
    console.log(`Project: ${projectName}`);
    console.log(`Config: ${options.configPath}`);
    console.log(`Distro: ${distro}`);
    console.log(`Entrypoint: ${SSH_TEMPLATE_ENTRYPOINT}`);
    console.log(`Authorized keys: ${authorizedKeysSource ? SSH_TEMPLATE_AUTHORIZED_KEYS : `${SSH_TEMPLATE_AUTHORIZED_KEYS} (create before live deploy)`}`);
    console.log("Next:");
    console.log(`  cd ${options.cwd}`);
    console.log("  switchboard deploy --dry-run --json");
  });
}

async function writeTemplateFile(filePath: string, contents: string, force: boolean, mode?: number): Promise<void> {
  if (!force && await fileExists(filePath)) {
    throw new Error(`${filePath} already exists. Pass --force to overwrite.`);
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
  if (mode !== undefined) {
    await chmod(filePath, mode);
  }
}

async function readAuthorizedKeysFile(filePath: string): Promise<string> {
  const lines = (await readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length === 0) {
    throw new Error(`${filePath} does not contain any SSH public keys`);
  }
  return lines.join("\n");
}

function sshTemplateEntrypoint(): string {
  return `#!/bin/sh
set -eu

PORT="\${PORT:-3000}"
SWITCHBOARD_RUN_DIR="\${SWITCHBOARD_RUN_DIR:-/run/switchboard}"
SCRIPT_PATH="$0"
case "\${SCRIPT_PATH}" in
  */*) SCRIPT_DIR="\${SCRIPT_PATH%/*}" ;;
  *) SCRIPT_DIR="." ;;
esac
if [ -z "\${SCRIPT_DIR}" ]; then
  SCRIPT_DIR="/"
fi
BOOTSTRAP_SCRIPT="\${BOOTSTRAP_SCRIPT:-\${SCRIPT_DIR}/${SSH_TEMPLATE_BOOTSTRAP}}"
STUNNEL_TEMPLATE="\${STUNNEL_TEMPLATE:-\${SCRIPT_DIR}/${SSH_TEMPLATE_STUNNEL_CONFIG}}"
STUNNEL_CONFIG="\${SWITCHBOARD_RUN_DIR}/stunnel.conf"
GETIFADDRS_OVERRIDE_SO="\${GETIFADDRS_OVERRIDE_SO:-/usr/local/lib/switchboard-getifaddrs-override.so}"
DROPBEAR_PID=""
STUNNEL_PID=""

bootstrap_log() {
  SB_BOOT_EVENT="$1"
  if [ -z "\${SB_BOOT_LOG_URL:-}" ] || ! command -v curl >/dev/null 2>&1; then
    return 0
  fi
  SB_BOOT_PAYLOAD="$(printf '{"event":"%s","source":"switchboard-cargo-shell"}' "\${SB_BOOT_EVENT}")" || return 0
  curl -fsS --max-time 5 -X POST -H 'content-type: application/json' --data "\${SB_BOOT_PAYLOAD}" "\${SB_BOOT_LOG_URL}" >/dev/null 2>&1 || true
}

on_exit() {
  bootstrap_log exit
  if [ -n "\${DROPBEAR_PID}" ]; then
    kill "\${DROPBEAR_PID}" 2>/dev/null || true
  fi
  if [ -n "\${STUNNEL_PID}" ]; then
    kill "\${STUNNEL_PID}" 2>/dev/null || true
  fi
}

trap on_exit 0
bootstrap_log entrypoint_start

: "\${${SSH_AUTH_KEYS_ENV}:?${SSH_AUTH_KEYS_ENV} must contain at least one SSH public key}"

/bin/sh "\${BOOTSTRAP_SCRIPT}"
if [ -f "\${GETIFADDRS_OVERRIDE_SO}" ]; then
  LD_PRELOAD="\${GETIFADDRS_OVERRIDE_SO}\${LD_PRELOAD:+:\${LD_PRELOAD}}"
  export LD_PRELOAD
  mkdir -p /etc/profile.d
  printf 'export LD_PRELOAD=%s\${LD_PRELOAD:+:$LD_PRELOAD}\\n' "\${GETIFADDRS_OVERRIDE_SO}" > /etc/profile.d/switchboard-ifaddrs-shim.sh
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 78
  fi
}

require_command dropbear
require_command dropbearkey
require_command sed
STUNNEL_BIN="\${STUNNEL_BIN:-$(command -v stunnel || command -v stunnel4 || true)}"
if [ -z "\${STUNNEL_BIN}" ]; then
  echo "missing required command: stunnel" >&2
  exit 78
fi

mkdir -p "\${SWITCHBOARD_RUN_DIR}"
chmod 700 "\${SWITCHBOARD_RUN_DIR}"

mkdir -p /etc/dropbear /root/.ssh
rm -f /etc/dropbear/dropbear_*_host_key
dropbearkey -t rsa -f /etc/dropbear/dropbear_rsa_host_key >/dev/null 2>&1 || true
dropbearkey -t ecdsa -f /etc/dropbear/dropbear_ecdsa_host_key >/dev/null 2>&1 || true
dropbearkey -t ed25519 -f /etc/dropbear/dropbear_ed25519_host_key >/dev/null 2>&1 || true
chmod 700 /root/.ssh
printf '%s\\n' "\${${SSH_AUTH_KEYS_ENV}}" > /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

bootstrap_log dropbear_start
dropbear -F -E -s -g -p 127.0.0.1:22 &
DROPBEAR_PID="$!"
sed "s/@PORT@/\${PORT}/g" "\${STUNNEL_TEMPLATE}" > "\${STUNNEL_CONFIG}"
bootstrap_log stunnel_start
"\${STUNNEL_BIN}" "\${STUNNEL_CONFIG}" &
STUNNEL_PID="$!"
bootstrap_log ready_start
/bin/sh "\${BOOTSTRAP_SCRIPT}" ready
wait "\${STUNNEL_PID}"
`;
}

function sshTemplateBootstrap(): string {
  return `#!/bin/sh
set -eu

MODE="\${1:-prepare}"
SCRIPT_PATH="$0"
case "\${SCRIPT_PATH}" in
  */*) SCRIPT_DIR="\${SCRIPT_PATH%/*}" ;;
  *) SCRIPT_DIR="." ;;
esac
if [ -z "\${SCRIPT_DIR}" ]; then
  SCRIPT_DIR="/"
fi
SWITCHBOARD_RUN_DIR="\${SWITCHBOARD_RUN_DIR:-/run/switchboard}"
PYTHON_HELPER="\${PYTHON_HELPER:-\${SCRIPT_DIR}/${SSH_TEMPLATE_BOOTSTRAP_PY}}"
GETIFADDRS_OVERRIDE_C="\${GETIFADDRS_OVERRIDE_C:-\${SCRIPT_DIR}/${SSH_TEMPLATE_GETIFADDRS_OVERRIDE}}"
GETIFADDRS_OVERRIDE_SO="\${GETIFADDRS_OVERRIDE_SO:-/usr/local/lib/switchboard-getifaddrs-override.so}"

bootstrap_log() {
  SB_BOOT_EVENT="$1"
  if [ -z "\${SB_BOOT_LOG_URL:-}" ] || ! command -v curl >/dev/null 2>&1; then
    return 0
  fi
  SB_BOOT_PAYLOAD="$(printf '{"event":"%s","source":"switchboard-cargo-shell"}' "\${SB_BOOT_EVENT}")" || return 0
  curl -fsS --max-time 5 -X POST -H 'content-type: application/json' --data "\${SB_BOOT_PAYLOAD}" "\${SB_BOOT_LOG_URL}" >/dev/null 2>&1 || true
}

ensure_curl() {
  if command -v curl >/dev/null 2>&1; then
    bootstrap_log curl_ready
    return
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \\
    ca-certificates \\
    curl
  bootstrap_log curl_ready
}

ensure_apt_deps() {
  bootstrap_log apt_deps_start
  if command -v python3 >/dev/null 2>&1 &&
     command -v openssl >/dev/null 2>&1 &&
     command -v gcc >/dev/null 2>&1 &&
     (command -v stunnel >/dev/null 2>&1 || command -v stunnel4 >/dev/null 2>&1) &&
     command -v dropbear >/dev/null 2>&1 &&
     command -v dropbearkey >/dev/null 2>&1; then
    bootstrap_log apt_deps_done
    bootstrap_log dropbear_deps_done
    bootstrap_log stunnel_deps_done
    return
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \\
    dropbear \\
    openssl \\
    gcc \\
    libc6-dev \\
    python3 \\
    stunnel4
  bootstrap_log apt_deps_done
  bootstrap_log dropbear_deps_done
  bootstrap_log stunnel_deps_done
}

ensure_python_runtime() {
  bootstrap_log python_runtime_start
  mkdir -p "\${SWITCHBOARD_RUN_DIR}"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "missing required command: python3" >&2
    exit 78
  fi
  SWITCHBOARD_PYTHON_BIN="$(command -v python3)"
  export SWITCHBOARD_PYTHON_BIN
  install_bridge_diagnostic_command
  bootstrap_log python_runtime_done
}

install_bridge_diagnostic_command() {
  BRIDGE_DIAGNOSTIC_COMMAND_PATH="\${SWITCHBOARD_BRIDGE_DIAGNOSTIC_COMMAND_PATH:-/usr/local/bin/${SSH_TEMPLATE_BRIDGE_DIAGNOSTIC_COMMAND}}"
  mkdir -p "\$(dirname "\${BRIDGE_DIAGNOSTIC_COMMAND_PATH}")"
  cat > "\${BRIDGE_DIAGNOSTIC_COMMAND_PATH}" <<'EOF'
#!/bin/sh
set -eu
exec "\${SWITCHBOARD_PYTHON_BIN:-python3}" - <<'PY'
import json
import os
import sys

state_path = os.environ.get("SWITCHBOARD_BRIDGE_DIAGNOSTIC_STATE")
if not state_path:
    run_dir = os.environ.get("SWITCHBOARD_RUN_DIR", "/run/switchboard")
    state_path = os.path.join(run_dir, "bridge-diagnostic.json")
os.environ["SWITCHBOARD_BRIDGE_DIAGNOSTIC_STATE"] = state_path
try:
    with open(state_path, "r", encoding="utf8") as handle:
        state = json.load(handle)
except Exception as error:
    print(f"switchboard cargo bridge diagnostic state unavailable: {error}", file=sys.stderr)
    raise SystemExit(78)
helper = state.get("pythonHelper") or os.environ.get("PYTHON_HELPER")
if not helper:
    print("switchboard cargo bridge diagnostic state did not include a helper path", file=sys.stderr)
    raise SystemExit(78)
os.execv(sys.executable, [sys.executable, helper, "bridge-doctor"])
PY
EOF
  chmod 755 "\${BRIDGE_DIAGNOSTIC_COMMAND_PATH}"
}

ensure_getifaddrs_override() {
  if [ -f "\${GETIFADDRS_OVERRIDE_SO}" ]; then
    bootstrap_log shim_ready
    return
  fi
  if [ ! -f "\${GETIFADDRS_OVERRIDE_C}" ]; then
    echo "missing getifaddrs override source: \${GETIFADDRS_OVERRIDE_C}" >&2
    exit 78
  fi
  mkdir -p "\$(dirname "\${GETIFADDRS_OVERRIDE_SO}")"
  gcc -shared -fPIC -o "\${GETIFADDRS_OVERRIDE_SO}" "\${GETIFADDRS_OVERRIDE_C}"
  chmod 755 "\${GETIFADDRS_OVERRIDE_SO}"
  bootstrap_log shim_ready
}

ensure_curl
ensure_apt_deps
ensure_getifaddrs_override
ensure_python_runtime
exec "\${SWITCHBOARD_PYTHON_BIN:-python3}" "\${PYTHON_HELPER}" "\${MODE}"
`;
}

function sshTemplateBootstrapPython(): string {
  return `#!/usr/bin/env python3
import base64
import ipaddress
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_RUN_DIR = Path(os.environ.get("SWITCHBOARD_RUN_DIR", "/run/switchboard"))
STATE_PATH = Path(os.environ.get("SWITCHBOARD_BOOTSTRAP_STATE", str(DEFAULT_RUN_DIR / "bootstrap-state.json")))
BRIDGE_DIAGNOSTIC_STATE_PATH = Path(os.environ.get("SWITCHBOARD_BRIDGE_DIAGNOSTIC_STATE", str(DEFAULT_RUN_DIR / "bridge-diagnostic.json")))
BRIDGE_DIAGNOSTIC_CHALLENGE = "0x" + "11" * 32
TLS_CERT_PATH = Path(os.environ.get("SWITCHBOARD_TLS_CERT", "/run/switchboard/tls.crt"))
TLS_KEY_PATH = Path(os.environ.get("SWITCHBOARD_TLS_KEY", "/run/switchboard/tls.key"))
REMOTE_BOOT_EVENTS = {
    "python_start",
    "bridge_connect_start",
    "bridge_connected",
    "claim_start",
    "claim_done",
    "registration_start",
    "registration_done",
    "certificate_start",
    "certificate_written",
    "health_ready",
}


def remote_log(event):
    if event not in REMOTE_BOOT_EVENTS:
        return
    url = os.environ.get("SB_BOOT_LOG_URL")
    if not url:
        return
    try:
        data = json.dumps({"event": event, "source": "switchboard-cargo-python"}, separators=(",", ":")).encode("utf8")
        request = urllib.request.Request(url, data=data, headers={"content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(request, timeout=5) as response:
            response.read()
    except Exception:
        return


def log(event, **details):
    record = {"event": event, **{k: v for k, v in details.items() if v is not None}}
    print(json.dumps(record, sort_keys=True), file=sys.stderr, flush=True)
    remote_log(event)


def fail(message):
    log("switchboard-cargo-bootstrap-failed", error=message)
    raise SystemExit(message)


def strip_0x(value):
    value = str(value)
    return value[2:] if value.startswith(("0x", "0X")) else value


def hex_byte_length(value):
    text = strip_0x(value)
    if len(text) % 2 != 0:
        return None
    try:
        bytes.fromhex(text)
    except ValueError:
        return None
    return len(text) // 2


def load_bridge_diagnostic_state(required=False):
    if not BRIDGE_DIAGNOSTIC_STATE_PATH.exists():
        if required:
            fail("Cargo bridge diagnostic state is unavailable; wait for bootstrap to start before running the bridge diagnostic helper")
        return {}
    try:
        data = json.loads(BRIDGE_DIAGNOSTIC_STATE_PATH.read_text(encoding="utf8"))
    except Exception as error:
        if required:
            fail(f"Cargo bridge diagnostic state could not be read: {error}")
        return {}
    return data if isinstance(data, dict) else {}


def save_bridge_diagnostic_state(bridge, config=None, public_key=None, deployment=None, job_signer=None):
    state = load_bridge_diagnostic_state(required=False)
    state.update({
        "version": 1,
        "socketName": bridge.socket_name,
        "pythonHelper": str(Path(__file__).resolve()),
        "signerMode": "cargo-bridge-secp256k1",
        "publicKey": public_key or state.get("publicKey"),
        "deployment": deployment or state.get("deployment"),
        "jobSigner": job_signer or state.get("jobSigner"),
    })
    safe_config = config or {}
    safe_fields = {
        "SWITCHBOARD_INTENT_ID": "intentId",
        "SWITCHBOARD_RELAY_URL": "relayUrl",
        "ENDPOINT_HOSTNAME": "endpointHostname",
        "SESSION_ID": "sessionId",
        "JOB_ID": "jobId",
        "GATEWAY_ID": "gatewayId",
        "PROCESSOR_ID": "processorId",
        "OPERATOR_ID": "operatorId",
    }
    for source, target in safe_fields.items():
        value = safe_config.get(source)
        if value:
            state[target] = value
    BRIDGE_DIAGNOSTIC_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    BRIDGE_DIAGNOSTIC_STATE_PATH.write_text(json.dumps({k: v for k, v in state.items() if v is not None}, sort_keys=True), encoding="utf8")
    os.chmod(BRIDGE_DIAGNOSTIC_STATE_PATH, 0o600)


def public_key_summary(public_key):
    byte_length = hex_byte_length(public_key)
    text = strip_0x(public_key)
    return {
        "value": public_key,
        "encoding": "hex",
        "bytes": byte_length,
        "compressedSecp256k1": byte_length == 33 and text[:2].lower() in ("02", "03"),
    }


def signature_summary(signature):
    byte_length = hex_byte_length(signature)
    return {
        "encoding": "hex",
        "bytes": byte_length,
        "hasRecoveryByte": byte_length == 65,
    }


class Bridge:
    def __init__(self, socket_name, source="env"):
        if not socket_name:
            fail("BRIDGE_SOCKET is required for Cargo bridge signing and no bridge diagnostic state is available")
        self.socket_name = socket_name
        self.source = source
        self.counter = 0

    @classmethod
    def from_env(cls):
        socket_name = os.environ.get("BRIDGE_SOCKET")
        if socket_name:
            return cls(socket_name, source="env")
        state = load_bridge_diagnostic_state(required=False)
        state_socket = state.get("socketName") if isinstance(state, dict) else None
        return cls(state_socket, source="diagnostic-state")

    def call(self, method, params=None):
        self.counter += 1
        request = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or [],
            "id": str(self.counter),
        }
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            if self.socket_name.startswith("/"):
                sock.connect(self.socket_name)
            else:
                sock.connect("\\0" + self.socket_name)
            sock.sendall((json.dumps(request, separators=(",", ":")) + "\\n").encode("utf8"))
            chunks = []
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                if b"\\n" in chunk:
                    break
        response = json.loads(b"".join(chunks).decode("utf8").strip())
        if response.get("error"):
            raise RuntimeError(f"Cargo bridge {method} failed: {response['error']}")
        return response.get("result")

    def public_key(self):
        result = self.call("signer_publicKey", [{"curve": "secp256k1"}])
        key = result.get("publicKey") if isinstance(result, dict) else None
        if not key:
            fail("Cargo bridge signer_publicKey did not return secp256k1 publicKey")
        return key

    def deployment_id(self):
        return self.call("deployment_id", [])

    def sign_digest(self, digest):
        result = self.call("signer_sign", [{"curve": "secp256k1", "bytes": strip_0x(digest)}])
        signature = result.get("bytes") if isinstance(result, dict) else None
        if not signature:
            fail("Cargo bridge signer_sign did not return signature bytes")
        return signature

    def whitelist_host(self, host):
        return self.call("network_whitelist", [{"host": host}])


def load_config():
    raw = os.environ.get("SWITCHBOARD_CONFIG") or os.environ.get("PROOF_INGRESS_CONFIG")
    if not raw:
        fail("SWITCHBOARD_CONFIG is required")
    raw = raw.strip()
    if not raw.startswith("{"):
        raw = base64.b64decode(raw).decode("utf8")
    parsed = json.loads(raw)
    return {str(k): str(v) for k, v in parsed.items() if v is not None}


def save_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, sort_keys=True), encoding="utf8")
    os.chmod(STATE_PATH, 0o600)


def load_state():
    if not STATE_PATH.exists():
        return {"config": load_config()}
    return json.loads(STATE_PATH.read_text(encoding="utf8"))


def required(config, name):
    value = config.get(name)
    if not value:
        fail(f"{name} is required")
    return value


def require_https_url(url, label):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme == "https" and parsed.netloc:
        return url
    if parsed.scheme == "http":
        fail(f"{label} must use https://; plaintext HTTP relay transport is not allowed in Acurast jobs")
    if parsed.scheme:
        fail(f"{label} must use https://; unsupported URL protocol {parsed.scheme}:")
    fail(f"{label} must be an absolute https URL")


def require_gateway_admission_url(url, label):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme in ("https", "http") and parsed.netloc:
        return url
    if parsed.scheme:
        fail(f"{label} must use http:// or https://; unsupported URL protocol {parsed.scheme}:")
    fail(f"{label} must be an absolute http or https URL")


def request_json(method, url, body=None, token=None, timeout=120):
    headers = {"accept": "application/json"}
    data = None
    if body is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(body, separators=(",", ":")).encode("utf8")
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf8")
            return response.status, json.loads(text) if text else {}
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf8")
        try:
            payload = json.loads(text) if text else {}
        except json.JSONDecodeError:
            payload = {"body": text}
        return error.code, payload


def maybe_whitelist_url(bridge, url):
    host = urllib.parse.urlparse(url).hostname
    if not host:
        return
    try:
        bridge.whitelist_host(host)
        log("network-whitelisted", host=host)
    except Exception as error:
        log("network-whitelist-skipped", host=host, error=str(error))


def split_csv(value):
    return [item.strip() for item in str(value or "").split(",") if item.strip()]


def public_ipv4(value):
    try:
        parsed = ipaddress.ip_address(str(value).strip().split("/", 1)[0])
    except ValueError:
        return None
    if parsed.version != 4:
        return None
    if parsed.is_loopback or parsed.is_private or parsed.is_link_local or parsed.is_multicast or parsed.is_unspecified:
        return None
    return str(parsed)


def append_public_ip(values, value):
    parsed = public_ipv4(value)
    if parsed and parsed not in values:
        values.append(parsed)


def upstream_ipv4(value):
    try:
        parsed = ipaddress.ip_address(str(value).strip().split("/", 1)[0])
    except ValueError:
        return None
    if parsed.version != 4:
        return None
    if parsed.is_loopback or parsed.is_link_local or parsed.is_multicast or parsed.is_unspecified:
        return None
    return str(parsed)


def append_upstream_ip(values, value):
    parsed = upstream_ipv4(value)
    if parsed and parsed not in values:
        values.append(parsed)


def command_output(args):
    try:
        return subprocess.check_output(args, text=True, timeout=3, stderr=subprocess.DEVNULL)
    except Exception as error:
        log("upstream-ip-local-discovery-skipped", command=" ".join(args), error=str(error))
        return ""


def route_target_endpoint(value):
    text = str(value or "").strip()
    if not text:
        return None
    if text.count(":") == 1:
        host, port_text = text.rsplit(":", 1)
        try:
            return host.strip(), int(port_text)
        except ValueError:
            return None
    return text, 443


def route_local_ips(targets):
    values = []
    for candidate in targets:
        endpoint = route_target_endpoint(candidate)
        if not endpoint:
            continue
        host, port = endpoint
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.connect((host, port))
                append_upstream_ip(values, sock.getsockname()[0])
        except Exception as error:
            log("upstream-ip-route-discovery-skipped", target=candidate, error=str(error))
    return values


def local_interface_ips(config):
    values = []
    route_targets = split_csv(config.get("SWITCHBOARD_ROUTE_LOCAL_IP_TARGETS") or os.environ.get("SWITCHBOARD_ROUTE_LOCAL_IP_TARGETS"))
    if not route_targets:
        route_targets = ["1.1.1.1:443", "8.8.8.8:53"]
    for candidate in route_local_ips(route_targets):
        append_upstream_ip(values, candidate)
    for candidate in command_output(["hostname", "-I"]).split():
        append_upstream_ip(values, candidate)
    for line in command_output(["ip", "-4", "-o", "addr", "show", "scope", "global"]).splitlines():
        parts = line.split()
        for index, part in enumerate(parts):
            if part == "inet" and index + 1 < len(parts):
                append_upstream_ip(values, parts[index + 1])
    try:
        for result in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET, socket.SOCK_STREAM):
            append_upstream_ip(values, result[4][0])
    except Exception as error:
        log("upstream-ip-hostname-discovery-skipped", error=str(error))
    return values


def public_ip_from_url(bridge, url):
    maybe_whitelist_url(bridge, url)
    request = urllib.request.Request(url, headers={"accept": "text/plain"}, method="GET")
    with urllib.request.urlopen(request, timeout=5) as response:
        return response.read().decode("utf8").strip()


def discover_upstream_ips(config, bridge):
    values = []
    for name in ("SWITCHBOARD_UPSTREAM_IPS", "SWITCHBOARD_UPSTREAM_IP", "SWITCHBOARD_PUBLIC_IP", "ACURAST_PUBLIC_IP"):
        for candidate in split_csv(config.get(name) or os.environ.get(name)):
            append_upstream_ip(values, candidate)
    if not values:
        for candidate in local_interface_ips(config):
            append_upstream_ip(values, candidate)
    urls = split_csv(config.get("SWITCHBOARD_PUBLIC_IP_URLS") or os.environ.get("SWITCHBOARD_PUBLIC_IP_URLS"))
    if not urls:
        urls = ["https://ifconfig.me/ip", "https://api.ipify.org"]
    for url in urls:
        if values:
            break
        try:
            append_public_ip(values, public_ip_from_url(bridge, url))
        except Exception as error:
            log("upstream-ip-discovery-skipped", url=url, error=str(error))
    log("upstream-ips-discovered", count=len(values), upstreamIps=values)
    return values


def intent_endpoint(config, suffix):
    relay_url = require_https_url(required(config, "SWITCHBOARD_RELAY_URL"), "SWITCHBOARD_RELAY_URL").rstrip("/")
    intent_id = urllib.parse.quote(required(config, "SWITCHBOARD_INTENT_ID"), safe="")
    return f"{relay_url}/v1/deployment-intents/{intent_id}{suffix}"


def post_health(config, state, details):
    relay_url = require_https_url(required(config, "SWITCHBOARD_RELAY_URL"), "SWITCHBOARD_RELAY_URL").rstrip("/")
    intent_id = required(config, "SWITCHBOARD_INTENT_ID")
    token = required(config, "SWITCHBOARD_INTENT_TOKEN")
    status, body = request_json(
        "POST",
        f"{relay_url}/v1/deployment-intents/{intent_id}/health",
        {"state": state, "details": details},
        token=token,
        timeout=int(config.get("SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS", "60000")) / 1000,
    )
    if status < 200 or status >= 300:
        raise RuntimeError(f"health report failed: {status} {body}")
    return body


def claim_intent(config, bridge, public_key, deployment, upstream_ips):
    log("claim_start")
    token = required(config, "SWITCHBOARD_INTENT_TOKEN")
    status, body = request_json(
        "POST",
        intent_endpoint(config, "/runtime-signing/claim"),
        {
            "signerMode": "cargo-bridge-secp256k1",
            "publicKey": public_key,
            "deployment": deployment,
            "upstreamIps": upstream_ips,
            "source": {"runtime": {"kind": "cargo-shell", "deployment": deployment}},
        },
        token=token,
        timeout=int(config.get("SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS", "60000")) / 1000,
    )
    if status < 200 or status >= 300:
        fail(f"deployment intent claim failed: {status} {body}")
    runtime_signer = body.get("runtimeSigner") or (((body.get("intent") or {}).get("public") or {}).get("runtimeSigner"))
    if not runtime_signer:
        fail("deployment intent runtime signing claim did not return runtimeSigner")
    log("claim_done")
    log("deployment-intent-claimed", intentId=required(config, "SWITCHBOARD_INTENT_ID"), runtimeSigner=runtime_signer)
    return body


def fetch_runtime_config(config):
    relay_url = require_https_url(required(config, "SWITCHBOARD_RELAY_URL"), "SWITCHBOARD_RELAY_URL").rstrip("/")
    intent_id = required(config, "SWITCHBOARD_INTENT_ID")
    token = required(config, "SWITCHBOARD_INTENT_TOKEN")
    timeout = int(config.get("SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS", "60000")) / 1000
    status, body = request_json("GET", f"{relay_url}/v1/deployment-intents/{intent_id}/runtime-config", token=token, timeout=timeout)
    if status == 202:
        return body
    if status < 200 or status >= 300 or not body.get("ok"):
        fail(f"runtime config failed: {status} {body}")
    return body


def apply_runtime_config(config, runtime):
    runtime_config = runtime.get("config") or {}
    mapping = {
        "relayUrl": "RELAY_URL",
        "chainId": "CHAIN_ID",
        "registryAddress": "INGRESS_REGISTRY_ADDRESS",
        "sessionId": "SESSION_ID",
        "jobId": "JOB_ID",
        "operatorId": "OPERATOR_ID",
        "processorId": "PROCESSOR_ID",
        "gatewayId": "GATEWAY_ID",
        "gatewayUpstreamAdmissionUrl": "GATEWAY_UPSTREAM_ADMISSION_URL",
        "endpointHostname": "ENDPOINT_HOSTNAME",
    }
    for source, target in mapping.items():
        if runtime_config.get(source) is not None:
            config[target] = str(runtime_config[source])
    if config.get("RELAY_URL"):
        require_https_url(config["RELAY_URL"], "RELAY_URL")
    if config.get("GATEWAY_UPSTREAM_ADMISSION_URL"):
        require_gateway_admission_url(config["GATEWAY_UPSTREAM_ADMISSION_URL"], "GATEWAY_UPSTREAM_ADMISSION_URL")
    config["SWITCHBOARD_CERTIFICATE_MODE"] = str(runtime_config.get("certificateMode") or "job-acme")
    certificate_hostnames = runtime_config.get("certificateHostnames") or [runtime_config.get("endpointHostname")]
    config["SWITCHBOARD_CERTIFICATE_HOSTNAMES"] = ",".join(str(item) for item in certificate_hostnames if item)


def wait_for_runtime_config(config):
    retry_ms = int(config.get("SWITCHBOARD_INTENT_POLL_MS") or config.get("SWITCHBOARD_REGISTRATION_RETRY_MS") or "30000")
    max_attempts = int(config.get("SWITCHBOARD_INTENT_MAX_ATTEMPTS") or "0")
    attempt = 1
    while max_attempts == 0 or attempt <= max_attempts:
        runtime = fetch_runtime_config(config)
        if runtime.get("ok") and runtime.get("config"):
            apply_runtime_config(config, runtime)
            post_health(config, "config_received", {
                "sessionId": config.get("SESSION_ID"),
                "endpointHostname": config.get("ENDPOINT_HOSTNAME"),
            })
            return runtime
        state = runtime.get("state")
        log("deployment-intent-waiting", attempt=attempt, state=state)
        post_health(config, "waiting_quote" if state == "waiting_quote" else "waiting_funding", {"attempt": attempt})
        time.sleep(retry_ms / 1000)
        attempt += 1
    fail("runtime config was not ready before max attempts")


def register_ingress(config, bridge, job_signer):
    log("registration_start")
    post_health(config, "registering", {"attempt": 1})
    token = required(config, "SWITCHBOARD_INTENT_TOKEN")
    status, challenge = request_json(
        "POST",
        intent_endpoint(config, "/runtime-signing/registration-challenge"),
        {},
        token=token,
        timeout=int(config.get("SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS", "60000")) / 1000,
    )
    if status < 200 or status >= 300:
        fail(f"registration challenge failed: {status} {challenge}")
    registration = challenge.get("registration")
    digest = challenge.get("digest")
    if not registration or not digest:
        fail("registration challenge response was missing registration or digest")
    signature = bridge.sign_digest(digest)
    status, body = request_json(
        "POST",
        intent_endpoint(config, "/runtime-signing/registration"),
        {"registration": registration, "signature": signature},
        token=token,
        timeout=int(config.get("CONTRACT_CALL_TIMEOUT_MS", "120000")) / 1000,
    )
    if status < 200 or status >= 300:
        fail(f"relay registration failed: {status} {body}")
    post_health(config, "registered", {"sessionId": config.get("SESSION_ID")})
    log("registration_done")
    log("registration-succeeded", relayResponse=body)


def create_csr(hostname):
    with tempfile.TemporaryDirectory() as tempdir:
        key_path = Path(tempdir) / "tls.key"
        csr_path = Path(tempdir) / "tls.csr"
        subprocess.run([
            "openssl",
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-subj",
            f"/CN={hostname}",
            "-addext",
            f"subjectAltName=DNS:{hostname}",
            "-keyout",
            str(key_path),
            "-out",
            str(csr_path),
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        return key_path.read_text(encoding="utf8"), csr_path.read_text(encoding="utf8")


def request_certificates(config, bridge, job_signer):
    if config.get("SWITCHBOARD_CERTIFICATE_MODE") != "job-acme":
        return []
    log("certificate_start")
    hostnames = [item.strip().lower() for item in config.get("SWITCHBOARD_CERTIFICATE_HOSTNAMES", "").split(",") if item.strip()]
    if not hostnames:
        hostnames = [required(config, "ENDPOINT_HOSTNAME").strip().lower()]
    certs = []
    token = required(config, "SWITCHBOARD_INTENT_TOKEN")
    for hostname in hostnames:
        post_health(config, "certificate_requesting", {"stage": "certificate_request", "hostnames": hostnames})
        private_key, csr = create_csr(hostname)
        status, challenge = request_json(
            "POST",
            intent_endpoint(config, "/runtime-signing/certificate-challenge"),
            {"hostname": hostname, "csrPem": csr},
            token=token,
            timeout=int(config.get("SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS", "60000")) / 1000,
        )
        if status < 200 or status >= 300:
            fail(f"certificate challenge failed for {hostname}: {status} {challenge}")
        certificate_request = challenge.get("certificateRequest")
        digest = challenge.get("digest")
        if not certificate_request or not digest:
            fail(f"certificate challenge response was missing certificateRequest or digest for {hostname}")
        signature = bridge.sign_digest(digest)
        status, body = request_json(
            "POST",
            intent_endpoint(config, "/runtime-signing/certificate"),
            {"certificateRequest": certificate_request, "csrPem": csr, "signature": signature},
            token=token,
            timeout=int(config.get("SWITCHBOARD_CERTIFICATE_REQUEST_TIMEOUT_MS", "360000")) / 1000,
        )
        if status < 200 or status >= 300:
            fail(f"relay certificate request failed for {hostname}: {status} {body}")
        certificate_pem = body.get("certificatePem")
        if not certificate_pem:
            fail(f"relay certificate response did not include certificatePem for {hostname}")
        certs.append({"hostname": hostname, "cert": certificate_pem, "key": private_key, "relayResponse": body})
        log("certificate-issued", hostname=hostname, issuer=body.get("issuer"), notAfter=body.get("notAfter"))
    return certs


def write_tls_certificate(cert):
    TLS_CERT_PATH.parent.mkdir(parents=True, exist_ok=True)
    TLS_CERT_PATH.write_text(cert["cert"], encoding="utf8")
    TLS_KEY_PATH.write_text(cert["key"], encoding="utf8")
    os.chmod(TLS_CERT_PATH, 0o644)
    os.chmod(TLS_KEY_PATH, 0o600)
    log("certificate_written")


def gateway_upstream_port(config):
    return int(config.get("GATEWAY_UPSTREAM_PORT") or config.get("SWITCHBOARD_UPSTREAM_PORT") or os.environ.get("PORT", "3000"))


def admit_gateway_upstream(config, bridge):
    admission_url = config.get("GATEWAY_UPSTREAM_ADMISSION_URL")
    if not admission_url:
        return None
    admission_url = require_gateway_admission_url(admission_url, "GATEWAY_UPSTREAM_ADMISSION_URL")
    maybe_whitelist_url(bridge, admission_url)
    token = required(config, "SWITCHBOARD_INTENT_TOKEN")
    status, challenge = request_json(
        "POST",
        intent_endpoint(config, "/runtime-signing/upstream-admission-challenge"),
        {"upstreamPort": gateway_upstream_port(config)},
        token=token,
        timeout=int(config.get("SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS", "60000")) / 1000,
    )
    if status < 200 or status >= 300:
        fail(f"gateway upstream admission challenge failed: {status} {challenge}")
    request = challenge.get("request")
    digest = challenge.get("digest")
    if not request or not digest:
        fail("gateway upstream admission challenge response was missing request or digest")
    signature = bridge.sign_digest(digest)
    status, gateway_body = request_json(
        "POST",
        admission_url,
        {"request": request, "signature": signature},
        timeout=int(config.get("SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS", "60000")) / 1000,
    )
    if status < 200 or status >= 300:
        fail(f"gateway upstream admission failed: {status} {gateway_body}")
    status, relay_body = request_json(
        "POST",
        intent_endpoint(config, "/upstream-admissions"),
        {
            "request": request,
            "requestSignature": signature,
            "observation": gateway_body.get("observation"),
            "observationSignature": gateway_body.get("observationSignature"),
        },
        token=token,
        timeout=int(config.get("SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS", "60000")) / 1000,
    )
    if status < 200 or status >= 300:
        fail(f"relay gateway upstream admission submit failed: {status} {relay_body}")
    admission = relay_body.get("admission") or {}
    log("gateway-upstream-admitted", admissionId=admission.get("admissionId"), observedAt=admission.get("observedAt"))
    return admission


def prepare():
    config = load_config()
    log("bridge_connect_start")
    bridge = Bridge.from_env()
    public_key = bridge.public_key()
    deployment = bridge.deployment_id()
    save_bridge_diagnostic_state(bridge, config=config, public_key=public_key, deployment=deployment)
    log("bridge_connected")
    maybe_whitelist_url(bridge, require_https_url(required(config, "SWITCHBOARD_RELAY_URL"), "SWITCHBOARD_RELAY_URL"))
    upstream_ips = discover_upstream_ips(config, bridge)
    claim = claim_intent(config, bridge, public_key, deployment, upstream_ips)
    job_signer = claim.get("runtimeSigner")
    log("job-signer-ready", signerMode="cargo-bridge-secp256k1", jobSigner=job_signer)
    post_health(config, "waiting_funding", {"runtimeSigner": job_signer, "upstreamIps": upstream_ips})
    wait_for_runtime_config(config)
    save_bridge_diagnostic_state(bridge, config=config, public_key=public_key, deployment=deployment, job_signer=job_signer)
    maybe_whitelist_url(bridge, require_https_url(required(config, "RELAY_URL"), "RELAY_URL"))
    register_ingress(config, bridge, job_signer)
    certs = request_certificates(config, bridge, job_signer)
    if certs:
        write_tls_certificate(certs[0])
    save_state({"config": config, "jobSigner": job_signer, "certificates": [{"hostname": cert["hostname"]} for cert in certs]})


def ready():
    state = load_state()
    config = state.get("config") or load_config()
    bridge = Bridge.from_env()
    admission = admit_gateway_upstream(config, bridge)
    post_health(config, "ready", {
        "sessionId": config.get("SESSION_ID"),
        "endpointHostname": config.get("ENDPOINT_HOSTNAME"),
        "protocol": "https",
        "applicationProtocol": "ssh",
        "port": gateway_upstream_port(config),
        "gatewayUpstreamAdmission": admission,
        "certificateHostnames": [item.strip() for item in config.get("SWITCHBOARD_CERTIFICATE_HOSTNAMES", "").split(",") if item.strip()],
    })
    log("health_ready")
    log("switchboard-cargo-ready", endpointHostname=config.get("ENDPOINT_HOSTNAME"))


def bridge_smoke():
    bridge = Bridge.from_env()
    public_key = bridge.public_key()
    signature = bridge.sign_digest("0x" + "11" * 32)
    print(json.dumps({"publicKey": public_key, "signature": signature}, sort_keys=True))


def bridge_doctor():
    state = load_bridge_diagnostic_state(required=False)
    bridge = Bridge.from_env()
    public_key = bridge.public_key()
    signature = bridge.sign_digest(BRIDGE_DIAGNOSTIC_CHALLENGE)
    if bridge.source == "env":
        save_bridge_diagnostic_state(bridge, public_key=public_key)
        state = load_bridge_diagnostic_state(required=False)
    output = {
        "ok": True,
        "action": "bridge-doctor",
        "signerMode": "cargo-bridge-secp256k1",
        "bridge": {
            "available": True,
            "source": bridge.source,
        },
        "publicKey": public_key_summary(public_key),
        "signature": signature_summary(signature),
        "challenge": {
            "kind": "fixed-diagnostic-digest",
            "digest": BRIDGE_DIAGNOSTIC_CHALLENGE,
        },
        "known": {
            "deployment": state.get("deployment"),
            "jobSigner": state.get("jobSigner"),
            "intentId": state.get("intentId"),
            "endpointHostname": state.get("endpointHostname"),
            "sessionId": state.get("sessionId"),
            "gatewayId": state.get("gatewayId"),
            "processorId": state.get("processorId"),
            "operatorId": state.get("operatorId"),
        },
    }
    print(json.dumps(output, sort_keys=True))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "prepare"
    log("python_start", mode=mode)
    if mode == "prepare":
        prepare()
    elif mode == "ready":
        ready()
    elif mode == "bridge-smoke":
        bridge_smoke()
    elif mode == "bridge-doctor":
        bridge_doctor()
    else:
        fail(f"unsupported bootstrap mode: {mode}")


if __name__ == "__main__":
    main()
`;
}

function sshTemplateGetifaddrsOverride(): string {
  return `#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>

int getifaddrs(struct ifaddrs **ifap) {
    struct ifaddrs *ifa = calloc(1, sizeof(struct ifaddrs));
    if (!ifa) return -1;

    ifa->ifa_next = NULL;
    ifa->ifa_name = strdup("lo");
    ifa->ifa_flags = IFF_UP | IFF_RUNNING | IFF_LOOPBACK;

    struct sockaddr_in *addr = calloc(1, sizeof(struct sockaddr_in));
    if (!addr) {
        free(ifa->ifa_name);
        free(ifa);
        return -1;
    }
    addr->sin_family = AF_INET;
    addr->sin_addr.s_addr = htonl(0x7f000001);
    ifa->ifa_addr = (struct sockaddr *)addr;

    struct sockaddr_in *netmask = calloc(1, sizeof(struct sockaddr_in));
    if (!netmask) {
        free(ifa->ifa_addr);
        free(ifa->ifa_name);
        free(ifa);
        return -1;
    }
    netmask->sin_family = AF_INET;
    netmask->sin_addr.s_addr = htonl(0xff000000);
    ifa->ifa_netmask = (struct sockaddr *)netmask;

    *ifap = ifa;
    return 0;
}

void freeifaddrs(struct ifaddrs *ifa) {
    while (ifa) {
        struct ifaddrs *next = ifa->ifa_next;
        free(ifa->ifa_name);
        free(ifa->ifa_addr);
        free(ifa->ifa_netmask);
        free(ifa);
        ifa = next;
    }
}
`;
}

function sshTemplateStunnelConfig(): string {
  return `foreground = yes
pid = /tmp/stunnel.pid

[ssh]
accept = 0.0.0.0:@PORT@
connect = 127.0.0.1:22
cert = /run/switchboard/tls.crt
key = /run/switchboard/tls.key
`;
}

function sshAuthorizedKeysExample(): string {
  return `# Add one or more SSH public keys here, then save as ${SSH_TEMPLATE_AUTHORIZED_KEYS}.
# Example:
# ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexampleexampleexampleexampleexample user@example
`;
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
    const endpoint = stringRecordField(runtime.projectState?.latestDeployment, "hostname");
    if (endpoint) {
      console.log(`Endpoint: ${endpoint}`);
    }
    if (runtime.projectState?.latestReport) {
      console.log(`Latest report: ${runtime.projectState.latestReport}`);
    }
  });
}

async function contextListCommand(flags: Map<string, string | boolean>, runtime: CliRuntime) {
  const store = await readContextStore(runtime.contextStorePath);
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

async function contextUseCommand(flags: Map<string, string | boolean>, positionals: string[], runtime: CliRuntime) {
  const name = positionals[2] ?? stringFlag(flags, "context");
  if (!name) {
    throw new Error("Missing context name. Use `switchboard context use <name>`.");
  }
  const store = await readContextStore(runtime.contextStorePath);
  if (!store.contexts?.[name]) {
    throw new Error(`Unknown context "${name}". Create it with \`switchboard context add ${name}\` or \`switchboard context set ${name} ...\`.`);
  }
  store.current = name;
  await writeContextStore(store, runtime.contextStorePath);
  writeOutput(flags, { ok: true, action: "context-use", current: name, contextStorePath: runtime.contextStorePath }, () => {
    console.log(`Current Switchboard context: ${name}`);
  });
}

async function contextSetCommand(flags: Map<string, string | boolean>, positionals: string[], runtime: CliRuntime) {
  assertNoRemovedContextSetFlags(flags);
  const name = positionals[2] ?? stringFlag(flags, "context");
  if (!name) {
    throw new Error("Missing context name. Use `switchboard context set <name> ...`.");
  }
  const store = await readContextStore(runtime.contextStorePath);
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
  await writeContextStore(store, runtime.contextStorePath);
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
  const acurastAddress = acurastAddressFromRuntime(runtime);
  addCheck(
    "Acurast deploy address",
    Boolean(acurastAddress),
    contextEnvDetail(runtime, "acurastAddressEnv", "ACURAST_MAINNET_ADDRESS or ACURAST_ADDRESS"),
    false
  );
  if (acurastSeedCheck.ok && acurastSeed && acurastAddress) {
    const match = await checkSeedAddressMatch(
      acurastSeed,
      acurastAddress,
      contextEnvDetail(runtime, "acurastAddressEnv", "ACURAST_MAINNET_ADDRESS")
    );
    addCheck("Acurast seed/address match", match.ok, match.detail);
  }
  for (const envName of ACURAST_IPFS_UPLOAD_ENV_VARS) {
    addCheck(acurastIpfsUploadCheckName(envName), true, acurastIpfsUploadEnvDetail(runtime, envName));
  }

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
      const polkadotSeed = stringFlag(flags, "polkadot-seed") ?? nativePaymentSeedFromRuntime(runtime);
      const polkadotSeedCheck = checkMnemonicSeed(polkadotSeed, nativePaymentSeedDetail(flags, runtime));
      addCheck("Polkadot payment seed", polkadotSeedCheck.ok, polkadotSeedCheck.detail);
      const polkadotAddress = stringFlag(flags, "polkadot-address") ?? nativePaymentAddressFromRuntime(runtime);
      addCheck("Polkadot payment address", Boolean(polkadotAddress), nativePaymentAddressDetail(flags, runtime), false);
      if (polkadotSeedCheck.ok && polkadotSeed && polkadotAddress) {
        const match = await checkSeedAddressMatch(polkadotSeed, polkadotAddress, nativePaymentAddressDetail(flags, runtime));
        addCheck("Polkadot seed/address match", match.ok, match.detail);
      }
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
  sourceRelayUrl?: string;
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
  sourceRelayUrl?: string;
}

type LaunchDemoGatewayCapabilityReport = GatewayCapabilityReport & {
  gateway: GatewayCapabilityReport["gateway"] & {
    routeStateAvailable?: boolean;
  };
};

interface LaunchDemoCapacityReport {
  receivedAt?: string;
  report: LaunchDemoGatewayCapabilityReport;
  sourceRelayUrl?: string;
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
  packageName?: string;
  packageVersion?: string;
}

async function launchDemoCommand(flags: Map<string, string | boolean>, runtime: CliRuntime) {
  launchDemoDebug("start");
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
  launchDemoDebug("resolved network manifest");
  const relayUrl =
    stringFlag(flags, "relay-url") ??
    optionalEnv("SWITCHBOARD_LAUNCH_DEMO_RELAY_URL") ??
    manifestConfig.relayUrl ??
    DEFAULT_CONTROL_PLANE_URL;
  const relayUrls = controlRelayCandidateUrls(relayUrl, manifestConfig, {
    pinned: relayUrlPinnedByUser(flags, ["SWITCHBOARD_LAUNCH_DEMO_RELAY_URL"])
  });
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
  const selection = await selectLaunchDemoCapacity({
    relayUrl,
    relayUrls,
    network: acurastNetwork,
    durationMinutes,
    scheduleBufferMinutes,
    processorCount: requestedProcessorCount,
    minReady: minReadyProcessors,
    operatorId: stringFlag(flags, "operator-id"),
    gatewayId: stringFlag(flags, "gateway-id"),
    processor: stringFlag(flags, "processor")
  });
  launchDemoDebug(`selected ${selection.processors.length} processor candidate(s)`);
  const operationRelayUrl = selection.sourceRelayUrl ?? relayUrl;
  const ingressEstimate = await fetchLaunchDemoQuotePreview({
    relayUrl: operationRelayUrl,
    assetAddress: manifestConfig.defaultAssetAddress,
    paidSeconds,
    manifestConfig,
    timeoutMs: numberFlag(flags, "quote-preview-timeout-ms", "SWITCHBOARD_LAUNCH_DEMO_QUOTE_PREVIEW_TIMEOUT_MS", 15_000),
    retries: numberFlag(flags, "quote-preview-retries", "SWITCHBOARD_LAUNCH_DEMO_QUOTE_PREVIEW_RETRIES", 2),
    retryDelayMs: numberFlag(flags, "quote-preview-retry-delay-ms", "SWITCHBOARD_LAUNCH_DEMO_QUOTE_PREVIEW_RETRY_DELAY_MS", 1_000)
  });
  launchDemoDebug(`quote preview ${ingressEstimate.ok ? "ok" : "unavailable"}`);
  if (!boolFlag(flags, "dry-run") && !ingressEstimate.ok) {
    throw new Error(`Ingress quote preview unavailable: ${ingressEstimate.error}`);
  }
  const demoProject = await createLaunchDemoProject(flags);
  launchDemoDebug("created demo project");
  if (!boolFlag(flags, "dry-run")) {
    assertLaunchDemoRuntimePackageFresh(demoProject, flags);
  }

  const childArgs = [
    INTERNAL_DEPLOY_RUNNER_SCRIPT,
    "--",
    "--yes",
    "--relay-url",
    operationRelayUrl,
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
  if (boolFlag(flags, "allow-local-relay") || isPrivateOrLocalUrl(operationRelayUrl)) {
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
    SWITCHBOARD_DEPLOY_RELAY_URL: operationRelayUrl,
    SWITCHBOARD_DEPLOY_ROUTE_ACTIVATION_MODE: "relay-reconciled",
    SWITCHBOARD_DEPLOY_VALIDATOR_MODE: "skip",
    SWITCHBOARD_DEPLOY_DURATION_MINUTES: String(durationMinutes),
    SWITCHBOARD_DEPLOY_SCHEDULE_BUFFER_MINUTES: String(scheduleBufferMinutes),
    SWITCHBOARD_DEPLOY_GROUP_MODE: groupDeployEnabled ? "true" : undefined,
    SWITCHBOARD_DEPLOY_GROUP_MEMBERS: groupDeployEnabled ? JSON.stringify(selection.members.map(launchDemoMemberEnv)) : undefined,
    SWITCHBOARD_DEPLOY_EXPECTED_REPLICAS: groupDeployEnabled ? String(selection.members.length) : undefined,
    SWITCHBOARD_DEPLOY_MIN_READY: groupDeployEnabled ? String(minReadyProcessors) : undefined,
    SWITCHBOARD_LAUNCH_DEMO: "true",
    SWITCHBOARD_DEMO_VERSION: demoProject.packageVersion,
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
    RELAY_URL: operationRelayUrl,
    PROOF_CONTROL_PLANE_URL: operationRelayUrl,
    PAYMENT_ASSET_ADDRESS: manifestConfig.defaultAssetAddress,
    PROOF_QUOTE_DEFAULT_ASSET: manifestConfig.defaultAssetAddress,
    SWITCHBOARD_DEPLOY_EXPECTED_QUOTE_AMOUNT: ingressEstimate.ok ? ingressEstimate.amount : undefined,
    SWITCHBOARD_DEPLOY_COLOR: cliColorEnabled(boolFlag(flags, "json") ? process.stderr : process.stdout) ? "1" : undefined
  };
  const workflowInput = launchDemoWorkflowInputFromCli({
    relayUrl: operationRelayUrl,
    manifestConfig,
    flags,
    durationMinutes,
    maxCostPerExecution,
    selection,
    demoProject,
    minReady: minReadyProcessors,
    groupDeployEnabled
  });
  const workflowStore = deployWorkflowStore(flags);
  const workflow = new SwitchboardDeployWorkflow(workflowInput, deployWorkflowAdapters(workflowInput, workflowStore, {
    helperEnv: contextRuntimeEnv(runtime)
  }));
  const capacitySnapshot = await workflow.advanceOnce();

  if (boolFlag(flags, "dry-run")) {
    const output = {
      ok: true,
      action: "launch-demo-dry-run",
      command: SWITCHBOARD_CLI,
      args: ["launch-demo", "--yes-spend"],
      relayUrl: operationRelayUrl,
      relayCandidates: relayUrls,
      target: target.name,
      acurastNetwork,
      durationMinutes,
      processorCount: requestedProcessorCount,
      candidateProcessorCount: selection.processors.length,
      minReadyProcessors,
      fixedStartDelayMs: DEFAULT_LAUNCH_DEMO_START_DELAY_MS,
      scheduleBufferMinutes,
      maxCostPerExecution,
      ingressEstimate,
      selection: launchDemoSelectionOutput(selection),
      demoProject,
      env: childEnv,
      workflow: {
        workflowId: capacitySnapshot.workflowId,
        input: workflowInput,
        snapshot: capacitySnapshot,
        events: capacitySnapshot.events
      },
      note: "No Acurast deployment, Hub transaction, DNS change, or route mutation was attempted."
    };
    writeOutput(flags, output, () => {
      console.log(sectionTitle("Switchboard launch-demo dry run"));
      printOutputRows([
        { label: "Relay", value: operationRelayUrl },
        { label: "Operator", value: formatOperator(selection.operatorId, selection.gatewayId) },
        { label: "Manager", value: selection.managerId ?? "pinned processor" },
        { label: "Processors", value: formatLaunchDemoProcessors(selection) },
        { label: "HA readiness", value: `${requestedProcessorCount}/${requestedProcessorCount} requested; ${selection.processors.length} candidate(s); min ${minReadyProcessors}` },
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
      relayUrl: operationRelayUrl,
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

  const { report, reportPath } = groupDeployEnabled
    ? await runDeployWorkflowGroupRunner({
        workflow,
        workflowStore,
        childArgs,
        childEnv,
        runtime,
        action: "launch-demo",
        json: boolFlag(flags, "json"),
        workDir: demoProject.dir
      })
    : await runDeployWorkflowCompatibilityRunner({
        workflow,
        workflowStore,
        childArgs,
        childEnv,
        runtime,
        action: "launch-demo",
        json: boolFlag(flags, "json"),
        workDir: demoProject.dir
      });
  const output = deployOutput(report, reportPath, {
    action: "launch-demo",
    relayUrl: operationRelayUrl,
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
  if (output.ok !== true) {
    printOrWriteDeployReportFailure(flags, output, report, reportPath, "launch-demo");
    throwHandledDeployReportFailure(report, reportPath, "launch-demo");
  }

  writeOutput(flags, output, () => printDeployResult(output));
}

function launchDemoDebug(message: string): void {
  if (process.env.SWITCHBOARD_LAUNCH_DEMO_DEBUG === "true") {
    console.error(`[launch-demo-debug] ${message}`);
  }
}

async function createLaunchDemoProject(flags: Map<string, string | boolean>): Promise<LaunchDemoProject> {
  const packageSpec =
    stringFlag(flags, "demo-package") ??
    optionalEnv("SWITCHBOARD_LAUNCH_DEMO_PACKAGE_SPEC") ??
    DEFAULT_LAUNCH_DEMO_PACKAGE_SPEC;
  const packageMetadata = await launchDemoPackageMetadata(packageSpec);
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
  return {
    dir,
    entrypoint: LAUNCH_DEMO_ENTRYPOINT,
    packageSpec,
    packageName: packageMetadata.name,
    packageVersion: packageMetadata.version
  };
}

async function launchDemoPackageMetadata(packageSpec: string): Promise<{ name?: string; version?: string }> {
  if (packageSpec.startsWith("file:")) {
    const rawPath = packageSpec.slice("file:".length);
    const packageDir = rawPath.startsWith("/") ? rawPath : path.resolve(process.cwd(), rawPath);
    try {
      const parsed = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      return {
        name: typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : undefined,
        version: typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : undefined
      };
    } catch {
      return {};
    }
  }
  const tag = packageSpec.match(/#v?([0-9]+(?:\.[0-9]+){1,2}(?:[-+][A-Za-z0-9.-]+)?)$/)?.[1];
  const npmVersion = packageSpec.match(/@([0-9]+(?:\.[0-9]+){1,2}(?:[-+][A-Za-z0-9.-]+)?)$/)?.[1];
  const knownDemoPackage = /(^|[/@:])switchboard-express-demo($|[#@?])/.test(packageSpec);
  return {
    name: knownDemoPackage ? "@proofcomputer/switchboard-express-demo" : undefined,
    version: tag ?? npmVersion
  };
}

function assertLaunchDemoRuntimePackageFresh(project: LaunchDemoProject, flags: Map<string, string | boolean>): void {
  if (!launchDemoPackageIsKnownExpressDemo(project) || !project.packageVersion) {
    return;
  }
  const comparison = compareSemver(project.packageVersion, MIN_LAUNCH_DEMO_RUNTIME_VERSION);
  if (comparison === undefined || comparison >= 0) {
    return;
  }

  const error =
    `SB_LAUNCH_DEMO_RUNTIME_STALE: launch-demo package ${project.packageSpec} resolves to ` +
    `@proofcomputer/switchboard-express-demo v${project.packageVersion}, which lacks the current runtime support for gateway upstream admission and bounded certificate-prep progress with ECDSA CSRs. ` +
    `Use ${DEFAULT_LAUNCH_DEMO_PACKAGE_SPEC}, or publish a demo package built with @proofcomputer/switchboard-sdk >= ${MIN_LAUNCH_DEMO_SDK_VERSION}.`;
  if (boolFlag(flags, "json")) {
    const handled = new Error(error);
    writeOutput(flags, {
      ok: false,
      action: "launch-demo",
      code: "SB_LAUNCH_DEMO_RUNTIME_STALE",
      error,
      demoProject: project,
      required: {
        package: "@proofcomputer/switchboard-express-demo",
        minVersion: MIN_LAUNCH_DEMO_RUNTIME_VERSION,
        minSdkVersion: MIN_LAUNCH_DEMO_SDK_VERSION,
        capabilities: ["gateway_upstream_admission", "certificate_prep_progress", "ecdsa_p256_csr"],
        packageSpec: DEFAULT_LAUNCH_DEMO_PACKAGE_SPEC
      }
    }, () => undefined);
    markErrorOutputHandled(handled);
    throw handled;
  }
  throw new Error(error);
}

function launchDemoPackageIsKnownExpressDemo(project: LaunchDemoProject): boolean {
  return (
    project.packageName === "@proofcomputer/switchboard-express-demo" ||
    /(^|[/@:])switchboard-express-demo($|[#@?])/.test(project.packageSpec)
  );
}

function compareSemver(left: string, right: string): number | undefined {
  const leftParts = parseStableSemver(left);
  const rightParts = parseStableSemver(right);
  if (!leftParts || !rightParts) {
    return undefined;
  }
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

function parseStableSemver(value: string): [number, number, number] | undefined {
  const match = value.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+].*)?$/);
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
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

export function relayUrlPinnedByUser(flags: Map<string, string | boolean>, envNames: string[]): boolean {
  return Boolean(relayUrlFlagPinnedByUser(flags) || envNames.some((name) => Boolean(optionalEnv(name))));
}

function relayUrlFlagPinnedByUser(flags: Map<string, string | boolean>): boolean {
  return Boolean(stringFlag(flags, "relay-url") && flags.get(runtimeDefaultFlagName("relay-url")) !== true);
}

function controlRelayCandidateUrls(
  primaryRelayUrl: string,
  manifestConfig: CliNetworkConfig,
  options: { pinned: boolean }
): string[] {
  if (options.pinned) {
    return [normalizeCliBaseUrl(primaryRelayUrl)];
  }
  return uniqueStrings([
    primaryRelayUrl,
    ...(manifestConfig.controlApiUrls ?? []),
    ...manifestRelayControlUrls(manifestConfig)
  ].map(normalizeCliBaseUrl));
}

function manifestRelayControlUrls(manifestConfig: CliNetworkConfig): string[] {
  return (manifestConfig.manifest?.relays ?? [])
    .filter((relay) => (relay.active ?? true) !== false)
    .map((relay) => relay.controlPlaneUrl ?? relay.apiBaseUrl)
    .filter((url): url is string => Boolean(url));
}

export function validatorLaunchControlRelayCandidates(
  requestedRelayUrl: string,
  manifestConfig: CliNetworkConfig,
  options: { pinned: boolean }
): string[] {
  if (options.pinned) {
    return [normalizeCliBaseUrl(requestedRelayUrl)];
  }
  const directRelayUrls = uniqueStrings(manifestRelayControlUrls(manifestConfig).map(normalizeCliBaseUrl));
  if (directRelayUrls.length > 0) {
    return directRelayUrls;
  }
  return controlRelayCandidateUrls(requestedRelayUrl, manifestConfig, { pinned: false });
}

export interface WritableControlRelaySelection {
  relayUrl: string;
  probes: WritableControlRelayProbe[];
}

export interface WritableControlRelayProbe {
  relayUrl: string;
  ok: boolean;
  healthOk?: boolean;
  readinessOk?: boolean;
  authorityEligible?: boolean;
  elapsedMs?: number;
  detail: string;
}

export async function selectWritableControlRelayUrl(
  relayUrls: string[],
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {}
): Promise<WritableControlRelaySelection> {
  const candidates = uniqueStrings(relayUrls.map(normalizeCliBaseUrl));
  if (candidates.length === 0) {
    throw new Error("No control relay URLs are available for validator launch");
  }
  if (candidates.length === 1) {
    return {
      relayUrl: candidates[0],
      probes: []
    };
  }
  const probes = await Promise.all(
    candidates.map((relayUrl) => probeWritableControlRelay(relayUrl, options))
  );
  const selected = probes
    .filter((probe) => probe.ok)
    .sort((left, right) => (left.elapsedMs ?? Number.MAX_SAFE_INTEGER) - (right.elapsedMs ?? Number.MAX_SAFE_INTEGER))[0];
  if (selected) {
    return {
      relayUrl: selected.relayUrl,
      probes
    };
  }
  throw new Error(
    `No writable control relay is currently healthy for validator launch: ${probes.map((probe) => `${probe.relayUrl}=${probe.detail}`).join("; ")}`
  );
}

async function probeWritableControlRelay(
  relayUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }
): Promise<WritableControlRelayProbe> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const startedAt = Date.now();
  try {
    const health = await fetchImpl(new URL("/health", relayUrl), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const healthBody = await health.text();
    if (!health.ok) {
      return {
        relayUrl,
        ok: false,
        healthOk: false,
        elapsedMs: Date.now() - startedAt,
        detail: `health ${health.status} ${truncateText(healthBody || health.statusText, 180)}`
      };
    }
  } catch (error) {
    return {
      relayUrl,
      ok: false,
      healthOk: false,
      elapsedMs: Date.now() - startedAt,
      detail: `health ${safeErrorMessage(error)}`
    };
  }

  try {
    const readiness = await fetchImpl(new URL("/v1/control-readiness", relayUrl), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const readinessBody = await readiness.text();
    if (readiness.status === 404) {
      return {
        relayUrl,
        ok: true,
        healthOk: true,
        readinessOk: false,
        elapsedMs: Date.now() - startedAt,
        detail: "health ok; readiness endpoint unavailable"
      };
    }
    const parsed = readinessBody ? parseJsonObject(readinessBody) : undefined;
    const authorityEligible = typeof parsed?.authorityEligible === "boolean" ? parsed.authorityEligible : undefined;
    if (readiness.ok && authorityEligible !== false) {
      return {
        relayUrl,
        ok: true,
        healthOk: true,
        readinessOk: true,
        authorityEligible,
        elapsedMs: Date.now() - startedAt,
        detail: "health ok; readiness ok"
      };
    }
    if (authorityEligible === false) {
      return {
        relayUrl,
        ok: false,
        healthOk: true,
        readinessOk: readiness.ok,
        authorityEligible,
        elapsedMs: Date.now() - startedAt,
        detail: `readiness authority ineligible ${readiness.status} ${truncateText(readinessBody || readiness.statusText, 180)}`
      };
    }
    return {
      relayUrl,
      ok: true,
      healthOk: true,
      readinessOk: false,
      elapsedMs: Date.now() - startedAt,
      detail: `health ok; readiness non-blocking ${readiness.status} ${truncateText(readinessBody || readiness.statusText, 180)}`
    };
  } catch (error) {
    return {
      relayUrl,
      ok: true,
      healthOk: true,
      readinessOk: false,
      elapsedMs: Date.now() - startedAt,
      detail: `health ok; readiness non-blocking ${safeErrorMessage(error)}`
    };
  }
}

function normalizeCliBaseUrl(value: string): string {
  return new URL("/", value).toString().replace(/\/$/, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

async function selectLaunchDemoCapacity(input: {
  relayUrl: string;
  relayUrls?: string[];
  network: AcurastNetwork;
  durationMinutes: number;
  scheduleBufferMinutes: number;
  processorCount: number;
  minReady: number;
  operatorId?: string;
  gatewayId?: string;
  processor?: string;
  requiredModules?: string[];
}): Promise<LaunchDemoCapacitySelection> {
  const relayUrls = input.relayUrls?.length ? input.relayUrls : [input.relayUrl];
  const reports = await readLaunchDemoCapabilityReports(relayUrls);
  const errors: string[] = [];
  const requestedOperatorId = input.operatorId?.toLowerCase();
  const requestedProcessorId = input.processor ? processorRefToId(input.processor) : undefined;
  if (input.processor && !requestedProcessorId) {
    throw new Error(`Cannot normalize pinned processor ${input.processor}; expected a 32-byte hex processor ID or SS58 processor address.`);
  }
  const eligibleReports = reports
    .filter((stored) => {
      if (requestedOperatorId && stored.report.operator.operatorId.toLowerCase() !== requestedOperatorId) {
        return false;
      }
      if (input.gatewayId && stored.report.operator.gatewayId !== input.gatewayId) {
        return false;
      }
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
        const allowedProcessors = launchDemoManagerScopeProcessors(scope);
        if (allowedProcessors.length === 0) {
          errors.push(`${report.operator.gatewayId}/${scope.managerId}: capability report listed no gateway-local processors`);
          continue;
        }
        const excludedIds = new Set(
          (scope.excludeProcessors ?? []).map((value) => processorRefToId(value)).filter((value): value is string => Boolean(value))
        );
        const scopedCandidateProcessors = allowedProcessors.filter((processor) => {
          const processorId = processorRefToId(processor);
          if (!processorId || excludedIds.has(processorId)) {
            return false;
          }
          return requestedProcessorId ? processorId === requestedProcessorId : true;
        });
        if (scopedCandidateProcessors.length === 0) {
          errors.push(`${report.operator.gatewayId}/${scope.managerId}: no matching gateway-local processors`);
          continue;
        }
        for (const processor of scopedCandidateProcessors) {
          const processorId = processorRefToId(processor);
          if (!processorId) continue;
          candidates.push(
            launchDemoMemberFromReport(stored, {
              memberId: `member-${candidates.length + 1}`,
              processor,
              processorId,
              managerId: scope.managerId,
              readiness: capabilityReportProcessorReadiness(processor)
            })
          );
        }
      } catch (error) {
        errors.push(`${report.operator.gatewayId}/${scope.managerId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const filteredCandidates = await filterAcurastModuleCapableMembers(candidates, {
    network: input.network,
    requiredModules: input.requiredModules,
    errors
  });

  if (filteredCandidates.length < input.processorCount) {
    const reason = errors.length > 0 ? ` Checked: ${errors.slice(0, 5).join("; ")}` : "";
    const pinned = [
      input.operatorId ? `operator ${input.operatorId}` : undefined,
      input.gatewayId ? `gateway ${input.gatewayId}` : undefined,
      input.processor ? `processor ${input.processor}` : undefined
    ].filter(Boolean).join(", ");
    const scope = pinned ? ` for ${pinned}` : "";
    const source = relayUrls.length === 1 ? relayUrls[0] : `${relayUrls.length} control relays`;
    throw new Error(`Only ${filteredCandidates.length}/${input.processorCount} launch-demo processors are currently available from ${source}${scope}.${reason}`);
  }

  const selectedMembers = selectLaunchDemoCandidatePool(filteredCandidates, input.processorCount);
  const selectedGateways = new Set(selectedMembers.map((member) => member.gatewayId));
  if (input.processorCount > 1 && selectedGateways.size < 2) {
    throw new Error(`launch-demo --ha requires selected members across at least two gateways; selected ${selectedGateways.size}`);
  }
  if (selectedMembers.length < input.minReady) {
    throw new Error(`Only ${selectedMembers.length}/${input.minReady} launch-demo members could be selected`);
  }
  return launchDemoSelectionFromMembers(selectedMembers);
}

export function launchDemoManagerScopeProcessors(scope: ProcessorScope): string[] {
  if (scope.kind !== "manager") {
    return [];
  }
  return [...new Set([...(scope.processors ?? []), ...(scope.includeProcessors ?? [])].filter((value) => value.length > 0))];
}

export function selectLaunchDemoCandidatePool(
  candidates: LaunchDemoMemberSelection[],
  processorCount: number
): LaunchDemoMemberSelection[] {
  return selectLaunchDemoMembers(candidates, processorCount);
}

function launchDemoMemberFromReport(
  report: LaunchDemoCapacityReport,
  input: {
    memberId: string;
    processor: string;
    processorId: string;
    managerId?: string;
    readiness: ProcessorInfo;
  }
): LaunchDemoMemberSelection {
  return {
    memberId: input.memberId,
    operatorId: report.report.operator.operatorId.toLowerCase(),
    gatewayId: report.report.operator.gatewayId,
    managerId: input.managerId,
    processor: input.processor,
    processorId: input.processorId,
    readiness: input.readiness,
    reportId: report.report.reportId,
    reportExpiresAt: report.report.expiresAt,
    publicAddresses: report.report.gateway.publicAddresses,
    activeRouteCount: report.report.gateway.activeRouteCount,
    routeCapacity: report.report.gateway.routeCapacity,
    sourceRelayUrl: report.sourceRelayUrl
  };
}

function capabilityReportProcessorReadiness(processor: string): ProcessorInfo {
  return {
    processor,
    heartbeatMs: Date.now(),
    heartbeatIso: new Date().toISOString(),
    heartbeatAgeSeconds: 0,
    version: "capability-report-candidate"
  };
}

async function selectDeployCapacity(input: {
  relayUrl: string;
  relayUrls?: string[];
  network: AcurastNetwork;
  operatorId?: string;
  gatewayId?: string;
  processor?: string;
  requiredModules?: string[];
}): Promise<LaunchDemoCapacitySelection> {
  const requestedOperatorId = input.operatorId?.toLowerCase();
  const requestedProcessorId = input.processor ? processorRefToId(input.processor) : undefined;
  if (input.processor && !requestedProcessorId) {
    throw new Error(`Cannot normalize pinned processor ${input.processor}; expected a 32-byte hex processor ID or SS58 processor address.`);
  }
  const reports = await readLaunchDemoCapabilityReports(input.relayUrls?.length ? input.relayUrls : [input.relayUrl]);
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
    const matchingProcessors = requestedProcessorId
      ? processors.filter((processor) => processor.processorId === requestedProcessorId)
      : processors;
    if (matchingProcessors.length === 0) {
      errors.push(`${report.operator.gatewayId}: requested processor ${input.processor} not in capability report`);
      continue;
    }
    for (const processor of matchingProcessors) {
      const operatorId = report.operator.operatorId.toLowerCase();
      const processorRef = requestedProcessorId ? input.processor ?? processor.address ?? processor.processorId : processor.address ?? processor.processorId;
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
        sourceRelayUrl: stored.sourceRelayUrl
      });
    }
  }

  const filteredCandidates = await filterAcurastModuleCapableMembers(candidates, {
    network: input.network,
    requiredModules: input.requiredModules,
    errors
  });
  filteredCandidates.sort(compareLaunchDemoMembers);
  const selected = filteredCandidates[0];
  if (!selected) {
    const request = [
      input.operatorId ? `operator ${input.operatorId}` : undefined,
      input.gatewayId ? `gateway ${input.gatewayId}` : undefined,
      input.processor ? `processor ${input.processor}` : undefined
    ].filter(Boolean).join(", ") || "available operator capacity";
    const checked = errors.length > 0 ? ` Checked: ${errors.slice(0, 5).join("; ")}` : "";
    throw new Error(`No route-state-capable deploy capacity matched ${request}.${checked}`);
  }
  return launchDemoSelectionFromMembers([{ ...selected, memberId: "member-1" }]);
}

export async function selectPinnedDeployCapacity(input: {
  relayUrl: string;
  relayUrls?: string[];
  network: AcurastNetwork;
  operatorId: string;
  processor: string;
  gatewayId?: string;
  requiredModules?: string[];
}): Promise<LaunchDemoCapacitySelection> {
  return selectDeployCapacity({
    relayUrl: input.relayUrl,
    relayUrls: input.relayUrls,
    network: input.network,
    operatorId: input.operatorId,
    gatewayId: input.gatewayId,
    processor: input.processor,
    requiredModules: input.requiredModules
  });
}

async function filterAcurastModuleCapableMembers(
  members: LaunchDemoMemberSelection[],
  input: {
    network: AcurastNetwork;
    requiredModules?: string[];
    errors?: string[];
  }
): Promise<LaunchDemoMemberSelection[]> {
  const requiredModules = [...new Set((input.requiredModules ?? []).filter((module) => module.length > 0))];
  if (requiredModules.length === 0 || members.length === 0) {
    return members;
  }

  const api = await ApiPromise.create({
    provider: new WsProvider(rpcForAcurastNetwork(input.network)),
    noInitWarn: true,
    types: { ...CUSTOM_TYPES }
  });
  await api.isReady;
  try {
    const marketplace = (api.query as any).acurastMarketplace;
    if (!marketplace?.storedAdvertisementRestriction) {
      throw new Error("Acurast marketplace advertisement restrictions are unavailable on this network");
    }
    const restrictions = await marketplace.storedAdvertisementRestriction.multi(members.map((member) => member.processor));
    return members.filter((member, index) => {
      const availableModules = acurastAvailableModulesFromRestriction(restrictions[index]?.toJSON());
      const missing = requiredModules.filter((module) => !availableModules.includes(module));
      if (missing.length === 0) {
        return true;
      }
      input.errors?.push(
        `${member.gatewayId}/${member.processor}: missing Acurast module(s) ${missing.join(", ")}; advertised ${availableModules.join(", ") || "none"}`
      );
      return false;
    });
  } finally {
    await api.disconnect().catch(() => undefined);
  }
}

function acurastAvailableModulesFromRestriction(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const modules = (value as Record<string, unknown>).availableModules;
  return Array.isArray(modules) ? modules.map(String) : [];
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

  return renumberLaunchDemoMembers(selected);
}

function renumberLaunchDemoMembers(members: LaunchDemoMemberSelection[]): LaunchDemoMemberSelection[] {
  return members.map((member, index) => ({ ...member, memberId: `member-${index + 1}` }));
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
    readiness: first.readiness,
    sourceRelayUrl: first.sourceRelayUrl
  };
}

export async function readLaunchDemoCapabilityReports(relayUrls: string | string[]): Promise<LaunchDemoCapacityReport[]> {
  const urls = Array.isArray(relayUrls) ? relayUrls : [relayUrls];
  if (urls.length === 1) {
    return readLaunchDemoCapabilityReportsFromRelay(urls[0]);
  }
  const results = await Promise.all(urls.map((relayUrl) => readLaunchDemoCapacityFromRelay(relayUrl)));
  const successfulReports = results.flatMap((result) => result.ok ? result.reports : []);
  if (successfulReports.length > 0) {
    return newestLaunchDemoReportsByGateway(successfulReports);
  }
  const details = results
    .map((result) => result.ok ? `${result.relayUrl}:0` : `${result.relayUrl}:${result.error}`)
    .join("; ");
  throw new Error(`Operator capacity lookup failed across ${urls.length} control relays: ${details}`);
}

async function readLaunchDemoCapabilityReportsFromRelay(relayUrl: string): Promise<LaunchDemoCapacityReport[]> {
  const result = await readLaunchDemoCapacityFromRelay(relayUrl);
  if (result.ok) {
    return result.reports;
  }
  throw new Error(`Operator capacity lookup failed at ${relayUrl}: ${result.error}`);
}

async function readLaunchDemoCapacityFromRelay(relayUrl: string): Promise<
  | { ok: true; relayUrl: string; reports: LaunchDemoCapacityReport[] }
  | { ok: false; relayUrl: string; error: string }
> {
  const url = new URL("/v1/operator-capacity", relayUrl);
  url.searchParams.set("activeOnly", "true");
  url.searchParams.set("limit", "100");
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json"
      },
      signal: AbortSignal.timeout(15_000)
    });
    const body = await response.text();
    const parsed = body ? parseJsonObject(body) : {};
    if (response.status === 404) {
      return {
        ok: true,
        relayUrl,
        reports: (await readLegacyLaunchDemoCapabilityReports(relayUrl)).map((report) => ({ ...report, sourceRelayUrl: relayUrl }))
      };
    }
    if (!response.ok || parsed?.ok !== true) {
      const error = stringRecordField(parsed, "error") ?? `http_${response.status}`;
      const reason = stringRecordField(parsed, "staleReason") ?? stringRecordField(parsed, "reason");
      return {
        ok: false,
        relayUrl,
        error: reason ? `${error}:${reason}` : `${error}:${body.slice(0, 300)}`
      };
    }
    const values = Array.isArray(parsed.latest) ? parsed.latest : Array.isArray(parsed.reports) ? parsed.reports : [];
    return {
      ok: true,
      relayUrl,
      reports: values
        .filter(isLaunchDemoCapacityReport)
        .map((report) => ({ ...report, sourceRelayUrl: relayUrl }))
    };
  } catch (error) {
    return {
      ok: false,
      relayUrl,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function newestLaunchDemoReportsByGateway(reports: LaunchDemoCapacityReport[]): LaunchDemoCapacityReport[] {
  const latest = new Map<string, LaunchDemoCapacityReport>();
  for (const report of reports) {
    const key = `${report.report.operator.operatorId.toLowerCase()}:${report.report.operator.gatewayId}`;
    const existing = latest.get(key);
    if (!existing || Date.parse(report.report.reportedAt) > Date.parse(existing.report.reportedAt)) {
      latest.set(key, report);
    }
  }
  return [...latest.values()].sort((left, right) => {
    const routeDiff = left.report.gateway.activeRouteCount - right.report.gateway.activeRouteCount;
    if (routeDiff !== 0) return routeDiff;
    return Date.parse(right.report.reportedAt) - Date.parse(left.report.reportedAt);
  });
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

export async function fetchLaunchDemoQuotePreview(input: {
  relayUrl: string;
  assetAddress?: string;
  paidSeconds: string;
  manifestConfig: CliNetworkConfig;
  timeoutMs: number;
  retries?: number;
  retryDelayMs?: number;
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

  const retries = input.retries ?? 0;
  const retryDelayMs = input.retryDelayMs ?? 1_000;
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
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
        const error = `${response.status} ${truncateText(body || response.statusText, 300)}`;
        if (!isRetryableLaunchDemoQuotePreviewStatus(response.status) || attempt >= retries) {
          return { ok: false, error };
        }
        lastError = error;
      } else {
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
      }
    } catch (error) {
      if (!isRetryableLaunchDemoQuotePreviewError(error) || attempt >= retries) {
        return { ok: false, error: safeErrorMessage(error) };
      }
      lastError = safeErrorMessage(error);
    }
    await delay(retryDelayMs);
  }
  return { ok: false, error: lastError || "quote preview failed" };
}

function isRetryableLaunchDemoQuotePreviewStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function isRetryableLaunchDemoQuotePreviewError(error: unknown): boolean {
  const name = error && typeof error === "object" ? String((error as { name?: unknown }).name ?? "") : "";
  return name === "AbortError" || name === "TimeoutError" || /timeout|network|fetch failed/i.test(safeErrorMessage(error));
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

function packagedJobBundleName(_entrypoint: string | undefined): undefined {
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
    sourceRelayUrl: selection.sourceRelayUrl,
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
    sourceRelayUrl: member.sourceRelayUrl,
    heartbeatAgeSeconds: member.readiness.heartbeatAgeSeconds,
    availability: member.readiness.availability
  };
}

function launchDemoWorkflowInputFromCli(input: {
  relayUrl: string;
  manifestConfig: CliNetworkConfig;
  flags: Map<string, string | boolean>;
  durationMinutes: number;
  maxCostPerExecution: string;
  selection: LaunchDemoCapacitySelection;
  demoProject: LaunchDemoProject;
  minReady: number;
  groupDeployEnabled?: boolean;
}): SwitchboardDeployWorkflowInput {
  const target = targetFromFlags(input.flags, input.manifestConfig);
  return launchDemoWorkflowInput({
    deploymentMode: input.groupDeployEnabled ? "group" : "single",
    relayUrl: input.relayUrl,
    allowInsecureHttp: boolFlag(input.flags, "allow-local-relay"),
    target: {
      name: target.name,
      chainId: input.manifestConfig.chainId ?? target.expectedChainId?.toString() ?? "",
      registryAddress: input.manifestConfig.registryAddress ?? "",
      ethRpcUrl: input.manifestConfig.ethRpcUrl,
      substrateWsUrl: input.manifestConfig.substrateWsUrl
    },
    durationSeconds: input.durationMinutes * 60,
    asset: input.manifestConfig.defaultAssetAddress,
    quoteCapAmount: deployWorkflowQuoteCapAmount(input.flags),
    certificateMode: "job-acme",
    capacity: launchDemoWorkflowCapacity(input.selection),
    group: input.groupDeployEnabled ? {
      expectedReplicas: input.selection.members.length,
      minReady: input.minReady,
      members: input.selection.members.map(launchDemoWorkflowGroupMember)
    } : undefined,
    pins: {
      operatorId: input.selection.operatorId,
      processorId: input.selection.processorId,
      processor: input.selection.processor,
      gatewayId: input.selection.gatewayId,
      managerId: input.selection.managerId
    },
    source: {
      mode: "switchboard-cli-launch-demo",
      compatibilityRunner: "switchboard-deploy",
      demoPackageSpec: input.demoProject.packageSpec,
      demoPackageVersion: input.demoProject.packageVersion
    },
    demoPackage: input.demoProject.packageSpec,
    minReady: input.minReady
  });
}

function launchDemoWorkflowGroupMember(member: LaunchDemoMemberSelection): SwitchboardGroupMemberSelection {
  return {
    memberId: member.memberId,
    operatorId: member.operatorId,
    processorId: member.processorId,
    processor: member.processor,
    gatewayId: member.gatewayId,
    managerId: member.managerId,
    reportId: member.reportId,
    reportExpiresAt: member.reportExpiresAt,
    publicAddresses: member.publicAddresses,
    sourceRelayUrl: member.sourceRelayUrl
  };
}

function launchDemoWorkflowCapacity(selection: LaunchDemoCapacitySelection): SwitchboardCapacitySelection {
  return {
    operatorId: selection.operatorId,
    processorId: selection.processorId,
    processor: selection.processor,
    gatewayId: selection.gatewayId,
    managerId: selection.managerId,
    reportId: selection.reportId,
    reportExpiresAt: selection.reportExpiresAt,
    publicAddresses: selection.publicAddresses,
    sourceRelayUrl: selection.sourceRelayUrl
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

type DeployRuntimeConfig =
  | { kind: "node" }
  | {
      kind: "script";
      entrypoint: string;
      image: { url: string; sha256: string };
      scriptFiles: string[];
      authorizedKeysFile?: string;
      authorizedKeys?: string;
      authorizedKeysPresent: boolean;
    };

async function resolveDeployRuntimeConfig(
  flags: Map<string, string | boolean>,
  options: { dryRun: boolean; projectRoot?: string }
): Promise<DeployRuntimeConfig> {
  const runtime = stringFlag(flags, "runtime") ?? optionalEnv("ACURAST_RUNTIME") ?? ACURAST_NODE_RUNTIME;
  if (runtime !== ACURAST_NODE_RUNTIME && runtime !== ACURAST_SCRIPT_RUNTIME) {
    throw new Error(`Unsupported deploy runtime: ${runtime}. Supported runtimes: ${ACURAST_NODE_RUNTIME}, ${ACURAST_SCRIPT_RUNTIME}`);
  }
  if (runtime === ACURAST_NODE_RUNTIME) {
    return { kind: "node" };
  }

  const entrypointFlag = stringFlag(flags, "entrypoint") ?? optionalEnv("ACURAST_ENTRYPOINT");
  const entrypoint = scriptEntrypointName(entrypointFlag, options.projectRoot);
  const imageUrl = stringFlag(flags, "script-image-url") ?? optionalEnv("ACURAST_SCRIPT_IMAGE_URL");
  const imageSha256 = stringFlag(flags, "script-image-sha256") ?? optionalEnv("ACURAST_SCRIPT_IMAGE_SHA256");
  if (!imageUrl || !imageSha256) {
    throw new Error("Script runtime requires --script-image-url and --script-image-sha256, or acurast.scriptImage in switchboard.json.");
  }

  const scriptFiles = splitCsv(stringFlag(flags, "script-files") ?? optionalEnv("ACURAST_SCRIPT_FILES") ?? entrypoint);
  const authorizedKeysFile = stringFlag(flags, "ssh-public-key-file") ?? optionalEnv("SWITCHBOARD_SSH_PUBLIC_KEY_FILE");
  let authorizedKeys: string | undefined;
  if (authorizedKeysFile && await fileExists(authorizedKeysFile)) {
    authorizedKeys = await readAuthorizedKeysFile(authorizedKeysFile);
  } else if (!options.dryRun) {
    throw new Error("Script SSH deploy requires --ssh-public-key-file or ssh.authorizedKeysFile in switchboard.json before live deploy.");
  }

  return {
    kind: "script",
    entrypoint,
    image: {
      url: imageUrl,
      sha256: imageSha256
    },
    scriptFiles,
    authorizedKeysFile,
    authorizedKeys,
    authorizedKeysPresent: Boolean(authorizedKeys)
  };
}

function scriptEntrypointName(entrypoint: string | undefined, projectRoot: string | undefined): string {
  const value = entrypoint ?? SSH_TEMPLATE_ENTRYPOINT;
  if (!path.isAbsolute(value)) {
    return value;
  }
  if (projectRoot) {
    const relative = path.relative(projectRoot, value);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative;
    }
  }
  return path.basename(value);
}

function deployWorkflowInputFromCli(input: {
  relayUrl: string;
  manifestConfig: CliNetworkConfig;
  flags: Map<string, string | boolean>;
  durationMinutes: number;
  certificateMode: string;
  maxCostPerExecution: string;
  operatorId: string;
  runtimeConfig?: DeployRuntimeConfig;
  processor?: string;
  processorId?: string;
  gatewayId?: string;
  managerId?: string;
  selection?: LaunchDemoCapacitySelection;
}): SwitchboardDeployWorkflowInput {
  const target = targetFromFlags(input.flags, input.manifestConfig);
  const processorId = input.processorId ?? (input.processor ? processorRefToId(input.processor) : undefined);
  const capacity: SwitchboardCapacitySelection = {
    operatorId: input.operatorId,
    processorId: processorId ?? input.processor ?? "auto",
    processor: input.processor,
    gatewayId: input.gatewayId,
    managerId: input.managerId,
    reportId: input.selection?.reportId,
    reportExpiresAt: input.selection?.reportExpiresAt,
    publicAddresses: input.selection?.publicAddresses,
    sourceRelayUrl: input.selection?.sourceRelayUrl
  };
  return {
    relayUrl: input.relayUrl,
    allowInsecureHttp: boolFlag(input.flags, "allow-local-relay"),
    target: {
      name: target.name,
      chainId: input.manifestConfig.chainId ?? target.expectedChainId?.toString() ?? "",
      registryAddress: input.manifestConfig.registryAddress ?? "",
      ethRpcUrl: input.manifestConfig.ethRpcUrl,
      substrateWsUrl: input.manifestConfig.substrateWsUrl
    },
    durationSeconds: input.durationMinutes * 60,
    entrypoint: stringFlag(input.flags, "entrypoint") ?? optionalEnv("ACURAST_ENTRYPOINT"),
    runtime: input.runtimeConfig,
    asset: input.manifestConfig.defaultAssetAddress,
    quoteCapAmount: deployWorkflowQuoteCapAmount(input.flags),
    certificateMode: input.certificateMode === "self-signed" ? "self-signed" : "job-acme",
    validatorMode: "skip",
    capacity,
    pins: {
      operatorId: input.operatorId,
      processorId,
      processor: input.processor,
      gatewayId: input.gatewayId,
      managerId: input.managerId
    },
    source: {
      mode: "switchboard-cli-deploy",
      compatibilityRunner: "switchboard-deploy"
    }
  };
}

function deployWorkflowAdapters(
  input: SwitchboardDeployWorkflowInput,
  store?: ReturnType<typeof deployWorkflowStore>,
  options: { helperEnv?: Record<string, string | undefined> } = {}
): SwitchboardDeployWorkflowAdapters {
  const controlPlane = new SwitchboardControlPlaneClient({
    relayUrl: input.relayUrl,
    allowInsecureHttp: input.allowInsecureHttp === true
  });
  return {
    controlPlane,
    acurast: {
      async submit({ workflow, deploymentIntent, deploymentIntentGroup }) {
        if (workflow.input.deploymentMode === "group") {
          if (!deploymentIntentGroup) {
            throw new Error("Group deploy workflow is missing deployment intent group");
          }
          return {
            id: "cli-runner-acurast-deploy",
            kind: "acurast.deploy",
            description: "Run the compatibility switchboard-deploy group runner",
            payload: buildAcurastGroupDeployRequiredAction(workflow, deploymentIntentGroup)
          };
        }
        if (!deploymentIntent) {
          throw new Error("Deploy workflow is missing deployment intent");
        }
        return {
          id: "cli-runner-acurast-deploy",
          kind: "acurast.deploy",
          description: "Run the compatibility switchboard-deploy runner",
          payload: buildAcurastDeployRequiredAction(workflow, deploymentIntent)
        };
      }
    },
    funding: {
      async requestQuote({ workflow, deploymentIntent, runtime }) {
        return requestDeployWorkflowQuoteViaCliHelper(input, workflow, deploymentIntent, runtime, options.helperEnv);
      },
      async fundQuote({ workflow, deploymentIntent, quote, runtime }) {
        return fundDeployWorkflowQuoteViaCliHelper(input, workflow, deploymentIntent, quote, runtime, options.helperEnv);
      }
    },
    confirmation: {
      async confirmSpend() {
        return true;
      }
    },
    store
  };
}

function deployWorkflowQuoteCapAmount(flags: Map<string, string | boolean>): string | undefined {
  return (
    stringFlag(flags, "payment-amount") ??
    optionalEnv("SWITCHBOARD_QUOTE_CAP_AMOUNT") ??
    optionalEnv("SWITCHBOARD_DEPLOY_EXPECTED_QUOTE_AMOUNT")
  );
}

async function requestDeployWorkflowQuoteViaCliHelper(
  input: SwitchboardDeployWorkflowInput,
  snapshot: SwitchboardDeployWorkflowSnapshot,
  deploymentIntent: DeploymentIntentBootstrap,
  runtime: Record<string, unknown>,
  helperEnv?: Record<string, string | undefined>
): Promise<QuoteResponse> {
  const helper = await resolveHubFundingHelper();
  const result = await runCliChild(helper.command, [
    ...helper.args,
    "--dry-run",
    "--relay-url",
    input.relayUrl,
    "--deployment-intent-id",
    deploymentIntent.intentId,
    ...(deploymentIntent.groupId ? ["--deployment-intent-group-id", deploymentIntent.groupId, "--group-member-intent-id", deploymentIntent.intentId] : []),
    "--intent-token",
    deploymentIntent.cliToken,
    "--paid-seconds",
    String(input.durationSeconds),
    "--session-label",
    input.sessionLabel ?? `switchboard-${snapshot.workflowId}`
  ], {
    cwd: helper.cwd,
    env: deployWorkflowFundingHelperEnv(input, snapshot, deploymentIntent, runtime, helperEnv),
    stream: false
  });
  const dryRun = parseHelperJsonOutput(result.stdout, "Hub quote helper dry-run");
  const quote = dryRun.quote && typeof dryRun.quote === "object" ? dryRun.quote as Record<string, unknown> : undefined;
  const signature = stringRecordField(dryRun, "signature");
  if (!quote || !signature) {
    throw new Error("Hub quote helper dry-run did not return quote and signature");
  }
  return jsonSafeOutput({
    ok: true,
    quote,
    signature,
    endpointHostname: stringRecordField(dryRun, "endpointHostname"),
    validationHostname: stringRecordField(dryRun, "validationHostname"),
    policy: dryRun.policy,
    allocation: dryRun.allocation,
    intent: dryRun.intent,
    dns: dryRun.dns,
    funding: dryRun.funding,
    lineItems: dryRun.lineItems,
    pricingPolicy: dryRun.pricingPolicy
  }) as QuoteResponse;
}

async function fundDeployWorkflowQuoteViaCliHelper(
  input: SwitchboardDeployWorkflowInput,
  snapshot: SwitchboardDeployWorkflowSnapshot,
  deploymentIntent: DeploymentIntentBootstrap,
  quote: QuoteResponse,
  runtime?: Record<string, unknown>,
  helperEnv?: Record<string, string | undefined>
): Promise<Record<string, unknown>> {
  const quoteFileDir = await mkdtemp(path.join(tmpdir(), "switchboard-workflow-quote-"));
  const quoteFile = path.join(quoteFileDir, "quote-response.json");
  await writeFile(quoteFile, `${JSON.stringify(jsonSafeOutput(quote), null, 2)}\n`, "utf8");
  const helper = await resolveHubFundingHelper();
  const result = await runCliChild(helper.command, [
    ...helper.args,
    "--yes",
    "--quote-response-file",
    quoteFile,
    "--relay-url",
    input.relayUrl,
    "--deployment-intent-id",
    deploymentIntent.intentId,
    ...(deploymentIntent.groupId ? ["--deployment-intent-group-id", deploymentIntent.groupId, "--group-member-intent-id", deploymentIntent.intentId] : []),
    "--intent-token",
    deploymentIntent.cliToken,
    "--paid-seconds",
    String(input.durationSeconds),
    "--session-label",
    input.sessionLabel ?? `switchboard-${snapshot.workflowId}`
  ], {
    cwd: helper.cwd,
    env: deployWorkflowFundingHelperEnv(input, snapshot, deploymentIntent, runtime ?? {
      runtimeSigner: stringRecordField(snapshot.data.runtime, "runtimeSigner")
    }, helperEnv),
    stream: false
  });
  const funded = parseHelperJsonOutput(result.stdout, "Hub quote funding helper");
  const txs = Array.isArray(funded.txs) ? funded.txs.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
  const fundingTx = txs.find((tx) => stringRecordField(tx, "action") === "fundWithAssetQuote") ?? txs[txs.length - 1];
  return jsonSafeOutput({
    adapter: "hub:fund-native-asset-quote",
    ok: funded.ok === true,
    txHash: stringRecordField(fundingTx, "txHash"),
    fundingTxHash: stringRecordField(fundingTx, "txHash"),
    txs,
    sessionId: stringRecordField(funded.session, "sessionId") ?? stringRecordField(funded.quote, "sessionId"),
    endpointHostname: stringRecordField(funded, "endpointHostname"),
    validationHostname: stringRecordField(funded, "validationHostname"),
    session: funded.session && typeof funded.session === "object" ? funded.session : undefined,
    quote: funded.quote && typeof funded.quote === "object" ? funded.quote : undefined
  }) as Record<string, unknown>;
}

function deployWorkflowFundingHelperEnv(
  input: SwitchboardDeployWorkflowInput,
  snapshot: SwitchboardDeployWorkflowSnapshot,
  deploymentIntent: DeploymentIntentBootstrap,
  runtime: Record<string, unknown>,
  helperEnv: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  const capacity = snapshot.data.capacity && typeof snapshot.data.capacity === "object"
    ? snapshot.data.capacity as Record<string, unknown>
    : {};
  const runtimeSigner = stringRecordField(runtime, "runtimeSigner") ?? stringRecordField(snapshot.data.runtime, "runtimeSigner");
  return {
    ...helperEnv,
    SWITCHBOARD_TARGET: input.target.name,
    INGRESS_REGISTRY_ADDRESS: input.target.registryAddress,
    HUB_ETH_RPC_URL: input.target.ethRpcUrl,
    HUB_SUBSTRATE_WS_URL: input.target.substrateWsUrl,
    CHAIN_ID: input.target.chainId,
    RELAY_URL: input.relayUrl,
    PROOF_CONTROL_PLANE_URL: input.relayUrl,
    SWITCHBOARD_DEPLOY_RELAY_URL: input.relayUrl,
    SWITCHBOARD_INTENT_ID: deploymentIntent.intentId,
    SWITCHBOARD_INTENT_GROUP_ID: deploymentIntent.groupId,
    SWITCHBOARD_INTENT_CLI_TOKEN: deploymentIntent.cliToken,
    JOB_ID: input.jobId,
    JOB_SIGNER_ADDRESS: runtimeSigner,
    OPERATOR_ID: stringRecordField(capacity, "operatorId"),
    PROCESSOR_ID: stringRecordField(capacity, "processorId"),
    GATEWAY_ID: stringRecordField(capacity, "gatewayId"),
    PAYMENT_ASSET_ADDRESS: input.asset,
    PROOF_QUOTE_DEFAULT_ASSET: input.asset,
    PAID_SECONDS: String(input.durationSeconds),
    SWITCHBOARD_QUOTE_CAP_AMOUNT: input.quoteCapAmount
  };
}

async function resolveHubFundingHelper(): Promise<{ command: string; args: string[]; cwd?: string }> {
  const cliRoot = cliPackageRoot();
  if (await repoScriptAvailable("hub:fund-native-asset-quote", { cwd: cliRoot })) {
    return { command: "pnpm", args: ["--silent", "hub:fund-native-asset-quote", "--"], cwd: cliRoot };
  }
  const currentFile = fileURLToPath(import.meta.url);
  const distDir = path.dirname(currentFile);
  const internalDir = path.join(distDir, "internal");
  const helper = path.join(internalDir, "hub-fund-native-asset-quote.js");
  await access(helper).catch(() => {
    throw new Error("deploy requires the packaged Hub funding helper. Rebuild or reinstall the Switchboard CLI package.");
  });
  return { command: process.execPath, args: [helper] };
}

function parseHelperJsonOutput(stdout: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("output was not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${label} produced non-JSON output: ${JSON.stringify(stdout)} (${safeErrorMessage(error)})`);
  }
}

function deployWorkflowStore(flags: Map<string, string | boolean>): { save(snapshot: SwitchboardDeployWorkflowSnapshot): Promise<void> } | undefined {
  const runDir = stringFlag(flags, "run-dir");
  const reportPath = deploymentReportPath(flags);
  const snapshotDir = runDir ?? (reportPath ? path.dirname(path.resolve(reportPath)) : undefined);
  if (!snapshotDir) return undefined;
  return deployWorkflowStoreForDir(snapshotDir);
}

function deployWorkflowStoreForDir(snapshotDir: string): { save(snapshot: SwitchboardDeployWorkflowSnapshot): Promise<void> } {
  return {
    async save(snapshot: SwitchboardDeployWorkflowSnapshot): Promise<void> {
      await writeDeployWorkflowSnapshots(snapshotDir, snapshot);
    }
  };
}

async function writeDeployWorkflowSnapshots(dir: string, snapshot: SwitchboardDeployWorkflowSnapshot): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, DEPLOY_WORKFLOW_SNAPSHOT_FILE), `${JSON.stringify(jsonSafeOutput(redactDeployWorkflowSnapshot(snapshot)), null, 2)}\n`, "utf8");
  const privatePath = path.join(dir, DEPLOY_WORKFLOW_PRIVATE_SNAPSHOT_FILE);
  await writeFile(privatePath, `${JSON.stringify(jsonSafeOutput(snapshot), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(privatePath, 0o600);
}

async function saveDeployWorkflowSnapshot(
  snapshot: SwitchboardDeployWorkflowSnapshot,
  store: ReturnType<typeof deployWorkflowStore> | undefined,
  reportPath: string
): Promise<void> {
  if (store) {
    await store.save(snapshot);
    return;
  }
  await writeDeployWorkflowSnapshots(path.dirname(path.resolve(reportPath)), snapshot);
}

interface DeployWorkflowStateSource {
  kind: "run-dir" | "report" | "snapshot" | "latest-report";
  runDir?: string;
  reportPath?: string;
  snapshotPath: string;
  privateSnapshotPath?: string;
}

interface LoadedDeployWorkflowState {
  snapshot: SwitchboardDeployWorkflowSnapshot;
  report?: Record<string, any>;
  source: DeployWorkflowStateSource;
  loadedSnapshotPath: string;
  loadedPrivate: boolean;
  tokenHydrated: boolean;
  warnings: string[];
}

interface DeployWorkflowStatusOutput {
  action: "deploy-status" | "deploy-resume";
  ok: boolean;
  phase: string;
  workflowId: string;
  nextAction: string;
  warnings: string[];
  schedule?: Record<string, unknown>;
  readbacks: Record<string, unknown>;
  reportPath?: string;
}

export interface DeployDoctorAdapters {
  fetchImpl?: typeof fetch;
  dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  probeSshOverTls?: (input: DeployDoctorProbeInput) => Promise<DeployDoctorProbeResult>;
  now?: () => Date;
}

export interface HostnameStatusReadinessInput {
  customerHostname: string;
  sessionId: string;
  routeIntentUrl?: string;
  operatorSshHost?: string;
  timeoutMs: number;
}

export interface HostnameStatusAdapters {
  fetchImpl?: typeof fetch;
  dnsProviderHint?: (customerHostname: string) => Promise<Record<string, any>> | Record<string, any>;
  readinessChecks?: (input: HostnameStatusReadinessInput) => Promise<Record<string, any>> | Record<string, any>;
}

export interface HostnameMutationAdapters {
  fetchImpl?: typeof fetch;
  dnsProviderHint?: (customerHostname: string) => Promise<Record<string, any>> | Record<string, any>;
}

export interface DeployDoctorProbeInput {
  hostname: string;
  port: number;
  timeoutMs: number;
}

export interface DeployDoctorProbeResult {
  checked: boolean;
  tls: {
    ok: boolean;
    authorized?: boolean;
    authorizationError?: string;
    peerCertificate?: Record<string, unknown>;
    error?: string;
    code?: string;
  };
  ssh: {
    ok: boolean;
    banner?: string;
    error?: string;
  };
}

interface DeployDoctorSource {
  kind: "intent-id" | LoadedDeployWorkflowState["source"]["kind"];
  source: DeployWorkflowStateSource | { kind: "intent-id" };
  snapshot?: SwitchboardDeployWorkflowSnapshot;
  report?: Record<string, any>;
  loadedSnapshotPath?: string;
  loadedPrivate?: boolean;
  tokenHydrated?: boolean;
  warnings: string[];
}

interface DeployDoctorHttpResult {
  checked: boolean;
  ok: boolean;
  status?: number;
  value?: Record<string, unknown>;
  error?: string;
  unauthorized?: boolean;
}

interface DeployDoctorOutput {
  ok: boolean;
  action: "deploy-doctor";
  classification: {
    status: string;
    stage: string;
    summary: string;
    nextAction: string;
  };
  source: Record<string, unknown>;
  identifiers: Record<string, unknown>;
  local: Record<string, unknown>;
  relay: Record<string, unknown>;
  capability: Record<string, unknown>;
  routeState: Record<string, unknown>;
  dns: Record<string, unknown>;
  publicProbe: DeployDoctorProbeResult | { checked: false; reason: string };
  bridgeDiagnostic: Record<string, unknown>;
  commands: Record<string, string>;
  warnings: string[];
}

async function deployWorkflowStatusCommand(flags: Map<string, string | boolean>, runtime: CliRuntime): Promise<void> {
  const loaded = await loadDeployWorkflowState(flags, runtime);
  const status = await buildDeployWorkflowStatusOutput(loaded, flags, "deploy-status");
  writeOutput(flags, status, () => printDeployWorkflowStatus(status));
}

export async function runSwitchboardProjectShow(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "project" ? [...argv] : ["project", "show", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "project-show") {
    throw new Error(`runSwitchboardProjectShow expected project show args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await projectShowCommand(flags, runtime);
}

export async function runSwitchboardProjectInit(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "init" || (argv[0] === "project" && argv[1] === "init")
    ? [...argv]
    : ["init", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "project-init") {
    throw new Error(`runSwitchboardProjectInit expected init args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await projectInitCommand(flags);
}

export async function runSwitchboardPreflight(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "preflight" ? [...argv] : ["preflight", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "preflight") {
    throw new Error(`runSwitchboardPreflight expected preflight args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await preflightCommand(flags, runtime);
}

export async function runSwitchboardDeploymentStatus(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "status" ? [...argv] : ["status", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "deployment-status") {
    throw new Error(`runSwitchboardDeploymentStatus expected status args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await deploymentStatusCommand(flags);
}

export async function runSwitchboardSessionStatus(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "session" && argv[1] === "status" ? [...argv] : ["session", "status", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "session-status") {
    throw new Error(`runSwitchboardSessionStatus expected session status args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await statusCommand(flags);
}

export async function runSwitchboardSessionRegister(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "session" && argv[1] === "register" ? [...argv] : ["session", "register", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "session-register") {
    throw new Error(`runSwitchboardSessionRegister expected session register args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await relayRegistrationCommand(flags);
}

export async function runSwitchboardValidatorScript(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "validator" && argv[1] === "script" ? [...argv] : ["validator", "script", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "validator-script") {
    throw new Error(`runSwitchboardValidatorScript expected validator script args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await validatorScriptCommand(flags);
}

export async function runSwitchboardCatalogInspect(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "catalog" && argv[1] === "inspect" ? [...argv] : ["catalog", "inspect", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "catalog-inspect") {
    throw new Error(`runSwitchboardCatalogInspect expected catalog inspect args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runCatalogInspect({ flags, positionals: parsed.positionals });
}

export async function runSwitchboardCatalogBuild(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "catalog" && argv[1] === "build" ? [...argv] : ["catalog", "build", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "catalog-build") {
    throw new Error(`runSwitchboardCatalogBuild expected catalog build args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runCatalogBuild({ flags, positionals: parsed.positionals });
}

export async function runSwitchboardCatalogSetState(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "catalog" && argv[1] === "set-state" ? [...argv] : ["catalog", "set-state", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "catalog-set-state") {
    throw new Error(`runSwitchboardCatalogSetState expected catalog set-state args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runCatalogSetState({ flags, positionals: parsed.positionals });
}

export async function runSwitchboardCatalogVerify(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "catalog" && argv[1] === "verify" ? [...argv] : ["catalog", "verify", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "catalog-verify") {
    throw new Error(`runSwitchboardCatalogVerify expected catalog verify args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runCatalogVerify({ flags, positionals: parsed.positionals });
}

type RelayCatalogBuildRunnerOptions = Pick<RunRelayCatalogBuildOptions, "cwd" | "env" | "io">;

export async function runSwitchboardRelayCatalogBuild(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime,
  catalogOptions: RelayCatalogBuildRunnerOptions = {}
): Promise<void> {
  const normalized =
    argv[0] === "relay" && argv[1] === "catalog"
      ? [...argv]
      : ["relay", "catalog", "build", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-catalog-build") {
    throw new Error(`runSwitchboardRelayCatalogBuild expected relay catalog build args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayCatalogBuild({ flags, positionals: parsed.positionals, ...catalogOptions });
}

type RelayCatalogSetStateRunnerOptions = Pick<RunRelayCatalogSetStateOptions, "cwd" | "env" | "io" | "build">;

export async function runSwitchboardRelayCatalogSetState(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime,
  catalogOptions: RelayCatalogSetStateRunnerOptions = {}
): Promise<void> {
  const normalized =
    argv[0] === "relay" && argv[1] === "catalog"
      ? [...argv]
      : ["relay", "catalog", "set-state", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-catalog-set-state") {
    throw new Error(`runSwitchboardRelayCatalogSetState expected relay catalog set-state args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayCatalogSetState({ flags, positionals: parsed.positionals, ...catalogOptions });
}

type RelaySyncRunnerOptions = Pick<RunRelaySyncOptions, "cwd" | "env" | "io" | "fetchImpl">;

export async function runSwitchboardRelaySync(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime,
  syncOptions: RelaySyncRunnerOptions = {}
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "sync" ? [...argv] : ["relay", "sync", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-sync") {
    throw new Error(`runSwitchboardRelaySync expected relay sync args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelaySync({
    flags: withDiscoveryDefaults(flags, syncOptions.env),
    positionals: parsed.positionals,
    ...syncOptions
  });
}

export async function runSwitchboardRelayStatus(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "status" ? [...argv] : ["relay", "status", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-status") {
    throw new Error(`runSwitchboardRelayStatus expected relay status args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayStatus({ flags, positionals: parsed.positionals });
}

export async function runSwitchboardRelayList(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized =
    argv[0] === "relay" && (argv[1] === "list" || argv[1] === "ls")
      ? [...argv]
      : ["relay", "list", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-list") {
    throw new Error(`runSwitchboardRelayList expected relay list args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayList({ flags: withDiscoveryDefaults(flags), positionals: parsed.positionals });
}

export async function runSwitchboardRelayDiff(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "diff" ? [...argv] : ["relay", "diff", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-diff") {
    throw new Error(`runSwitchboardRelayDiff expected relay diff args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayDiff({ flags: withDiscoveryDefaults(flags), positionals: parsed.positionals });
}

type RelayKeygenRunnerOptions = Pick<RunRelayKeygenOptions, "io" | "createWallet">;

export async function runSwitchboardRelayKeygen(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime,
  keygenOptions: RelayKeygenRunnerOptions = {}
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "keygen" ? [...argv] : ["relay", "keygen", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-keygen") {
    throw new Error(`runSwitchboardRelayKeygen expected relay keygen args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayKeygen({ flags, positionals: parsed.positionals, ...keygenOptions });
}

type RelayScaffoldRunnerOptions = Pick<RunRelayScaffoldOptions, "cwd" | "env" | "io" | "createWallet">;

export async function runSwitchboardRelayScaffold(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime,
  scaffoldOptions: RelayScaffoldRunnerOptions = {}
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "scaffold"
    ? [...argv]
    : ["relay", "scaffold", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-scaffold") {
    throw new Error(`runSwitchboardRelayScaffold expected relay scaffold args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayScaffold({ flags, positionals: parsed.positionals, ...scaffoldOptions });
}

type RelayPickProcessorRunnerOptions = Pick<RunRelayPickProcessorOptions, "cwd" | "io" | "discover">;

export async function runSwitchboardRelayPickProcessor(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime,
  pickOptions: RelayPickProcessorRunnerOptions = {}
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "pick-processor"
    ? [...argv]
    : ["relay", "pick-processor", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-pick-processor") {
    throw new Error(`runSwitchboardRelayPickProcessor expected relay pick-processor args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayPickProcessor({ flags, positionals: parsed.positionals, ...pickOptions });
}

export async function runSwitchboardRelayDeployments(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "deployments"
    ? [...argv]
    : ["relay", "deployments", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-deployments") {
    throw new Error(`runSwitchboardRelayDeployments expected relay deployments args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayDeployments({ flags, positionals: parsed.positionals });
}

export async function runSwitchboardRelayLogs(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "logs" ? [...argv] : ["relay", "logs", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-logs") {
    throw new Error(`runSwitchboardRelayLogs expected relay logs args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayLogs({ flags, positionals: parsed.positionals });
}

type RelayWatchRunnerOptions = Pick<RunRelayWatchOptions, "cwd" | "io" | "fetchImpl" | "sleep" | "now">;

export async function runSwitchboardRelayWatch(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime,
  watchOptions: RelayWatchRunnerOptions = {}
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "watch" ? [...argv] : ["relay", "watch", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-watch") {
    throw new Error(`runSwitchboardRelayWatch expected relay watch args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayWatch({ flags, positionals: parsed.positionals, ...watchOptions });
}

export async function runSwitchboardRelayVerify(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "verify" ? [...argv] : ["relay", "verify", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-verify") {
    throw new Error(`runSwitchboardRelayVerify expected relay verify args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  const result = await runRelayVerify({ flags: withDiscoveryDefaults(flags), positionals: parsed.positionals });
  if (!result.ok) {
    throw new Error(`relay verify ${result.relayId}: ${result.checks.filter((check) => !check.ok).length} check(s) failed`);
  }
}

type RelayDnsRunnerOptions = Pick<RelayDnsSubcommandArgs, "cwd" | "env" | "io" | "validateCnameTarget">;

export async function runSwitchboardRelayDnsPlan(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime,
  dnsOptions: RelayDnsRunnerOptions = {}
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "dns" ? [...argv] : ["relay", "dns", "plan", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-dns" || parsed.positionals[2] !== "plan") {
    throw new Error(`runSwitchboardRelayDnsPlan expected relay dns plan args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayDnsSubcommand({ flags, positionals: parsed.positionals, ...dnsOptions });
}

export async function runSwitchboardRelayDnsVerify(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime,
  dnsOptions: RelayDnsRunnerOptions = {}
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "dns" ? [...argv] : ["relay", "dns", "verify", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-dns" || parsed.positionals[2] !== "verify") {
    throw new Error(`runSwitchboardRelayDnsVerify expected relay dns verify args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayDnsSubcommand({ flags, positionals: parsed.positionals, ...dnsOptions });
}

export async function runSwitchboardRelayBudget(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "budget" ? [...argv] : ["relay", "budget", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-budget") {
    throw new Error(`runSwitchboardRelayBudget expected relay budget args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayBudget({ flags, positionals: parsed.positionals });
}

type RelayLifecycleRunnerOptions = Pick<RelayLifecycleArgs, "cwd" | "env" | "io" | "spawnPnpm">;

export async function runSwitchboardRelayInspect(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime,
  lifecycleOptions: RelayLifecycleRunnerOptions = {}
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "inspect"
    ? [...argv]
    : ["relay", "inspect", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-inspect") {
    throw new Error(`runSwitchboardRelayInspect expected relay inspect args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayInspect({ flags, positionals: parsed.positionals, ...lifecycleOptions });
}

export async function runSwitchboardRelayDeploymentStatus(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime,
  lifecycleOptions: RelayLifecycleRunnerOptions = {}
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "deployment-status"
    ? [...argv]
    : ["relay", "deployment-status", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-deployment-status") {
    throw new Error(`runSwitchboardRelayDeploymentStatus expected relay deployment-status args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayDeploymentStatus({ flags, positionals: parsed.positionals, ...lifecycleOptions });
}

export async function runSwitchboardRelayWhoami(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "relay" && argv[1] === "whoami" ? [...argv] : ["relay", "whoami", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "relay-whoami") {
    throw new Error(`runSwitchboardRelayWhoami expected relay whoami args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runRelayWhoami({ flags, positionals: parsed.positionals });
}

export async function runSwitchboardGatewaySetup(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "gateway" && argv[1] === "setup" ? [...argv] : ["gateway", "setup", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "gateway-setup") {
    throw new Error(`runSwitchboardGatewaySetup expected gateway setup args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runOperatorSetup(flags);
}

export async function runSwitchboardGatewayDiscover(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "gateway" && argv[1] === "discover" ? [...argv] : ["gateway", "discover", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "gateway-discover") {
    throw new Error(`runSwitchboardGatewayDiscover expected gateway discover args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runOperatorDiscover(flags);
}

export async function runSwitchboardGatewayStatus(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "gateway" && argv[1] === "status" ? [...argv] : ["gateway", "status", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "gateway-status") {
    throw new Error(`runSwitchboardGatewayStatus expected gateway status args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runOperatorStatus(flags);
}

export async function runSwitchboardGatewayUpgrade(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "gateway" && argv[1] === "upgrade" ? [...argv] : ["gateway", "upgrade", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "gateway-upgrade") {
    throw new Error(`runSwitchboardGatewayUpgrade expected gateway upgrade args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await runOperatorUpgrade(flags);
}

export async function runSwitchboardContextList(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "context" && (argv[1] === "list" || argv[1] === "ls")
    ? [...argv]
    : ["context", "list", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "context-list") {
    throw new Error(`runSwitchboardContextList expected context list args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await contextListCommand(flags, runtime);
}

export async function runSwitchboardContextCurrent(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "context" && argv[1] === "current" ? [...argv] : ["context", "current", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "context-current") {
    throw new Error(`runSwitchboardContextCurrent expected context current args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await contextCurrentCommand(flags, runtime);
}

export async function runSwitchboardContextUse(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "context" && argv[1] === "use" ? [...argv] : ["context", "use", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "context-use") {
    throw new Error(`runSwitchboardContextUse expected context use args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await contextUseCommand(flags, parsed.positionals, runtime);
}

export async function runSwitchboardContextSet(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "context" && argv[1] === "set" ? [...argv] : ["context", "set", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "context-set") {
    throw new Error(`runSwitchboardContextSet expected context set args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await contextSetCommand(flags, parsed.positionals, runtime);
}

export async function runSwitchboardContextAdd(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "context" && argv[1] === "add" ? [...argv] : ["context", "add", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "context-add") {
    throw new Error(`runSwitchboardContextAdd expected context add args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await contextAddCommand(flags, parsed.positionals, runtime);
}

export async function runSwitchboardContextDnsSet(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "context" && argv[1] === "dns" && argv[2] === "set"
    ? [...argv]
    : ["context", "dns", "set", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "context-dns-set") {
    throw new Error(`runSwitchboardContextDnsSet expected context dns set args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await contextDnsSetCommand(flags, parsed.positionals, runtime);
}

export async function runSwitchboardContextDnsClear(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "context" &&
    argv[1] === "dns" &&
    (argv[2] === "clear" || argv[2] === "remove" || argv[2] === "rm")
    ? [...argv]
    : ["context", "dns", "clear", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "context-dns-clear") {
    throw new Error(`runSwitchboardContextDnsClear expected context dns clear args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await contextDnsClearCommand(flags, parsed.positionals, runtime);
}

export async function runSwitchboardClaimable(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "claimable" ? [...argv] : ["claimable", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "claimable") {
    throw new Error(`runSwitchboardClaimable expected claimable args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await claimCommand(flags, { readOnly: true });
}

export async function runSwitchboardClaim(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "claim" ? [...argv] : ["claim", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "claim") {
    throw new Error(`runSwitchboardClaim expected claim args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await claimCommand(flags);
}

export async function runSwitchboardRefundable(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "refundable" || (argv[0] === "session" && argv[1] === "refundable")
    ? [...argv]
    : ["refundable", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "session-refundable") {
    throw new Error(`runSwitchboardRefundable expected refundable args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await refundCommand(flags, { readOnly: true });
}

export async function runSwitchboardRefund(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "refund" || (argv[0] === "session" && argv[1] === "refund")
    ? [...argv]
    : ["refund", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "session-refund") {
    throw new Error(`runSwitchboardRefund expected refund args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await refundCommand(flags);
}

export async function runSwitchboardHostnameStatus(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime,
  adapters: HostnameStatusAdapters = {}
): Promise<void> {
  const normalized = argv[0] === "hostname" && argv[1] === "status" ? [...argv] : ["hostname", "status", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "hostname-status") {
    throw new Error(`runSwitchboardHostnameStatus expected hostname status args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await hostnameStatusCommand(flags, parsed.positionals, adapters);
}

export async function runSwitchboardHostnameAdd(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime,
  adapters: HostnameMutationAdapters = {}
): Promise<void> {
  const normalized = argv[0] === "hostname" && argv[1] === "add" ? [...argv] : ["hostname", "add", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "hostname-attach") {
    throw new Error(`runSwitchboardHostnameAdd expected hostname add args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await hostnameAttachCommand(flags, parsed.positionals, adapters);
}

export async function runSwitchboardHostnameRemove(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime,
  adapters: HostnameMutationAdapters = {}
): Promise<void> {
  const normalized = argv[0] === "hostname" && argv[1] === "remove" ? [...argv] : ["hostname", "remove", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "hostname-remove") {
    throw new Error(`runSwitchboardHostnameRemove expected hostname remove args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await hostnameRemoveCommand(flags, parsed.positionals, adapters);
}

export async function runSwitchboardDeployStatus(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "deploy" && argv[1] === "status" ? [...argv] : ["deploy", "status", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "deploy-status") {
    throw new Error(`runSwitchboardDeployStatus expected deploy status args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await deployWorkflowStatusCommand(flags, runtime);
}

export async function runSwitchboardLaunchDemo(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "launch-demo" ? [...argv] : ["launch-demo", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "launch-demo") {
    throw new Error(`runSwitchboardLaunchDemo expected launch-demo args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await launchDemoCommand(flags, runtime);
}

export async function runSwitchboardDeploy(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "deploy" ? [...argv] : ["deploy", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "deploy") {
    throw new Error(`runSwitchboardDeploy expected deploy args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await deployCommand(flags, runtime);
}

export async function runSwitchboardDeployResume(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime
): Promise<void> {
  const normalized = argv[0] === "deploy" && argv[1] === "resume" ? [...argv] : ["deploy", "resume", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "deploy-resume") {
    throw new Error(`runSwitchboardDeployResume expected deploy resume args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await deployWorkflowResumeCommand(flags, runtime);
}

async function deployDoctorCommand(
  flags: Map<string, string | boolean>,
  runtime: CliRuntime,
  adapters: DeployDoctorAdapters = {}
): Promise<void> {
  const output = await buildSwitchboardDeployDoctorReport(flags, runtime, adapters);
  writeOutput(flags, output, () => printDeployDoctor(output));
}

export async function runSwitchboardDeployDoctor(
  argv: readonly string[] = process.argv.slice(2),
  runtimeOverride?: CliRuntime,
  adapters: DeployDoctorAdapters = {}
): Promise<void> {
  const normalized = argv[0] === "deploy" && argv[1] === "doctor" ? [...argv] : ["deploy", "doctor", ...argv];
  const parsed = parseArgs(normalized);
  if (parsed.command !== "deploy-doctor") {
    throw new Error(`runSwitchboardDeployDoctor expected deploy doctor args, got ${normalized.join(" ")}`);
  }
  const runtime = runtimeOverride ?? await loadCliRuntime(parsed.flags, parsed.command);
  assertNoLegacyPublicRuntimeConfig(parsed.command, runtime);
  assertNoRemovedPublicCommandFlags(parsed.command, parsed.flags);
  const flags = applyRuntimeDefaults(parsed.flags, runtime, parsed.command);
  await deployDoctorCommand(flags, runtime, adapters);
}

export async function buildSwitchboardDeployDoctorReport(
  flags: Map<string, string | boolean>,
  runtime: CliRuntime,
  adapters: DeployDoctorAdapters = {}
): Promise<DeployDoctorOutput> {
  const now = adapters.now?.() ?? new Date();
  const source = await loadDeployDoctorSource(flags, runtime);
  const report = source.report;
  const snapshot = source.snapshot;
  const warnings = [...source.warnings];
  if (source.tokenHydrated) {
    warnings.push("Hydrated the unredacted deployment intent token from report.json localSecret.");
  }

  const intentId = deployDoctorIntentId(flags, source);
  const intentToken = deployDoctorIntentToken(flags, source);
  const relayUrl = await deployDoctorRelayUrl(flags, runtime, source);
  const requestTimeoutMs = numberFlag(flags, "request-timeout-ms", "SWITCHBOARD_DEPLOY_DOCTOR_REQUEST_TIMEOUT_MS", 15_000);
  const observability = intentId && relayUrl && intentToken
    ? await deployDoctorFetchJson({
        fetchImpl: adapters.fetchImpl,
        url: new URL(`/v1/deployment-intents/${encodeURIComponent(intentId)}/observability`, relayUrl),
        token: intentToken,
        timeoutMs: requestTimeoutMs
      })
    : {
        checked: false,
        ok: false,
        error: !intentId
          ? "missing intent id"
          : !relayUrl
            ? "missing relay URL"
            : "missing deployment intent token"
      };
  if (observability.error && observability.checked) {
    warnings.push(`Deployment intent observability unavailable: ${observability.error}`);
  }

  const observabilityValue = recordValue(observability.value);
  const availability = recordValue(observabilityValue.availability);
  const gateway = recordValue(observabilityValue.gateway);
  const observabilityCapability = recordValue(gateway.capability);
  const observabilityRouteState = recordValue(observabilityValue.routeState);
  const localRoute = deployDoctorLocalRoute(source);
  const runtimeSummary = deployDoctorRuntimeSummary(source, observabilityValue);
  const schedule = snapshot ? deployWorkflowScheduleSummary(snapshot, report) : deployDoctorReportScheduleSummary(report);
  warnings.push(...deployWorkflowScheduleWarnings(schedule));

  const identifiers = deployDoctorIdentifiers({
    flags,
    source,
    observability: observabilityValue,
    runtime: runtimeSummary
  });
  const bridgeDiagnostic = deployDoctorBridgeDiagnostic(source, identifiers, runtimeSummary);
  const commands = deployDoctorCommands(identifiers.hostname, booleanRecordField(bridgeDiagnostic, "available"));

  const capability = await deployDoctorCapabilitySummary({
    flags,
    relayUrl,
    identifiers,
    observabilityCapability,
    requestTimeoutMs,
    adapters,
    now
  });
  if (capability.warning) warnings.push(capability.warning);

  const routeState = await deployDoctorRouteStateSummary({
    flags,
    relayUrl,
    identifiers,
    observabilityRouteState,
    requestTimeoutMs,
    adapters
  });
  if (routeState.warning) warnings.push(routeState.warning);

  const dns = identifiers.hostname
    ? await deployDoctorDnsSummary(identifiers.hostname, adapters)
    : { checked: false, reason: "missing hostname" };
  if (stringRecordField(dns, "error")) {
    warnings.push(`DNS lookup failed: ${stringRecordField(dns, "error")}`);
  }

  const publicProbe = boolFlag(flags, "probe")
    ? identifiers.hostname
      ? await (adapters.probeSshOverTls ?? probeSshOverTls)({
          hostname: identifiers.hostname,
          port: numberFlag(flags, "tls-port", "SWITCHBOARD_DEPLOY_DOCTOR_TLS_PORT", 443),
          timeoutMs: numberFlag(flags, "probe-timeout-ms", "SWITCHBOARD_DEPLOY_DOCTOR_PROBE_TIMEOUT_MS", 8_000)
        })
      : { checked: false as const, reason: "missing hostname" }
    : { checked: false as const, reason: "pass --probe to run public TLS/SNI and SSH banner checks" };

  const funding = deployDoctorFundingSummary(source, availability);
  const route = deployDoctorRouteSummary(localRoute, availability, observabilityRouteState, routeState);
  const classification = classifyDeployDoctor({
    phase: snapshot ? normalizedDeployWorkflowPhase(snapshot) : undefined,
    funding,
    route,
    schedule,
    capability,
    routeState,
    runtime: runtimeSummary,
    publicProbe
  });

  return {
    ok: classification.status === "healthy",
    action: "deploy-doctor",
    classification,
    source: jsonSafeOutput({
      kind: source.kind,
      reportPath: source.source.kind !== "intent-id" ? source.source.reportPath : undefined,
      snapshotPath: source.source.kind !== "intent-id" ? source.source.snapshotPath : undefined,
      loadedSnapshotPath: source.loadedSnapshotPath,
      loadedPrivate: source.loadedPrivate
    }),
    identifiers: jsonSafeOutput({
      intentId,
      relayUrl,
      hostname: identifiers.hostname,
      operatorId: identifiers.operatorId,
      gatewayId: identifiers.gatewayId,
      processorId: identifiers.processorId,
      processor: identifiers.processor,
      deploymentId: identifiers.deploymentId,
      sessionId: identifiers.sessionId
    }),
    local: jsonSafeOutput({
      workflowId: snapshot?.workflowId,
      phase: snapshot ? normalizedDeployWorkflowPhase(snapshot) : undefined,
      schedule,
      funding,
      route: localRoute,
      runtime: runtimeSummary
    }),
    relay: jsonSafeOutput({
      observability,
      availability
    }),
    capability: jsonSafeOutput(capability.output),
    routeState: jsonSafeOutput(routeState.output),
    dns: jsonSafeOutput(dns),
    publicProbe: jsonSafeOutput(publicProbe),
    bridgeDiagnostic: jsonSafeOutput(bridgeDiagnostic),
    commands,
    warnings
  };
}

async function deployWorkflowResumeCommand(flags: Map<string, string | boolean>, runtime: CliRuntime): Promise<void> {
  if (!boolFlag(flags, "yes") && optionalEnv("SWITCHBOARD_ASSUME_YES") !== "true" && optionalEnv("SWITCHBOARD_DEPLOY_ASSUME_YES") !== "true") {
    throw new Error("Refusing to resume deployment without --yes.");
  }
  const loaded = await loadDeployWorkflowState(flags, runtime);
  if (loaded.snapshot.input.deploymentMode === "group") {
    throw new Error("switchboard deploy resume supports single-replica workflows only; HA/group resume is not supported yet.");
  }
  assertDeployWorkflowHasPrivateIntentToken(loaded);

  const snapshot = snapshotForResume(loaded.snapshot);
  const runDir = deployWorkflowRunDir(loaded);
  const workflowStore = deployWorkflowStoreForDir(runDir);
  const workflow = new SwitchboardDeployWorkflow(snapshot.input, deployWorkflowAdapters(snapshot.input, workflowStore, {
    helperEnv: contextRuntimeEnv(runtime)
  }), snapshot);
  const resumeEnv = deployWorkflowResumeEnv(snapshot, loaded, runtime, runDir);

  let finalSnapshot: SwitchboardDeployWorkflowSnapshot;
  if (snapshot.step === "deploy_action_required") {
    const result = await runDeployWorkflowCompatibilityRunner({
      workflow,
      workflowStore,
      childArgs: [INTERNAL_DEPLOY_RUNNER_SCRIPT, "--", "--yes", "--run-dir", runDir],
      childEnv: resumeEnv,
      runtime,
      action: "deploy",
      json: boolFlag(flags, "json"),
      workDir: runtime.projectRoot
    });
    finalSnapshot = result.workflowSnapshot;
    loaded.report = result.report;
    loaded.source.reportPath = result.reportPath;
  } else {
    finalSnapshot = await runDeployWorkflowResumeToTerminalOrBlocked({
      workflow,
      allowLateFunding: boolFlag(flags, "allow-late-funding"),
      report: loaded.report,
      env: resumeEnv
    });
    await saveDeployWorkflowSnapshot(finalSnapshot, workflowStore, deployWorkflowReportPath(loaded, runDir));
    await writeDeployWorkflowReportFromSnapshot(finalSnapshot, loaded, deployWorkflowReportPath(loaded, runDir));
  }

  loaded.snapshot = finalSnapshot;
  const status = await buildDeployWorkflowStatusOutput(loaded, flags, "deploy-resume");
  writeOutput(flags, status, () => printDeployWorkflowStatus(status));
}

function resolveDeployWorkflowStateSource(flags: Map<string, string | boolean>, runtime: CliRuntime): DeployWorkflowStateSource {
  const runDir = stringFlag(flags, "run-dir");
  const report = stringFlag(flags, "report");
  const snapshot = stringFlag(flags, "snapshot");
  const choices = [runDir, report, snapshot].filter((value): value is string => Boolean(value));
  if (choices.length > 1) {
    throw new Error("Use only one of --run-dir, --report, or --snapshot for deploy workflow recovery.");
  }
  if (runDir) {
    const resolved = path.resolve(runDir);
    return {
      kind: "run-dir",
      runDir: resolved,
      reportPath: path.join(resolved, "report.json"),
      snapshotPath: path.join(resolved, DEPLOY_WORKFLOW_SNAPSHOT_FILE),
      privateSnapshotPath: path.join(resolved, DEPLOY_WORKFLOW_PRIVATE_SNAPSHOT_FILE)
    };
  }
  if (report) {
    const reportPath = path.resolve(report);
    const dir = path.dirname(reportPath);
    return {
      kind: "report",
      runDir: dir,
      reportPath,
      snapshotPath: path.join(dir, DEPLOY_WORKFLOW_SNAPSHOT_FILE),
      privateSnapshotPath: path.join(dir, DEPLOY_WORKFLOW_PRIVATE_SNAPSHOT_FILE)
    };
  }
  if (snapshot) {
    const snapshotPath = path.resolve(snapshot);
    const dir = path.dirname(snapshotPath);
    return {
      kind: "snapshot",
      runDir: dir,
      reportPath: path.join(dir, "report.json"),
      snapshotPath,
      privateSnapshotPath: path.basename(snapshotPath) === DEPLOY_WORKFLOW_SNAPSHOT_FILE
        ? path.join(dir, DEPLOY_WORKFLOW_PRIVATE_SNAPSHOT_FILE)
        : undefined
    };
  }
  const latestReport = stringRecordField(runtime.projectState, "latestReport");
  if (latestReport) {
    const reportPath = path.resolve(runtime.projectRoot ?? process.cwd(), latestReport);
    const dir = path.dirname(reportPath);
    return {
      kind: "latest-report",
      runDir: dir,
      reportPath,
      snapshotPath: path.join(dir, DEPLOY_WORKFLOW_SNAPSHOT_FILE),
      privateSnapshotPath: path.join(dir, DEPLOY_WORKFLOW_PRIVATE_SNAPSHOT_FILE)
    };
  }
  throw new Error("Missing deploy workflow source. Pass --run-dir, --report, or --snapshot.");
}

async function loadDeployWorkflowState(flags: Map<string, string | boolean>, runtime: CliRuntime): Promise<LoadedDeployWorkflowState> {
  const source = resolveDeployWorkflowStateSource(flags, runtime);
  const warnings: string[] = [];
  const report = source.reportPath && await fileExists(source.reportPath)
    ? await readDeployWorkflowJsonFile(source.reportPath)
    : undefined;
  const privateAvailable = source.privateSnapshotPath ? await fileExists(source.privateSnapshotPath) : false;
  const preferredSnapshotPath = privateAvailable ? source.privateSnapshotPath as string : source.snapshotPath;
  let loadedSnapshotPath = preferredSnapshotPath;
  let loadedPrivate = privateAvailable && preferredSnapshotPath === source.privateSnapshotPath;
  let snapshot: SwitchboardDeployWorkflowSnapshot | undefined;
  if (await fileExists(preferredSnapshotPath)) {
    snapshot = await readDeployWorkflowJsonFile(preferredSnapshotPath) as SwitchboardDeployWorkflowSnapshot;
  } else if (report?.workflow && typeof report.workflow === "object" && !Array.isArray(report.workflow)) {
    snapshot = report.workflow as SwitchboardDeployWorkflowSnapshot;
    loadedSnapshotPath = source.reportPath ?? preferredSnapshotPath;
    loadedPrivate = false;
  }
  if (!snapshot) {
    throw new Error(`No deploy workflow snapshot found at ${preferredSnapshotPath}`);
  }
  if (snapshot.version !== 1 || !snapshot.workflowId || !snapshot.input || !snapshot.data) {
    throw new Error(`Invalid deploy workflow snapshot at ${loadedSnapshotPath}`);
  }
  if (!loadedPrivate && source.privateSnapshotPath) {
    warnings.push(`Private workflow snapshot not found at ${source.privateSnapshotPath}; resume needs an unredacted local intent token.`);
  }
  const tokenHydrated = hydrateDeployWorkflowSnapshotFromReport(snapshot, report);
  return { snapshot, report, source, loadedSnapshotPath, loadedPrivate, tokenHydrated, warnings };
}

async function readDeployWorkflowJsonFile(filePath: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, any>;
}

function hydrateDeployWorkflowSnapshotFromReport(
  snapshot: SwitchboardDeployWorkflowSnapshot,
  report: Record<string, any> | undefined
): boolean {
  if (deployWorkflowIntentToken(snapshot)) {
    return false;
  }
  const token =
    stringRecordField(report?.deploymentIntent?.localSecret, "cliToken") ??
    stringRecordField(report?.deploymentIntent, "cliToken");
  if (!token || token === "[redacted]") {
    return false;
  }
  hydrateDeploymentIntentToken(recordValue(snapshot.data.deploymentIntent), snapshot, token);
  hydrateDeploymentIntentToken(recordValue(snapshot.requiredAction?.payload?.deploymentIntent), snapshot, token);
  return true;
}

function hydrateDeploymentIntentToken(intent: Record<string, any>, snapshot: SwitchboardDeployWorkflowSnapshot, token: string): void {
  if (Object.keys(intent).length === 0) return;
  intent.cliToken = token;
  const intentId = stringRecordField(intent, "intentId") ?? deployWorkflowIntentId(snapshot);
  intent.env = {
    ...recordValue(intent.env),
    SWITCHBOARD_RELAY_URL: stringRecordField(intent.env, "SWITCHBOARD_RELAY_URL") ?? snapshot.input.relayUrl,
    SWITCHBOARD_INTENT_ID: stringRecordField(intent.env, "SWITCHBOARD_INTENT_ID") ?? intentId,
    SWITCHBOARD_INTENT_TOKEN: token
  };
  const raw = recordValue(intent.raw);
  if (Object.keys(raw).length > 0) {
    raw.cliToken = token;
    raw.job = {
      ...recordValue(raw.job),
      token,
      env: {
        ...recordValue(recordValue(raw.job).env),
        SWITCHBOARD_RELAY_URL: stringRecordField(recordValue(raw.job).env, "SWITCHBOARD_RELAY_URL") ?? snapshot.input.relayUrl,
        SWITCHBOARD_INTENT_ID: stringRecordField(recordValue(raw.job).env, "SWITCHBOARD_INTENT_ID") ?? intentId,
        SWITCHBOARD_INTENT_TOKEN: token
      }
    };
    intent.raw = raw;
  }
}

function assertDeployWorkflowHasPrivateIntentToken(loaded: LoadedDeployWorkflowState): void {
  const intentId = deployWorkflowIntentId(loaded.snapshot);
  if (!intentId || deployWorkflowIntentToken(loaded.snapshot)) {
    return;
  }
  throw new Error(
    `Missing unredacted deployment intent token for ${intentId}. Expected ${loaded.source.privateSnapshotPath ?? DEPLOY_WORKFLOW_PRIVATE_SNAPSHOT_FILE} or report.json with deploymentIntent.localSecret.cliToken.`
  );
}

function deployWorkflowIntentRecord(snapshot: SwitchboardDeployWorkflowSnapshot): Record<string, any> {
  const dataIntent = recordValue(snapshot.data.deploymentIntent);
  if (stringRecordField(dataIntent, "intentId") || stringRecordField(dataIntent, "cliToken")) {
    return dataIntent;
  }
  return recordValue(snapshot.requiredAction?.payload?.deploymentIntent);
}

function deployWorkflowIntentId(snapshot: SwitchboardDeployWorkflowSnapshot): string | undefined {
  return stringRecordField(deployWorkflowIntentRecord(snapshot), "intentId");
}

function deployWorkflowIntentToken(snapshot: SwitchboardDeployWorkflowSnapshot): string | undefined {
  const token = stringRecordField(deployWorkflowIntentRecord(snapshot), "cliToken");
  return token && token !== "[redacted]" ? token : undefined;
}

function snapshotForResume(snapshot: SwitchboardDeployWorkflowSnapshot): SwitchboardDeployWorkflowSnapshot {
  const clone = structuredClone(snapshot);
  if (clone.step === "failed" && clone.requiredAction?.kind === "acurast.deploy") {
    clone.step = "deploy_action_required";
  }
  return clone;
}

function deployWorkflowRunDir(loaded: LoadedDeployWorkflowState): string {
  return loaded.source.runDir ?? path.dirname(path.resolve(loaded.source.reportPath ?? loaded.loadedSnapshotPath));
}

function deployWorkflowReportPath(loaded: LoadedDeployWorkflowState, runDir = deployWorkflowRunDir(loaded)): string {
  return loaded.source.reportPath ?? stringRecordField(loaded.snapshot.data, "reportPath") ?? path.join(runDir, "report.json");
}

function deployWorkflowResumeEnv(
  snapshot: SwitchboardDeployWorkflowSnapshot,
  loaded: LoadedDeployWorkflowState,
  runtime: CliRuntime,
  runDir: string
): Record<string, string | undefined> {
  const input = snapshot.input;
  const capacity = recordValue(snapshot.data.capacity) as SwitchboardCapacitySelection;
  const scriptRuntime = input.runtime?.kind === "script";
  return {
    ...publicDeployRunnerSafetyEnv(),
    SWITCHBOARD_DEPLOY_RUN_DIR: runDir,
    SWITCHBOARD_DEPLOY_RELAY_URL: input.relayUrl,
    RELAY_URL: input.relayUrl,
    PROOF_CONTROL_PLANE_URL: input.relayUrl,
    SWITCHBOARD_TARGET: input.target.name,
    INGRESS_REGISTRY_ADDRESS: input.target.registryAddress,
    HUB_ETH_RPC_URL: input.target.ethRpcUrl,
    HUB_SUBSTRATE_WS_URL: input.target.substrateWsUrl,
    CHAIN_ID: input.target.chainId,
    PAYMENT_ASSET_ADDRESS: input.asset,
    PROOF_QUOTE_DEFAULT_ASSET: input.asset,
    OPERATOR_ID: capacity.operatorId,
    PROCESSOR_ID: capacity.processorId,
    GATEWAY_ID: capacity.gatewayId,
    SWITCHBOARD_OPERATOR_ID: capacity.operatorId,
    SWITCHBOARD_DEPLOY_PROCESSOR: capacity.processor,
    SWITCHBOARD_DEPLOY_GATEWAY_ID: capacity.gatewayId,
    ACURAST_INSTANT_MATCH_PROCESSORS: capacity.processor,
    ACURAST_MANAGER_ID: capacity.managerId,
    SWITCHBOARD_WORK_DIR: runtime.projectRoot,
    ACURAST_ENTRYPOINT: stringRecordField(input.runtime, "entrypoint") ?? input.entrypoint,
    ACURAST_RUNTIME: scriptRuntime ? "script" : "node",
    ACURAST_SCRIPT_IMAGE_URL: scriptRuntime ? stringRecordField(recordValue(input.runtime?.image), "url") : undefined,
    ACURAST_SCRIPT_IMAGE_SHA256: scriptRuntime ? stringRecordField(recordValue(input.runtime?.image), "sha256") : undefined,
    ACURAST_SCRIPT_FILES: scriptRuntime
      ? (Array.isArray(input.runtime?.scriptFiles) ? input.runtime.scriptFiles.filter((item): item is string => typeof item === "string").join(",") : undefined)
      : undefined,
    ACURAST_REQUIRED_MODULES: scriptRuntime ? RequiredModules.Shell : undefined,
    [SSH_AUTH_KEYS_ENV]: scriptRuntime ? stringRecordField(input.runtime, "authorizedKeys") : undefined,
    SWITCHBOARD_QUOTE_CAP_AMOUNT: input.quoteCapAmount,
    SWITCHBOARD_DEPLOY_DURATION_MINUTES: String(Math.ceil(input.durationSeconds / 60)),
    SWITCHBOARD_DEPLOY_CERTIFICATE_MODE: input.certificateMode,
    SWITCHBOARD_DEPLOY_ROUTE_ACTIVATION_MODE: "relay-reconciled",
    SWITCHBOARD_DEPLOY_VALIDATOR_MODE: input.validatorMode,
    SWITCHBOARD_DEPLOY_REPORT_PATH: deployWorkflowReportPath(loaded, runDir)
  };
}

async function runDeployWorkflowResumeToTerminalOrBlocked(input: {
  workflow: SwitchboardDeployWorkflow;
  allowLateFunding: boolean;
  report?: Record<string, any>;
  env: Record<string, string | undefined>;
}): Promise<SwitchboardDeployWorkflowSnapshot> {
  const { pollMs, timeoutMs } = deployWorkflowPollingConfig(input.env);
  const startedAt = Date.now();
  let snapshot = input.workflow.snapshot;
  while (!["complete", "failed", "deploy_action_required", "funding_action_required"].includes(snapshot.step)) {
    if ((snapshot.step === "quote_ready" || snapshot.step === "funding_action_required") && !input.allowLateFunding) {
      const late = lateFundingWarning(snapshot, input.report);
      if (late) {
        throw new Error(`${late} Re-run with --allow-late-funding only if you intentionally want to fund expired evidence.`);
      }
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for deploy workflow to advance from ${snapshot.step} after ${timeoutMs}ms`);
    }
    const before = snapshot.step;
    snapshot = await input.workflow.advanceOnce();
    if (snapshot.step === before) {
      await sleep(pollMs);
    }
  }
  return snapshot;
}

async function writeDeployWorkflowReportFromSnapshot(
  snapshot: SwitchboardDeployWorkflowSnapshot,
  loaded: LoadedDeployWorkflowState,
  reportPath: string
): Promise<void> {
  const report = {
    ...(loaded.report ?? {}),
    ok: snapshot.step === "complete",
    workflowId: snapshot.workflowId,
    workflow: redactDeployWorkflowSnapshot(snapshot),
    workflowEvents: redactDeployWorkflowSnapshot(snapshot).events,
    requiredAction: snapshot.requiredAction ? redactDeployWorkflowSnapshot(snapshot).requiredAction : undefined
  };
  mergeDeployWorkflowCompletionIntoReport(report, redactDeployWorkflowSnapshot(snapshot));
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(jsonSafeOutput(report), null, 2)}\n`, "utf8");
  loaded.report = report;
  loaded.source.reportPath = reportPath;
}

async function buildDeployWorkflowStatusOutput(
  loaded: LoadedDeployWorkflowState,
  flags: Map<string, string | boolean>,
  action: "deploy-status" | "deploy-resume"
): Promise<DeployWorkflowStatusOutput> {
  const warnings = [...loaded.warnings];
  if (loaded.tokenHydrated) {
    warnings.push("Hydrated the unredacted deployment intent token from report.json localSecret.");
  }
  const schedule = deployWorkflowScheduleSummary(loaded.snapshot, loaded.report);
  warnings.push(...deployWorkflowScheduleWarnings(schedule));
  const intentReadback = await readDeployWorkflowIntentStatus(loaded).catch((error) => {
    warnings.push(`Could not read deployment intent status: ${safeErrorMessage(error)}`);
    return undefined;
  });
  const phase = normalizedDeployWorkflowPhase(loaded.snapshot);
  return {
    action,
    ok: phase !== "failed",
    phase,
    workflowId: loaded.snapshot.workflowId,
    nextAction: deployWorkflowNextAction(loaded.snapshot, loaded, flags, schedule),
    warnings,
    schedule,
    readbacks: deployWorkflowReadbacks(loaded.snapshot, loaded.report, intentReadback),
    reportPath: deployWorkflowReportPath(loaded)
  };
}

async function readDeployWorkflowIntentStatus(loaded: LoadedDeployWorkflowState): Promise<Record<string, unknown> | undefined> {
  const intentId = deployWorkflowIntentId(loaded.snapshot);
  if (!intentId) return undefined;
  const token = deployWorkflowIntentToken(loaded.snapshot);
  if (!token) return undefined;
  const client = new SwitchboardControlPlaneClient({
    relayUrl: loaded.snapshot.input.relayUrl,
    allowInsecureHttp: loaded.snapshot.input.allowInsecureHttp === true
  });
  return client.readDeploymentIntent(intentId, { cliToken: token });
}

function normalizedDeployWorkflowPhase(snapshot: SwitchboardDeployWorkflowSnapshot): string {
  switch (snapshot.step) {
    case "initialized":
      return "initialized";
    case "capacity_selected":
      return "capacity selected";
    case "intent_created":
      return "intent created";
    case "deploy_action_required":
      return "intent created";
    case "deploy_submitted":
      return "deploy submitted";
    case "runtime_claimed":
      return "runtime claimed";
    case "quote_ready":
      return "quote ready";
    case "funding_action_required":
      return "funding needed";
    case "funding_submitted":
      return "funding submitted";
    case "dns_propagated":
      return "dns propagated";
    case "route_active":
      return "route active";
    case "registration_observed":
      return "registration observed";
    case "validation_observed":
      return "validation observed";
    case "complete":
      return "complete";
    case "failed":
      return "failed";
  }
}

function deployWorkflowNextAction(
  snapshot: SwitchboardDeployWorkflowSnapshot,
  loaded: LoadedDeployWorkflowState,
  flags: Map<string, string | boolean>,
  schedule?: Record<string, unknown>
): string {
  const source = deployWorkflowSourceArg(loaded);
  const resume = `${SWITCHBOARD_CLI} deploy resume --yes ${source}`.trim();
  if (snapshot.step === "complete") return "No action required.";
  if (snapshot.step === "failed" && !snapshot.requiredAction) return `Inspect ${deployWorkflowReportPath(loaded)} and rerun deploy when the failure is resolved.`;
  if ((snapshot.step === "quote_ready" || snapshot.step === "funding_action_required") && lateFundingWarningFromSummary(schedule)) {
    return `${resume} --allow-late-funding`;
  }
  if (snapshot.step === "deploy_action_required" || snapshot.requiredAction?.kind === "acurast.deploy") {
    return resume;
  }
  if (snapshot.step === "funding_action_required") {
    return resume;
  }
  if (!deployWorkflowIntentToken(snapshot) && deployWorkflowIntentId(snapshot)) {
    return `Restore ${loaded.source.privateSnapshotPath ?? DEPLOY_WORKFLOW_PRIVATE_SNAPSHOT_FILE} or pass --report with deploymentIntent.localSecret.cliToken.`;
  }
  return resume;
}

function deployWorkflowSourceArg(loaded: LoadedDeployWorkflowState): string {
  if (loaded.source.kind === "snapshot") return `--snapshot ${shellSingleQuote(loaded.loadedSnapshotPath)}`;
  if (loaded.source.reportPath) return `--report ${shellSingleQuote(loaded.source.reportPath)}`;
  return `--run-dir ${shellSingleQuote(deployWorkflowRunDir(loaded))}`;
}

function deployWorkflowReadbacks(
  snapshot: SwitchboardDeployWorkflowSnapshot,
  report: Record<string, any> | undefined,
  intentStatus: Record<string, unknown> | undefined
): Record<string, unknown> {
  const intent = recordValue(intentStatus?.intent);
  return jsonSafeOutput({
    intent: intentStatus,
    deployment: snapshot.data.deployment ?? report?.deployment,
    runtime: Object.keys(recordValue(snapshot.data.runtime)).length > 0
      ? snapshot.data.runtime
      : {
          runtimeSigner: stringRecordField(intent, "runtimeSigner"),
          upstreamIps: Array.isArray(intent.upstreamIps) ? intent.upstreamIps : undefined
        },
    quote: snapshot.data.quote ?? report?.quote,
    funding: recordValue(intent.funding).status ? intent.funding : snapshot.data.fundingStatus ?? snapshot.data.funding ?? report?.funding,
    route: intentStatus?.route ?? intent.route ?? snapshot.data.routeStatus ?? snapshot.data.route ?? report?.route,
    registration: snapshot.data.intentStatus,
    validation: snapshot.data.validation ?? report?.validation
  });
}

function deployWorkflowScheduleSummary(
  snapshot: SwitchboardDeployWorkflowSnapshot,
  report: Record<string, any> | undefined
): Record<string, unknown> | undefined {
  const snapshotSchedule = recordValue(recordValue(snapshot.data.deployment).schedule);
  const reportSchedule = recordValue(recordValue(report?.lifecycle).schedule);
  const schedule = Object.keys(snapshotSchedule).length > 0 ? snapshotSchedule : reportSchedule;
  if (Object.keys(schedule).length === 0) return undefined;
  const startMs = normalizeScheduleTimestampMs(schedule.startTime);
  const endMs = normalizeScheduleTimestampMs(schedule.endTime);
  const maxStartDelayMs = normalizeDurationMs(schedule.maxStartDelay);
  const latestStartMs = startMs !== undefined && maxStartDelayMs !== undefined ? startMs + maxStartDelayMs : undefined;
  return {
    ...schedule,
    startIso: startMs ? new Date(startMs).toISOString() : undefined,
    endIso: endMs ? new Date(endMs).toISOString() : undefined,
    latestStartIso: latestStartMs ? new Date(latestStartMs).toISOString() : undefined,
    startWindowExpired: latestStartMs !== undefined ? Date.now() > latestStartMs : undefined,
    endExpired: endMs !== undefined ? Date.now() > endMs : undefined
  };
}

function deployWorkflowScheduleWarnings(schedule: Record<string, unknown> | undefined): string[] {
  const warnings: string[] = [];
  if (!schedule) return warnings;
  if (schedule.startWindowExpired === true) {
    warnings.push(`Acurast start window expired at ${stringRecordField(schedule, "latestStartIso") ?? "unknown time"}.`);
  }
  if (schedule.endExpired === true) {
    warnings.push(`Acurast end time passed at ${stringRecordField(schedule, "endIso") ?? "unknown time"}.`);
  }
  return warnings;
}

function lateFundingWarning(snapshot: SwitchboardDeployWorkflowSnapshot, report: Record<string, any> | undefined): string | undefined {
  return lateFundingWarningFromSummary(deployWorkflowScheduleSummary(snapshot, report));
}

function lateFundingWarningFromSummary(schedule: Record<string, unknown> | undefined): string | undefined {
  if (!schedule) return undefined;
  if (schedule.endExpired === true) {
    return `Refusing late funding because the Acurast end time passed at ${stringRecordField(schedule, "endIso") ?? "unknown time"}.`;
  }
  if (schedule.startWindowExpired === true) {
    return `Refusing late funding because the Acurast start window expired at ${stringRecordField(schedule, "latestStartIso") ?? "unknown time"}.`;
  }
  return undefined;
}

function normalizeScheduleTimestampMs(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : undefined;
  if (!numeric || !Number.isFinite(numeric)) return undefined;
  return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
}

function normalizeDurationMs(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : undefined;
  if (numeric === undefined || !Number.isFinite(numeric)) return undefined;
  return numeric;
}

function printDeployWorkflowStatus(status: DeployWorkflowStatusOutput): void {
  console.log(sectionTitle(status.action === "deploy-resume" ? "Deploy resume" : "Deploy status"));
  printOutputRows([
    { label: "Workflow", value: status.workflowId },
    { label: "Phase", value: status.phase },
    { label: "Report", value: status.reportPath },
    { label: "Next", value: status.nextAction }
  ]);
  for (const warning of status.warnings) {
    console.log(statusLine("warn", "Warning", warning));
  }
}

async function loadDeployDoctorSource(flags: Map<string, string | boolean>, runtime: CliRuntime): Promise<DeployDoctorSource> {
  const intentId = stringFlag(flags, "intent-id");
  const localSources = ["run-dir", "report", "snapshot"].filter((name) => stringFlag(flags, name));
  if (intentId && localSources.length > 0) {
    throw new Error("Use only one of --intent-id, --run-dir, --report, or --snapshot for deploy doctor.");
  }
  if (intentId) {
    return {
      kind: "intent-id",
      source: { kind: "intent-id" },
      warnings: []
    };
  }
  const loaded = await loadDeployWorkflowState(flags, runtime);
  return {
    kind: loaded.source.kind,
    source: loaded.source,
    snapshot: loaded.snapshot,
    report: loaded.report,
    loadedSnapshotPath: loaded.loadedSnapshotPath,
    loadedPrivate: loaded.loadedPrivate,
    tokenHydrated: loaded.tokenHydrated,
    warnings: loaded.warnings
  };
}

function deployDoctorIntentId(flags: Map<string, string | boolean>, source: DeployDoctorSource): string | undefined {
  return (
    stringFlag(flags, "intent-id") ??
    (source.snapshot ? deployWorkflowIntentId(source.snapshot) : undefined) ??
    stringRecordField(source.report?.deploymentIntent, "intentId") ??
    stringNestedField(source.report?.deploymentIntent, "intent", "intentId")
  );
}

function deployDoctorIntentToken(flags: Map<string, string | boolean>, source: DeployDoctorSource): string | undefined {
  return (
    stringFlag(flags, "intent-token") ??
    secretFromEnvFlag(flags, "intent-token-env") ??
    optionalEnv("SWITCHBOARD_INTENT_TOKEN") ??
    (source.snapshot ? deployWorkflowIntentToken(source.snapshot) : undefined) ??
    stringNestedField(source.report?.deploymentIntent, "localSecret", "cliToken") ??
    stringRecordField(source.report?.deploymentIntent, "cliToken")
  );
}

async function deployDoctorRelayUrl(
  flags: Map<string, string | boolean>,
  runtime: CliRuntime,
  source: DeployDoctorSource
): Promise<string | undefined> {
  const local =
    stringFlag(flags, "relay-url") ??
    source.snapshot?.input.relayUrl ??
    stringRecordField(source.report?.relay, "url") ??
    stringRecordField(source.report?.deploymentIntent, "relayUrl") ??
    stringNestedField(source.report?.deploymentIntent, "env", "SWITCHBOARD_RELAY_URL") ??
    optionalEnv("RELAY_URL") ??
    optionalEnv("PROOF_CONTROL_PLANE_URL");
  if (local) {
    return normalizeCliBaseUrl(local);
  }
  if (stringFlag(flags, "intent-id")) {
    const manifestConfig = await resolveCliNetworkConfig(flags);
    return manifestConfig.relayUrl ? normalizeCliBaseUrl(manifestConfig.relayUrl) : undefined;
  }
  void runtime;
  return undefined;
}

async function deployDoctorFetchJson(input: {
  fetchImpl?: typeof fetch;
  url: URL;
  token?: string;
  timeoutMs: number;
}): Promise<DeployDoctorHttpResult> {
  try {
    const response = await (input.fetchImpl ?? fetch)(input.url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {})
      },
      signal: AbortSignal.timeout(input.timeoutMs)
    });
    const body = await response.text();
    const parsed = body ? parseJsonObject(body) : {};
    if (!response.ok || parsed?.ok === false) {
      return {
        checked: true,
        ok: false,
        status: response.status,
        value: parsed,
        unauthorized: response.status === 401 || response.status === 403,
        error: `${response.status} ${body.slice(0, 500)}`
      };
    }
    return {
      checked: true,
      ok: true,
      status: response.status,
      value: parsed
    };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      error: safeErrorMessage(error)
    };
  }
}

function deployDoctorLocalRoute(source: DeployDoctorSource): Record<string, unknown> {
  const snapshot = source.snapshot;
  const report = source.report;
  return firstNonEmptyRecord([
    recordValue(recordValue(snapshot?.data.routeStatus).route),
    recordValue(recordValue(recordValue(snapshot?.data.routeStatus).intent).route),
    recordValue(snapshot?.data.route),
    recordValue(report?.route),
    recordValue(report?.routeActivation),
    recordValue(recordValue(report?.deploymentIntent).route),
    recordValue(recordValue(recordValue(report?.deploymentIntent).intent).route)
  ]);
}

function deployDoctorRuntimeSummary(
  source: DeployDoctorSource,
  observability: Record<string, unknown>
): Record<string, unknown> {
  const runtime = firstNonEmptyRecord([
    recordValue(source.snapshot?.data.runtime),
    recordValue(source.report?.runtime),
    recordValue(recordValue(observability.availability).health)
  ]);
  const upstreams = uniqueStrings([
    ...stringArrayRecordField(runtime, "upstreamIps"),
    ...stringArrayRecordField(runtime, "upstreamHosts"),
    ...stringArrayRecordField(recordValue(source.report?.operator), "upstreamIps"),
    hostFromHostPort(stringRecordField(source.report?.operator, "upstream"))
  ].filter((item): item is string => Boolean(item)));
  return {
    ...runtime,
    upstreamIps: upstreams.length > 0 ? upstreams : undefined,
    upstreamClassifications: upstreams.map((upstream) => ({
      upstream,
      classification: classifyUpstreamAddress(upstream)
    }))
  };
}

function deployDoctorIdentifiers(input: {
  flags: Map<string, string | boolean>;
  source: DeployDoctorSource;
  observability: Record<string, unknown>;
  runtime: Record<string, unknown>;
}): {
  hostname?: string;
  operatorId?: string;
  gatewayId?: string;
  processorId?: string;
  processor?: string;
  deploymentId?: string;
  sessionId?: string;
} {
  const report = input.source.report;
  const snapshot = input.source.snapshot;
  const reportHostnames = deploymentReportHostnames(report);
  const gateway = recordValue(input.observability.gateway);
  const availability = recordValue(input.observability.availability);
  const routeState = recordValue(input.observability.routeState);
  const dnsCanonical = recordValue(recordValue(input.observability.dns).canonical);
  const localRoute = deployDoctorLocalRoute(input.source);
  const capacity = recordValue(snapshot?.data.capacity);
  const deployment = recordValue(snapshot?.data.deployment);
  const reportSession = recordValue(report?.session);
  const funding = recordValue(availability.funding);

  return {
    hostname: normalizeHostnameForCli(
      stringFlag(input.flags, "hostname") ??
      reportHostnames.public ??
      stringRecordField(reportSession, "hostname") ??
      stringRecordField(availability, "endpointHostname") ??
      stringRecordField(routeState, "hostname") ??
      stringRecordField(dnsCanonical, "hostname") ??
      stringRecordField(localRoute, "hostname")
    ),
    operatorId:
      stringFlag(input.flags, "operator-id") ??
      stringRecordField(capacity, "operatorId") ??
      stringRecordField(reportSession, "operatorId") ??
      stringRecordField(gateway, "operatorId") ??
      stringRecordField(recordValue(localRoute.source), "operatorId"),
    gatewayId:
      stringFlag(input.flags, "gateway-id") ??
      stringRecordField(capacity, "gatewayId") ??
      stringRecordField(reportSession, "gatewayId") ??
      stringRecordField(gateway, "gatewayId") ??
      stringRecordField(routeState, "gatewayId") ??
      stringRecordField(recordValue(localRoute.sink), "gatewayId") ??
      stringRecordField(recordValue(localRoute.source), "gatewayId"),
    processorId:
      stringFlag(input.flags, "processor-id") ??
      stringRecordField(capacity, "processorId") ??
      stringRecordField(reportSession, "processorId") ??
      stringRecordField(gateway, "processorId"),
    processor:
      stringFlag(input.flags, "processor") ??
      stringRecordField(capacity, "processor") ??
      stringRecordField(reportSession, "processor"),
    deploymentId:
      stringFlag(input.flags, "deployment-id") ??
      stringRecordField(deployment, "deploymentId") ??
      stringRecordField(report?.deployment, "deploymentId"),
    sessionId:
      stringFlag(input.flags, "session-id") ??
      stringRecordField(reportSession, "sessionId") ??
      stringRecordField(availability, "sessionId") ??
      stringRecordField(funding, "sessionId")
  };
}

async function deployDoctorCapabilitySummary(input: {
  flags: Map<string, string | boolean>;
  relayUrl?: string;
  identifiers: { operatorId?: string; gatewayId?: string };
  observabilityCapability: Record<string, unknown>;
  requestTimeoutMs: number;
  adapters: DeployDoctorAdapters;
  now: Date;
}): Promise<{ output: Record<string, unknown>; warning?: string }> {
  const latestFromObservability = recordValue(input.observabilityCapability.latestReport);
  let latestReport = Object.keys(latestFromObservability).length > 0 ? latestFromObservability : undefined;
  let warning: string | undefined;
  const operatorId = input.identifiers.operatorId;
  const gatewayId = input.identifiers.gatewayId;
  const capabilityUrl = input.relayUrl && (operatorId || gatewayId)
    ? new URL("/v1/operator-capabilities", input.relayUrl)
    : undefined;
  if (capabilityUrl) {
    if (operatorId) capabilityUrl.searchParams.set("operatorId", operatorId);
    if (gatewayId) capabilityUrl.searchParams.set("gatewayId", gatewayId);
    capabilityUrl.searchParams.set("activeOnly", "true");
    capabilityUrl.searchParams.set("limit", "5");
  }
  const readToken =
    secretFromEnvFlag(input.flags, "capability-read-token-env") ??
    optionalEnv("PROOF_OPERATOR_CAPABILITY_READ_TOKEN") ??
    optionalEnv("SWITCHBOARD_OPERATOR_CAPABILITY_READ_TOKEN");
  const capabilityRead = capabilityUrl
    ? await deployDoctorFetchJson({
        fetchImpl: input.adapters.fetchImpl,
        url: capabilityUrl,
        token: readToken,
        timeoutMs: input.requestTimeoutMs
      })
    : { checked: false, ok: false, error: "missing relay/operator/gateway" };

  const latestReadReports = arrayRecordField(capabilityRead.value, "latest");
  if (!latestReport && latestReadReports[0]) {
    latestReport = deployDoctorCapabilityReportSummary(latestReadReports[0]);
  }
  const reportExpiresAt = stringRecordField(latestReport, "expiresAt");
  const stale = reportExpiresAt ? Date.parse(reportExpiresAt) <= input.now.getTime() : undefined;
  if (capabilityRead.unauthorized) {
    warning = "Operator capability read was unauthorized; check the capability read token or relay admission.";
  } else if (stale === true) {
    warning = `Latest operator capability report expired at ${reportExpiresAt}.`;
  } else if (input.observabilityCapability.available === false) {
    warning = `No fresh matching operator capability report: ${stringRecordField(input.observabilityCapability, "reason") ?? "unknown"}.`;
  }

  return {
    warning,
    output: {
      available: input.observabilityCapability.available,
      reason: stringRecordField(input.observabilityCapability, "reason"),
      operatorId,
      gatewayId,
      latestReport,
      stale,
      routeStateAvailable: input.observabilityCapability.routeStateAvailable,
      routeState: input.observabilityCapability.routeState,
      capacity: {
        activeRouteCount: input.observabilityCapability.activeRouteCount,
        routeCapacity: input.observabilityCapability.routeCapacity,
        reportedProcessorCount: input.observabilityCapability.reportedProcessorCount
      },
      read: capabilityRead
    }
  };
}

function deployDoctorCapabilityReportSummary(report: Record<string, unknown>): Record<string, unknown> {
  const body = recordValue(report.report);
  return {
    reportId: stringRecordField(body, "reportId") ?? stringRecordField(report, "reportId"),
    reportedAt: stringRecordField(body, "reportedAt") ?? stringRecordField(report, "reportedAt"),
    receivedAt: stringRecordField(report, "receivedAt"),
    expiresAt: stringRecordField(body, "expiresAt") ?? stringRecordField(report, "expiresAt"),
    signer: stringRecordField(report, "signer"),
    operatorId: stringNestedField(body, "operator", "operatorId"),
    gatewayId: stringNestedField(body, "operator", "gatewayId")
  };
}

async function deployDoctorRouteStateSummary(input: {
  flags: Map<string, string | boolean>;
  relayUrl?: string;
  identifiers: { operatorId?: string; gatewayId?: string; hostname?: string };
  observabilityRouteState: Record<string, unknown>;
  requestTimeoutMs: number;
  adapters: DeployDoctorAdapters;
}): Promise<{ output: Record<string, unknown>; warning?: string }> {
  const token =
    secretFromEnvFlag(input.flags, "route-state-token-env") ??
    optionalEnv("GATEWAY_ROUTE_STATE_TOKEN") ??
    optionalEnv("PROOF_GATEWAY_ROUTE_STATE_TOKEN");
  const operatorId = input.identifiers.operatorId;
  const gatewayId = input.identifiers.gatewayId;
  const routeStateUrl = input.relayUrl && operatorId && gatewayId
    ? new URL(`/v1/operators/${encodeURIComponent(operatorId)}/gateways/${encodeURIComponent(gatewayId)}/route-state`, input.relayUrl)
    : undefined;
  const read = routeStateUrl && token
    ? await deployDoctorFetchJson({
        fetchImpl: input.adapters.fetchImpl,
        url: routeStateUrl,
        token,
        timeoutMs: input.requestTimeoutMs
      })
    : { checked: false, ok: false, error: routeStateUrl ? "missing route-state token" : "missing relay/operator/gateway" };
  const routes = arrayRecordField(read.value, "routes");
  const activeRoutes = arrayRecordField(read.value, "activeRoutes");
  const hostname = input.identifiers.hostname?.toLowerCase();
  const routeMatchesHostname = Boolean(hostname && [...routes, ...activeRoutes].some((route) => routeHostnames(route).includes(hostname)));
  const active = activeRoutes.length > 0 && (!hostname || routeMatchesHostname);
  let warning: string | undefined;
  if (read.unauthorized) {
    warning = "Gateway route-state read was unauthorized; check the route-state token.";
  }
  return {
    warning,
    output: {
      desired: input.observabilityRouteState.desired,
      reason: stringRecordField(input.observabilityRouteState, "reason"),
      runtimeHttpsReady: input.observabilityRouteState.runtimeHttpsReady,
      operatorId,
      gatewayId,
      active,
      routeMatchesHostname,
      read
    }
  };
}

async function deployDoctorDnsSummary(hostname: string, adapters: DeployDoctorAdapters): Promise<Record<string, unknown>> {
  try {
    const lookup = adapters.dnsLookup ?? ((value: string) => dnsLookup(value, { all: true }));
    const addresses = await lookup(hostname);
    return {
      checked: true,
      ok: addresses.length > 0,
      hostname,
      addresses
    };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      hostname,
      error: safeErrorMessage(error)
    };
  }
}

function deployDoctorFundingSummary(source: DeployDoctorSource, availability: Record<string, unknown>): Record<string, unknown> {
  const relayFunding = recordValue(availability.funding);
  const snapshot = source.snapshot;
  const localFunding = firstNonEmptyRecord([
    recordValue(snapshot?.data.fundingStatus),
    recordValue(snapshot?.data.funding),
    recordValue(source.report?.funding)
  ]);
  const quote = firstNonEmptyRecord([
    recordValue(snapshot?.data.quote),
    recordValue(source.report?.quote)
  ]);
  const status = stringRecordField(relayFunding, "status") ?? stringRecordField(localFunding, "status");
  return {
    status: status ?? (Object.keys(quote).length > 0 ? "quote_ready" : undefined),
    funded: status === "funded" || Boolean(stringRecordField(localFunding, "txHash")),
    quoteReady: Object.keys(quote).length > 0,
    sessionId: stringRecordField(relayFunding, "sessionId") ?? stringRecordField(localFunding, "sessionId") ?? stringNestedField(quote, "quote", "sessionId"),
    relay: relayFunding,
    local: localFunding,
    quote
  };
}

function deployDoctorRouteSummary(
  localRoute: Record<string, unknown>,
  availability: Record<string, unknown>,
  observabilityRouteState: Record<string, unknown>,
  routeState: { output: Record<string, unknown> }
): Record<string, unknown> {
  const availabilityRoute = recordValue(availability.route);
  const localStatus = stringRecordField(localRoute, "status");
  const relayStatus = stringRecordField(availabilityRoute, "status");
  const active =
    localStatus === "active" ||
    relayStatus === "active" ||
    booleanRecordField(routeState.output, "active");
  return {
    active,
    status: relayStatus ?? localStatus,
    desired: observabilityRouteState.desired,
    desiredReason: stringRecordField(observabilityRouteState, "reason"),
    local: localRoute,
    relay: availabilityRoute
  };
}

function deployDoctorReportScheduleSummary(report: Record<string, any> | undefined): Record<string, unknown> | undefined {
  const schedule = deploymentSchedule(report);
  if (!schedule) return undefined;
  const startMs =
    normalizeScheduleTimestampMs(schedule.startTime) ??
    (unixSecondsField(schedule, "startUnixSeconds") !== undefined ? unixSecondsField(schedule, "startUnixSeconds")! * 1000 : undefined);
  const endMs =
    normalizeScheduleTimestampMs(schedule.endTime) ??
    (unixSecondsField(schedule, "endUnixSeconds") !== undefined ? unixSecondsField(schedule, "endUnixSeconds")! * 1000 : undefined);
  const maxStartDelayMs = normalizeDurationMs(schedule.maxStartDelay);
  const latestStartMs = startMs !== undefined && maxStartDelayMs !== undefined ? startMs + maxStartDelayMs : undefined;
  return {
    ...schedule,
    startIso: stringRecordField(schedule, "startIso") ?? (startMs ? new Date(startMs).toISOString() : undefined),
    endIso: stringRecordField(schedule, "endIso") ?? (endMs ? new Date(endMs).toISOString() : undefined),
    latestStartIso: latestStartMs ? new Date(latestStartMs).toISOString() : undefined,
    startWindowExpired: latestStartMs !== undefined ? Date.now() > latestStartMs : undefined,
    endExpired: endMs !== undefined ? Date.now() > endMs : undefined
  };
}

function deployDoctorBridgeDiagnostic(
  source: DeployDoctorSource,
  identifiers: {
    hostname?: string;
    deploymentId?: string;
    sessionId?: string;
    gatewayId?: string;
    processorId?: string;
    operatorId?: string;
  },
  runtime: Record<string, unknown>
): Record<string, unknown> {
  const report = source.report;
  const snapshotRuntime = recordValue(source.snapshot?.input.runtime);
  const reportRuntime = recordValue(report?.runtime);
  const reportDeployment = recordValue(report?.deployment);
  const applicationProtocol =
    stringRecordField(runtime, "applicationProtocol") ??
    stringRecordField(reportRuntime, "applicationProtocol") ??
    stringRecordField(reportDeployment, "applicationProtocol");
  const signerMode =
    stringRecordField(runtime, "signerMode") ??
    stringRecordField(reportRuntime, "signerMode") ??
    stringRecordField(reportDeployment, "signerMode");
  const runtimeKind =
    stringRecordField(snapshotRuntime, "kind") ??
    stringRecordField(reportRuntime, "kind") ??
    stringRecordField(reportDeployment, "runtime");
  const available =
    applicationProtocol === "ssh" ||
    signerMode === "cargo-bridge-secp256k1" ||
    runtimeKind === "script" ||
    Boolean(stringRecordField(snapshotRuntime, "authorizedKeys"));
  return {
    available,
    command: available ? SSH_TEMPLATE_BRIDGE_DIAGNOSTIC_COMMAND : undefined,
    signerMode: available ? "cargo-bridge-secp256k1" : signerMode,
    applicationProtocol,
    runtimeKind,
    known: {
      runtimeSigner: stringRecordField(runtime, "runtimeSigner") ?? stringRecordField(reportRuntime, "runtimeSigner"),
      deploymentId: identifiers.deploymentId,
      sessionId: identifiers.sessionId,
      gatewayId: identifiers.gatewayId,
      processorId: identifiers.processorId,
      operatorId: identifiers.operatorId,
      hostname: identifiers.hostname
    }
  };
}

function deployDoctorCommands(hostname: string | undefined, includeBridgeDiagnostic = false): Record<string, string> {
  const commands: Record<string, string> = includeBridgeDiagnostic
    ? { bridgeDoctor: SSH_TEMPLATE_BRIDGE_DIAGNOSTIC_COMMAND }
    : {};
  if (!hostname) return commands;
  return {
    ...commands,
    openssl: `openssl s_client -connect ${hostname}:443 -servername ${hostname} -quiet`,
    ssh: `ssh -o "ProxyCommand=openssl s_client -quiet -connect %h:443 -servername %h" root@${hostname}`,
    ...(includeBridgeDiagnostic
      ? { sshBridgeDoctor: `ssh -o "ProxyCommand=openssl s_client -quiet -connect %h:443 -servername %h" root@${hostname} ${SSH_TEMPLATE_BRIDGE_DIAGNOSTIC_COMMAND}` }
      : {})
  };
}

function classifyDeployDoctor(input: {
  phase?: string;
  funding: Record<string, unknown>;
  route: Record<string, unknown>;
  schedule?: Record<string, unknown>;
  capability: { output: Record<string, unknown> };
  routeState: { output: Record<string, unknown> };
  runtime: Record<string, unknown>;
  publicProbe: DeployDoctorProbeResult | { checked: false; reason: string };
}): DeployDoctorOutput["classification"] {
  const lateFunding = lateFundingWarningFromSummary(input.schedule);
  const funded = booleanRecordField(input.funding, "funded");
  const runtimeUpstreams = arrayRecordField(input.runtime, "upstreamClassifications");
  const publicUpstream = runtimeUpstreams.find((item) => stringRecordField(item, "classification") === "public-egress");
  if (lateFunding && !funded) {
    return {
      status: "late_funding_window",
      stage: "funding",
      summary: lateFunding,
      nextAction: "Do not fund this run unless you intentionally accept expired Acurast evidence."
    };
  }
  if (recordValue(input.capability.output.read).unauthorized === true) {
    return {
      status: "capability_token_unauthorized",
      stage: "operator capability",
      summary: "The relay rejected the operator capability read token.",
      nextAction: "Check the capability read token/admission before spending against this gateway."
    };
  }
  if (input.capability.output.stale === true || input.capability.output.available === false) {
    return {
      status: "stale_or_missing_capability",
      stage: "operator capability",
      summary: stringRecordField(input.capability.output, "reason") ?? "No fresh authorized capability report matched this deployment.",
      nextAction: "Repair gateway-agent capability reporting before spending or resuming the deploy."
    };
  }
  if (publicUpstream) {
    return {
      status: "upstream_public_egress",
      stage: "runtime upstream",
      summary: `Runtime upstream ${stringRecordField(publicUpstream, "upstream")} looks like public egress, not a gateway-reachable LAN address.`,
      nextAction: "Redeploy or repair runtime upstream discovery so route-state targets the processor-local listener."
    };
  }
  if (!funded && (input.phase === "quote ready" || input.phase === "funding needed" || input.funding.status === "quote_ready")) {
    return {
      status: "funding_required",
      stage: "funding",
      summary: "The runtime has a quote but the Hub session is not funded.",
      nextAction: "Run deploy resume only if the schedule window is still valid."
    };
  }
  if (!funded && !input.phase?.includes("runtime claimed")) {
    return {
      status: "runtime_not_claimed",
      stage: "runtime claim",
      summary: "The deployment has not reached a funded runtime/route diagnostic point yet.",
      nextAction: "Wait for the Acurast job to claim the intent, or inspect the Acurast deployment logs."
    };
  }
  if (funded && input.route.active !== true) {
    return {
      status: "route_missing",
      stage: "route-state",
      summary: stringRecordField(input.route, "desiredReason") ?? "The funded deployment does not have an active gateway route.",
      nextAction: "Check runtime HTTPS readiness, route-state polling, and gateway capability freshness."
    };
  }
  if (input.publicProbe.checked && input.publicProbe.tls.ok === false) {
    const error = input.publicProbe.tls.error ?? "TLS/SNI probe failed";
    return {
      status: /reset|ECONNRESET/i.test(error) ? "tls_route_reset" : "tls_probe_failed",
      stage: "public TLS/SNI",
      summary: error,
      nextAction: "Check gateway route-state target and whether stunnel is listening on the advertised upstream."
    };
  }
  if (input.publicProbe.checked && input.publicProbe.tls.ok && input.publicProbe.ssh.ok === false) {
    return {
      status: "ssh_banner_missing",
      stage: "SSH banner",
      summary: input.publicProbe.ssh.error ?? "TLS connected but no SSH banner was observed.",
      nextAction: "Check Dropbear startup and stunnel forwarding inside the Cargo runtime."
    };
  }
  if (input.route.active === true && (!input.publicProbe.checked || input.publicProbe.ssh.ok === true)) {
    return {
      status: "healthy",
      stage: input.publicProbe.checked ? "SSH banner" : "route-state",
      summary: input.publicProbe.checked ? "Route is active and the SSH banner probe succeeded." : "Route is active. Pass --probe to verify TLS/SNI and SSH banner reachability.",
      nextAction: "No action required."
    };
  }
  return {
    status: "needs_attention",
    stage: input.phase ?? "deployment",
    summary: "Deploy doctor could not classify the deployment as healthy.",
    nextAction: "Inspect the readbacks above and rerun with --probe when the public hostname is expected to be reachable."
  };
}

function printDeployDoctor(output: DeployDoctorOutput): void {
  console.log(sectionTitle("Deploy doctor"));
  printOutputRows([
    { label: "Status", value: output.ok ? "healthy" : "needs attention" },
    { label: "Stage", value: output.classification.stage },
    { label: "Summary", value: output.classification.summary },
    { label: "Next", value: output.classification.nextAction },
    { label: "Intent", value: stringRecordField(output.identifiers, "intentId") },
    { label: "Hostname", value: stringRecordField(output.identifiers, "hostname") },
    { label: "Gateway", value: stringRecordField(output.identifiers, "gatewayId") },
    { label: "Processor", value: compactId(stringRecordField(output.identifiers, "processor") ?? stringRecordField(output.identifiers, "processorId")) }
  ]);
  if (booleanRecordField(output.bridgeDiagnostic, "available")) {
    const known = recordValue(output.bridgeDiagnostic.known);
    console.log("");
    console.log(sectionTitle("Bridge diagnostic"));
    printOutputRows([
      { label: "Command", value: stringRecordField(output.bridgeDiagnostic, "command") },
      { label: "Signer mode", value: stringRecordField(output.bridgeDiagnostic, "signerMode") },
      { label: "Runtime signer", value: compactId(stringRecordField(known, "runtimeSigner")) }
    ]);
  }
  if (Object.keys(output.commands).length > 0) {
    console.log("");
    console.log(sectionTitle("Probe commands"));
    for (const [name, command] of Object.entries(output.commands)) {
      console.log(`${name}: ${command}`);
    }
  }
  for (const warning of output.warnings) {
    console.log(statusLine("warn", "Warning", warning));
  }
}

async function probeSshOverTls(input: DeployDoctorProbeInput): Promise<DeployDoctorProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let secure = false;
    let socket: TLSSocket | undefined;
    const finish = (result: DeployDoctorProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        checked: true,
        tls: secure ? { ok: true } : { ok: false, error: `TLS probe timed out after ${input.timeoutMs}ms` },
        ssh: { ok: false, error: `SSH banner timed out after ${input.timeoutMs}ms` }
      });
    }, input.timeoutMs);

    socket = tlsConnect({
      host: input.hostname,
      port: input.port,
      servername: input.hostname,
      rejectUnauthorized: false
    });
    socket.setEncoding("utf8");
    socket.once("secureConnect", () => {
      secure = true;
      const certificate = socket?.getPeerCertificate();
      const tls = {
        ok: true,
        authorized: socket?.authorized,
        authorizationError: typeof socket?.authorizationError === "string" ? socket.authorizationError : undefined,
        peerCertificate: certificate && Object.keys(certificate).length > 0
          ? {
              subject: certificate.subject,
              issuer: certificate.issuer,
              validFrom: certificate.valid_from,
              validTo: certificate.valid_to,
              subjectaltname: certificate.subjectaltname
            }
          : undefined
      };
      socket?.once("data", (chunk: string | Buffer) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
        const first = firstLine(text);
        finish({
          checked: true,
          tls,
          ssh: first.startsWith("SSH-")
            ? { ok: true, banner: first }
            : { ok: false, banner: first, error: "first bytes were not an SSH banner" }
        });
      });
      socket?.once("end", () => {
        finish({
          checked: true,
          tls,
          ssh: { ok: false, error: "TLS stream ended before an SSH banner arrived" }
        });
      });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        checked: true,
        tls: secure ? { ok: true } : { ok: false, error: error.message, code: error.code },
        ssh: { ok: false, error: error.message }
      });
    });
  });
}

function firstNonEmptyRecord(records: Record<string, unknown>[]): Record<string, unknown> {
  return records.find((record) => Object.keys(record).length > 0) ?? {};
}

function arrayRecordField(record: unknown, name: string): Array<Record<string, unknown>> {
  const value = record && typeof record === "object" && !Array.isArray(record)
    ? (record as Record<string, unknown>)[name]
    : undefined;
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function hostFromHostPort(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.includes("]")) {
    return trimmed.slice(1, trimmed.indexOf("]"));
  }
  return trimmed.split(":")[0];
}

function classifyUpstreamAddress(value: string): string {
  if (publicIpv4Address(value)) return "public-egress";
  if (privateIpv4Address(value)) return "private-lan";
  if (/^127\.|^0\.|^169\.254\./.test(value)) return "local-or-link";
  if (/^[0-9.]+$/.test(value)) return "reserved-or-non-public";
  return "hostname";
}

function privateIpv4Address(value: string): boolean {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function requireDeployWorkflowAcurastAction(snapshot: SwitchboardDeployWorkflowSnapshot): WorkflowRequiredAction {
  if (snapshot.step !== "deploy_action_required" || snapshot.requiredAction?.kind !== "acurast.deploy") {
    throw new Error(`Deploy workflow stopped at ${snapshot.step}; expected acurast.deploy action`);
  }
  return snapshot.requiredAction;
}

function deployWorkflowRunnerReceipt(
  action: WorkflowRequiredAction,
  report: Record<string, any>,
  reportPath: string
): WorkflowActionReceipt {
  const route = report.route ?? report.routeActivation;
  return {
    actionId: action.id,
    kind: action.kind,
    receipt: jsonSafeOutput({
      adapter: stringRecordField(report, "mode") === "acurast-sdk-submit-only" ? "acurast-sdk" : "switchboard-deploy",
      ok: report.ok === true,
      deploymentId: stringRecordField(report.deployment, "deploymentId"),
      txHash: stringRecordField(report.deployment, "txHash"),
      jobId: stringRecordField(report.session, "jobId"),
      processor: stringRecordField(report.session, "processor"),
      processorId: stringRecordField(report.session, "processorId"),
      operatorId: stringRecordField(report.session, "operatorId"),
      gatewayId: stringRecordField(report.session, "gatewayId"),
      schedule: report.lifecycle && typeof report.lifecycle === "object" ? (report.lifecycle as Record<string, any>).schedule : undefined,
      deploymentIntentId: stringRecordField(report.deploymentIntent, "intentId"),
      reportPath,
      route: route ? jsonSafeOutput(route) : undefined,
      failure: report.ok === true ? undefined : {
        stage: stringRecordField(report.failure, "stage") ?? stringRecordField(report.error, "stage"),
        message: stringRecordField(report.failure, "message") ?? stringRecordField(report.error, "message") ?? stringRecordField(report, "error")
      }
    }) as Record<string, any>
  };
}

function deployWorkflowGroupRunnerReceipt(
  action: WorkflowRequiredAction,
  report: Record<string, any>,
  reportPath: string
): WorkflowActionReceipt {
  const receipt: AcurastGroupDeployReceiptPayload = {
    adapter: "switchboard-deploy",
    ok: report.ok === true,
    deployment: jsonSafeWorkflowValue(report.deployment) as Record<string, any>,
    deploymentIntentGroup: jsonSafeWorkflowValue(report.deploymentIntentGroup) as Record<string, any>,
    ha: jsonSafeWorkflowValue(report.ha ?? report.deploymentIntentGroup) as Record<string, any>,
    funding: jsonSafeWorkflowValue(report.funding) as Record<string, any>,
    route: jsonSafeWorkflowValue(report.route ?? report.routeActivation ?? report.publicProbe) as Record<string, any>,
    validation: jsonSafeWorkflowValue(report.validation ?? report.validationReports) as Record<string, any>,
    reportPath,
    failure: report.ok === true ? undefined : {
      stage: stringRecordField(report.failure, "stage") ?? stringRecordField(report.error, "stage"),
      message: stringRecordField(report.failure, "message") ?? stringRecordField(report.error, "message") ?? stringRecordField(report, "error")
    }
  };
  return {
    actionId: action.id,
    kind: action.kind,
    receipt: jsonSafeOutput(receipt) as Record<string, any>
  };
}

async function runDeployWorkflowToTerminalOrBlockedWithPolling(input: {
  workflow: SwitchboardDeployWorkflow;
  pollMs: number;
  timeoutMs: number;
}): Promise<SwitchboardDeployWorkflowSnapshot> {
  const startedAt = Date.now();
  let snapshot = await input.workflow.runToBlocked();
  while (!["complete", "failed", "funding_action_required", "deploy_action_required"].includes(snapshot.step)) {
    if (Date.now() - startedAt > input.timeoutMs) {
      throw new Error(`Timed out waiting for deploy workflow to advance from ${snapshot.step} after ${input.timeoutMs}ms`);
    }
    const before = snapshot.step;
    snapshot = await input.workflow.advanceOnce();
    if (snapshot.step === before) {
      await sleep(input.pollMs);
    }
  }
  return snapshot;
}

function deployWorkflowPollingConfig(childEnv: Record<string, string | undefined>): { pollMs: number; timeoutMs: number } {
  const pollMs = parsePositiveIntegerString(
    "SWITCHBOARD_DEPLOY_POLL_INTERVAL_MS",
    childEnv.SWITCHBOARD_DEPLOY_POLL_INTERVAL_MS ?? optionalEnv("SWITCHBOARD_DEPLOY_POLL_INTERVAL_MS") ?? "10000"
  );
  const startDelayMs = parseIntegerFlagValue(
    "ACURAST_START_DELAY_MS",
    childEnv.ACURAST_START_DELAY_MS ?? optionalEnv("ACURAST_START_DELAY_MS") ?? "0"
  );
  const executionMs = parseIntegerFlagValue(
    "ACURAST_EXECUTION_MS",
    childEnv.ACURAST_EXECUTION_MS ?? optionalEnv("ACURAST_EXECUTION_MS") ?? "0"
  );
  const fallbackTimeoutMs = Math.max(900_000, startDelayMs + executionMs + 300_000);
  const timeoutMs = parsePositiveIntegerString(
    "SWITCHBOARD_DEPLOY_RUNTIME_TIMEOUT_MS",
    childEnv.SWITCHBOARD_DEPLOY_RUNTIME_TIMEOUT_MS ?? optionalEnv("SWITCHBOARD_DEPLOY_RUNTIME_TIMEOUT_MS") ?? String(fallbackTimeoutMs)
  );
  return { pollMs, timeoutMs };
}

async function completeDeployWorkflowSnapshotFromRunner(
  snapshot: SwitchboardDeployWorkflowSnapshot,
  report: Record<string, any>,
  reportPath: string,
  receipt?: WorkflowActionReceipt
): Promise<SwitchboardDeployWorkflowSnapshot> {
  const updatedAt = new Date().toISOString();
  const events = [
    ...snapshot.events,
    deployWorkflowEvent(snapshot.events.length + 1, updatedAt, "deploy_submitted", {
      deploymentId: stringRecordField(report.deployment, "deploymentId"),
      reportPath
    }),
    deployWorkflowEvent(snapshot.events.length + 2, updatedAt, "final_report", {
      ok: report.ok === true,
      sessionId: stringRecordField(report.session, "sessionId"),
      hostname: deploymentReportHostnames(report).public ?? stringRecordField(report.session, "hostname")
    })
  ];
  return {
    ...snapshot,
    step: report.ok === true ? "complete" : "failed",
    data: {
      ...snapshot.data,
      deployment: jsonSafeOutput(report.deployment),
      session: jsonSafeOutput(report.session),
      quote: jsonSafeWorkflowValue(report.quote),
      funding: jsonSafeWorkflowValue(report.funding),
      route: jsonSafeWorkflowValue(report.route ?? report.routeActivation),
      validation: jsonSafeWorkflowValue(report.validation ?? report.validationReports),
      actionReceipts: [
        ...(Array.isArray(snapshot.data.actionReceipts) ? snapshot.data.actionReceipts : []),
        ...(receipt ? [receipt] : [])
      ],
      reportPath
    },
    requiredAction: report.ok === true ? undefined : {
      id: receipt?.actionId ?? `deploy-runner-${snapshot.workflowId}`,
      kind: "acurast.deploy",
      description: "Compatibility deploy runner failed before the workflow completed",
      payload: {
        reportPath,
        actionReceipt: receipt?.receipt
      }
    },
    events,
    updatedAt
  };
}

function deployWorkflowEvent(
  sequence: number,
  at: string,
  type: string,
  details?: Record<string, unknown>
): SwitchboardDeployWorkflowEvent {
  return { sequence, at, type, details };
}

function attachDeployWorkflowReportMetadata(report: Record<string, any>, snapshot: SwitchboardDeployWorkflowSnapshot): void {
  const redacted = redactDeployWorkflowSnapshot(snapshot);
  mergeDeployWorkflowCompletionIntoReport(report, redacted);
  report.workflowId = redacted.workflowId;
  report.workflow = redacted;
  report.workflowEvents = redacted.events;
  if (redacted.requiredAction) {
    report.requiredAction = redacted.requiredAction;
  }
}

function mergeDeployWorkflowCompletionIntoReport(report: Record<string, any>, snapshot: SwitchboardDeployWorkflowSnapshot): void {
  if (snapshot.step !== "complete") return;
  const data = snapshot.data;
  const quote = data.quote && typeof data.quote === "object" ? data.quote as Record<string, unknown> : {};
  const quoteRecord = quote.quote && typeof quote.quote === "object" ? quote.quote as Record<string, unknown> : {};
  const runtime = data.runtime && typeof data.runtime === "object" ? data.runtime as Record<string, unknown> : {};
  const funding = data.funding && typeof data.funding === "object" ? data.funding as Record<string, unknown> : {};
  const routeStatus = data.routeStatus && typeof data.routeStatus === "object" ? data.routeStatus as Record<string, unknown> : {};
  const route = routeStatus.route && typeof routeStatus.route === "object"
    ? routeStatus.route as Record<string, unknown>
    : routeStatus.intent && typeof routeStatus.intent === "object" && (routeStatus.intent as Record<string, unknown>).route && typeof (routeStatus.intent as Record<string, unknown>).route === "object"
      ? (routeStatus.intent as Record<string, any>).route as Record<string, unknown>
      : {};
  const sessionId =
    stringRecordField(quoteRecord, "sessionId") ??
    stringRecordField(funding, "sessionId") ??
    stringRecordField(funding.session, "sessionId");
  const endpointHostname = stringRecordField(quote, "endpointHostname") ?? stringRecordField(route, "hostname");
  const validationHostname = stringRecordField(quote, "validationHostname");
  report.session = {
    ...(report.session && typeof report.session === "object" ? report.session : {}),
    sessionId,
    jobId: snapshot.input.jobId,
    jobSigner: stringRecordField(runtime, "runtimeSigner"),
    operatorId: stringRecordField(snapshot.data.capacity, "operatorId"),
    processor: stringRecordField(snapshot.data.capacity, "processor"),
    processorId: stringRecordField(snapshot.data.capacity, "processorId"),
    hostname: endpointHostname,
    validationHostname
  };
  report.hostnames = {
    ...(report.hostnames && typeof report.hostnames === "object" ? report.hostnames : {}),
    public: endpointHostname,
    validation: validationHostname
  };
  report.quote = quote;
  report.funding = funding;
  report.route = Object.keys(route).length > 0 ? route : report.route;
  report.validation = data.validation;
}

async function runDeployWorkflowCompatibilityRunner(input: {
  workflow: SwitchboardDeployWorkflow;
  workflowStore: ReturnType<typeof deployWorkflowStore> | undefined;
  childArgs: string[];
  childEnv: Record<string, string | undefined>;
  runtime: CliRuntime;
  action: "launch-demo" | "deploy";
  json: boolean;
  workDir?: string;
}): Promise<{
  report: Record<string, any>;
  reportPath: string;
  workflowSnapshot: SwitchboardDeployWorkflowSnapshot;
}> {
  const deployActionSnapshot = await input.workflow.runToBlocked();
  const deployAction = requireDeployWorkflowAcurastAction(deployActionSnapshot);
  const submit = await submitAcurastSingleReplicaWithSdk({
    actionPayload: deployAction.payload as AcurastSdkSubmitActionPayload,
    env: {
      ...process.env,
      ...contextRuntimeEnv(input.runtime),
      ...input.childEnv,
      SWITCHBOARD_DEPLOY_RUN_DIR: argValue(input.childArgs, "--run-dir"),
      SWITCHBOARD_DEPLOY_PRECREATED_INTENT_JSON: JSON.stringify(deployAction.payload)
    },
    workDir: input.workDir,
    action: input.action,
    json: input.json
  });
  const reportPath = submit.reportPath;
  const report = submit.report;
  const receipt = deployWorkflowRunnerReceipt(deployAction, report, reportPath);
  if (report.ok !== true) {
    const workflowSnapshot = await completeDeployWorkflowSnapshotFromRunner(deployActionSnapshot, report, reportPath, receipt);
    await saveDeployWorkflowSnapshot(workflowSnapshot, input.workflowStore, reportPath);
    attachDeployWorkflowReportMetadata(report, workflowSnapshot);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { report, reportPath, workflowSnapshot };
  }
  await input.workflow.applyActionReceipt(receipt);
  const workflowSnapshot = await runDeployWorkflowToTerminalOrBlockedWithPolling({
    workflow: input.workflow,
    ...deployWorkflowPollingConfig(input.childEnv)
  });
  await saveDeployWorkflowSnapshot(workflowSnapshot, input.workflowStore, reportPath);
  attachDeployWorkflowReportMetadata(report, workflowSnapshot);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, reportPath, workflowSnapshot };
}

async function runDeployWorkflowGroupRunner(input: {
  workflow: SwitchboardDeployWorkflow;
  workflowStore: ReturnType<typeof deployWorkflowStore> | undefined;
  childArgs: string[];
  childEnv: Record<string, string | undefined>;
  runtime: CliRuntime;
  action: "launch-demo" | "deploy";
  json: boolean;
  workDir?: string;
}): Promise<{
  report: Record<string, any>;
  reportPath: string;
  workflowSnapshot: SwitchboardDeployWorkflowSnapshot;
}> {
  const deployActionSnapshot = await input.workflow.runToBlocked();
  const deployAction = requireDeployWorkflowAcurastAction(deployActionSnapshot);
  const deployRunner = await resolveDeployRunner(input.childArgs, {
    ...contextRuntimeEnv(input.runtime),
    ...input.childEnv,
    SWITCHBOARD_DEPLOY_RUNNER_MODE: "acurast-group-submit-only",
    SWITCHBOARD_DEPLOY_PRECREATED_GROUP_JSON: JSON.stringify(deployAction.payload)
  }, { workDir: input.workDir });
  const result = await runDeployRunner(deployRunner.command, deployRunner.args, {
    env: deployRunner.env,
    cwd: deployRunner.cwd,
    childStdoutToStderr: input.json,
    action: input.action,
    json: input.json
  });
  const reportPath = parseDeployReportPath(result.stdout, result.stderr);
  const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, any>;
  const receipt = deployWorkflowGroupRunnerReceipt(deployAction, report, reportPath);
  await input.workflow.applyActionReceipt(receipt);
  const workflowSnapshot = report.ok === true
    ? await runDeployWorkflowToTerminalOrBlockedWithPolling({
        workflow: input.workflow,
        ...deployWorkflowPollingConfig(input.childEnv)
      })
    : input.workflow.snapshot;
  await saveDeployWorkflowSnapshot(workflowSnapshot, input.workflowStore, reportPath);
  attachDeployWorkflowReportMetadata(report, workflowSnapshot);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, reportPath, workflowSnapshot };
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function deployCommand(flags: Map<string, string | boolean>, runtime: CliRuntime) {
  if (!boolFlag(flags, "dry-run") && !boolFlag(flags, "yes") && optionalEnv("SWITCHBOARD_ASSUME_YES") !== "true" && optionalEnv("SWITCHBOARD_DEPLOY_ASSUME_YES") !== "true") {
    throw new Error("Refusing to run deployment without --yes");
  }
  if (!stringFlag(flags, "entrypoint") && !optionalEnv("ACURAST_ENTRYPOINT")) {
    throw new Error(
      "switchboard deploy is for project workloads. The bundled demo moved to `switchboard launch-demo --yes-spend`; configure acurast.entrypoint in switchboard.json or pass --entrypoint for project deploys."
    );
  }
  const deployRuntimeConfig = await resolveDeployRuntimeConfig(flags, {
    dryRun: boolFlag(flags, "dry-run"),
    projectRoot: runtime.projectRoot
  });

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
  const relayUrls = controlRelayCandidateUrls(relayUrl, manifestConfig, {
    pinned: relayUrlPinnedByUser(flags, ["SWITCHBOARD_DEPLOY_RELAY_URL", "RELAY_URL"])
  });
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
  const acurastNetwork = launchDemoAcurastNetwork(flags);
  const requiredAcurastModules = deployRuntimeConfig.kind === "script" && !boolFlag(flags, "dry-run") ? [RequiredModules.Shell] : [];
  const explicitOperatorId = stringFlag(flags, "operator-id") ?? optionalEnv("SWITCHBOARD_OPERATOR_ID") ?? optionalEnv("OPERATOR_ID");
  const explicitProcessor = stringFlag(flags, "processor") ?? optionalEnv("SWITCHBOARD_DEPLOY_PROCESSOR");
  const explicitGatewayId = deployGatewayOverride(flags);
  const routeActivationMode = "relay-reconciled";
  let selection: LaunchDemoCapacitySelection | undefined;
  if (routeActivationMode === "relay-reconciled" && (explicitOperatorId || explicitGatewayId || explicitProcessor)) {
    selection = await selectDeployCapacity({
      relayUrl,
      relayUrls,
      network: acurastNetwork,
      operatorId: explicitOperatorId,
      gatewayId: explicitGatewayId,
      processor: explicitProcessor,
      requiredModules: requiredAcurastModules
    });
  } else if (!explicitOperatorId) {
    selection = await selectLaunchDemoCapacity({
        relayUrl,
        relayUrls,
        network: acurastNetwork,
        durationMinutes,
        scheduleBufferMinutes,
        processorCount: 1,
        minReady: 1,
        requiredModules: requiredAcurastModules
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

  const operationRelayUrl = selection?.sourceRelayUrl ?? relayUrl;
  const childArgs = [INTERNAL_DEPLOY_RUNNER_SCRIPT, "--", "--yes", "--relay-url", operationRelayUrl, "--operator-id", operatorId];
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
    RELAY_URL: operationRelayUrl,
    PROOF_CONTROL_PLANE_URL: operationRelayUrl,
    PAYMENT_ASSET_ADDRESS: manifestConfig.defaultAssetAddress,
    PROOF_QUOTE_DEFAULT_ASSET: manifestConfig.defaultAssetAddress,
    SWITCHBOARD_WORK_DIR: runtime.projectRoot,
    ACURAST_ENTRYPOINT: deployRuntimeConfig.kind === "script" ? deployRuntimeConfig.entrypoint : stringFlag(flags, "entrypoint") ?? optionalEnv("ACURAST_ENTRYPOINT"),
    ACURAST_STAGE_DIR: stringFlag(flags, "stage-dir") ?? optionalEnv("ACURAST_STAGE_DIR"),
    ACURAST_RUNTIME: deployRuntimeConfig.kind,
    ACURAST_SCRIPT_IMAGE_URL: deployRuntimeConfig.kind === "script" ? deployRuntimeConfig.image.url : undefined,
    ACURAST_SCRIPT_IMAGE_SHA256: deployRuntimeConfig.kind === "script" ? deployRuntimeConfig.image.sha256 : undefined,
    ACURAST_SCRIPT_FILES: deployRuntimeConfig.kind === "script" ? deployRuntimeConfig.scriptFiles.join(",") : undefined,
    ACURAST_REQUIRED_MODULES: deployRuntimeConfig.kind === "script" ? RequiredModules.Shell : undefined,
    [SSH_AUTH_KEYS_ENV]: deployRuntimeConfig.kind === "script" ? deployRuntimeConfig.authorizedKeys : undefined,
    SWITCHBOARD_DEPLOY_PROCESSOR: explicitProcessor ?? selection?.processor,
    ACURAST_INSTANT_MATCH_PROCESSORS: explicitProcessor ?? optionalEnv("ACURAST_INSTANT_MATCH_PROCESSORS") ?? selection?.processor,
    ACURAST_MANAGER_ID: stringFlag(flags, "manager-id") ?? optionalEnv("ACURAST_MANAGER_ID") ?? selection?.managerId
  };
  const workflowInput = deployWorkflowInputFromCli({
    relayUrl: operationRelayUrl,
    manifestConfig,
    flags,
    durationMinutes,
    certificateMode,
    maxCostPerExecution,
    operatorId,
    runtimeConfig: deployRuntimeConfig,
    processor: childEnv.SWITCHBOARD_DEPLOY_PROCESSOR,
    processorId: selection?.processorId,
    gatewayId: selectedGatewayId,
    managerId: stringFlag(flags, "manager-id") ?? optionalEnv("ACURAST_MANAGER_ID") ?? selection?.managerId,
    selection
  });
  const workflowStore = deployWorkflowStore(flags);
  const workflow = new SwitchboardDeployWorkflow(workflowInput, deployWorkflowAdapters(workflowInput, workflowStore, {
    helperEnv: contextRuntimeEnv(runtime)
  }));
  const capacitySnapshot = await workflow.advanceOnce();
  if (boolFlag(flags, "dry-run")) {
    const output = {
      ok: true,
      action: "deploy-dry-run",
      command: SWITCHBOARD_CLI,
      args: ["deploy", "--yes"],
      relayUrl: operationRelayUrl,
      relayCandidates: relayUrls,
      env: childEnv,
      runtime: deployRuntimeConfig,
      manifest: {
        url: manifestConfig.manifestUrl,
        signer: manifestConfig.signer,
        sequence: manifestConfig.manifest?.sequence,
        expiresAt: manifestConfig.manifest?.expiresAt
      },
      workflow: {
        workflowId: capacitySnapshot.workflowId,
        input: workflowInput,
        snapshot: capacitySnapshot,
        events: capacitySnapshot.events
      },
      note: "No Acurast deployment, Hub transaction, DNS change, or route mutation was attempted."
    };
    writeOutput(flags, output, () => {
      console.log(sectionTitle("Switchboard deploy dry run"));
      printOutputRows([
        { label: "Command", value: `${SWITCHBOARD_CLI} deploy --yes` },
        { label: "Relay", value: operationRelayUrl },
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

  if (!boolFlag(flags, "json")) {
    printProjectDeployStart({
      relayUrl: operationRelayUrl,
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
  const { report, reportPath } = await runDeployWorkflowCompatibilityRunner({
    workflow,
    workflowStore,
    childArgs,
    childEnv,
    runtime,
    action: "deploy",
    json: boolFlag(flags, "json"),
    workDir: runtime.projectRoot
  });
  const output = deployOutput(report, reportPath, {
    relayUrl: operationRelayUrl,
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
  const requestedRelayUrl =
    stringFlag(flags, "relay-url") ??
    optionalEnv("SWITCHBOARD_VALIDATOR_RELAY_URL") ??
    manifestConfig.relayUrl ??
    DEFAULT_CONTROL_PLANE_URL;
  const relayPinned = Boolean(relayUrlFlagPinnedByUser(flags) || optionalEnv("SWITCHBOARD_VALIDATOR_RELAY_URL"));
  const relayCandidates = validatorLaunchControlRelayCandidates(requestedRelayUrl, manifestConfig, { pinned: relayPinned });
  const validatorRelaySelection = await selectWritableControlRelayUrl(
    relayCandidates
  );
  const relayUrl = validatorRelaySelection.relayUrl;
  const seed = stringFlag(flags, "deployer-seed") ?? optionalEnv("ACURAST_MAINNET_SEED") ?? optionalEnv("PROOF_ACURAST_MAINNET_DEPLOYER_SEED");
  if (!seed) {
    throw new Error("Missing --deployer-seed or ACURAST_MAINNET_SEED/PROOF_ACURAST_MAINNET_DEPLOYER_SEED");
  }
  const ss58Format = numberFlag(flags, "ss58-format", "VALIDATOR_REPORT_SS58_FORMAT", 42);
  const deployer = await accountFromUri(seed, ss58Format);
  const targetNetwork = stringFlag(flags, "acurast-network") ?? runtime.context?.acurastNetwork ?? "mainnet";
  const intentPayload = {
    deployerAddress: deployer.address,
    requestedCount: numberFlag(flags, "count", "PROOF_VALIDATOR_LAUNCH_COUNT", 1),
    targetNetwork,
    nonce: randomNonce(),
    deadline: String(Math.floor(Date.now() / 1000) + 300)
  };
  let intent: unknown;
  try {
    intent = await postSignedJson(new URL("/v1/validator-launch-intents", relayUrl).toString(), intentPayload, {
      domain: "switchboard.validator-launch-intent.v1",
      seed,
      ss58Format,
      retries: 2,
      timeoutMs: 20_000
    });
  } catch (error) {
    const latest = await resolveValidatorScriptLookup(flags, manifestConfig);
    if (latest?.scriptIpfs && String(error instanceof Error ? error.message : error).includes("validator_script_not_configured")) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `Latest validator script pin is ${latest.scriptIpfs}; configure the relay with PROOF_VALIDATOR_SCRIPT_MANIFEST_URL/FILE/JSON or PROOF_VALIDATOR_SCRIPT_IPFS before launch.`
      );
    }
    throw error;
  }
  const intentRecord = intent as Record<string, any>;
  const scriptIpfs = stringRecordField(intentRecord, "validatorScriptIpfs") ?? manifestConfig.manifest?.validators?.launch?.scriptIpfs;
  if (!scriptIpfs) {
    throw new Error("Control plane did not return a validator script IPFS URI");
  }
  const enrollmentMnemonic = mnemonicGenerate(12);
  const enrollmentAccount = await accountFromUri(enrollmentMnemonic, ss58Format);
  const enrollmentPubkey = enrollmentAccount.address;

  const durationMinutes = optionalIntegerFlag(flags, "duration-minutes", "SWITCHBOARD_DEPLOY_DURATION_MINUTES");
  const scheduleBufferMinutes = optionalIntegerFlag(flags, "schedule-buffer-minutes", "SWITCHBOARD_DEPLOY_SCHEDULE_BUFFER_MINUTES") ?? 0;
  const validatorExecutionMs = resolveValidatorLaunchExecutionMs({
    durationMinutes,
    scheduleBufferMinutes,
    executionMs: stringFlag(flags, "execution-ms") ?? optionalEnv("ACURAST_EXECUTION_MS")
  });
  const validatorStartDelayMs = numberFlag(flags, "start-delay-ms", "ACURAST_START_DELAY_MS", 600_000);
  const validatorNetworkRequests = numberFlag(flags, "network-requests", "ACURAST_MAX_NETWORK_REQUESTS", 1_000);
  const validatorProcessors = await resolveValidatorLaunchProcessorSelection({
    flags,
    targetNetwork: targetNetwork === "canary" ? "canary" : "mainnet",
    requestedCount: Number(intentPayload.requestedCount),
    durationMs: Number(validatorExecutionMs),
    startDelayMs: validatorStartDelayMs
  });
  const validatorWorkEnv = resolveValidatorLaunchWorkRuntimeEnv({
    executionMs: validatorExecutionMs
  });

  if (boolFlag(flags, "dry-run")) {
    writeOutput(flags, {
      ok: true,
      intent,
      scriptIpfs,
      enrollmentPubkey,
      deployer: {
        address: deployer.address,
        ss58Format
      },
      execution: {
        executionMs: validatorExecutionMs,
        startDelayMs: validatorStartDelayMs,
        durationMinutes: durationMinutes ?? DEFAULT_DEPLOY_DURATION_MINUTES,
        scheduleBufferMinutes
      },
      networkRequests: validatorNetworkRequests,
      validatorWork: validatorWorkEnv,
      relay: {
        relayUrl,
        requestedRelayUrl,
        candidates: validatorRelaySelection.probes.map((probe) => ({
          relayUrl: probe.relayUrl,
          ok: probe.ok,
          elapsedMs: probe.elapsedMs,
          detail: probe.detail
        }))
      },
      processorSelection: validatorProcessors
    }, () => {
      console.log("Validator launch dry run");
      console.log(`Intent: ${stringRecordField(intentRecord, "intentId")}`);
      console.log(`Relay: ${relayUrl}`);
      console.log(`Script: ${scriptIpfs}`);
      console.log(`Deployer: ${deployer.address}`);
      console.log(`SS58 format: ${ss58Format}`);
      console.log(`Enrollment pubkey: ${enrollmentPubkey}`);
      console.log(`Execution ms: ${validatorExecutionMs}`);
      console.log(`Network requests: ${validatorNetworkRequests}`);
      console.log(`Work poll interval ms: ${validatorWorkEnv.VALIDATOR_WORK_POLL_INTERVAL_MS}`);
      console.log(`Work lease seconds: ${validatorWorkEnv.VALIDATOR_WORK_LEASE_SECONDS}`);
      console.log(`Work max items: ${validatorWorkEnv.VALIDATOR_WORK_MAX_ITEMS}`);
      if (validatorProcessors.processors) console.log(`Processors: ${validatorProcessors.processors}`);
    });
    return;
  }
  const validatorEnvKeys = [
    "PROOF_CONTROL_PLANE_URL",
    "PROOF_VALIDATOR_LAUNCH_INTENT_ID",
    "VALIDATOR_ENROLLMENT_SEED",
    "VALIDATOR_WORK_POLL",
    "VALIDATOR_WORK_RUN_MS",
    "VALIDATOR_WORK_POLL_INTERVAL_MS",
    "VALIDATOR_WORK_LEASE_SECONDS",
    "VALIDATOR_WORK_MAX_ITEMS",
    "VALIDATOR_DEPLOYMENT_ID",
    "VALIDATOR_ACURAST_JOB_ID"
  ];
  const pendingDeploymentId = "__SWITCHBOARD_PENDING_VALIDATOR_DEPLOYMENT_ID__";
  const pendingAcurastJobId = "__SWITCHBOARD_PENDING_VALIDATOR_ACURAST_JOB_ID__";

  const deployRunner = await resolveAcurastDirectDeployRunner(["--script-ipfs", scriptIpfs, "--skip-env"], {
    ...contextRuntimeEnv(runtime),
    ACURAST_MAINNET_SEED: seed,
    ACURAST_SEED: seed,
    ACURAST_CANARY_SEED: optionalEnv("ACURAST_CANARY_SEED"),
    ACURAST_ASSUME_YES: boolFlag(flags, "yes") ? "true" : optionalEnv("ACURAST_ASSUME_YES"),
    ACURAST_COMPACT_ENV: "true",
    ACURAST_EXPLICIT_ENV_ONLY: "true",
    ACURAST_SCRIPT_IPFS: scriptIpfs,
    ACURAST_ENTRYPOINT: "validator-job",
    ACURAST_NETWORK: targetNetwork,
    ACURAST_RPC: stringFlag(flags, "acurast-rpc") ?? optionalEnv("ACURAST_RPC"),
    ACURAST_MANAGER_ID: validatorProcessors.managerId,
    ACURAST_INSTANT_MATCH_PROCESSORS: validatorProcessors.processors,
    ACURAST_EXECUTION_MS: validatorExecutionMs,
    ACURAST_START_DELAY_MS: String(validatorStartDelayMs),
    ACURAST_MAX_NETWORK_REQUESTS: String(validatorNetworkRequests),
    ACURAST_MAX_ALLOWED_START_DELAY_MS: optionalEnv("ACURAST_MAX_ALLOWED_START_DELAY_MS"),
    ACURAST_INSTANT_MATCH_START_DELAY_MS: optionalEnv("ACURAST_INSTANT_MATCH_START_DELAY_MS"),
    ACURAST_MAX_COST_PER_EXECUTION: stringFlag(flags, "max-cost-per-execution") ?? optionalEnv("ACURAST_MAX_COST_PER_EXECUTION"),
    ACURAST_ACK_TIMEOUT_MS: optionalEnv("ACURAST_ACK_TIMEOUT_MS"),
    ACURAST_ACK_INTERVAL_MS: optionalEnv("ACURAST_ACK_INTERVAL_MS"),
    ACURAST_SET_ENV_TIMEOUT_MS: optionalEnv("ACURAST_SET_ENV_TIMEOUT_MS"),
    SWITCHBOARD_DEPLOY_PROCESSOR: optionalEnv("SWITCHBOARD_DEPLOY_PROCESSOR"),
    SWITCHBOARD_DEPLOY_DURATION_MINUTES: durationMinutes === undefined ? optionalEnv("SWITCHBOARD_DEPLOY_DURATION_MINUTES") : String(durationMinutes),
    SWITCHBOARD_DEPLOY_SCHEDULE_BUFFER_MINUTES: String(scheduleBufferMinutes),
    PROOF_CONTROL_PLANE_URL: relayUrl,
    PROOF_VALIDATOR_LAUNCH_INTENT_ID: stringRecordField(intentRecord, "intentId"),
    VALIDATOR_ENROLLMENT_SEED: enrollmentMnemonic,
    ...validatorWorkEnv,
    VALIDATOR_DEPLOYMENT_ID: pendingDeploymentId,
    VALIDATOR_ACURAST_JOB_ID: pendingAcurastJobId,
    ACURAST_INCLUDE_ENV: validatorEnvKeys.join(",")
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
  const acurastJobId = JSON.stringify([{ acurast: deployer.address }, deploymentId]);
  const updateEnvRunner = await resolveAcurastUpdateEnvRunner(["--deployment-id", deploymentId], {
    ...deployRunner.env,
    VALIDATOR_DEPLOYMENT_ID: deploymentId,
    VALIDATOR_ACURAST_JOB_ID: acurastJobId,
    ACURAST_DEPLOYMENT_ID: deploymentId
  });
  await runCliChild(updateEnvRunner.command, updateEnvRunner.args, {
    env: {
      ...updateEnvRunner.env
    },
    childStdoutToStderr: boolFlag(flags, "json")
  });

  const registrationPayload = {
    intentId: requiredStringRecordField(intentRecord, "intentId"),
    deployerAddress: deployer.address,
    acurastJobId,
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
      ss58Format,
      retries: 4,
      retryDelayMs: 2_500,
      timeoutMs: numberFlag(flags, "validator-registration-timeout-ms", "SWITCHBOARD_VALIDATOR_REGISTRATION_TIMEOUT_MS", 60_000)
    }
  );
  writeOutput(flags, {
    ok: true,
    intent,
    deploymentId,
    registered,
    enrollmentPubkey,
    relay: {
      relayUrl,
      requestedRelayUrl,
      candidates: validatorRelaySelection.probes.map((probe) => ({
        relayUrl: probe.relayUrl,
        ok: probe.ok,
        elapsedMs: probe.elapsedMs,
        detail: probe.detail
      }))
    },
    deployer: {
      address: deployer.address,
      ss58Format
    },
    execution: {
      executionMs: validatorExecutionMs,
      startDelayMs: validatorStartDelayMs,
      durationMinutes: durationMinutes ?? DEFAULT_DEPLOY_DURATION_MINUTES,
      scheduleBufferMinutes
    },
    networkRequests: validatorNetworkRequests,
    validatorWork: validatorWorkEnv
  }, () => {
    console.log("Validator launch registered");
    console.log(`Intent: ${requiredStringRecordField(intentRecord, "intentId")}`);
    console.log(`Relay: ${relayUrl}`);
    console.log(`Deployment: ${deploymentId}`);
    console.log(`Script: ${scriptIpfs}`);
    console.log(`Deployer: ${deployer.address}`);
    console.log(`SS58 format: ${ss58Format}`);
    console.log(`Enrollment pubkey: ${enrollmentPubkey}`);
    console.log(`Execution ms: ${validatorExecutionMs}`);
    console.log(`Network requests: ${validatorNetworkRequests}`);
  });
}

export function resolveValidatorLaunchExecutionMs(input: {
  durationMinutes?: number;
  scheduleBufferMinutes?: number;
  executionMs?: string;
}): string {
  if (input.executionMs) {
    const parsed = parsePositiveIntegerString("execution-ms", input.executionMs);
    return String(parsed);
  }
  const durationMinutes = input.durationMinutes ?? DEFAULT_DEPLOY_DURATION_MINUTES;
  const scheduleBufferMinutes = input.scheduleBufferMinutes ?? 0;
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes <= 0) {
    throw new Error("validator launch duration-minutes must be a positive integer");
  }
  if (!Number.isSafeInteger(scheduleBufferMinutes) || scheduleBufferMinutes < 0) {
    throw new Error("validator launch schedule-buffer-minutes must be a non-negative integer");
  }
  return String((durationMinutes + scheduleBufferMinutes) * 60_000);
}

export function resolveValidatorLaunchWorkRuntimeEnv(input: {
  executionMs: string;
  env?: Record<string, string | undefined>;
}): Record<string, string> {
  const env = input.env ?? process.env;
  const runMs = env.VALIDATOR_WORK_RUN_MS ?? input.executionMs;
  return {
    VALIDATOR_WORK_POLL: "true",
    VALIDATOR_WORK_RUN_MS: String(parsePositiveIntegerString("VALIDATOR_WORK_RUN_MS", runMs)),
    VALIDATOR_WORK_POLL_INTERVAL_MS: String(parsePositiveIntegerString(
      "VALIDATOR_WORK_POLL_INTERVAL_MS",
      env.VALIDATOR_WORK_POLL_INTERVAL_MS ?? env.SWITCHBOARD_DEPLOY_VALIDATOR_WORK_POLL_INTERVAL_MS ?? "30000"
    )),
    VALIDATOR_WORK_LEASE_SECONDS: String(parsePositiveIntegerString(
      "VALIDATOR_WORK_LEASE_SECONDS",
      env.VALIDATOR_WORK_LEASE_SECONDS ?? env.SWITCHBOARD_DEPLOY_VALIDATOR_WORK_LEASE_SECONDS ?? "120"
    )),
    VALIDATOR_WORK_MAX_ITEMS: String(parsePositiveIntegerString(
      "VALIDATOR_WORK_MAX_ITEMS",
      env.VALIDATOR_WORK_MAX_ITEMS ?? env.SWITCHBOARD_DEPLOY_VALIDATOR_WORK_MAX_ITEMS ?? "1"
    ))
  };
}

export function selectValidatorLaunchProcessorsFromInventory(
  processors: ProcessorInfo[],
  input: { requestedCount: number; maxAgeSeconds?: number }
): string[] {
  if (!Number.isInteger(input.requestedCount) || input.requestedCount <= 0) {
    throw new Error("validator launch count must be a positive integer");
  }
  const selected = selectReadyProcessors(processors.filter((processor) => processor.availability?.conflicts === 0), {
    maxAgeSeconds: input.maxAgeSeconds ?? DEFAULT_LAUNCH_DEMO_PROCESSOR_MAX_AGE_SECONDS,
    requireAvailability: true,
    limit: input.requestedCount
  });
  if (selected.length !== input.requestedCount) {
    throw new Error(
      `Insufficient fresh available validator processor capacity: requested ${input.requestedCount}, selected ${selected.length}`
    );
  }
  return selected.map((processor) => processor.processor);
}

async function resolveValidatorLaunchProcessorSelection(input: {
  flags: Map<string, string | boolean>;
  targetNetwork: AcurastNetwork;
  requestedCount: number;
  durationMs: number;
  startDelayMs: number;
}): Promise<{ managerId?: string; processors?: string; source: string; inventory?: Record<string, unknown> }> {
  const explicitProcessors =
    stringFlag(input.flags, "processors") ??
    stringFlag(input.flags, "processor") ??
    optionalEnv("ACURAST_INSTANT_MATCH_PROCESSORS") ??
    optionalEnv("SWITCHBOARD_VALIDATOR_PROCESSORS") ??
    optionalEnv("SWITCHBOARD_VALIDATOR_PROCESSOR");
  const managerId = stringFlag(input.flags, "manager-id") ?? optionalEnv("ACURAST_MANAGER_ID");
  if (explicitProcessors) {
    const processors = splitCsv(explicitProcessors);
    if (processors.length !== input.requestedCount) {
      throw new Error(`Validator launch requires exactly ${input.requestedCount} processor(s), got ${processors.length}`);
    }
    return {
      managerId,
      processors: processors.join(","),
      source: "explicit"
    };
  }
  if (!managerId) {
    throw new Error("Missing --manager-id or ACURAST_MANAGER_ID for validator processor auto-selection");
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0) {
    throw new Error("validator launch duration must resolve to a positive millisecond value");
  }
  const inventory = await discoverManagerProcessors({
    network: input.targetNetwork,
    managerId,
    rpcUrl: stringFlag(input.flags, "acurast-rpc") ?? optionalEnv("ACURAST_RPC"),
    checkAvailability: true,
    startDelayMs: input.startDelayMs,
    durationMs: input.durationMs
  });
  const processors = selectValidatorLaunchProcessorsFromInventory(inventory.processors, {
    requestedCount: input.requestedCount
  });
  return {
    managerId,
    processors: processors.join(","),
    source: "manager-auto",
    inventory: {
      network: inventory.network,
      managerId: inventory.managerId,
      rpcUrl: inventory.rpcUrl,
      chainTimestampIso: inventory.chainTimestampIso,
      totalProcessors: inventory.totalProcessors,
      recentProcessors: inventory.recentProcessors,
      availableProcessors: inventory.availableProcessors,
      recentAvailableProcessors: inventory.recentAvailableProcessors,
      availabilityWindow: inventory.availabilityWindow
    }
  };
}

async function validatorScriptCommand(flags: Map<string, string | boolean>) {
  const manifestConfig = await resolveCliNetworkConfig(flags);
  const resolved = await resolveValidatorScriptLookup(flags, manifestConfig);
  if (!resolved?.scriptIpfs) {
    throw new Error("No validator script pin found in the network manifest or validator script manifest");
  }
  writeOutput(flags, { ok: true, ...resolved }, () => {
    console.log(`Validator script: ${resolved.scriptIpfs}`);
    if (resolved.scriptHash) console.log(`Script hash: ${resolved.scriptHash}`);
    console.log(`Source: ${resolved.source}`);
  });
}

async function resolveValidatorScriptLookup(
  flags: Map<string, string | boolean>,
  manifestConfig: CliNetworkConfig
): Promise<{ scriptIpfs: string; scriptHash?: string; source: string } | undefined> {
  const launch = manifestConfig.manifest?.validators?.launch;
  if (launch?.scriptIpfs) {
    return {
      scriptIpfs: launch.scriptIpfs,
      scriptHash: launch.scriptHash,
      source: manifestConfig.manifestUrl
    };
  }

  const json = stringFlag(flags, "validator-script-manifest-json") ??
    optionalEnv("SWITCHBOARD_VALIDATOR_SCRIPT_MANIFEST_JSON") ??
    optionalEnv("PROOF_VALIDATOR_SCRIPT_MANIFEST_JSON");
  const file = stringFlag(flags, "validator-script-manifest-file") ??
    optionalEnv("SWITCHBOARD_VALIDATOR_SCRIPT_MANIFEST_FILE") ??
    optionalEnv("PROOF_VALIDATOR_SCRIPT_MANIFEST_FILE");
  const url = stringFlag(flags, "validator-script-manifest-url") ??
    optionalEnv("SWITCHBOARD_VALIDATOR_SCRIPT_MANIFEST_URL") ??
    optionalEnv("PROOF_VALIDATOR_SCRIPT_MANIFEST_URL");
  if (!json && !file && !url) {
    return undefined;
  }

  let raw: string;
  let source: string;
  if (json) {
    raw = json;
    source = "inline";
  } else if (file) {
    raw = await readFile(file, "utf8");
    source = file;
  } else {
    const response = await fetch(url!, { headers: { accept: "application/json" } });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`${url} failed: ${response.status} ${body.slice(0, 1000)}`);
    }
    raw = body;
    source = url!;
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const scriptIpfs = typeof parsed.scriptIpfs === "string" ? parsed.scriptIpfs : undefined;
  if (!scriptIpfs?.startsWith("ipfs://")) {
    throw new Error("Validator script manifest must include scriptIpfs as an ipfs:// URI");
  }
  const scriptHash = typeof parsed.scriptHash === "string"
    ? parsed.scriptHash
    : typeof parsed.bundleSha256 === "string"
      ? `sha256:${parsed.bundleSha256}`
      : undefined;
  return { scriptIpfs, scriptHash, source };
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
  const hubExpiresAt = positiveUnixSecondsField(session, "expiresAt");
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
      expiresAt: hubExpiresAt === undefined ? undefined : String(hubExpiresAt),
      expiresAtIso: unixSecondsToIso(hubExpiresAt),
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

async function hostnameAttachCommand(
  flags: Map<string, string | boolean>,
  positionals: string[],
  adapters: HostnameMutationAdapters = {}
) {
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
  const dnsProviderHint = adapters.dnsProviderHint
    ? Promise.resolve(adapters.dnsProviderHint(customerHostname))
    : lookupDnsProviderHintForCli(customerHostname);
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
    }, adapters.fetchImpl);
    const waitSeconds = numberFlag(flags, "wait-seconds", "PROOF_CUSTOMER_HOSTNAME_WAIT_SECONDS", boolFlag(flags, "wait") ? 300 : 0);
    const output =
      waitSeconds > 0
        ? await waitForCustomerHostname(
            relayUrl,
            endpointId,
            customerHostname,
            waitSeconds,
            numberFlag(flags, "poll-seconds", "PROOF_CUSTOMER_HOSTNAME_POLL_SECONDS", 10),
            adapters.fetchImpl
          )
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

async function hostnameRemoveCommand(
  flags: Map<string, string | boolean>,
  positionals: string[],
  adapters: HostnameMutationAdapters = {}
) {
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
    }, adapters.fetchImpl);

    writeOutput(flags, { ...output, signer: signerOutput(signer) }, () => printCustomerHostnameRemovalResult(output));
  } finally {
    await disconnectCliHubSigner(signer);
  }
}

async function hostnameStatusCommand(
  flags: Map<string, string | boolean>,
  positionals: string[],
  adapters: HostnameStatusAdapters = {}
) {
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
  const dnsProviderHint = adapters.dnsProviderHint
    ? Promise.resolve(adapters.dnsProviderHint(customerHostname))
    : lookupDnsProviderHintForCli(customerHostname);
  const output =
    waitSeconds > 0
      ? await waitForCustomerHostname(
          relayUrl,
          endpointId,
          customerHostname,
          waitSeconds,
          numberFlag(flags, "poll-seconds", "PROOF_CUSTOMER_HOSTNAME_POLL_SECONDS", 10),
          adapters.fetchImpl
        )
      : await getCustomerHostnameStatus(relayUrl, endpointId, customerHostname, adapters.fetchImpl);
  const readiness =
    output.status === "dns_validated" && !boolFlag(flags, "skip-readiness-checks")
      ? await (adapters.readinessChecks ?? customerHostnameReadinessChecks)({
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
    const configuredAddress = stringFlag(flags, "polkadot-address") ?? nativePaymentAddressFromEnv();
    const seed = stringFlag(flags, "polkadot-seed") ?? nativePaymentSeedFromEnv();
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
      : await accountFromUri(requiredValue(seed, "POLKADOT_SEED or ACURAST_MAINNET_SEED"), ss58Format);

    if (configuredAddress && !samePolkadotAddress(configuredAddress, account.address)) {
      throw new Error(`Configured native payment seed resolves to ${account.address}, not configured payment address ${configuredAddress}`);
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
    optionalEnv("ACURAST_MAINNET_SEED") ||
    optionalEnv("ACURAST_SEED") ||
    stringFlag(flags, "polkadot-address") ||
    optionalEnv("POLKADOT_ADDRESS") ||
    optionalEnv("ACURAST_MAINNET_ADDRESS") ||
    optionalEnv("ACURAST_ADDRESS") ||
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

function printOrWriteDeployReportFailure(
  flags: Map<string, string | boolean>,
  output: Record<string, any>,
  report: Record<string, any>,
  reportPath: string,
  action: "launch-demo" | "deploy"
): void {
  if (boolFlag(flags, "json")) {
    writeOutput(flags, output, () => undefined);
    return;
  }
  printDeployReportFailure(report, reportPath, action);
}

function printDeployReportFailure(report: Record<string, any>, reportPath: string, action: "launch-demo" | "deploy"): void {
  const failure = deployReportFailureFields(report);
  const summary = deployFailureSummary(`${failure.stage ?? ""}\n${failure.message ?? ""}`.toLowerCase());
  console.error("");
  console.error(sectionTitle(action === "launch-demo" ? "Demo did not complete" : "Deploy did not complete", process.stderr));
  for (const line of formatRows([
    { label: "Last stage", value: summary.stage },
    { label: "Impact", value: summary.impact },
    { label: "Error", value: failure.message ? firstLine(failure.message) : "report ok=false" },
    { label: "Report", value: reportPath }
  ])) {
    console.error(line);
  }
}

function throwHandledDeployReportFailure(report: Record<string, any>, reportPath: string, action: "launch-demo" | "deploy"): never {
  const failure = deployReportFailureFields(report);
  const label = action === "launch-demo" ? "Demo" : "Deploy";
  const stage = failure.stage ? ` at ${failure.stage}` : "";
  const detail = failure.message ? `: ${firstLine(failure.message)}` : "";
  const error = new Error(`${label} did not complete${stage}${detail}. Report: ${reportPath}`);
  markErrorOutputHandled(error);
  throw error;
}

function deployReportFailureFields(report: Record<string, any>): { stage?: string; message?: string } {
  const failure = report.failure && typeof report.failure === "object" ? report.failure as Record<string, unknown> : undefined;
  return {
    stage: stringRecordField(failure, "stage") ?? stringRecordField(report, "stage"),
    message: stringRecordField(failure, "message") ?? stringRecordField(report, "message") ?? stringRecordField(report, "error")
  };
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
  const hubLease = output.hub.expiresAtIso ?? output.hub.expiresAt ?? (output.hub.registered ? "pending activation" : "unknown");
  console.log(`Hub: ${output.hub.ok ? "registered" : "not ready"}; expires ${hubLease}`);
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
    workflowId: stringRecordField(report, "workflowId"),
    workflow: report.workflow && typeof report.workflow === "object" ? report.workflow : undefined,
    workflowEvents: Array.isArray(report.workflowEvents) ? report.workflowEvents : undefined,
    requiredAction: report.requiredAction && typeof report.requiredAction === "object" ? report.requiredAction : undefined,
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
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, any>> {
  const url = new URL(`/v1/endpoints/${encodeURIComponent(endpointId)}/customer-hostnames`, relayUrl);
  const response = await fetchImpl(url, {
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
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, any>> {
  const url = new URL(
    `/v1/endpoints/${encodeURIComponent(endpointId)}/customer-hostnames/${encodeURIComponent(customerHostname)}`,
    relayUrl
  );
  const response = await fetchImpl(url, {
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
  customerHostname: string,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, any>> {
  const url = new URL(
    `/v1/endpoints/${encodeURIComponent(endpointId)}/customer-hostnames/${encodeURIComponent(customerHostname)}`,
    relayUrl
  );
  const response = await fetchImpl(url);
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
  pollSeconds: number,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, any>> {
  const deadline = Date.now() + waitSeconds * 1000;
  let latest: Record<string, any> | undefined;
  while (Date.now() <= deadline) {
    latest = await getCustomerHostnameStatus(relayUrl, endpointId, customerHostname, fetchImpl);
    if (latest.status === "dns_validated") {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, pollSeconds) * 1000));
  }
  return latest ?? (await getCustomerHostnameStatus(relayUrl, endpointId, customerHostname, fetchImpl));
}

async function customerHostnameReadinessChecks(input: HostnameStatusReadinessInput): Promise<Record<string, any>> {
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
  const hubExpiresAt = positiveUnixSecondsField(input.session, "expiresAt");
  const routeExpiresAt = positiveUnixSecondsField(input.route, "expiresAt");
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

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
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

function positiveUnixSecondsField(record: unknown, name: string): number | undefined {
  const parsed = unixSecondsField(record, name);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  if (lower.includes("certificate_hostname_lock_unavailable") || lower.includes("certificate_lock")) {
    return {
      stage: "Issuing the job certificate",
      impact: "The job registered, but another HA member was already issuing a certificate for the shared hostname."
    };
  }
  if (lower.includes("timed out waiting for public route") || lower.includes("public https route") || lower.includes("public route")) {
    return {
      stage: "Verifying the public HTTPS route",
      impact: "The route was created, but the public gateway did not become reachable before the route timeout."
    };
  }
  if (lower.includes("route activation") || lower.includes("route reconciled") || lower.includes("activated route") || lower.includes("runtime_https_not_ready")) {
    return {
      stage: "Activating the public route",
      impact: "The job registered, but Switchboard did not finish HTTPS route activation before the timeout."
    };
  }
  if (lower.includes("canonical dns") || lower.includes("dns materialization") || lower.includes("dns_not_propagated")) {
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

function jsonSafeOutput<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)) as T;
}

function jsonSafeWorkflowValue(value: unknown): unknown {
  return value === undefined ? undefined : jsonSafeOutput(value);
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
  options: {
    domain: string;
    seed: string;
    ss58Format: number;
    retries?: number;
    retryDelayMs?: number;
    timeoutMs?: number;
  }
): Promise<unknown> {
  const signature = await signReportPayload(options.seed, options.domain, payload, {
    scheme: "substrate-sr25519",
    ss58Format: options.ss58Format
  });
  const body = JSON.stringify({
    ...payload,
    signature
  });
  const retries = options.retries ?? 0;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000)
      });
      const responseBody = await response.text();
      if (response.ok) {
        return JSON.parse(responseBody);
      }
      const error = new Error(`${url} failed: ${response.status} ${responseBody.slice(0, 1000)}`);
      if (!isRetryablePostSignedJsonStatus(response.status) || attempt >= retries) {
        throw error;
      }
      lastError = error;
    } catch (error) {
      if (!isRetryablePostSignedJsonError(error) || attempt >= retries) {
        throw error;
      }
      lastError = error;
    }
    await delay(retryDelayMs);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryablePostSignedJsonStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function isRetryablePostSignedJsonError(error: unknown): boolean {
  void error;
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
function withDiscoveryDefaults(
  flags: Map<string, string | boolean>,
  env: NodeJS.ProcessEnv = process.env
): Map<string, string | boolean> {
  const next = new Map(flags);
  if (!next.has("manifest-url")) {
    next.set("manifest-url", optionalEnvFrom(env, "PROOF_NETWORK_MANIFEST_URL") ?? PROOF_NETWORK_MANIFEST_URL);
  }
  if (!next.has("manifest-signer") && !boolFlag(next, "allow-unpinned-signer")) {
    next.set("manifest-signer", optionalEnvFrom(env, "PROOF_NETWORK_MANIFEST_SIGNER") ?? PROOF_NETWORK_MANIFEST_SIGNER);
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
  const controlApiUrls = resolveControlApiEndpoints(discovery);
  const controlApiUrl = controlApiUrls[0];
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
    controlApiUrls,
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

export async function resolveDeployRunner(
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
  return resolveAcurastExpressRunner("deploy-direct", "acurast:deploy-express:direct", args, env);
}

async function resolveAcurastUpdateEnvRunner(
  args: string[],
  env: Record<string, string | undefined>
): Promise<{ command: string; args: string[]; env: Record<string, string | undefined> }> {
  return resolveAcurastExpressRunner("update-env", "acurast:update-env-express", args, env);
}

async function resolveAcurastExpressRunner(
  commandName: "deploy-direct" | "update-env",
  repoScriptName: string,
  args: string[],
  env: Record<string, string | undefined>
): Promise<{ command: string; args: string[]; env: Record<string, string | undefined> }> {
  if (await repoScriptAvailable(repoScriptName)) {
    return {
      command: "pnpm",
      args: [repoScriptName, "--", ...args],
      env: {
        ...env,
        SWITCHBOARD_SKIP_BUNDLE_BUILD: "true"
      }
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
    args: [acurastExpress, commandName, ...args],
    env: {
      ...env,
      SWITCHBOARD_WORK_DIR: process.cwd(),
      SWITCHBOARD_INTERNAL_BIN_DIR: internalDir,
      SWITCHBOARD_PACKAGED_ASSETS_DIR: assetsDir,
      SWITCHBOARD_SKIP_BUNDLE_BUILD: "true"
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
    command === "gateway-setup" ||
    command === "gateway-discover" ||
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
    command === "gateway-setup" ||
    command === "gateway-discover" ||
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
      output.set(runtimeDefaultFlagName(name), true);
    }
  };
  const setBool = (name: string, value: boolean | undefined) => {
    if (!output.has(name) && value === true) {
      output.set(name, true);
      output.set(runtimeDefaultFlagName(name), true);
    }
  };

  const project = runtime.projectConfig;
  const deploy = project?.deploy;
  const useProjectDeployDefaults = command === "deploy" || command === "deployment-status";
  setString("context", runtime.contextName);
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
  setString("runtime", project?.acurast?.runtime);
  setString("script-image-url", project?.acurast?.scriptImage?.url);
  setString("script-image-sha256", project?.acurast?.scriptImage?.sha256);
  setString("script-files", project?.acurast?.scriptFiles?.join(","));
  setString("stage-dir", project?.acurast?.stageDir ? resolveProjectPath(runtime.projectRoot, project.acurast.stageDir) : undefined);
  if (useProjectDeployDefaults) {
    setString("entrypoint", project?.acurast?.entrypoint ? resolveProjectPath(runtime.projectRoot, project.acurast.entrypoint) : undefined);
    setString("ssh-public-key-file", project?.ssh?.authorizedKeysFile ? resolveProjectPath(runtime.projectRoot, project.ssh.authorizedKeysFile) : undefined);
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
  setString("polkadot-seed", nativePaymentSeedFromRuntime(runtime));
  setString("polkadot-address", nativePaymentAddressFromRuntime(runtime));
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

function runtimeDefaultFlagName(name: string): string {
  return `${RUNTIME_DEFAULT_FLAG_PREFIX}${name}`;
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

export async function readContextStore(filePath: string = contextStorePath()): Promise<SwitchboardContextStore> {
  if (await fileExists(filePath)) {
    const parsed = await readJsonFile<SwitchboardContextStore>(filePath);
    return {
      current: parsed.current,
      contexts: parsed.contexts ?? {}
    };
  }
  return { contexts: {} };
}

export async function writeContextStore(store: SwitchboardContextStore, filePath: string = contextStorePath()): Promise<void> {
  await writeJsonFile(filePath, {
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

function acurastIpfsUploadCheckName(envName: AcurastIpfsUploadEnvName): string {
  return envName === "ACURAST_IPFS_URL" ? "Acurast IPFS endpoint" : "Acurast IPFS API key";
}

function acurastIpfsUploadEnvDetail(runtime: CliRuntime, envName: AcurastIpfsUploadEnvName): string {
  if (optionalEnv(envName)) {
    return `${envName} configured`;
  }
  const hint = `${envName} in ${builderContextSecretHint(runtime)} or shell environment`;
  if (envName === "ACURAST_IPFS_URL") {
    return `default ${DEFAULT_ACURAST_IPFS_URL}; override with ${hint}`;
  }
  return DEFAULT_ACURAST_IPFS_API_KEY.length > 0
    ? `default configured; override with ${hint}`
    : `default empty API key for Acurast IPFS proxy; override with ${hint}`;
}

function builderContextSecretHint(runtime: Pick<CliRuntime, "contextName">): string {
  const explicit = optionalEnv(SWITCHBOARD_CONTEXT_SECRET_FILE_ENV);
  if (explicit) {
    return explicit;
  }
  if (runtime.contextName) {
    return switchboardHomePaths({ contextName: runtime.contextName }).builderSecretFile;
  }
  return `${SWITCHBOARD_CONTEXT_SECRET_FILE_ENV} or ~/.switchboard/secrets/<context>.env`;
}

function nativePaymentSeedDetail(flags: Map<string, string | boolean>, runtime: CliRuntime): string {
  if (stringFlag(flags, "polkadot-seed")) {
    return "--polkadot-seed";
  }
  if (runtime.context?.polkadotSeedEnv) {
    return `${runtime.context.polkadotSeedEnv} via context ${runtime.contextName}`;
  }
  if (optionalEnv("POLKADOT_SEED")) {
    return "POLKADOT_SEED";
  }
  if (runtime.context?.acurastSeedEnv && contextEnv(runtime.context.acurastSeedEnv)) {
    return `${runtime.context.acurastSeedEnv} via Acurast deploy context`;
  }
  if (optionalEnv("ACURAST_MAINNET_SEED")) {
    return "ACURAST_MAINNET_SEED as payment fallback";
  }
  if (optionalEnv("ACURAST_SEED")) {
    return "ACURAST_SEED as payment fallback";
  }
  return "POLKADOT_SEED or ACURAST_MAINNET_SEED";
}

function nativePaymentAddressDetail(flags: Map<string, string | boolean>, runtime: CliRuntime): string {
  if (stringFlag(flags, "polkadot-address")) {
    return "--polkadot-address";
  }
  if (runtime.context?.polkadotAddressEnv) {
    return `${runtime.context.polkadotAddressEnv} via context ${runtime.contextName}`;
  }
  if (runtime.context?.polkadotAddress) {
    return `${runtime.context.polkadotAddress} via context ${runtime.contextName}`;
  }
  if (optionalEnv("POLKADOT_ADDRESS")) {
    return "POLKADOT_ADDRESS";
  }
  if (runtime.context?.acurastAddressEnv && contextEnv(runtime.context.acurastAddressEnv)) {
    return `${runtime.context.acurastAddressEnv} via Acurast deploy context`;
  }
  if (optionalEnv("ACURAST_MAINNET_ADDRESS")) {
    return "ACURAST_MAINNET_ADDRESS as payment fallback";
  }
  if (optionalEnv("ACURAST_ADDRESS")) {
    return "ACURAST_ADDRESS as payment fallback";
  }
  return "POLKADOT_ADDRESS or ACURAST_MAINNET_ADDRESS";
}

function acurastSeedFromRuntime(runtime: Pick<CliRuntime, "context">): string | undefined {
  return contextEnv(runtime.context?.acurastSeedEnv) ?? optionalEnv("ACURAST_MAINNET_SEED") ?? optionalEnv("ACURAST_SEED");
}

function acurastAddressFromRuntime(runtime: Pick<CliRuntime, "context">): string | undefined {
  return contextEnv(runtime.context?.acurastAddressEnv) ?? optionalEnv("ACURAST_MAINNET_ADDRESS") ?? optionalEnv("ACURAST_ADDRESS");
}

export function nativePaymentSeedFromRuntime(runtime: Pick<CliRuntime, "context">): string | undefined {
  return contextEnv(runtime.context?.polkadotSeedEnv) ?? nativePaymentSeedFromEnv() ?? acurastSeedFromRuntime(runtime);
}

export function nativePaymentAddressFromRuntime(runtime: Pick<CliRuntime, "context">): string | undefined {
  return contextEnv(runtime.context?.polkadotAddressEnv) ?? runtime.context?.polkadotAddress ?? nativePaymentAddressFromEnv() ?? acurastAddressFromRuntime(runtime);
}

function nativePaymentSeedFromEnv(): string | undefined {
  return optionalEnv("POLKADOT_SEED") ?? optionalEnv("ACURAST_MAINNET_SEED") ?? optionalEnv("ACURAST_SEED");
}

function nativePaymentAddressFromEnv(): string | undefined {
  return optionalEnv("POLKADOT_ADDRESS") ?? optionalEnv("ACURAST_MAINNET_ADDRESS") ?? optionalEnv("ACURAST_ADDRESS");
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
    POLKADOT_SEED: nativePaymentSeedFromRuntime(runtime),
    POLKADOT_ADDRESS: nativePaymentAddressFromRuntime(runtime),
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
  if (positionals.length === 2 && positionals[0] === "deploy" && positionals[1] === "status") {
    return "deploy-status";
  }
  if (positionals.length === 2 && positionals[0] === "deploy" && positionals[1] === "doctor") {
    return "deploy-doctor";
  }
  if (positionals.length === 2 && positionals[0] === "deploy" && positionals[1] === "resume") {
    return "deploy-resume";
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
  if (positionals.length === 2 && positionals[0] === "gateway" && positionals[1] === "discover") {
    return "gateway-discover";
  }
  if (positionals.length === 2 && positionals[0] === "gateway" && positionals[1] === "status") {
    return "gateway-status";
  }
  if (positionals.length === 2 && positionals[0] === "gateway" && positionals[1] === "upgrade") {
    return "gateway-upgrade";
  }
  if (positionals.length === 2 && positionals[0] === "gateway" && positionals[1] === "setup") {
    return "gateway-setup";
  }
  if (positionals.length === 2 && positionals[0] === "validator" && positionals[1] === "launch") {
    return "validator-launch";
  }
  if (positionals.length === 2 && positionals[0] === "validator" && positionals[1] === "script") {
    return "validator-script";
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

function optionalEnvFrom(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value && value.length > 0 ? value : undefined;
}

function splitCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
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

function requiredValue(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Missing ${label}`);
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

function parsePositiveIntegerString(label: string, value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
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
          script, and register the job. Auto-selects exact fresh manager
          processor capacity unless --processor/--processors is provided.
          --manager-id <id> is required when ACURAST_MANAGER_ID is not set.
  validator script
          Look up the approved validator IPFS script pin from the network
          manifest or a validator script manifest URL/file.

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
  context list | context current | context use <name> | context set <name>
          Manage named developer/payment contexts.
  preflight
          Check manifest, RPCs, credentials, payment, and deploy readiness.
  launch-demo
          Launch the bundled demo on current live operator capacity.
  deploy
          Deploy a project workload from switchboard.json or --entrypoint.
  deploy status
          Read local deploy workflow/report state and print the next recovery action.
  deploy doctor
          Diagnose local workflow, relay, route-state, DNS/TLS, and SSH banner state.
  deploy resume
          Resume a single-replica deploy workflow from local private state.
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
  gateway setup
          Prepare host Docker/Compose config and launch a gateway stack.
  gateway discover
          Check manager-scoped gateway readiness and suggest env config.
  gateway status
          Show local compose, gateway-agent, and relay capability registration state.
  gateway upgrade
          Pull current gateway images and recreate the Docker Compose stack.
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
  --polkadot-seed <uri>            Native account seed for USDC quote funding; defaults to the Acurast seed when unset
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
  --operator-id <bytes32>          Optional capacity pin; normal deploys auto-select
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
  switchboard init --project <name> --context <name>
  switchboard init --template ssh --distro ubuntu --project-dir ./switchboard-ssh-demo
  switchboard project show
  Directory-local config is stored in switchboard.json. Deployment state,
  latest report pointers, and local caches are stored in .switchboard/.
  The SSH template generates an inspectable Script/Cargo project whose
  bootstrap uses the Cargo bridge signer for registration and job-ACME.

Deploy doctor:
  switchboard deploy doctor --run-dir .switchboard/runs/<id>
  switchboard deploy doctor --intent-id di_... --relay-url https://control.switchboard.proof.computer --intent-token-env SWITCHBOARD_INTENT_TOKEN
  switchboard deploy doctor --report report.json --probe
  deploy doctor is read-only. --probe performs only public TLS/SNI and SSH
  banner checks. It never spends, deploys, mutates DNS/routes, or records
  settlement.

Contexts:
  switchboard context add mainnet
  switchboard context set mainnet --use --acurast-seed-env ACURAST_MAINNET_SEED --acurast-address-env ACURAST_MAINNET_ADDRESS
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
  --cloudflare-api-token-env <env> PROOF/internal DNS provider token env name

${advanced ? `PROOF DNS context commands:
  switchboard context dns set cloudflare --token-env <NAME>
  switchboard context dns clear [provider]
  Support/admin commands for PROOF-managed DNS authority. Normal app deploys
  and customer-domain setup do not require DNS provider tokens.

Ops profiles:
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

Gateway setup:
  switchboard gateway setup --manager-address <address> --manager-id <id>
  --management-address <address>   Alias for --manager-address
  --public-address <ip-or-host>    Default fetched with curl --ipv4 https://ifconfig.me/ip
  --processor-file <path>          Read processor include list from JSON, CSV, or newline text
  --payout-address <0xaddress>     Operator payout recipient to advertise
  --generate-report-seed           Generate and store a new local sr25519 report seed
  --prepare-admission              Write redacted operator-admission-request.json for PROOF admission
  --admission-file <path>          Apply a PROOF-issued admission bundle
  --env-file <path>                Default .operator-host/operator.env
  --image-registry <registry/ns>   Default ghcr.io/proof-computer/switchboard-gateway
  --image-tag <tag>                Default latest
  --skip-install                   Do not install Docker/Compose if missing
  --skip-compose                   Write config but do not launch compose
  --gateway-agent-port <port>      Gateway-agent API port, default 18080
  --upstream-admission-url <url>   URL relays should use for gateway upstream admission
  --route-state-url <url>          Default control-plane route-state polling URL when OPERATOR_ID is known
  --route-state-token-env <env>    Env var containing route-state bearer token
  --route-intent-token-env <env>   Env var containing gateway route-intent bearer token
  --local-build                    Build local repo images instead of pulling prebuilt images
  --local-only                     Allow lab setup without relay admission/reporting material
  --dry-run                        Print checks and planned actions only

Gateway discover:
  switchboard gateway discover --manager-id <id> --public-address <ip-or-host>
  --gateway-agent-url <url>        Default http://127.0.0.1:18080
  --available                      Check Acurast schedule conflicts; enabled by default
  --skip-availability              Skip existing-job/schedule conflict checks
  --limit <n>                      Test next n processors not checked recently
  --smoke-hostname <hostname>      Temporarily route and TLS-probe this SNI name
  --state-file <path>              Operator-local discovery state file
  --ready-ttl-ms <ms>              Recent-ready TTL for cached readiness
  --recent-check-ttl-ms <ms>       Recent-check TTL for --limit
  --no-state                       Do not read or write discovery state
  --write-env <path>               Write suggested gateway env values

Gateway status and upgrade:
  switchboard gateway status
  switchboard gateway upgrade --yes
  --project-dir <path>             Operator project directory
  --compose-file <path[,path...]>  Compose file(s), default docker-compose.yaml
  --env-file <path>                Env file, default .operator-host/operator.env
  --gateway-agent-url <url>        Status check URL, default http://127.0.0.1:18080
  --capability-url <url>           Relay capability lookup URL
  --capability-token-env <env>     Env var containing relay capability read/write token
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
  --demo-package <spec>            Demo package spec; use file:/path/to/switchboard-express-demo for local clones
  Ingress estimate                 Previewed before Acurast deploy/funding
  --quote-preview-timeout-ms <ms>  Default 15000; retried on transient relay failures
  Acurast start delay              Fixed 3 minutes
  --max-cost-per-execution <n>     Default ${DEFAULT_LAUNCH_DEMO_MAX_COST_PER_EXECUTION}

Deploy defaults:
  --yes                            Required; spends ACU and the configured Hub payment asset
  --dry-run                        Print the deploy runner command without side effects
  --entrypoint <path>              Required unless switchboard.json has acurast.entrypoint
  --runtime <node|script>          Default node; script maps to Acurast Cargo Shell
  --script-image-url <url>         Required for script runtime unless switchboard.json sets acurast.scriptImage.url
  --script-image-sha256 <sha256>   Required for script runtime unless switchboard.json sets acurast.scriptImage.sha256
  --ssh-public-key-file <path>     Authorized SSH public keys for Script SSH templates
  Canonical hostname               Relay-allocated under ingress.<tld>
  --relay-url <url>                Default ${DEFAULT_CONTROL_PLANE_URL}
  Operator/manager/processor       Auto-selected from live operator capacity unless pinned
  --operator-id <bytes32>          Pin to one operator ID
  --gateway-id <id>                Pin launch-demo/deploy capacity to one gateway ID
  --processor <account>            Pin to one Acurast processor
  --duration-minutes <minutes>     Default ${DEFAULT_DEPLOY_DURATION_MINUTES}; derives lease seconds and job runtime
  --lease-minutes <minutes>        Alias for --duration-minutes
  --schedule-buffer-minutes <n>    Extra runtime beyond lease, default ${DEFAULT_DEPLOY_SCHEDULE_BUFFER_MINUTES}
  --quote                          Default; fund through a signed deployment-intent quote
  --payment-mode <mode>            quote only
  --report <path>                  Deployment report JSON to diagnose
  --run-dir <path>                 Deploy run directory for workflow snapshots
  --snapshot <path>                Deploy workflow snapshot for status/resume
  --allow-late-funding             Resume funding after an expired Acurast start/end window
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
  runSwitchboardCli().catch((error: unknown) => {
    if (!errorOutputHandled(error)) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[switchboard] ${message}`);
    }
    process.exitCode = 1;
  });
}
