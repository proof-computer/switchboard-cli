import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { build } from "esbuild";
import { deployProject } from "@acurast/sdk/deploy";
import { convertConfigToJob } from "@acurast/sdk/chain";
import { walletFromMnemonic } from "@acurast/sdk/chain";
import {
  AssignmentStrategyVariant,
  DeploymentRuntime,
  RestartPolicy,
  ScriptMutability,
  type AcurastProjectConfig,
  type JobRegistration
} from "@acurast/sdk/types";

import {
  encryptAcurastBundleFile,
  generateSwitchboardCodeKey,
  SWITCHBOARD_CODE_KEY_ENV
} from "./relay/encrypted-code.js";

const DEFAULT_MAINNET_RPC = "wss://archive.mainnet.acurast.com";
const DEFAULT_CANARY_RPC = "wss://canarynet-ws-1.acurast-h-server-2.papers.tech";
export const DEFAULT_ACURAST_IPFS_URL = "https://ipfs-proxy.acurast.prod.gke.papers.tech";
export const DEFAULT_ACURAST_IPFS_API_KEY = "";
const DEFAULT_ACURAST_MAX_NETWORK_REQUESTS = "1000";

export interface AcurastSdkSubmitActionPayload {
  workflowId: string;
  jobId: string;
  capacity: {
    operatorId: string;
    processorId: string;
    processor?: string;
    gatewayId?: string;
    managerId?: string;
  };
  deploymentIntent: {
    intentId: string;
    cliToken: string;
    env: {
      SWITCHBOARD_RELAY_URL: string;
      SWITCHBOARD_INTENT_ID: string;
      SWITCHBOARD_INTENT_TOKEN: string;
    };
    intent?: Record<string, unknown>;
  };
  sensitiveFields?: string[];
}

export interface AcurastSdkSubmitInput {
  actionPayload: AcurastSdkSubmitActionPayload;
  env: Record<string, string | undefined>;
  workDir?: string;
  action: "deploy" | "launch-demo";
  json?: boolean;
}

export interface AcurastSdkSubmitResult {
  report: Record<string, any>;
  reportPath: string;
}

interface PreparedSdkSubmit {
  config: AcurastProjectConfig;
  job: JobRegistration;
  envVars: Array<{ key: string; value: string }>;
  bundlePath: string;
  reportPath: string;
  runDir: string;
  buildConfigPath: string;
  metadataPath: string;
  schedule: Record<string, unknown>;
}

