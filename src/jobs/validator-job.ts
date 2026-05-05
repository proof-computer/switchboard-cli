#!/usr/bin/env node
import "dotenv/config";

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEncryptedSwitchboardLogger } from "../runtime/index.js";
import { signReportPayload } from "../report-signing.js";
import { validateSwitchboardRoute, type OperatorValidationSignals } from "../route-validation-report.js";

declare const __SWITCHBOARD_BUILD_CONFIG__: string | undefined;

const config = readConfig();
const remoteLog = createRemoteLogger();

async function main(): Promise<void> {
  if (configValue("VALIDATOR_WORK_POLL") === "true" || configValue("VALIDATOR_WORK_MODE") === "poll") {
    await runPollingValidator();
    return;
  }

  const sessionId = requiredConfig("VALIDATION_SESSION_ID", "SESSION_ID");
  const hostname = requiredConfig("VALIDATION_HOSTNAME", "HOSTNAME");
  const controlPlaneUrl = requiredConfig("PROOF_CONTROL_PLANE_URL", "RELAY_URL");
  const controlPlane = new URL(controlPlaneUrl);
  const submitUrls = reportSubmitUrlsFromConfig(controlPlaneUrl);
  const operatorSignalUrl = configValue("OPERATOR_SIGNAL_URL", "PROOF_OPERATOR_SIGNAL_URL");
  const seed = requiredConfig("VALIDATOR_REPORT_SEED", "PROOF_VALIDATOR_REPORT_SEED");
  const validatorDeploymentId = configValue("VALIDATOR_DEPLOYMENT_ID") ?? acurastDeploymentId();
  const validatorDeviceAddress = configValue("VALIDATOR_DEVICE_ADDRESS") ?? acurastDeviceAddress();

  const allowlist = await allowAcurastHostnames([
    hostname,
    controlPlane.hostname,
    ...submitUrls.map(urlHostname),
    urlHostname(operatorSignalUrl),
    urlHostname(configValue("SWITCHBOARD_LOG_URL"))
  ]);

  await logEvent("validator-start", {
    sessionId,
    hostname,
    controlPlaneHost: controlPlane.host,
    validatorDeploymentId,
    validatorDeviceAddress,
    allowlist,
    envPresence: envPresence([
      "VALIDATION_SESSION_ID",
      "VALIDATION_HOSTNAME",
      "PROOF_CONTROL_PLANE_URL",
      "PROOF_VALIDATOR_REPORT_URLS",
      "VALIDATION_REPORT_URLS",
      "PROOF_VALIDATOR_REPORT_URL",
      "VALIDATOR_REPORT_SEED",
      "PROOF_VALIDATOR_REPORT_SEED",
      ...remoteLogEnvNames()
    ])
  });

  await logEvent("validator-report-started", {
    sessionId,
    hostname,
    deploymentId: configValue("TARGET_DEPLOYMENT_ID"),
    mode: validationMode()
  });
  const report = await validateSwitchboardRoute({
    sessionId,
    hostname,
    deploymentId: configValue("TARGET_DEPLOYMENT_ID"),
    operatorId: configValue("OPERATOR_ID"),
    gatewayId: configValue("GATEWAY_ID"),
    operatorSignals: await fetchOperatorSignals(operatorSignalUrl, {
      sessionId,
      hostname,
      operatorId: configValue("OPERATOR_ID"),
      gatewayId: configValue("GATEWAY_ID"),
      processorId: configValue("PROCESSOR_ID"),
      publicAddress: configValue("OPERATOR_PUBLIC_ADDRESS")
    }),
    validatorId: configValue("VALIDATOR_ID") ?? `acurast-validator-${validatorDeploymentId ?? "unknown"}`,
    validatorDeploymentId,
    validatorDeviceAddress,
    mode: validationMode(),
    timeoutMs: numberConfig("VALIDATION_TIMEOUT_MS", 15_000),
    signingKey: seed,
    signingScheme: "substrate-sr25519",
    signingSs58Format: numberConfig("VALIDATOR_REPORT_SS58_FORMAT", 42)
  });

  await logEvent("validator-report-built", {
    success: report.success,
    reportId: report.reportId,
    signer: report.signature?.signer,
    failureReason: report.failureReason,
    checkCount: Object.keys(report.checks).length,
    checks: report.checks
  });

  await submitValidationReports(submitUrls, report);
}

