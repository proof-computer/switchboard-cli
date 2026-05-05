import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { decodeAddress } from "@polkadot/util-crypto";

import { createAcurastApi, rpcForAcurastNetwork } from "../../../src/acurast-manager.js";
import {
  FORBIDDEN_ACURAST_ENV_NAMES,
  isForbiddenAcurastEnvName,
  type RelayDeploymentSpec
} from "../../../src/relay-deployment-spec.js";
import { parseSignedServiceCatalog } from "../../../src/service-catalog.js";
import {
  describeAcurastProcessorStatus,
  queryAcurastProcessorStatus
} from "./acurast-processor-status.js";
import { readLatestAcurastDeployState } from "./acurast-deploy-state.js";
import {
  checkPeerReachability,
  pollRelayReadiness,
  type CheckPeerReachabilityResult,
  type PollRelayReadinessResult
} from "./readiness.js";
import {
  assertSecretIntentAllowed,
  buildAcurastSecretIntentPlan,
  formatSecretIntentPlan
} from "./secret-intent.js";
import { spawnAcurastScript } from "./acurast-script-runner.js";

const HEX32_REGEX = /^0x[0-9a-fA-F]{64}$/;

export interface AcurastRegistrationOverrides {
  /** 0x-prefixed 32-byte hex of the funded Hub session. Random per-deploy if absent. */
  sessionId?: string;
  /** 0x-prefixed 32-byte hex job identifier. Random per-deploy if absent. */
  jobId?: string;
  /** 0x-prefixed 32-byte hex operator account id. Falls back to env PROOF_OPERATOR_ID. */
  operatorId?: string;
  /** Optional nonce override. Random 32-byte hex if absent. */
  nonce?: string;
  /** Optional deadline override (unix-seconds string). Defaults to now + executionMs + buffer. */
  deadline?: string;
}

export interface AcurastDeployContext {
  /** Public, non-secret build-time config baked into the IPFS bundle as
   * __SWITCHBOARD_BUILD_CONFIG__. Must never contain secrets. */
  buildConfig: Record<string, string>;
  /** Runtime env passed through Acurast's encrypted env channel. May contain
   * secrets resolved from the spec's *Env references. */
  runtimeEnv: Record<string, string>;
  /** Env consumed by scripts/acurast/express-harness.ts itself (ACURAST_*,
   * deployer seed envs, etc.). */
  acurastEnv: Record<string, string>;
  /** ACURAST_INCLUDE_ENV value (comma-separated list of runtimeEnv keys to
   * pass through to the deployment). */
  includeEnv: string[];
  /** Diagnostics: which spec.secrets / spec.acurast.deployerSeedEnv references
   * were resolved successfully (true) vs missing in process.env (false). */
  resolvedSecrets: Record<string, boolean>;
}

export interface AcurastLogSinkOverride {
  /** URL the job posts encrypted log events to. Goes into `SWITCHBOARD_LOG_URL` (build config — public). */
  writeUrl: string;
  /** Bearer the job uses on each write. Goes into `SWITCHBOARD_LOG_TOKEN` (encrypted runtime env). */
  writeToken: string;
  /** Client-side AES-256-GCM key. Goes into `SWITCHBOARD_LOG_ENCRYPTION_KEY` (encrypted runtime env). */
  encryptionKey: string;
}

export interface AcurastDeploySources {
  env: NodeJS.ProcessEnv;
  /** Working directory used to resolve local public config files. */
  cwd?: string;
  /** Per-deploy registration overrides (sessionId/jobId/operatorId/nonce/deadline). */
  registration?: AcurastRegistrationOverrides;
  /**
   * Per-deploy ephemeral job-signer private key (0x-prefixed 32-byte hex).
   * Emitted into the relay's encrypted runtime env as `JOB_SIGNER_PRIVATE_KEY`
   * so the relay job's `switchboardJobSigner` can take the `private-key` mode
   * branch when the Acurast TEE-derived secp256k1 signer is unavailable.
   * The matching address must equal the `expectedJobSigner` the Hub session
   * was funded against — generate once at deploy time, fund with that address,
   * pass the same key here.
   */
  jobSignerPrivateKey?: string;
  /**
   * Per-deploy log sink (writeUrl/writeToken/encryptionKey). When present,
   * emits SWITCHBOARD_LOG_URL into the public build config and
   * SWITCHBOARD_LOG_TOKEN + SWITCHBOARD_LOG_ENCRYPTION_KEY into the
   * encrypted runtime env.
   */
  logSink?: AcurastLogSinkOverride;
  /** Replace the random-bytes generator. Used by tests. */
  randomBytes?: (size: number) => Buffer;
  /** Replace the wall clock. Used by tests. */
  now?: () => number;
}