export function buildAcurastSdkProjectConfig(input: {
  env: Record<string, string | undefined>;
  bundlePath: string;
  processor: string;
}): AcurastProjectConfig {
  const network = acurastNetwork(input.env);
  const executionMs = positiveInteger(input.env.ACURAST_EXECUTION_MS ?? "1200000", "ACURAST_EXECUTION_MS");
  const startDelayMs = nonNegativeInteger(input.env.ACURAST_START_DELAY_MS ?? "300000", "ACURAST_START_DELAY_MS");
  const maxAllowedStartDelayMs = nonNegativeInteger(
    input.env.ACURAST_MAX_ALLOWED_START_DELAY_MS ?? input.env.ACURAST_INSTANT_MATCH_START_DELAY_MS ?? "120000",
    "ACURAST_MAX_ALLOWED_START_DELAY_MS"
  );
  const instantMatchStartDelayMs = nonNegativeInteger(
    input.env.ACURAST_INSTANT_MATCH_START_DELAY_MS ?? String(maxAllowedStartDelayMs),
    "ACURAST_INSTANT_MATCH_START_DELAY_MS"
  );
  const maxCostPerExecution = nonNegativeInteger(
    input.env.ACURAST_MAX_COST_PER_EXECUTION ?? "40000000000",
    "ACURAST_MAX_COST_PER_EXECUTION"
  );
  return {
    projectName: input.env.ACURAST_PROJECT_NAME ?? "switchboard-express",
    fileUrl: input.bundlePath,
    entrypoint: path.basename(input.bundlePath),
    network,
    onlyAttestedDevices: input.env.ACURAST_ONLY_ATTESTED_DEVICES !== "false",
    startAt: { msFromNow: startDelayMs },
    assignmentStrategy: {
      type: AssignmentStrategyVariant.Single,
      instantMatch: [{
        processor: input.processor,
        maxAllowedStartDelayInMs: instantMatchStartDelayMs
      }]
    },
    execution: {
      type: "onetime",
      maxExecutionTimeInMs: executionMs
    },
    maxAllowedStartDelayInMs: maxAllowedStartDelayMs,
    usageLimit: {
      maxMemory: nonNegativeInteger(input.env.ACURAST_MAX_MEMORY ?? "0", "ACURAST_MAX_MEMORY"),
      maxNetworkRequests: nonNegativeInteger(
        input.env.ACURAST_MAX_NETWORK_REQUESTS ?? DEFAULT_ACURAST_MAX_NETWORK_REQUESTS,
        "ACURAST_MAX_NETWORK_REQUESTS"
      ),
      maxStorage: nonNegativeInteger(input.env.ACURAST_MAX_STORAGE ?? "0", "ACURAST_MAX_STORAGE")
    },
    numberOfReplicas: 1,
    requiredModules: csv(input.env.ACURAST_REQUIRED_MODULES) as AcurastProjectConfig["requiredModules"],
    minProcessorReputation: nonNegativeInteger(input.env.ACURAST_MIN_PROCESSOR_REPUTATION ?? "0", "ACURAST_MIN_PROCESSOR_REPUTATION"),
    maxCostPerExecution,
    includeEnvironmentVariables: buildAcurastSdkEnvVars(input.env, undefined).map((item) => item.key),
    processorWhitelist: csv(input.env.ACURAST_PROCESSOR_WHITELIST),
    mutability: (input.env.ACURAST_MUTABILITY as ScriptMutability | undefined) ?? ScriptMutability.Immutable,
    runtime: DeploymentRuntime.NodeJSWithBundle,
    restartPolicy: RestartPolicy.OnFailure,
    enableDevtools: input.env.ACURAST_ENABLE_DEVTOOLS === "true"
  };
}

export function buildAcurastSdkEnvVars(
  env: Record<string, string | undefined>,
  actionPayload: AcurastSdkSubmitActionPayload | undefined
): Array<{ key: string; value: string }> {
  const explicit = csv(env.ACURAST_INCLUDE_ENV);
  const values = new Map<string, string>();
  const add = (key: string, value: string | undefined): void => {
    if (value !== undefined && value.length > 0) values.set(key, value);
  };
  if (actionPayload) {
    add("SWITCHBOARD_CONFIG", JSON.stringify({
      PORT: env.PORT ?? "3000",
      SWITCHBOARD_HOST: env.SWITCHBOARD_HOST ?? "0.0.0.0",
      SWITCHBOARD_AUTO_REGISTER: "true",
      SWITCHBOARD_RELAY_URL: actionPayload.deploymentIntent.env.SWITCHBOARD_RELAY_URL,
      SWITCHBOARD_INTENT_ID: actionPayload.deploymentIntent.env.SWITCHBOARD_INTENT_ID,
      SWITCHBOARD_INTENT_TOKEN: actionPayload.deploymentIntent.env.SWITCHBOARD_INTENT_TOKEN,
      SWITCHBOARD_INTENT_POLL_MS: env.SWITCHBOARD_DEPLOY_INTENT_POLL_MS ?? "30000",
      SWITCHBOARD_INTENT_MAX_ATTEMPTS: "0",
      SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS: env.SWITCHBOARD_DEPLOY_INTENT_REQUEST_TIMEOUT_MS ?? "60000",
      SWITCHBOARD_CERTIFICATE_MODE: env.SWITCHBOARD_DEPLOY_CERTIFICATE_MODE ?? "job-acme",
      SWITCHBOARD_CERTIFICATE_REQUEST_TIMEOUT_MS: env.SWITCHBOARD_DEPLOY_CERTIFICATE_REQUEST_TIMEOUT_MS ?? "360000",
      SWITCHBOARD_RELAY_DIAGNOSTICS: "true",
      SWITCHBOARD_RELAY_DIAGNOSTICS_TIMEOUT_MS: env.SWITCHBOARD_DEPLOY_RELAY_DIAGNOSTICS_TIMEOUT_MS ?? "10000",
      SWITCHBOARD_DEMO_VERSION: env.SWITCHBOARD_DEMO_VERSION
    }));
  }
  for (const key of explicit) {
    const value = env[key];
    if (!value) {
      throw new Error(`${key} is listed in ACURAST_INCLUDE_ENV but is not set`);
    }
    add(key, value);
  }
  return Array.from(values.entries()).map(([key, value]) => ({ key, value }));
}