async function runPollingValidator(): Promise<void> {
  const controlPlaneUrl = requiredConfig("PROOF_CONTROL_PLANE_URL", "RELAY_URL");
  const controlPlane = new URL(controlPlaneUrl);
  const seed = await validatorRuntimeSeed();
  const validatorDeploymentId = configValue("VALIDATOR_DEPLOYMENT_ID") ?? acurastDeploymentId();
  const validatorDeviceAddress = configValue("VALIDATOR_DEVICE_ADDRESS") ?? acurastDeviceAddress();
  const validatorId = configValue("VALIDATOR_ID") ?? `acurast-validator-${validatorDeploymentId ?? "unknown"}`;
  const pollIntervalMs = numberConfig("VALIDATOR_WORK_POLL_INTERVAL_MS", 30_000);
  const runMs = numberConfig("VALIDATOR_WORK_RUN_MS", 180_000);
  const leaseSeconds = numberConfig("VALIDATOR_WORK_LEASE_SECONDS", 120);
  const maxItems = numberConfig("VALIDATOR_WORK_MAX_ITEMS", 1);
  const stopAt = Date.now() + runMs;

  await allowAcurastHostnames([controlPlane.hostname, urlHostname(configValue("SWITCHBOARD_LOG_URL"))]);
  await logEvent("validator-poll-start", {
    controlPlaneHost: controlPlane.host,
    validatorId,
    validatorDeploymentId,
    validatorDeviceAddress,
    pollIntervalMs,
    runMs,
    leaseSeconds,
    maxItems
  });

  await enrollValidatorRuntime(controlPlaneUrl, seed, {
    validatorDeploymentId,
    validatorDeviceAddress
  });

  while (Date.now() < stopAt) {
    const claim = await claimValidatorWork(controlPlaneUrl, seed, {
      validatorId,
      validatorDeploymentId,
      validatorDeviceAddress,
      maxItems,
      leaseSeconds
    });
    if (claim.work.length === 0) {
      await logEvent("validator-poll-empty", { nextPollMs: pollIntervalMs });
      await sleep(Math.min(pollIntervalMs, Math.max(0, stopAt - Date.now())));
      continue;
    }

    for (const work of claim.work) {
      await validateAndSubmitWork(controlPlaneUrl, seed, {
        work,
        validatorId,
        validatorDeploymentId,
        validatorDeviceAddress
      });
    }
  }

  await logEvent("validator-poll-finished", {
    validatorId,
    elapsedMs: runMs
  });
}

async function claimValidatorWork(
  controlPlaneUrl: string,
  seed: string,
  input: {
    validatorId: string;
    validatorDeploymentId?: string;
    validatorDeviceAddress?: string;
    maxItems: number;
    leaseSeconds: number;
  }
): Promise<{ work: ValidatorWorkPackage[] }> {
  const url = new URL("/v1/validator-work-claims", controlPlaneUrl);
  const deadline = String(Math.floor(Date.now() / 1000) + 300);
  const payload = {
    validatorId: input.validatorId,
    validatorDeploymentId: input.validatorDeploymentId,
    validatorDeviceAddress: input.validatorDeviceAddress,
    acurastJobId: configValue("VALIDATOR_ACURAST_JOB_ID", "ACURAST_JOB_ID"),
    maxItems: input.maxItems,
    leaseSeconds: input.leaseSeconds,
    nonce: randomBytes(16).toString("hex"),
    deadline
  };
  const signature = await signReportPayload(seed, "switchboard.validator-work-claim.v1", payload, {
    scheme: "substrate-sr25519",
    ss58Format: numberConfig("VALIDATOR_REPORT_SS58_FORMAT", 42)
  });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      ...payload,
      signature
    })
  });
  const body = await response.text();
  if (!response.ok) {
    await logEvent("validator-work-claim-failed", {
      status: response.status,
      body: body.slice(0, 1000)
    });
    throw new Error(`Validator work claim failed: ${response.status} ${body}`);
  }
  const parsed = parseJson(body) as { work?: unknown[] } | undefined;
  return {
    work: Array.isArray(parsed?.work) ? parsed.work.map(parseValidatorWorkPackage) : []
  };
}