const DEFAULT_SOURCES: AcurastDeploySources = { env: process.env };
const DEFAULT_SIGNED_SERVICE_CATALOGS_FILE = ".control-plane/service-catalogs/service-catalogs.signed.json";

function defaultRandomHex32(rng: (size: number) => Buffer = randomBytes): string {
  return `0x${rng(32).toString("hex")}`;
}

/**
 * Decimal uint256 string. The relay's `registerIngress` endpoint validates
 * `nonce` and `deadline` against `/^[0-9]+$/` (hex won't match). 8 random
 * bytes is plenty of entropy for a per-deploy nonce; convert to BigInt then
 * to base-10.
 */
function defaultRandomUintString(rng: (size: number) => Buffer = randomBytes): string {
  return BigInt(`0x${rng(8).toString("hex")}`).toString(10);
}

function ss58ToBytes32Hex(address: string): string {
  return `0x${Buffer.from(decodeAddress(address)).toString("hex")}`.toLowerCase();
}

export function prepareAcurastDeployContext(
  spec: RelayDeploymentSpec,
  sources: AcurastDeploySources = DEFAULT_SOURCES
): AcurastDeployContext {
  if (spec.target !== "acurast" || !spec.acurast) {
    throw new Error("prepareAcurastDeployContext requires spec.target=acurast");
  }
  const env = sources.env;

  const resolveEnv = (name: string, label: string): string => {
    const value = env[name];
    if (!value || value.length === 0) {
      throw new Error(`${label} env ${name} is not set in the calling shell`);
    }
    return value;
  };
  const resolveOptionalEnv = (name: string | undefined): string | undefined =>
    name && env[name] && env[name]!.length > 0 ? env[name] : undefined;

  const resolvedSecrets: Record<string, boolean> = {};
  const recordSecret = (name: string | undefined): void => {
    if (name) resolvedSecrets[name] = Boolean(env[name] && env[name]!.length > 0);
  };

  const relayerPrivateKey = resolveEnv(
    spec.secrets.relayerPrivateKeyEnv,
    `secrets.relayerPrivateKeyEnv (${spec.secrets.relayerPrivateKeyEnv})`
  );
  recordSecret(spec.secrets.relayerPrivateKeyEnv);

  const validationReadToken = resolveOptionalEnv(spec.secrets.validationReadTokenEnv);
  recordSecret(spec.secrets.validationReadTokenEnv);
  const controlPlaneToken = resolveOptionalEnv(spec.secrets.controlPlaneTokenEnv);
  recordSecret(spec.secrets.controlPlaneTokenEnv);
  const logCreateToken = resolveOptionalEnv(spec.secrets.logCreateTokenEnv);
  recordSecret(spec.secrets.logCreateTokenEnv);
  const logEncryptionKey = resolveOptionalEnv(spec.secrets.logEncryptionKeyEnv);
  recordSecret(spec.secrets.logEncryptionKeyEnv);

  if (spec.relay.enableControlPlane && !controlPlaneToken) {
    throw new Error(
      `relay.enableControlPlane=true but spec.secrets.controlPlaneTokenEnv is missing or unset in env`
    );
  }

  const peers = spec.peers.map((peer) => ({
    relayId: peer.relayId,
    apiBaseUrl: peer.apiBaseUrl,
    readToken: peer.readTokenEnv ? resolveOptionalEnv(peer.readTokenEnv) : undefined
  }));
  for (const peer of peers) {
    const declared = spec.peers.find((p) => p.relayId === peer.relayId);
    if (declared?.readTokenEnv) recordSecret(declared.readTokenEnv);
  }

  const peerBackfillEnabled = spec.relay.enablePeerBackfill && peers.length > 0;

  // Public, IPFS-bound build config. NEVER includes secret tokens or any
  // value resolved from spec.secrets or peer readTokenEnv.
  const buildConfig: Record<string, string> = {
    SWITCHBOARD_HOST: "0.0.0.0",
    PORT: "3000",
    SWITCHBOARD_AUTO_REGISTER: spec.relay.autoRegister ? "true" : "false",
    HUB_ETH_RPC_URL: resolveEnv("HUB_ETH_RPC_URL", "HUB_ETH_RPC_URL"),
    INGRESS_REGISTRY_ADDRESS: resolveEnv("INGRESS_REGISTRY_ADDRESS", "INGRESS_REGISTRY_ADDRESS"),
    CHAIN_ID: resolveEnv("CHAIN_ID", "CHAIN_ID"),
    PROOF_RELAY_ID: spec.relayId,
    PROOF_SETTLEMENT_RELAY_ID: spec.relay.settlementRelayId ?? spec.relayId,
    PROOF_AUTHORITY_LEASE_OWNER_ID: spec.relay.authorityLeaseOwnerId ?? spec.relayId,
    PROOF_QUOTES_ENABLED: spec.relay.quotesEnabled ? "true" : "false",
    PROOF_VALIDATION_REPORTS_ENABLED: spec.relay.enableValidationReports ? "true" : "false",
    PROOF_VALIDATION_REPORT_STORE_KIND: "sqlite",
    PROOF_RELAY_SQLITE_FILE: spec.relay.sqliteFile,
    PROOF_SQLITE_DRIVER: spec.relay.sqliteDriver,
    PROOF_RELAY_PEER_BACKFILL_ENABLED: peerBackfillEnabled ? "true" : "false",
    PROOF_RELAY_PEER_BACKFILL_AUTOSTART: peerBackfillEnabled ? "true" : "false",
    PROOF_CONTROL_PLANE_ENABLED: spec.relay.enableControlPlane ? "true" : "false",
    PROOF_RELAY_MONITORING_ENABLED: spec.relay.enableMonitoring ? "true" : "false",
    PROOF_RELAY_RATE_LIMITS_ENABLED: spec.relay.enableRateLimits ? "true" : "false",
    PROOF_RELAY_METRICS_PUBLIC: spec.relay.publicMetrics ? "true" : "false"
  };

  const recorderCoordinatorAddress = env.PROOF_RECORDER_COORDINATOR_ADDRESS;
  if (recorderCoordinatorAddress) {
    buildConfig.PROOF_RECORDER_COORDINATOR_ADDRESS = recorderCoordinatorAddress;
  }
  const allowedSigners = env.PROOF_VALIDATION_ALLOWED_SIGNERS;
  if (allowedSigners) {
    buildConfig.PROOF_VALIDATION_ALLOWED_SIGNERS = allowedSigners;
  }
  const serviceCatalogsJson = signedServiceCatalogsJson(env, sources.cwd ?? process.cwd());
  if (serviceCatalogsJson) {
    buildConfig.PROOF_SERVICE_CATALOGS_JSON = serviceCatalogsJson;
  }

  // Self-registration env. When the relay is configured to register
  // itself as a Switchboard customer (`relay.autoRegister=true`), emit the
  // inputs the job's `registerIngressWithRelay` / `requestCertificateWithRelay`
  // calls need. Without these, `maybeRegisterIngress` short-circuits with
  // `reason: "missing-env"`. See
  // docs/knowledge/raw-inputs/2026-05-03-acurast-relay-cutover-via-self-ingress.md.
  if (spec.relay.autoRegister) {
    if (!spec.relay.bootstrapRelayUrl) {
      // The schema enforces this for target=acurast, but guard defensively
      // in case a non-standard spec slipped through.
      throw new Error(
        "relay.autoRegister=true requires relay.bootstrapRelayUrl in the spec"
      );
    }
    const reg = sources.registration ?? {};
    const rng = sources.randomBytes ?? randomBytes;
    const now = sources.now ?? (() => Date.now());

    const endpointHostname = new URL(spec.apiBaseUrl).hostname;
    if (endpointHostname.length === 0) {
      throw new Error(`Could not derive endpoint hostname from spec.apiBaseUrl=${spec.apiBaseUrl}`);
    }

    const operatorIdRaw = reg.operatorId ?? env.PROOF_OPERATOR_ID ?? env.OPERATOR_ID;
    if (!operatorIdRaw || !HEX32_REGEX.test(operatorIdRaw)) {
      throw new Error(
        "relay.autoRegister=true requires --operator-id <0x..32-byte..> or PROOF_OPERATOR_ID env"
      );
    }

    const sessionId = reg.sessionId ?? defaultRandomHex32(rng);
    if (!HEX32_REGEX.test(sessionId)) {
      throw new Error(`--session-id must be 0x-prefixed 32-byte hex (got ${sessionId})`);
    }
    const jobId = reg.jobId ?? defaultRandomHex32(rng);
    if (!HEX32_REGEX.test(jobId)) {
      throw new Error(`--job-id must be 0x-prefixed 32-byte hex (got ${jobId})`);
    }
    const nonce = reg.nonce ?? defaultRandomUintString(rng);

    // Default deadline: execution end + a 10-minute buffer. Conservative —
    // the registration must remain valid for the relay job's full window
    // plus the time it takes to ACME-issue and re-arm TLS.
    const executionEndMs = now() + spec.acurast!.executionMs;
    const deadline = reg.deadline ?? String(Math.floor((executionEndMs + 10 * 60_000) / 1000));

    if (spec.acurast!.instantMatchProcessors.length === 0) {
      throw new Error(
        "relay.autoRegister=true requires acurast.instantMatchProcessors[0] (the assigned processor) so PROCESSOR_ID can be derived"
      );
    }
    const processorId = ss58ToBytes32Hex(spec.acurast!.instantMatchProcessors[0]);

    buildConfig.RELAY_URL = spec.relay.bootstrapRelayUrl;
    buildConfig.ENDPOINT_HOSTNAME = endpointHostname;
    buildConfig.OPERATOR_ID = operatorIdRaw.toLowerCase();
    buildConfig.PROCESSOR_ID = processorId;
    buildConfig.SESSION_ID = sessionId;
    buildConfig.JOB_ID = jobId;
    buildConfig.NONCE = nonce;
    buildConfig.DEADLINE = deadline;
    buildConfig.SWITCHBOARD_CERTIFICATE_MODE = spec.relay.certificateMode;
    if (spec.relay.certificateMode === "job-acme") {
      buildConfig.SWITCHBOARD_CERTIFICATE_HOSTNAMES = endpointHostname;
    }
  }

  // Defensive: refuse to ship a build config that references a forbidden name.
  for (const key of Object.keys(buildConfig)) {
    if (isForbiddenAcurastEnvName(key)) {
      throw new Error(`build config key ${key} is on the forbidden Acurast list`);
    }
  }

  // Runtime env (encrypted Acurast .env). Peer read tokens live here, not in
  // the IPFS-public build config.
  const runtimeEnv: Record<string, string> = {
    RELAYER_PRIVATE_KEY: relayerPrivateKey
  };
  if (validationReadToken) runtimeEnv.PROOF_VALIDATION_READ_TOKEN = validationReadToken;
  if (controlPlaneToken) runtimeEnv.PROOF_CONTROL_PLANE_TOKEN = controlPlaneToken;
  if (logCreateToken) runtimeEnv.PROOF_LOG_CREATE_TOKEN = logCreateToken;
  if (logEncryptionKey) runtimeEnv.SWITCHBOARD_LOG_ENCRYPTION_KEY = logEncryptionKey;
  if (spec.relay.autoRegister && sources.jobSignerPrivateKey) {
    runtimeEnv.JOB_SIGNER_PRIVATE_KEY = sources.jobSignerPrivateKey;
  }
  if (sources.logSink) {
    // SWITCHBOARD_LOG_URL is non-secret — it's just a URL on the
    // bootstrap relay. Goes into the public IPFS-bound build config.
    buildConfig.SWITCHBOARD_LOG_URL = sources.logSink.writeUrl;
    buildConfig.SWITCHBOARD_LOG_CONTEXT = `relay-${spec.relayId}`;
    // The write bearer and AES-256-GCM key MUST stay in encrypted runtime
    // env — they authenticate writes and encrypt log payloads.
    runtimeEnv.SWITCHBOARD_LOG_TOKEN = sources.logSink.writeToken;
    runtimeEnv.SWITCHBOARD_LOG_ENCRYPTION_KEY = sources.logSink.encryptionKey;
  }
  if (peerBackfillEnabled) {
    runtimeEnv.PROOF_RELAY_PEERS_JSON = JSON.stringify(
      peers.map((peer) => ({
        relayId: peer.relayId,
        apiBaseUrl: peer.apiBaseUrl,
        ...(peer.readToken ? { readToken: peer.readToken } : {})
      }))
    );
  }

  // Whitelisted env names that ride along to the Acurast job.
  const includeEnv: string[] = [...Object.keys(runtimeEnv), ...spec.acurast.includeEnv];
  const includeEnvUnique = Array.from(new Set(includeEnv));
  for (const name of includeEnvUnique) {
    if (isForbiddenAcurastEnvName(name)) {
      throw new Error(`Refusing to include forbidden Acurast env name in deployment: ${name}`);
    }
  }

  // Env consumed by the express-harness wrapper itself.
  const acurastEnv: Record<string, string> = {
    ACURAST_NETWORK: spec.acurast.network,
    ACURAST_PROJECT_NAME: spec.acurast.projectName,
    ACURAST_STAGE_DIR: spec.acurast.stageDir,
    ACURAST_ENTRYPOINT: spec.acurast.entrypoint,
    ACURAST_DEPLOYMENT_PROFILE: spec.acurast.deploymentProfile,
    ACURAST_EXECUTION_MS: String(spec.acurast.executionMs),
    ACURAST_MAX_COST_PER_EXECUTION: spec.acurast.maxCostPerExecution,
    ACURAST_REPLICAS: String(spec.acurast.replicas),
    ACURAST_COMPACT_ENV: spec.acurast.compactEnv ? "true" : "false",
    ACURAST_INCLUDE_ENV: includeEnvUnique.join(",")
  };
  if (spec.acurast.instantMatchProcessors.length > 0) {
    acurastEnv.ACURAST_INSTANT_MATCH_PROCESSORS = spec.acurast.instantMatchProcessors.join(",");
  }
  const seedValue = resolveEnv(
    spec.acurast.deployerSeedEnv,
    `acurast.deployerSeedEnv (${spec.acurast.deployerSeedEnv})`
  );
  recordSecret(spec.acurast.deployerSeedEnv);
  acurastEnv[seedEnvNameFor(spec.acurast.network)] = seedValue;
  if (spec.acurast.deployerAddress) {
    acurastEnv[addressEnvNameFor(spec.acurast.network)] = spec.acurast.deployerAddress;
  }

  return { buildConfig, runtimeEnv, acurastEnv, includeEnv: includeEnvUnique, resolvedSecrets };
}