export async function submitAcurastSingleReplicaWithSdk(input: AcurastSdkSubmitInput): Promise<AcurastSdkSubmitResult> {
  validateActionPayload(input.actionPayload);
  const fakeRaw = input.env.SWITCHBOARD_FAKE_ACURAST_SDK_SUBMIT_JSON;
  const fake = fakeRaw && fakeRaw !== "undefined"
    ? JSON.parse(fakeRaw) as Record<string, unknown>
    : undefined;
  const prepared = fake ? await prepareFakeSdkSubmit(input) : await prepareSdkSubmit(input);
  try {
    if (fake?.ok === false) {
      throw new Error(typeof fake.message === "string" ? fake.message : "fake SDK submit failure");
    }
    const submit = fake ?? await submitPreparedSdkJob(input, prepared);
    const deploymentId = requiredString(submit.deploymentId, "SDK submit deploymentId");
    const txHash = requiredString(submit.txHash, "SDK submit txHash");
    await updateDeploymentIntentDeployment(input, {
      deploymentId,
      jobId: input.actionPayload.jobId,
      processor: input.actionPayload.capacity.processor,
      processorId: input.actionPayload.capacity.processorId
    });
    const report = sdkSubmitReport(input, prepared, {
      ok: true,
      deploymentId,
      txHash,
      sdk: submit
    });
    await writeJson(prepared.reportPath, report);
    return { report, reportPath: prepared.reportPath };
  } catch (error) {
    const report = sdkSubmitReport(input, prepared, {
      ok: false,
      failure: {
        stage: "acurast-deploy",
        message: error instanceof Error ? error.message : String(error)
      }
    });
    await writeJson(prepared.reportPath, report);
    return { report, reportPath: prepared.reportPath };
  }
}

async function prepareFakeSdkSubmit(input: AcurastSdkSubmitInput): Promise<PreparedSdkSubmit> {
  const workDir = path.resolve(input.workDir ?? input.env.SWITCHBOARD_WORK_DIR ?? process.cwd());
  const runDir = path.resolve(input.env.SWITCHBOARD_FAKE_RUN_DIR ?? input.env.SWITCHBOARD_DEPLOY_RUN_DIR ?? await mkdtemp(path.join(tmpdir(), "switchboard-deploy-")));
  const reportPath = path.join(runDir, "report.json");
  const buildConfigPath = path.join(runDir, "acurast-config.json");
  const metadataPath = path.join(runDir, "metadata.json");
  const stageDir = path.resolve(input.env.ACURAST_STAGE_DIR ?? path.join(workDir, "dist/acurast/express-webserver"));
  const bundlePath = path.join(stageDir, "dist/bundle.cjs");
  const envVars = buildAcurastSdkEnvVars(input.env, input.actionPayload);
  const config = buildAcurastSdkProjectConfig({
    env: input.env,
    bundlePath,
    processor: requiredString(input.actionPayload.capacity.processor, "selected processor")
  });
  config.includeEnvironmentVariables = envVars.map((item) => item.key);
  const job = convertConfigToJob(config);
  await mkdir(runDir, { recursive: true });
  return {
    config,
    job,
    envVars,
    bundlePath,
    reportPath,
    runDir,
    buildConfigPath,
    metadataPath,
    schedule: {
      startTime: job.schedule.startTime,
      endTime: job.schedule.endTime,
      duration: job.schedule.duration,
      interval: job.schedule.interval,
      maxStartDelay: job.schedule.maxStartDelay
    }
  };
}