async function enrollValidatorRuntime(
  controlPlaneUrl: string,
  seed: string,
  input: {
    validatorDeploymentId?: string;
    validatorDeviceAddress?: string;
  }
): Promise<void> {
  const intentId = configValue("PROOF_VALIDATOR_LAUNCH_INTENT_ID", "VALIDATOR_LAUNCH_INTENT_ID");
  if (!intentId || !input.validatorDeploymentId) {
    return;
  }
  const enrollmentSeed = configValue("VALIDATOR_ENROLLMENT_SEED", "PROOF_VALIDATOR_ENROLLMENT_SEED");
  if (!enrollmentSeed) {
    await logEvent("validator-runtime-enrollment-missing-seed", {
      intentId,
      validatorDeploymentId: input.validatorDeploymentId
    });
    throw new Error("VALIDATOR_ENROLLMENT_SEED is required for runtime enrollment");
  }
  const ss58Format = numberConfig("VALIDATOR_REPORT_SS58_FORMAT", 42);
  const acurastJobId =
    configValue("VALIDATOR_ACURAST_JOB_ID", "ACURAST_JOB_ID") ??
    canonicalAcurastJobId(configValue("PROOF_VALIDATOR_DEPLOYER_ADDRESS"), input.validatorDeploymentId);
  if (!acurastJobId) {
    throw new Error(
      "Cannot determine acurastJobId: set VALIDATOR_ACURAST_JOB_ID or PROOF_VALIDATOR_DEPLOYER_ADDRESS"
    );
  }
  const runtimeSignerProbe = await signReportPayload(seed, "switchboard.validator-runtime-enrollment.probe", {
    intentId,
    acurastDeploymentId: input.validatorDeploymentId
  }, {
    scheme: "substrate-sr25519",
    ss58Format
  });
  const payload = {
    intentId,
    acurastJobId,
    acurastDeploymentId: input.validatorDeploymentId,
    deviceAddress: input.validatorDeviceAddress,
    runtimeSigner: runtimeSignerProbe.signer,
    nonce: randomBytes(16).toString("hex"),
    deadline: String(Math.floor(Date.now() / 1000) + 300)
  };
  const signature = await signReportPayload(enrollmentSeed, "switchboard.validator-runtime-enrollment.v1", payload, {
    scheme: "substrate-sr25519",
    ss58Format
  });
  const response = await fetch(new URL("/v1/validator-runtime-enrollments", controlPlaneUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      ...payload,
      signature
    })
  });
  const body = await response.text();
  if (!response.ok && response.status !== 409) {
    await logEvent("validator-runtime-enrollment-failed", {
      status: response.status,
      body: body.slice(0, 1000)
    });
    throw new Error(`Validator runtime enrollment failed: ${response.status} ${body}`);
  }
  await logEvent("validator-runtime-enrolled", {
    status: response.status,
    runtimeSigner: payload.runtimeSigner,
    enrollmentSigner: signature.signer
  });
}

function canonicalAcurastJobId(deployerAddress: string | undefined, deploymentId: string | undefined): string | undefined {
  if (!deployerAddress || !deploymentId) {
    return undefined;
  }
  return JSON.stringify([{ acurast: deployerAddress }, deploymentId]);
}