type AcurastNetwork = "mainnet" | "canary";

function seedEnvNameFor(network: AcurastNetwork): string {
  return network === "canary" ? "ACURAST_CANARY_SEED" : "ACURAST_MAINNET_SEED";
}

function addressEnvNameFor(network: AcurastNetwork): string {
  return network === "canary" ? "ACURAST_CANARY_ADDRESS" : "ACURAST_MAINNET_ADDRESS";
}

export interface RunAcurastDeployOptions {
  yes?: boolean;
  cwd?: string;
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  /** Replace the Acurast helper spawner. Used by tests. */
  spawnPnpm?: (args: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<number>;
  /** Replace the node-script spawner used for the secret scanner. Used by tests. */
  spawnNode?: (args: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<number>;
  /** Override env / sources, used by tests. */
  sources?: AcurastDeploySources;
  /** Override the fetch implementation used for readiness/peer probes. Used by tests. */
  fetchImpl?: typeof fetch;
  /** Skip the post-deploy readiness poll (operator opt-out). */
  skipReadinessPoll?: boolean;
  /** Skip the peer-backfill reachability check (operator opt-out). */
  skipPeerCheck?: boolean;
}

export interface RunAcurastDeployResult {
  context: AcurastDeployContext;
  readiness?: PollRelayReadinessResult;
  peerReachability?: CheckPeerReachabilityResult;
}

export async function runAcurastDeploy(
  spec: RelayDeploymentSpec,
  options: RunAcurastDeployOptions = {}
): Promise<RunAcurastDeployResult> {
  const io = options.io ?? {
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
    error: (line) => console.error(line)
  };

  if (!options.yes) {
    throw new Error("Refusing to deploy without --yes");
  }

  const cwd = options.cwd ?? process.cwd();
  const inputSources = options.sources ?? DEFAULT_SOURCES;
  const sources: AcurastDeploySources = {
    ...inputSources,
    cwd: inputSources.cwd ?? cwd
  };
  const context = prepareAcurastDeployContext(spec, sources);
  const secretIntent = buildAcurastSecretIntentPlan(spec, context, sources.env);
  assertSecretIntentAllowed(secretIntent);

  const childEnv: NodeJS.ProcessEnv = {
    ...sources.env,
    ...context.acurastEnv,
    ...context.runtimeEnv,
    SWITCHBOARD_BUILD_CONFIG: JSON.stringify(context.buildConfig)
  };

  io.log(`relay deploy ${spec.relayId} -> acurast ${spec.acurast?.network}`);
  io.log(`  project name : ${spec.acurast?.projectName}`);
  io.log(`  stage dir    : ${spec.acurast?.stageDir}`);
  io.log(`  include env  : ${context.includeEnv.length} names (${context.includeEnv.join(",")})`);
  io.log(`  forbidden screened: ${FORBIDDEN_ACURAST_ENV_NAMES.length} names`);
  io.log("");
  for (const line of formatSecretIntentPlan(secretIntent)) {
    io.log(line);
  }
  io.log("");

  const spawner = options.spawnPnpm ?? spawnAcurastScript;
  const nodeSpawner = options.spawnNode ?? defaultSpawnNode;

  io.log(`> acurast prepare-express`);
  const prepareCode = await spawner(["acurast:prepare-express"], childEnv, cwd);
  if (prepareCode !== 0) {
    throw new Error(`acurast:prepare-express exited with code ${prepareCode}`);
  }

  const stageDir = spec.acurast!.stageDir;
  const scannerPath = "scripts/mainnet/scan-acurast-artifact-secrets.mjs";
  io.log(`> node ${scannerPath} ${stageDir}`);
  const scanCode = await nodeSpawner([scannerPath, stageDir], childEnv, cwd);
  if (scanCode !== 0) {
    throw new Error(
      `${scannerPath} exited with code ${scanCode}: refusing to deploy a staged Acurast artifact that contains a sourced secret value`
    );
  }

  io.log(`> acurast deploy-express:direct --yes`);
  const deployCode = await spawner(
    ["acurast:deploy-express:direct", "--", "--yes"],
    childEnv,
    cwd
  );
  if (deployCode !== 0) {
    throw new Error(`acurast:deploy-express:direct exited with code ${deployCode}`);
  }

  io.log("");
  io.log(`relay deploy ${spec.relayId} submitted to Acurast.`);

  let readiness: PollRelayReadinessResult | undefined;
  if (!options.skipReadinessPoll) {
    io.log("");
    // Acurast self-ingress deploys need extra time on top of the bootstrap
    // baseline: 5-min `startAt.msFromNow` + register-ingress + hub-watcher
    // pickup + gateway-agent xDS + ACME issuance.
    const isAcurastSelfIngress = spec.relay.autoRegister;
    const pollTimeoutMs =
      spec.verification.pollTimeoutMs +
      (isAcurastSelfIngress ? spec.verification.acurastReadyGraceMs : 0);

    let startAtMs: number | undefined;
    let supplementarySource: { deploymentId: string; origin: string } | undefined;
    if (isAcurastSelfIngress && spec.acurast) {
      const deployState = await readLatestAcurastDeployState(spec.acurast.stageDir).catch(() => undefined);
      if (deployState?.startTime) {
        startAtMs = deployState.startTime;
      }
      if (deployState?.deploymentId && deployState.origin) {
        supplementarySource = { deploymentId: deployState.deploymentId, origin: deployState.origin };
      }
    }

    io.log(
      `Polling ${spec.apiBaseUrl} for readiness (timeout=${pollTimeoutMs}ms, interval=${spec.verification.pollIntervalMs}ms${
        startAtMs ? `, startAt=${new Date(startAtMs).toISOString()}` : ""
      })`
    );

    // Open a chain api for supplementary signal, if applicable. Held for
    // the duration of polling so we don't reconnect each cycle.
    let processorStatusApi: Awaited<ReturnType<typeof createAcurastApi>> | undefined;
    if (supplementarySource && spec.acurast) {
      try {
        processorStatusApi = await createAcurastApi({
          network: spec.acurast.network,
          rpcUrl: rpcForAcurastNetwork(spec.acurast.network)
        });
      } catch (error) {
        io.warn(
          `  readiness: could not open Acurast chain api for supplementary signal (${(error as Error).message}); polling without it`
        );
      }
    }

    try {
      readiness = await pollRelayReadiness({
        apiBaseUrl: spec.apiBaseUrl,
        relayId: spec.relayId,
        pollIntervalMs: spec.verification.pollIntervalMs,
        pollTimeoutMs,
        startAtMs,
        fetchImpl: options.fetchImpl,
        io,
        collectSupplementarySignal:
          processorStatusApi && supplementarySource
            ? async () => {
                const snapshot = await queryAcurastProcessorStatus(processorStatusApi!, {
                  deploymentId: supplementarySource!.deploymentId,
                  origin: supplementarySource!.origin,
                  network: spec.acurast!.network
                });
                return describeAcurastProcessorStatus(snapshot);
              }
            : undefined
      });
      io.log(`Relay ${spec.relayId} ready after ${readiness.attempts} attempt(s) in ${readiness.durationMs}ms`);
    } finally {
      if (processorStatusApi) {
        await processorStatusApi.disconnect().catch(() => undefined);
      }
    }
  }

  let peerReachability: CheckPeerReachabilityResult | undefined;
  if (!options.skipPeerCheck && spec.peers.length > 0) {
    io.log("");
    io.log(
      `Checking peer-backfill reachability for ${spec.peers.length} peer(s) (require=${spec.verification.requirePeerBackfillReachable})`
    );
    peerReachability = await checkPeerReachability({
      peers: spec.peers.map((peer) => ({ relayId: peer.relayId, apiBaseUrl: peer.apiBaseUrl })),
      required: spec.verification.requirePeerBackfillReachable,
      pollIntervalMs: spec.verification.pollIntervalMs,
      pollTimeoutMs: spec.verification.pollTimeoutMs,
      fetchImpl: options.fetchImpl,
      io
    });
    io.log(
      `  reachable: [${peerReachability.reachable.join(", ")}]${peerReachability.unreachable.length > 0 ? `; unreachable: [${peerReachability.unreachable.map((p) => p.relayId).join(", ")}]` : ""}`
    );
  }

  return { context, readiness, peerReachability };
}

function signedServiceCatalogsJson(env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const inline = env.PROOF_SERVICE_CATALOGS_JSON;
  if (inline && inline.length > 0) {
    validateSignedServiceCatalogsJson(inline);
    return inline;
  }

  const configuredFile = env.PROOF_SERVICE_CATALOGS_FILE;
  const candidates = [
    configuredFile,
    DEFAULT_SIGNED_SERVICE_CATALOGS_FILE
  ].filter((value): value is string => Boolean(value && value.length > 0));

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    if (!existsSync(resolved)) continue;
    const content = readFileSync(resolved, "utf8");
    validateSignedServiceCatalogsJson(content);
    return content;
  }

  return undefined;
}

function validateSignedServiceCatalogsJson(raw: string): void {
  const input = JSON.parse(raw) as unknown;
  if (Array.isArray(input)) {
    for (const value of input) parseSignedServiceCatalog(value);
    return;
  }
  if (input && typeof input === "object" && "catalog" in input && "signature" in input) {
    parseSignedServiceCatalog(input);
    return;
  }
  if (!input || typeof input !== "object") {
    throw new Error("PROOF_SERVICE_CATALOGS_JSON must be a signed catalog, array, or object keyed by role");
  }
  for (const value of Object.values(input as Record<string, unknown>)) {
    parseSignedServiceCatalog(value);
  }
}

function defaultSpawnNode(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}