async function prepareSdkSubmit(input: AcurastSdkSubmitInput): Promise<PreparedSdkSubmit> {
  const workDir = path.resolve(input.workDir ?? input.env.SWITCHBOARD_WORK_DIR ?? process.cwd());
  const runDir = path.resolve(input.env.SWITCHBOARD_FAKE_RUN_DIR ?? input.env.SWITCHBOARD_DEPLOY_RUN_DIR ?? await mkdtemp(path.join(tmpdir(), "switchboard-deploy-")));
  const reportPath = path.join(runDir, "report.json");
  const buildConfigPath = path.join(runDir, "acurast-config.json");
  const metadataPath = path.join(runDir, "metadata.json");
  const stageDir = path.resolve(input.env.ACURAST_STAGE_DIR ?? path.join(workDir, "dist/acurast/express-webserver"));
  const bundlePath = path.join(stageDir, "dist/bundle.cjs");
  await rm(path.join(stageDir, "dist"), { recursive: true, force: true });
  await mkdir(path.dirname(bundlePath), { recursive: true });

  const envVars = buildAcurastSdkEnvVars(input.env, input.actionPayload);
  const buildConfig = JSON.parse(envVars.find((item) => item.key === "SWITCHBOARD_CONFIG")?.value ?? "{}") as Record<string, unknown>;
  await writeJson(buildConfigPath, buildConfig);
  await writeJson(metadataPath, {
    action: input.action,
    workflowId: input.actionPayload.workflowId,
    jobId: input.actionPayload.jobId,
    deploymentIntent: {
      intentId: input.actionPayload.deploymentIntent.intentId,
      relayUrl: input.actionPayload.deploymentIntent.env.SWITCHBOARD_RELAY_URL,
      intent: input.actionPayload.deploymentIntent.intent,
      localSecret: {
        description: "Deployer-local deployment intent token. Do not publish this report.",
        cliToken: input.actionPayload.deploymentIntent.cliToken
      },
      sensitiveFields: ["deploymentIntent.localSecret.cliToken"]
    },
    capacity: input.actionPayload.capacity
  });

  await buildBundle({
    workDir,
    entrypoint: requiredString(input.env.ACURAST_ENTRYPOINT, "ACURAST_ENTRYPOINT"),
    bundlePath,
    buildConfig
  });
  const encryptedCode = input.env.ACURAST_ENCRYPTED_CODE !== "false";
  if (encryptedCode) {
    const codeKey = input.env[SWITCHBOARD_CODE_KEY_ENV] ?? generateSwitchboardCodeKey();
    input.env[SWITCHBOARD_CODE_KEY_ENV] = codeKey;
    envVars.push({ key: SWITCHBOARD_CODE_KEY_ENV, value: codeKey });
    await encryptAcurastBundleFile(bundlePath, { keyHex: codeKey });
  }
  auditEnvVars(envVars);
  const config = buildAcurastSdkProjectConfig({
    env: input.env,
    bundlePath,
    processor: requiredString(input.actionPayload.capacity.processor, "selected processor")
  });
  config.includeEnvironmentVariables = envVars.map((item) => item.key);
  const job = convertConfigToJob(config);
  const schedule = {
    startTime: job.schedule.startTime,
    endTime: job.schedule.endTime,
    duration: job.schedule.duration,
    interval: job.schedule.interval,
    maxStartDelay: job.schedule.maxStartDelay
  };
  return { config, job, envVars, bundlePath, reportPath, runDir, buildConfigPath, metadataPath, schedule };
}

async function submitPreparedSdkJob(
  input: AcurastSdkSubmitInput,
  prepared: PreparedSdkSubmit
): Promise<Record<string, unknown>> {
  const mnemonic = acurastMnemonic(input.env);
  const ipfs = acurastSdkIpfsUploadConfig(input.env);
  const wallet = await walletFromMnemonic(mnemonic, { name: "switchboard-cli" });
  let txHash: string | undefined;
  let deploymentId: string | undefined;
  await deployProject(prepared.config, prepared.job, {
    wallet,
    rpcEndpoint: acurastRpc(input.env),
    ipfs,
    envVars: prepared.envVars,
    statusCallback(status, data) {
      if (status === "Submit" && data && typeof data === "object") {
        txHash = typeof (data as Record<string, unknown>).txHash === "string" ? (data as Record<string, string>).txHash : txHash;
      }
      if (status === "WaitingForMatch" && data && typeof data === "object") {
        const ids = (data as Record<string, unknown>).jobIds;
        const first = Array.isArray(ids) ? ids[0] : undefined;
        if (Array.isArray(first) && first.length > 1) {
          deploymentId = String(first[1]);
        }
      }
    },
    bundleFolder: path.join(prepared.runDir, "acurast-bundles")
  });
  return {
    deploymentId,
    txHash,
    projectName: prepared.config.projectName,
    network: prepared.config.network
  };
}