async function validateAndSubmitWork(
  controlPlaneUrl: string,
  seed: string,
  input: {
    work: ValidatorWorkPackage;
    validatorId: string;
    validatorDeploymentId?: string;
    validatorDeviceAddress?: string;
  }
): Promise<void> {
  const { work } = input;
  const submitUrls = reportSubmitUrlsForWork(controlPlaneUrl, work);
  await allowAcurastHostnames([
    work.hostname,
    new URL(controlPlaneUrl).hostname,
    ...submitUrls.map(urlHostname),
    urlHostname(work.operatorSignalUrl),
    urlHostname(configValue("SWITCHBOARD_LOG_URL"))
  ]);
  await logEvent("validator-work-started", {
    workId: work.workId,
    sessionId: work.sessionId,
    hostname: work.hostname,
    mode: work.mode
  });
  const report = await validateSwitchboardRoute({
    sessionId: work.sessionId,
    hostname: work.hostname,
    deploymentId: work.deploymentId,
    operatorId: work.operatorId,
    gatewayId: work.gatewayId,
    operatorSignals: await fetchOperatorSignals(work.operatorSignalUrl, {
      sessionId: work.sessionId,
      hostname: work.hostname,
      operatorId: work.operatorId,
      gatewayId: work.gatewayId
    }),
    validatorId: input.validatorId,
    validatorDeploymentId: input.validatorDeploymentId,
    validatorDeviceAddress: input.validatorDeviceAddress,
    mode: work.mode,
    port: work.port,
    timeoutMs: work.checkTimeoutMs,
    signingKey: seed,
    signingScheme: "substrate-sr25519",
    signingSs58Format: numberConfig("VALIDATOR_REPORT_SS58_FORMAT", 42)
  });
  await logEvent("validator-work-report-built", {
    workId: work.workId,
    assignmentId: work.assignmentId,
    reportId: report.reportId,
    success: report.success,
    failureReason: report.failureReason
  });
  await submitValidationReports(submitUrls, report, {
    workId: work.workId,
    assignmentId: work.assignmentId
  });
}

async function submitValidationReports(
  urls: string[],
  report: Awaited<ReturnType<typeof validateSwitchboardRoute>>,
  refs: { workId?: string; assignmentId?: string } = {}
): Promise<void> {
  await logEvent("validator-submit-started", {
    workId: refs.workId,
    assignmentId: refs.assignmentId,
    reportId: report.reportId,
    urls
  });

  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ report, workId: refs.workId, assignmentId: refs.assignmentId })
        });
        const body = await response.text();
        if (!response.ok) {
          return {
            ok: false as const,
            url,
            error: `${response.status} ${body.slice(0, 1000)}`
          };
        }
        return {
          ok: true as const,
          url,
          response: parseJson(body)
        };
      } catch (error) {
        return {
          ok: false as const,
          url,
          error: safeErrorMessage(error)
        };
      }
    })
  );

  const successes = results.filter((result): result is Extract<typeof result, { ok: true }> => result.ok);
  const failures = results.filter((result): result is Extract<typeof result, { ok: false }> => !result.ok);
  if (successes.length === 0) {
    await logEvent("validator-submit-failed", {
      workId: refs.workId,
      assignmentId: refs.assignmentId,
      reportId: report.reportId,
      failures
    });
    throw new Error(`Validation report submit failed for all relays: ${failures.map((item) => `${item.url}: ${item.error}`).join("; ")}`);
  }

  await logEvent("validator-submitted", {
    workId: refs.workId,
    assignmentId: refs.assignmentId,
    success: report.success,
    reportId: report.reportId,
    signer: report.signature?.signer,
    submitted: successes.map((item) => ({
      url: item.url,
      response: item.response
    })),
    failures: failures.length > 0 ? failures : undefined
  });
}

function reportSubmitUrlsFromConfig(controlPlaneUrl: string): string[] {
  const explicitUrls = splitCsv(configValue("PROOF_VALIDATOR_REPORT_URLS", "VALIDATION_REPORT_URLS") ?? "");
  const singleUrl = configValue("PROOF_VALIDATOR_REPORT_URL");
  const urls = [...explicitUrls, ...(singleUrl ? [singleUrl] : [])];
  if (urls.length > 0) {
    return uniqueStrings(urls.map(normalizeReportSubmitUrl));
  }
  return [new URL("/v1/validation-reports", controlPlaneUrl).toString()];
}

function reportSubmitUrlsForWork(controlPlaneUrl: string, work: ValidatorWorkPackage): string[] {
  const urls = work.reportSubmitUrls && work.reportSubmitUrls.length > 0
    ? work.reportSubmitUrls
    : [new URL("/v1/validation-reports", controlPlaneUrl).toString()];
  return uniqueStrings(urls.map(normalizeReportSubmitUrl));
}

function normalizeReportSubmitUrl(value: string): string {
  const url = new URL(value);
  if (url.pathname === "/" || url.pathname === "") {
    return new URL("/v1/validation-reports", url).toString();
  }
  return url.toString();
}