export function acurastSdkIpfsUploadConfig(env: Record<string, string | undefined>): { endpoint: string; apiKey: string } {
  return {
    endpoint: nonEmptyString(env.ACURAST_IPFS_URL) ?? DEFAULT_ACURAST_IPFS_URL,
    apiKey: env.ACURAST_IPFS_API_KEY ?? DEFAULT_ACURAST_IPFS_API_KEY
  };
}

function sdkSubmitReport(
  input: AcurastSdkSubmitInput,
  prepared: PreparedSdkSubmit,
  result: { ok: true; deploymentId: string; txHash: string; sdk: Record<string, unknown> } | { ok: false; failure: Record<string, unknown> }
): Record<string, any> {
  const intent = input.actionPayload.deploymentIntent;
  const capacity = input.actionPayload.capacity;
  return {
    ok: result.ok,
    runId: path.basename(prepared.runDir),
    mode: "acurast-sdk-submit-only",
    deployment: result.ok
      ? {
          deploymentId: result.deploymentId,
          txHash: result.txHash,
          sdk: result.sdk
        }
      : {},
    session: {
      jobId: input.actionPayload.jobId,
      operatorId: capacity.operatorId,
      gatewayId: capacity.gatewayId,
      processor: capacity.processor,
      processorId: capacity.processorId
    },
    relay: {
      url: intent.env.SWITCHBOARD_RELAY_URL
    },
    deploymentIntent: {
      intentId: intent.intentId,
      relayUrl: intent.env.SWITCHBOARD_RELAY_URL,
      localSecret: {
        description: "Deployer-local deployment intent token. Do not publish this report.",
        cliToken: intent.cliToken
      },
      sensitiveFields: ["deploymentIntent.localSecret.cliToken"]
    },
    lifecycle: {
      executionMs: prepared.job.schedule.duration,
      schedule: prepared.schedule
    },
    artifacts: {
      runDir: prepared.runDir,
      buildConfigPath: prepared.buildConfigPath,
      metadataPath: prepared.metadataPath,
      reportPath: prepared.reportPath,
      bundlePath: prepared.bundlePath
    },
    failure: result.ok ? undefined : result.failure
  };
}

async function updateDeploymentIntentDeployment(
  input: AcurastSdkSubmitInput,
  deployment: { deploymentId: string; jobId: string; processor: string | undefined; processorId: string }
): Promise<void> {
  const intent = input.actionPayload.deploymentIntent;
  const response = await fetch(new URL(`/v1/deployment-intents/${encodeURIComponent(intent.intentId)}/deployment`, intent.env.SWITCHBOARD_RELAY_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${intent.cliToken}`
    },
    body: JSON.stringify({
      acurastDeploymentId: deployment.deploymentId,
      jobId: deployment.jobId,
      operatorId: input.actionPayload.capacity.operatorId,
      processorId: deployment.processorId,
      processor: deployment.processor,
      upstreamPort: Number(input.env.PORT ?? "3000"),
      source: {
        mode: "switchboard-deploy-sdk",
        workflowId: input.actionPayload.workflowId
      }
    }),
    signal: AbortSignal.timeout(nonNegativeInteger(input.env.SWITCHBOARD_DEPLOY_INTENT_UPDATE_TIMEOUT_MS ?? "15000", "SWITCHBOARD_DEPLOY_INTENT_UPDATE_TIMEOUT_MS"))
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok || json.ok !== true) {
    throw new Error(`Deployment intent update failed: ${response.status} ${JSON.stringify(json)}`);
  }
}

async function buildBundle(input: {
  workDir: string;
  entrypoint: string;
  bundlePath: string;
  buildConfig: Record<string, unknown>;
}): Promise<void> {
  try {
    await build({
      entryPoints: [path.resolve(input.workDir, input.entrypoint)],
      outfile: input.bundlePath,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      sourcemap: false,
      minify: true,
      legalComments: "none",
      define: {
        __SWITCHBOARD_BUILD_CONFIG__: JSON.stringify(JSON.stringify(input.buildConfig))
      },
      logLevel: "silent"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/top-level await/i.test(message)) {
      throw new Error(
        "Acurast NodeJSWithBundle loads project bundles with require(); top-level await is not supported. Wrap startup in an async function and call it without top-level await."
      );
    }
    throw error;
  }
}

function validateActionPayload(payload: AcurastSdkSubmitActionPayload): void {
  if (!payload || typeof payload !== "object") {
    throw new Error("acurast.deploy action payload is required");
  }
  requiredString(payload.workflowId, "workflowId");
  requiredString(payload.jobId, "jobId");
  requiredString(payload.capacity?.operatorId, "capacity.operatorId");
  requiredString(payload.capacity?.processorId, "capacity.processorId");
  requiredString(payload.capacity?.processor, "capacity.processor");
  requiredString(payload.deploymentIntent?.intentId, "deploymentIntent.intentId");
  requiredString(payload.deploymentIntent?.cliToken, "deploymentIntent.cliToken");
  requiredString(payload.deploymentIntent?.env?.SWITCHBOARD_RELAY_URL, "deploymentIntent.env.SWITCHBOARD_RELAY_URL");
  requiredString(payload.deploymentIntent?.env?.SWITCHBOARD_INTENT_ID, "deploymentIntent.env.SWITCHBOARD_INTENT_ID");
  requiredString(payload.deploymentIntent?.env?.SWITCHBOARD_INTENT_TOKEN, "deploymentIntent.env.SWITCHBOARD_INTENT_TOKEN");
  if (!payload.sensitiveFields?.includes("deploymentIntent.cliToken") ||
      !payload.sensitiveFields.includes("deploymentIntent.env.SWITCHBOARD_INTENT_TOKEN")) {
    throw new Error("acurast.deploy action payload is missing sensitive field markers");
  }
}

function auditEnvVars(envVars: Array<{ key: string; value: string }>): void {
  const violations: string[] = [];
  if (envVars.length > 10) violations.push(`count ${envVars.length} > maxEnvVars=10`);
  for (const item of envVars) {
    const keyBytes = Buffer.byteLength(item.key, "utf8");
    const valueBytes = Buffer.byteLength(item.value, "utf8");
    if (keyBytes > 32) violations.push(`key "${item.key}" is ${keyBytes} bytes > envKeyMaxSize=32`);
    if (valueBytes > 996) violations.push(`value for "${item.key}" is ${valueBytes} bytes > plaintext cap 996`);
  }
  if (violations.length > 0) {
    throw new Error(`Refusing to submit Acurast env vars: ${violations.join("; ")}`);
  }
}

function acurastNetwork(env: Record<string, string | undefined>): "mainnet" | "canary" {
  const network = env.ACURAST_NETWORK ?? "mainnet";
  if (network !== "mainnet" && network !== "canary") {
    throw new Error(`Unsupported Acurast network: ${network}`);
  }
  return network;
}

function acurastRpc(env: Record<string, string | undefined>): string {
  return env.ACURAST_RPC ?? (acurastNetwork(env) === "canary" ? env.ACURAST_CANARY_RPC ?? DEFAULT_CANARY_RPC : DEFAULT_MAINNET_RPC);
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function acurastMnemonic(env: Record<string, string | undefined>): string {
  const network = acurastNetwork(env);
  const value = network === "canary"
    ? env.ACURAST_CANARY_SEED ?? env.ACURAST_SEED
    : env.ACURAST_MAINNET_SEED ?? env.ACURAST_SEED;
  return requiredString(value, network === "canary" ? "ACURAST_CANARY_SEED or ACURAST_SEED" : "ACURAST_MAINNET_SEED or ACURAST_SEED");
}

function csv(value: string | undefined): string[] {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function nonNegativeInteger(value: string, label: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return parsed;
}

function positiveInteger(value: string, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed <= 0) {
    throw new Error(`${label} must be positive`);
  }
  return parsed;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