async function validatorRuntimeSeed(): Promise<string> {
  const configured = configValue("VALIDATOR_RUNTIME_SEED", "PROOF_VALIDATOR_RUNTIME_SEED", "VALIDATOR_REPORT_SEED", "PROOF_VALIDATOR_REPORT_SEED");
  if (configured) {
    return configured;
  }
  const seedFile = configValue("VALIDATOR_RUNTIME_SEED_FILE", "PROOF_VALIDATOR_RUNTIME_SEED_FILE") ?? ".proof-validator-runtime-seed";
  try {
    const existing = (await readFile(seedFile, "utf8")).trim();
    if (existing.length > 0) {
      return existing;
    }
  } catch {
    // Generate below when the runtime has no persisted validator key yet.
  }
  const generated = `0x${randomBytes(32).toString("hex")}`;
  await mkdir(path.dirname(path.resolve(seedFile)), { recursive: true });
  await writeFile(seedFile, `${generated}\n`, { mode: 0o600 });
  return generated;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

interface ValidatorWorkPackage {
  workId: string;
  assignmentId?: string;
  sessionId: string;
  hostname: string;
  deploymentId?: string;
  operatorId?: string;
  gatewayId?: string;
  operatorSignalUrl?: string;
  mode: "route_open" | "reachability";
  port: number;
  checkTimeoutMs: number;
  reportSubmitUrls?: string[];
}

function parseValidatorWorkPackage(input: unknown): ValidatorWorkPackage {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const mode = record.mode === "reachability" ? "reachability" : "route_open";
  return {
    workId: requiredStringRecordField(record, "workId"),
    assignmentId: stringRecordField(record, "assignmentId"),
    sessionId: requiredStringRecordField(record, "sessionId"),
    hostname: requiredStringRecordField(record, "hostname"),
    deploymentId: stringRecordField(record, "deploymentId"),
    operatorId: stringRecordField(record, "operatorId"),
    gatewayId: stringRecordField(record, "gatewayId"),
    operatorSignalUrl: stringRecordField(record, "operatorSignalUrl"),
    mode,
    port: numberRecordField(record, "port", 443),
    checkTimeoutMs: numberRecordField(record, "checkTimeoutMs", 15_000),
    reportSubmitUrls: stringArrayRecordField(record, "reportSubmitUrls")
  };
}

async function fetchOperatorSignals(
  signalUrl: string | undefined,
  context: {
    sessionId: string;
    hostname: string;
    operatorId?: string;
    gatewayId?: string;
    processorId?: string;
    publicAddress?: string;
  }
): Promise<OperatorValidationSignals | undefined> {
  if (!signalUrl) {
    return undefined;
  }

  const url = new URL(signalUrl);
  url.searchParams.set("sessionId", context.sessionId);
  url.searchParams.set("hostname", context.hostname);
  if (context.processorId) url.searchParams.set("processorId", context.processorId);
  if (context.publicAddress) url.searchParams.set("publicAddress", context.publicAddress);

  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json"
      },
      signal: AbortSignal.timeout(numberConfig("OPERATOR_SIGNAL_TIMEOUT_MS", 5_000))
    });
    const body = await response.text();
    if (!response.ok) {
      return {
        sampledAt: new Date().toISOString(),
        source: signalUrl,
        capability: {
          available: false,
          error: `${response.status} ${body.slice(0, 500)}`
        },
        gateway: {
          reachable: false,
          operatorId: context.operatorId,
          gatewayId: context.gatewayId,
          error: `${response.status} ${body.slice(0, 500)}`
        }
      };
    }
    return normalizeOperatorSignals(parseJson(body), signalUrl, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      sampledAt: new Date().toISOString(),
      source: signalUrl,
      capability: {
        available: false,
        error: message
      },
      gateway: {
        reachable: false,
        operatorId: context.operatorId,
        gatewayId: context.gatewayId,
        error: message
      }
    };
  }
}

function normalizeOperatorSignals(
  input: unknown,
  source: string,
  context: { operatorId?: string; gatewayId?: string }
): OperatorValidationSignals {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const capability = record.capability && typeof record.capability === "object" ? (record.capability as Record<string, unknown>) : {};
  const gateway = record.gateway && typeof record.gateway === "object" ? (record.gateway as Record<string, unknown>) : {};
  return {
    sampledAt: stringRecordField(record, "sampledAt") ?? new Date().toISOString(),
    source: stringRecordField(record, "source") ?? source,
    capability: {
      available: booleanRecordField(capability, "available", false),
      reportId: stringRecordField(capability, "reportId"),
      signer: stringRecordField(capability, "signer"),
      reportedAt: stringRecordField(capability, "reportedAt"),
      expiresAt: stringRecordField(capability, "expiresAt"),
      operatorId: stringRecordField(capability, "operatorId"),
      gatewayId: stringRecordField(capability, "gatewayId"),
      managerIds: stringArrayRecordField(capability, "managerIds"),
      routeCapacity: optionalNumberRecordField(capability, "routeCapacity"),
      activeRouteCount: optionalNumberRecordField(capability, "activeRouteCount"),
      processorMatched: optionalBooleanRecordField(capability, "processorMatched"),
      publicAddressMatched: optionalBooleanRecordField(capability, "publicAddressMatched"),
      error: stringRecordField(capability, "error")
    },
    gateway: {
      reachable: booleanRecordField(gateway, "reachable", false),
      operatorId: stringRecordField(gateway, "operatorId") ?? context.operatorId,
      gatewayId: stringRecordField(gateway, "gatewayId") ?? context.gatewayId,
      configVersion: stringRecordField(gateway, "configVersion"),
      routeInstalled: optionalBooleanRecordField(gateway, "routeInstalled"),
      routeActive: optionalBooleanRecordField(gateway, "routeActive"),
      routeExpiresAt: stringRecordField(gateway, "routeExpiresAt"),
      matchedHostnames: stringArrayRecordField(gateway, "matchedHostnames"),
      activeRouteCount: optionalNumberRecordField(gateway, "activeRouteCount"),
      storedRouteCount: optionalNumberRecordField(gateway, "storedRouteCount"),
      processorDiscoveryFresh: optionalBooleanRecordField(gateway, "processorDiscoveryFresh"),
      reportedProcessorCount: optionalNumberRecordField(gateway, "reportedProcessorCount"),
      error: stringRecordField(gateway, "error")
    }
  };
}

function validationMode(): "route_open" | "reachability" {
  const mode = configValue("VALIDATION_MODE") ?? "route_open";
  if (mode !== "route_open" && mode !== "reachability") {
    throw new Error(`VALIDATION_MODE must be route_open or reachability, got ${mode}`);
  }
  return mode;
}

function readConfig(): Record<string, string> {
  const raw = envValue("SWITCHBOARD_CONFIG") ?? buildConfigValue();
  if (!raw) {
    return {};
  }
  const json = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );
}

function buildConfigValue(): string | undefined {
  return typeof __SWITCHBOARD_BUILD_CONFIG__ === "string" && __SWITCHBOARD_BUILD_CONFIG__.length > 0
    ? __SWITCHBOARD_BUILD_CONFIG__
    : undefined;
}

function configValue(...names: string[]): string | undefined {
  for (const name of names) {
    const env = envValue(name);
    if (env && env.length > 0) {
      return env;
    }
    const value = config[name];
    if (value && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function envValue(name: string): string | undefined {
  const processValue = process.env[name];
  if (processValue) {
    return processValue;
  }

  const acurastEnv = (globalThis as any)._STD_?.env?.[name];
  if (typeof acurastEnv === "string" && acurastEnv.length > 0) {
    return acurastEnv;
  }

  const environment = (globalThis as any).environment;
  if (typeof environment === "function") {
    const value = environment(name);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  return undefined;
}

function requiredConfig(...names: string[]): string {
  const value = configValue(...names);
  if (!value) {
    throw new Error(`Missing required configuration: ${names.join(" or ")}`);
  }
  return value;
}

function numberConfig(name: string, fallback: number): number {
  const value = configValue(name);
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function requiredStringRecordField(record: Record<string, unknown>, name: string): string {
  const value = stringRecordField(record, name);
  if (!value) {
    throw new Error(`Expected string field ${name}`);
  }
  return value;
}

function stringRecordField(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberRecordField(record: Record<string, unknown>, name: string, fallback: number): number {
  const value = record[name];
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function optionalNumberRecordField(record: Record<string, unknown>, name: string): number | undefined {
  const value = record[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanRecordField(record: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = record[name];
  return typeof value === "boolean" ? value : fallback;
}

function optionalBooleanRecordField(record: Record<string, unknown>, name: string): boolean | undefined {
  const value = record[name];
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayRecordField(record: Record<string, unknown>, name: string): string[] | undefined {
  const value = record[name];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function acurastDeploymentId(): string | undefined {
  const getId = (globalThis as any)._STD_?.job?.getId;
  if (typeof getId !== "function") {
    return undefined;
  }
  const id = getId();
  return typeof id === "string" ? id : JSON.stringify(id);
}

function acurastDeviceAddress(): string | undefined {
  const getAddress = (globalThis as any)._STD_?.device?.getAddress;
  if (typeof getAddress !== "function") {
    return undefined;
  }
  const address = getAddress();
  return typeof address === "string" ? address : JSON.stringify(address);
}

async function allowAcurastHostnames(hostnames: Array<string | undefined>): Promise<Record<string, unknown>> {
  const addAllowedHostnames = (globalThis as any)._STD_?.net?.addAllowedHostnames;
  const uniqueHostnames = [...new Set(hostnames.filter((hostname): hostname is string => Boolean(hostname)))];
  if (typeof addAllowedHostnames !== "function") {
    return {
      available: false,
      hostnames: uniqueHostnames
    };
  }

  try {
    await Promise.resolve(addAllowedHostnames(uniqueHostnames));
    return {
      available: true,
      ok: true,
      hostnames: uniqueHostnames
    };
  } catch (error) {
    console.warn(`Acurast hostname allowlist failed: ${safeErrorMessage(error)}`);
    return {
      available: true,
      ok: false,
      hostnames: uniqueHostnames,
      error: safeError(error)
    };
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.split("\n").slice(0, 4).join("\n")
    };
  }
  return {
    message: String(error)
  };
}

function createRemoteLogger(): (event: string, details?: Record<string, unknown>) => Promise<void> {
  const logUrl = configValue("SWITCHBOARD_LOG_URL");
  const writeToken = configValue("SWITCHBOARD_LOG_TOKEN");
  const encryptionKey = configValue("SWITCHBOARD_LOG_ENCRYPTION_KEY");
  const timeoutMs = numberConfig("SWITCHBOARD_LOG_TIMEOUT_MS", 5_000);
  const context = configValue("SWITCHBOARD_LOG_CONTEXT") ?? "validator";

  return createEncryptedSwitchboardLogger({
    logUrl,
    writeToken,
    encryptionKey,
    timeoutMs,
    context,
    baseRecord: () => ({
      deploymentId: configValue("VALIDATOR_DEPLOYMENT_ID") ?? acurastDeploymentId(),
      runtime: runtimeSummary()
    }),
    onError: (error, event) => {
      console.warn(`Encrypted Switchboard log failed for ${event}: ${safeErrorMessage(error)}`);
    }
  });
}

async function logEvent(event: string, details: Record<string, unknown> = {}): Promise<void> {
  console.log(JSON.stringify({ event, ...details }));
  await remoteLog(event, details);
}

function runtimeSummary(): Record<string, unknown> {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    acurastJobApi: Boolean((globalThis as any)._STD_?.job),
    acurastDeviceApi: Boolean((globalThis as any)._STD_?.device),
    acurastNetApi: Boolean((globalThis as any)._STD_?.net)
  };
}

function envPresence(names: string[]): Record<string, boolean> {
  return Object.fromEntries(names.map((name) => [name, Boolean(configValue(name))]));
}

function remoteLogEnvNames(): string[] {
  return [
    "SWITCHBOARD_LOG_URL",
    "SWITCHBOARD_LOG_TOKEN",
    "SWITCHBOARD_LOG_ENCRYPTION_KEY",
    "SWITCHBOARD_LOG_TIMEOUT_MS",
    "SWITCHBOARD_LOG_CONTEXT"
  ];
}

function urlHostname(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) {
    return undefined;
  }
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return undefined;
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

main().catch(async (error: unknown) => {
  console.error(safeErrorMessage(error));
  await remoteLog("validator-failed", { error: safeError(error) });
  process.exitCode = 1;
});
