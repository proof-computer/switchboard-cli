#!/usr/bin/env node
import "dotenv/config";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { decodeAddress } from "@polkadot/util-crypto";
import { ethers } from "ethers";

import { getSwitchboardTarget } from "../../src/chains.js";
import { normalizeDnsHostname } from "../../src/cloudflare-dns.js";
import {
  CANONICAL_CONSUMER_INGRESS_DOMAIN_POOL
} from "../../src/domain-pool.js";
import { compactId, createWaitLogCoalescer, orange, statusLine, switchboardColorEnabled } from "../../cli/src/output.js";

interface ParsedArgs {
  flags: Map<string, string | boolean>;
}

export interface HarnessConfig {
  rootDir: string;
  runId: string;
  runDir: string;
  network: "mainnet" | "canary";
  targetName: string;
  registryAddress: string;
  relayUrl: string;
  operatorId: string;
  gatewayId: string;
  capabilityReportId: string;
  capabilityReportExpiresAt: string;
  operatorPublicAddresses: string[];
  operatorSshHost: string;
  operatorPublicIp: string;
  operatorProjectDir: string;
  operatorComposeEnvFile: string;
  operatorComposeProfile: string;
  operatorRouteMetadataFile: string;
  operatorRouteActivationMode: "relay-reconciled" | "control-plane" | "gateway-agent" | "metadata-file";
  operatorRouteIntentUrl: string;
  managerId: string;
  hostname: string;
  validationHostname: string;
  port: number;
  durationMinutes?: number;
  leaseSeconds?: number;
  paymentAmount?: string;
  paymentMode: "public-price" | "quote";
  expectedQuoteAmount?: string;
  scheduleBufferMinutes?: number;
  startDelayMs: number;
  executionMs: number;
  maxAllowedStartDelayMs: number;
  instantMatchStartDelayMs: number;
  maxCostPerExecution: string;
  pollIntervalMs: number;
  runtimeTimeoutMs: number;
  registrationTimeoutMs: number;
  routeTimeoutMs: number;
  certificateMode: "self-signed" | "job-acme";
  certificateHostnames: string[];
  publicProbeInsecure: boolean;
  jobControlToken: string;
  validatorMode: "local" | "acurast" | "skip";
  activationEnabled: boolean;
  fulfillmentEnabled: boolean;
  fulfillmentDelayMs: number;
  fulfillmentIntervalMs: number;
  dns: DeployDnsConfig;
  assumeYes: boolean;
  group?: DeploymentGroupConfig;
}

interface DeployDnsConfig {
  enabled: boolean;
  zoneId?: string;
  zoneName?: string;
  zoneNames?: string[];
  ttl: number;
  proxied: boolean;
  waitTimeoutMs: number;
  resolvers: string[];
  curlDohUrl?: string;
  publicProbeMode: "dns" | "resolve";
  publicProbeModeExplicit: boolean;
}

interface RegistrationObservation {
  txHash?: string;
  blockNumber?: number;
  event?: unknown;
  source: "hub-read" | "runtime-status";
}

interface AcurastJobConfigFile {
  PORT: string;
  SWITCHBOARD_HOST: string;
  SWITCHBOARD_AUTO_REGISTER: string;
  SWITCHBOARD_RELAY_URL: string;
  SWITCHBOARD_INTENT_ID?: string;
  SWITCHBOARD_INTENT_GROUP_ID?: string;
  SWITCHBOARD_INTENT_POLL_MS: string;
  SWITCHBOARD_INTENT_MAX_ATTEMPTS: string;
  SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS: string;
  SWITCHBOARD_RELAY_DIAGNOSTICS: string;
  SWITCHBOARD_RELAY_DIAGNOSTICS_TIMEOUT_MS: string;
  SWITCHBOARD_DEMO_VERSION?: string;
  SWITCHBOARD_TLS_CERT_PEM_BASE64?: string;
  SWITCHBOARD_TLS_KEY_PEM_BASE64?: string;
  SWITCHBOARD_CERTIFICATE_MODE?: string;
  SWITCHBOARD_CERTIFICATE_HOSTNAMES?: string;
  SWITCHBOARD_CERTIFICATE_REQUEST_TIMEOUT_MS?: string;
}

export interface DeploymentIntentBootstrap {
  intentId: string;
  cliToken: string;
  groupId?: string;
  env: {
    SWITCHBOARD_RELAY_URL: string;
    SWITCHBOARD_INTENT_ID: string;
    SWITCHBOARD_INTENT_TOKEN: string;
  };
  intent?: Record<string, unknown>;
}

export interface PrecreatedDeployIntentPayload {
  workflowId: string;
  jobId: string;
  capacity: {
    operatorId: string;
    processorId: string;
    processor?: string;
    gatewayId?: string;
    managerId?: string;
  };
  deploymentIntent: DeploymentIntentBootstrap;
  sensitiveFields?: string[];
}

export interface PrecreatedDeployGroupPayload {
  workflowId: string;
  deploymentMode: "group";
  jobId: string;
  capacity: {
    operatorId: string;
    processorId: string;
    processor?: string;
    gatewayId?: string;
    managerId?: string;
  };
  group: {
    expectedReplicas: number;
    minReady: number;
    members: DeploymentGroupMemberConfig[];
  };
  deploymentIntentGroup: DeploymentIntentGroupBootstrap;
  sensitiveFields?: string[];
}

interface DeploymentIntentGroupBootstrap {
  groupId: string;
  cliToken: string;
  env: {
    SWITCHBOARD_RELAY_URL: string;
    SWITCHBOARD_INTENT_GROUP_ID: string;
    SWITCHBOARD_INTENT_TOKEN: string;
  };
  group?: Record<string, unknown>;
  members: DeploymentIntentGroupMemberBootstrap[];
}

interface DeploymentIntentGroupMemberBootstrap {
  memberId: string;
  intentId: string;
  cliToken: string;
  jobId: string;
  operatorId: string;
  processorId: string;
  processor?: string;
  gatewayId?: string;
  managerId?: string;
  validationHostname?: string;
  intent?: Record<string, unknown>;
}

export interface DeploymentGroupMemberConfig {
  memberId: string;
  operatorId: string;
  processorId: string;
  processor: string;
  gatewayId?: string;
  managerId?: string;
  reportId?: string;
  reportExpiresAt?: string;
  publicAddresses?: string[];
}

export interface DeploymentGroupConfig {
  expectedReplicas: number;
  minReady: number;
  members: DeploymentGroupMemberConfig[];
}

export interface DeploymentIntentCreateBodyConfig {
  leaseSeconds?: number;
  runId: string;
  operatorId: string;
  managerId: string;
  gatewayId: string;
  capabilityReportId: string;
  capabilityReportExpiresAt: string;
  operatorPublicAddresses: string[];
  targetName: string;
}

interface RuntimeObservation {
  jobSigner: string;
  serverListening: boolean;
  candidateIps: string[];
}

interface DeploymentSchedule {
  startIso: string;
  endIso: string;
  startUnixSeconds?: number;
  endUnixSeconds?: number;
  startMs?: number;
  endMs?: number;
}

const SWITCHBOARD_DEPLOY_PREFIX = "[switchboard-deploy]";
const DEFAULT_JOB_CONTROL_PLANE_REGISTER_TIMEOUT_MS = 300_000;
const DEFAULT_ROUTE_ACTIVATION_TIMEOUT_MS = 600_000;
const JOB_CONTROL_PLANE_REGISTER_TIMEOUT_MESSAGE =
  "the job did not call the register with the control plane. Please report issues.";

installSwitchboardDeployPrefixColor();

function installSwitchboardDeployPrefixColor(): void {
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  console.log = (...values: unknown[]) => {
    originalLog(...colorSwitchboardDeployPrefix(values, process.stdout));
  };
  console.error = (...values: unknown[]) => {
    originalError(...colorSwitchboardDeployPrefix(values, process.stderr));
  };
}

function colorSwitchboardDeployPrefix(values: unknown[], stream: NodeJS.WriteStream): unknown[] {
  if (values.length === 0 || typeof values[0] !== "string" || !values[0].startsWith(SWITCHBOARD_DEPLOY_PREFIX)) {
    return values;
  }
  if (!switchboardDeployColorEnabled(stream)) {
    return values;
  }
  return [
    `${orange(SWITCHBOARD_DEPLOY_PREFIX, stream)}${values[0].slice(SWITCHBOARD_DEPLOY_PREFIX.length)}`,
    ...values.slice(1)
  ];
}

function switchboardDeployColorEnabled(stream: NodeJS.WriteStream): boolean {
  return switchboardColorEnabled(stream);
}

function deployStatus(status: "info" | "ok" | "wait" | "warn" | "error", label: string, detail?: string): string {
  return `${SWITCHBOARD_DEPLOY_PREFIX} ${statusLine(status, label, detail)}`;
}

const waitLogCoalescer = createWaitLogCoalescer();

function logWaitStatus(label: string, detail: string, state = detail): void {
  if (
    waitLogCoalescer.shouldEmit({
      key: label,
      state,
      intervalMs: numberEnv("SWITCHBOARD_DEPLOY_WAIT_LOG_INTERVAL_MS", 60_000)
    })
  ) {
    console.log(deployStatus("wait", label, detail));
  }
}

interface RouteMetadataFile {
  routes: RouteMetadata[];
}

interface RouteMetadata {
  routeId?: string;
  sessionId: string;
  hostname: string;
  publicHostname?: string;
  validationHostname?: string;
  customerHostnames?: string[];
  hostnameRole?: "legacy" | "ha_public" | "validation";
  upstreamHost: string;
  upstreamPort: number;
}

interface RouteIntentPayload extends RouteMetadata {
  expiresAt: number;
  source?: Record<string, unknown>;
}

interface DnsProvisionResult {
  name: string;
  role: "public" | "validation";
  content: string;
  ttl: number;
  proxied: boolean;
  zoneId: string;
  zoneName?: string;
  resolvedBy: Record<string, string[]>;
}

interface CertificateAuthorizationResult {
  ok: boolean;
  authorization?: unknown;
}

interface DnsProvisioningResult {
  public: DnsProvisionResult;
  validation?: DnsProvisionResult;
  records: DnsProvisionResult[];
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

const cliPackageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rootDir = process.env.SWITCHBOARD_WORK_DIR
  ? path.resolve(process.env.SWITCHBOARD_WORK_DIR)
  : cliPackageDir;
const switchboardDomainPool = CANONICAL_CONSUMER_INGRESS_DOMAIN_POOL;

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (boolFlag(parsed.flags, "help")) {
    printHelp();
    return;
  }
  const config = loadConfig(parsed.flags);
  if (!config.assumeYes) {
    throw new Error("Refusing to run the real Switchboard deploy flow without --yes or SWITCHBOARD_DEPLOY_ASSUME_YES=true");
  }

  const chain = getSwitchboardTarget(config.targetName);
  const chainId = chain.expectedChainId?.toString() ?? String(process.env.CHAIN_ID ?? "");
  if (!chainId) {
    throw new Error(`Target ${config.targetName} does not define an expected chain ID; set CHAIN_ID`);
  }

  let sessionId = "";
  const precreatedIntent = parsePrecreatedDeployIntentPayload();
  const precreatedGroup = parsePrecreatedDeployGroupPayload();
  if (precreatedIntent && precreatedGroup) {
    throw new Error("Only one of SWITCHBOARD_DEPLOY_PRECREATED_INTENT_JSON or SWITCHBOARD_DEPLOY_PRECREATED_GROUP_JSON may be set");
  }
  const jobId = precreatedIntent?.jobId ?? ethers.hexlify(randomBytes(32));
  const processor = await selectProcessor(config);
  if (config.group) {
    if (precreatedGroup) {
      validatePrecreatedDeployGroupPayload(precreatedGroup, config);
    }
    await runDeploymentIntentGroup(config, processor, { json: boolFlag(parsed.flags, "json"), precreatedGroup });
    return;
  }
  if (precreatedGroup) {
    throw new Error("SWITCHBOARD_DEPLOY_PRECREATED_GROUP_JSON requires group deploy mode");
  }
  const processorId = accountIdBytes32(processor);
  if (precreatedIntent) {
    validatePrecreatedDeployIntentPayload(precreatedIntent, config, { processor, processorId });
  }
  const tls = config.certificateMode === "self-signed" ? await createSelfSignedCertificate(config) : undefined;
  const deploymentIntent = precreatedIntent?.deploymentIntent ?? await createDeploymentIntent(config, {
    jobId,
    processorId
  });
  const buildConfigPath = path.join(config.runDir, "acurast-config.json");
  const extraBuildConfig = await readManagedExtraBuildConfig();
  const metadataPath = path.join(config.runDir, "metadata.json");
  const reportPath = path.join(config.runDir, "report.json");

  const jobConfig: AcurastJobConfigFile = {
    PORT: String(config.port),
    SWITCHBOARD_HOST: "0.0.0.0",
    SWITCHBOARD_AUTO_REGISTER: "true",
    SWITCHBOARD_RELAY_URL: deploymentIntent.env.SWITCHBOARD_RELAY_URL,
    SWITCHBOARD_INTENT_ID: deploymentIntent.env.SWITCHBOARD_INTENT_ID,
    SWITCHBOARD_INTENT_POLL_MS: String(numberEnv("SWITCHBOARD_DEPLOY_INTENT_POLL_MS", 30_000)),
    SWITCHBOARD_INTENT_MAX_ATTEMPTS: "0",
    SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS: String(numberEnv("SWITCHBOARD_DEPLOY_INTENT_REQUEST_TIMEOUT_MS", 60_000)),
    SWITCHBOARD_RELAY_DIAGNOSTICS: "true",
    SWITCHBOARD_RELAY_DIAGNOSTICS_TIMEOUT_MS: String(numberEnv("SWITCHBOARD_DEPLOY_RELAY_DIAGNOSTICS_TIMEOUT_MS", 10_000)),
    SWITCHBOARD_DEMO_VERSION: stringEnv("SWITCHBOARD_DEMO_VERSION"),
    ...(tls
      ? {
          SWITCHBOARD_TLS_CERT_PEM_BASE64: tls.certBase64,
          SWITCHBOARD_TLS_KEY_PEM_BASE64: tls.keyBase64
        }
      : {
          SWITCHBOARD_CERTIFICATE_MODE: "job-acme",
          SWITCHBOARD_CERTIFICATE_REQUEST_TIMEOUT_MS: String(numberEnv("SWITCHBOARD_DEPLOY_CERTIFICATE_REQUEST_TIMEOUT_MS", 360_000))
        })
  };
  await writeJson(buildConfigPath, {
    ...jobConfig,
    ...extraBuildConfig
  });
  await writeJson(metadataPath, {
    runId: config.runId,
    runDir: config.runDir,
    jobId,
    endpointAllocation: config.hostname
      ? { mode: "explicit", hostname: config.hostname, validationHostname: config.validationHostname || config.hostname }
      : { mode: "relay-allocated" },
    deploymentIntent: {
      intentId: deploymentIntent.intentId,
      relayUrl: config.relayUrl,
      intent: deploymentIntent.intent,
      localSecret: {
        description: "Deployer-local deployment intent token. Do not publish this report.",
        cliToken: deploymentIntent.cliToken
      },
      sensitiveFields: ["deploymentIntent.localSecret.cliToken"]
    },
    operatorId: config.operatorId,
    processor,
    processorId,
    registryAddress: config.registryAddress,
    relayUrl: config.relayUrl,
    jobControl: reportJobControl(config),
    tls: {
      mode: config.certificateMode,
      certificateHostnames: config.certificateHostnames,
      certPath: tls?.certPath,
      keyPath: tls?.keyPath
    },
    dns: {
      enabled: config.dns.enabled,
      zoneId: config.dns.zoneId,
      zoneName: config.dns.zoneName,
      zoneNames: config.dns.zoneNames,
      ttl: config.dns.ttl,
      proxied: config.dns.proxied,
      resolvers: config.dns.resolvers,
      curlDohUrl: config.dns.curlDohUrl,
      publicProbeMode: config.dns.publicProbeMode
    },
    publicProbeInsecure: config.publicProbeInsecure,
    lifecycle: {
      durationMinutes: config.durationMinutes,
      leaseSeconds: config.leaseSeconds,
      paymentAmount: config.paymentAmount,
      paymentMode: config.paymentMode,
      expectedQuoteAmount: config.expectedQuoteAmount,
      executionMs: config.executionMs,
      scheduleBufferMinutes: config.scheduleBufferMinutes
    }
  });

  console.log(deployStatus("info", "Run context", `run=${config.runId} relay=${config.relayUrl}`));
  console.log(deployStatus("info", "Selected processor", compactId(processor)));
  console.log(deployStatus("info", "Deployment intent", deploymentIntent.intentId));

  await assertRelayHealthy(config.relayUrl);
  const dnsRecords: DnsProvisioningResult | undefined = undefined;
  const certificateAuthorization: Record<string, unknown> | undefined = undefined;
  let deployment: Awaited<ReturnType<typeof deployAcurastJob>>;
  try {
    deployment = await deployAcurastJob(config, buildConfigPath, processor, deploymentIntent, jobConfig);
  } catch (error) {
    await writeFailureReport(config, {
      stage: "acurast-deploy",
      error: safeError(error),
      dns: dnsRecords,
      certificateAuthorization,
      session: {
        ...(sessionId ? { sessionId } : {}),
        jobId,
        operatorId: config.operatorId,
        processor,
        processorId,
        ...deploymentSessionHostnames(config)
      }
    });
    throw error;
  }
  console.log(deployStatus("ok", "Submitted to Acurast", `deployment=${deployment.deploymentId}`));
  const deploymentSchedule = parseDeploymentSchedule(deployment.output);
  await updateDeploymentIntentDeployment(config, deploymentIntent, {
    deploymentId: deployment.deploymentId,
    jobId,
    processor,
    processorId
  });

  if (deployRunnerMode() === "acurast-submit-only") {
    const report = {
      ok: true,
      runId: config.runId,
      mode: "acurast-submit-only",
      deployment,
      session: {
        jobId,
        operatorId: config.operatorId,
        gatewayId: config.gatewayId,
        processor,
        processorId,
        ...deploymentSessionHostnames(config)
      },
      hostnames: deploymentReportHostnames(config),
      relay: {
        url: config.relayUrl
      },
      deploymentIntent: {
        intentId: deploymentIntent.intentId,
        relayUrl: config.relayUrl,
        localSecret: {
          description: "Deployer-local deployment intent token. Do not publish this report.",
          cliToken: deploymentIntent.cliToken
        },
        sensitiveFields: ["deploymentIntent.localSecret.cliToken"]
      },
      lifecycle: {
        durationMinutes: config.durationMinutes,
        leaseSeconds: config.leaseSeconds,
        paymentMode: config.paymentMode,
        expectedQuoteAmount: config.expectedQuoteAmount,
        executionMs: config.executionMs,
        scheduleBufferMinutes: config.scheduleBufferMinutes,
        schedule: deploymentSchedule
      },
      artifacts: {
        runDir: config.runDir,
        buildConfigPath,
        metadataPath,
        reportPath,
        certPath: tls?.certPath,
        keyPath: tls?.keyPath
      }
    };
    await writeJson(reportPath, report);
    console.log(deployStatus("ok", "Wrote deployment report", reportPath));
    console.log(`[switchboard-deploy] report=${reportPath}`);
    if (boolFlag(parsed.flags, "json")) {
      console.log(JSON.stringify(report, null, 2));
    }
    return;
  }

  let runtime: RuntimeObservation;
  try {
    runtime = await waitForRuntimeObservation(deploymentIntent, config, deploymentSchedule);
  } catch (error) {
    await writeFailureReport(config, {
      stage: "runtime-observation",
      error: safeError(error),
      deployment,
      schedule: deploymentSchedule,
      session: {
        ...(sessionId ? { sessionId } : {}),
        jobId,
        operatorId: config.operatorId,
        processor,
        processorId,
        ...deploymentSessionHostnames(config)
      },
      acurastInspection: await inspectAcurastDeployment(config, deployment.deploymentId).catch((inspectError) => ({
        error: safeError(inspectError)
      }))
    });
    throw error;
  }
  console.log(deployStatus("ok", "Job claimed runtime", `signer=${runtime.jobSigner} ips=${runtime.candidateIps.join(", ")}`));

  let upstreamIp: string;
  let funding: Record<string, unknown>;
  let registration: Awaited<ReturnType<typeof waitForRegistration>>;
  let publicProbe: Awaited<ReturnType<typeof waitForPublicRoute>>;
  let dnsMaterialization: Record<string, unknown> | undefined;
  let validatorWork: Awaited<ReturnType<typeof createValidatorWorkPackages>> | undefined;
  let validation: Awaited<ReturnType<typeof runValidationStage>> | undefined;
  let activation: Awaited<ReturnType<typeof activatePaidSession>> | undefined;
  let fulfillment: Awaited<ReturnType<typeof recordFulfillmentStage>> | undefined;

  try {
    if ((config.operatorRouteActivationMode === "control-plane" || config.operatorRouteActivationMode === "relay-reconciled") && !config.operatorSshHost) {
      upstreamIp = selectUpstreamCandidate(config, runtime.candidateIps);
    } else if (config.certificateMode === "job-acme") {
      upstreamIp = await selectHttpReachableUpstream(config, runtime.candidateIps);
    } else {
      upstreamIp = await selectReachableUpstream(config, runtime.candidateIps);
    }
    console.log(deployStatus("info", "Selected upstream", `${upstreamIp}:${config.port}${config.certificateMode === "job-acme" ? " candidate" : ""}`));
    await waitForDeploymentIntentClaimed(config, deploymentIntent, runtime.jobSigner);

    funding = await fundSession(config, {
      sessionId,
      jobId,
      processorId,
      jobSigner: runtime.jobSigner,
      deploymentIntent
    });
    sessionId = requiredStringField(funding, "sessionId");
    applyDeploymentIntentHostnames(config, funding);
    console.log(deployStatus("ok", "Funded Hub session", `tx=${funding.txHash ?? "already-funded"}`));
    const fundingRefresh = await refreshDeploymentIntentFunding(config, deploymentIntent);
    applyDeploymentIntentHostnames(config, funding, fundingRefresh);
    const deploymentIntentStatus = await readDeploymentIntent(config, deploymentIntent);
    applyDeploymentIntentHostnames(config, funding, deploymentIntentStatus);
    const allocatedHostnames = requireDeploymentHostnames(config, "funded deployment intent");
    console.log(deployStatus("info", "Endpoint hostname", allocatedHostnames.hostname));
    dnsMaterialization = await waitForDeploymentIntentDnsPropagated(config, deploymentIntent, allocatedHostnames.hostname);

    registration = await waitForRegistration(config, sessionId);
    console.log(deployStatus("ok", "Registered on Hub", registration.txHash ? `tx=${registration.txHash}` : "observed on-chain"));

    if (config.operatorRouteActivationMode === "relay-reconciled") {
      await waitForDeploymentIntentRouteReconciled(config, deploymentIntent);
    } else {
      const registeredSession = await readSession(config, sessionId);
      const routeExpiresAt =
        sessionRouteExpiresAt(registeredSession) ||
        Math.floor(Date.now() / 1000) + (config.leaseSeconds ?? 3600) + Math.max(3600, (config.scheduleBufferMinutes ?? 10) * 60);
      await activateOperatorRoute(config, {
        routeId: `switchboard-${deployment.deploymentId}`,
        sessionId,
        hostname: config.hostname,
        publicHostname: config.hostname,
        validationHostname: config.validationHostname,
        customerHostnames: config.certificateHostnames.filter((hostname) => hostname !== config.hostname),
        hostnameRole: "ha_public",
        upstreamHost: upstreamIp,
        upstreamPort: config.port,
        expiresAt: routeExpiresAt,
        source: {
          mode: "switchboard-deploy",
          deploymentId: deployment.deploymentId,
          deploymentTxHash: deployment.txHash,
          fundingTxHash: funding.txHash,
          registrationTxHash: registration.txHash,
          jobSigner: runtime.jobSigner,
          operatorId: config.operatorId,
          processorId,
          gatewayId: stringField(funding.allocation, "gatewayId"),
          capabilityReportId: stringField(funding.allocation, "reportId")
        }
      });
    }
    console.log(deployStatus("ok", "Activated route", config.operatorRouteActivationMode));

    if (config.certificateMode === "job-acme") {
      if (config.operatorSshHost) {
        upstreamIp = await selectReachableUpstream(config, [upstreamIp, ...runtime.candidateIps]);
        console.log(deployStatus("ok", "Verified upstream HTTPS", `${upstreamIp}:${config.port}`));
      } else {
        console.log(deployStatus("info", "Skipping upstream HTTPS probe", "public route probe will verify ingress"));
      }
    }

    publicProbe = await waitForPublicRoute(config, sessionId, dnsMaterialization);
    console.log(deployStatus("ok", "Verified HTTPS route", `nonce=${publicProbe.nonce}`));
    const enrichedRegistration = await enrichRegistrationFromPublicStatus(config, registration, dnsMaterialization);
    if (!registration.txHash && enrichedRegistration.txHash) {
      console.log(deployStatus("info", "Registration tx", enrichedRegistration.txHash));
    }
    registration = enrichedRegistration;

    validatorWork = await createValidatorWorkPackages(config, {
      sessionId,
      hostname: config.hostname,
      deploymentId: deployment.deploymentId
    });
    if (validatorWork) {
      const workCount = Array.isArray(validatorWork.work) ? validatorWork.work.length : 1;
      console.log(deployStatus("ok", "Created validator work", `${workCount} package${workCount === 1 ? "" : "s"}`));
    }

    validation = await runValidationStage(config, {
      reportPath,
      sessionId,
      hostname: config.hostname,
      deploymentId: deployment.deploymentId
    });
    if (validation) {
      console.log(deployStatus("ok", "Validation complete", `report=${validation.reportId ?? "ok"} success=${validation.success}`));
    }

    if (config.activationEnabled) {
      activation = await activatePaidSession(config, {
        sessionId,
        hostname: config.hostname,
        validationReportId: stringField(validation, "reportId")
      });
      console.log(deployStatus("ok", "Activated Hub session", `tx=${activation.txHash ?? "already-active"}`));
    }

    if (config.fulfillmentEnabled) {
      fulfillment = await recordFulfillmentLoop(config, {
        sessionId,
        hostname: config.hostname
      });
      console.log(deployStatus("ok", "Recorded fulfillment", `${Array.isArray(fulfillment.records) ? fulfillment.records.length : 0} records`));
    }
  } catch (error) {
    await writeFailureReport(config, {
      stage: "post-runtime-route-registration",
      error: safeError(error),
      deployment,
      dns: dnsRecords,
      dnsMaterialization,
      certificateAuthorization,
      session: {
        sessionId,
        jobId,
        jobSigner: runtime.jobSigner,
        operatorId: config.operatorId,
        processor,
        processorId,
        ...deploymentSessionHostnames(config)
      },
      runtime,
      acurastInspection: await inspectAcurastDeployment(config, deployment.deploymentId).catch((inspectError) => ({
        error: safeError(inspectError)
      }))
    });
    throw error;
  }

  const finalHostnames = requireDeploymentHostnames(config, "deployment report");
  const report = {
    ok: true,
    runId: config.runId,
    deployment,
    session: {
      sessionId,
      jobId,
      jobSigner: runtime.jobSigner,
      operatorId: config.operatorId,
      processor,
      processorId,
      hostname: finalHostnames.hostname,
      validationHostname: finalHostnames.validationHostname
    },
    hostnames: {
      public: finalHostnames.hostname,
      validation: finalHostnames.validationHostname
    },
    relay: {
      url: config.relayUrl
    },
    deploymentIntent: {
      intentId: deploymentIntent.intentId,
      relayUrl: config.relayUrl,
      localSecret: {
        description: "Deployer-local deployment intent token. Do not publish this report.",
        cliToken: deploymentIntent.cliToken
      },
      sensitiveFields: ["deploymentIntent.localSecret.cliToken"]
    },
    dns: dnsRecords,
    dnsMaterialization,
    certificateAuthorization,
    operator: {
      sshHost: config.operatorSshHost,
      publicIp: config.operatorPublicIp,
      upstream: `${upstreamIp}:${config.port}`
    },
    funding,
    registration,
    publicProbe,
    validation,
    validatorWork,
    activation,
    fulfillment,
    lifecycle: {
      durationMinutes: config.durationMinutes,
      leaseSeconds: config.leaseSeconds,
      paymentMode: config.paymentMode,
      paymentAmount: stringField(funding, "paymentAmount") ?? config.paymentAmount,
      expectedQuoteAmount: config.expectedQuoteAmount,
      nativePricePerSecond: stringField(funding, "nativePricePerSecond"),
      executionMs: config.executionMs,
      scheduleBufferMinutes: config.scheduleBufferMinutes,
      schedule: deploymentSchedule,
      hubExpiresAt: stringField(funding.session, "expiresAt")
    },
    artifacts: {
      runDir: config.runDir,
      buildConfigPath,
      metadataPath,
      reportPath,
      certPath: tls?.certPath,
      keyPath: tls?.keyPath
    }
  };
  await writeJson(reportPath, report);
  console.log(deployStatus("ok", "Wrote deployment report", reportPath));
  console.log(`[switchboard-deploy] report=${reportPath}`);
  if (boolFlag(parsed.flags, "json")) {
    console.log(JSON.stringify(report, null, 2));
  }
}

async function runDeploymentIntentGroup(
  config: HarnessConfig,
  processor: string,
  options: { json: boolean; precreatedGroup?: PrecreatedDeployGroupPayload }
): Promise<void> {
  const group = options.precreatedGroup?.deploymentIntentGroup ?? await createDeploymentIntentGroup(config);
  const buildConfigPath = path.join(config.runDir, "acurast-config.json");
  const extraBuildConfig = await readManagedExtraBuildConfig();
  const metadataPath = path.join(config.runDir, "metadata.json");
  const reportPath = path.join(config.runDir, "report.json");
  const jobConfig: AcurastJobConfigFile = {
    PORT: String(config.port),
    SWITCHBOARD_HOST: "0.0.0.0",
    SWITCHBOARD_AUTO_REGISTER: "true",
    SWITCHBOARD_RELAY_URL: group.env.SWITCHBOARD_RELAY_URL,
    SWITCHBOARD_INTENT_GROUP_ID: group.env.SWITCHBOARD_INTENT_GROUP_ID,
    SWITCHBOARD_INTENT_POLL_MS: String(numberEnv("SWITCHBOARD_DEPLOY_INTENT_POLL_MS", 30_000)),
    SWITCHBOARD_INTENT_MAX_ATTEMPTS: "0",
    SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS: String(numberEnv("SWITCHBOARD_DEPLOY_INTENT_REQUEST_TIMEOUT_MS", 60_000)),
    SWITCHBOARD_RELAY_DIAGNOSTICS: "true",
    SWITCHBOARD_RELAY_DIAGNOSTICS_TIMEOUT_MS: String(numberEnv("SWITCHBOARD_DEPLOY_RELAY_DIAGNOSTICS_TIMEOUT_MS", 10_000)),
    SWITCHBOARD_CERTIFICATE_MODE: "job-acme",
    SWITCHBOARD_CERTIFICATE_REQUEST_TIMEOUT_MS: String(numberEnv("SWITCHBOARD_DEPLOY_CERTIFICATE_REQUEST_TIMEOUT_MS", 360_000))
  };
  await writeJson(buildConfigPath, {
    ...jobConfig,
    ...extraBuildConfig
  });
  await writeJson(metadataPath, {
    runId: config.runId,
    runDir: config.runDir,
    deploymentIntentGroup: {
      groupId: group.groupId,
      relayUrl: config.relayUrl,
      group: group.group,
      members: group.members.map((member) => ({
        memberId: member.memberId,
        intentId: member.intentId,
        operatorId: member.operatorId,
        processorId: member.processorId,
        processor: member.processor,
        gatewayId: member.gatewayId
      })),
      localSecret: {
        description: "Deployer-local deployment intent group token. Do not publish this report.",
        cliToken: group.cliToken
      },
      sensitiveFields: ["deploymentIntentGroup.localSecret.cliToken"]
    },
    registryAddress: config.registryAddress,
    relayUrl: config.relayUrl,
    lifecycle: {
      durationMinutes: config.durationMinutes,
      leaseSeconds: config.leaseSeconds,
      paymentMode: config.paymentMode,
      expectedQuoteAmount: config.expectedQuoteAmount,
      executionMs: config.executionMs,
      scheduleBufferMinutes: config.scheduleBufferMinutes
    }
  });

  console.log(deployStatus("info", "Run context", `run=${config.runId} relay=${config.relayUrl}`));
  console.log(deployStatus("info", "Deployment intent group", `${group.groupId} replicas=${group.members.length}`));
  console.log(deployStatus("info", "Selected processors", group.members.map((member) => compactId(member.processor ?? member.processorId)).join(", ")));

  await assertRelayHealthy(config.relayUrl);
  let deployment: Awaited<ReturnType<typeof deployAcurastJob>>;
  try {
    deployment = await deployAcurastJob(config, buildConfigPath, processor, group, jobConfig);
  } catch (error) {
    await writeFailureReport(config, {
      stage: "acurast-deploy",
      error: safeError(error),
      group: groupOutput(group)
    });
    throw error;
  }
  console.log(deployStatus("ok", "Submitted to Acurast", `deployment=${deployment.deploymentId}`));
  const deploymentSchedule = parseDeploymentSchedule(deployment.output);
  await updateDeploymentIntentGroupDeployment(config, group, {
    deploymentId: deployment.deploymentId
  });

  if (deployRunnerMode() === "acurast-group-submit-only") {
    const report = {
      ok: true,
      runId: config.runId,
      mode: "acurast-group-submit-only",
      deployment,
      deploymentIntentGroup: {
        groupId: group.groupId,
        relayUrl: config.relayUrl,
        group: group.group,
        members: group.members.map((member) => ({
          memberId: member.memberId,
          intentId: member.intentId,
          jobId: member.jobId,
          operatorId: member.operatorId,
          processorId: member.processorId,
          processor: member.processor,
          gatewayId: member.gatewayId,
          validationHostname: member.validationHostname
        })),
        expectedReplicas: config.group!.expectedReplicas,
        minReady: config.group!.minReady,
        localSecret: {
          description: "Deployer-local deployment intent group token. Do not publish this report.",
          cliToken: group.cliToken
        },
        sensitiveFields: ["deploymentIntentGroup.localSecret.cliToken"]
      },
      relay: { url: config.relayUrl },
      lifecycle: {
        durationMinutes: config.durationMinutes,
        leaseSeconds: config.leaseSeconds,
        paymentMode: config.paymentMode,
        expectedQuoteAmount: config.expectedQuoteAmount,
        executionMs: config.executionMs,
        scheduleBufferMinutes: config.scheduleBufferMinutes,
        schedule: deploymentSchedule
      },
      artifacts: {
        runDir: config.runDir,
        buildConfigPath,
        metadataPath,
        reportPath
      }
    };
    await writeJson(reportPath, report);
    console.log(deployStatus("ok", "Wrote deployment report", reportPath));
    console.log(`[switchboard-deploy] report=${reportPath}`);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    }
    return;
  }

  let claimed = await waitForDeploymentIntentGroupClaims(config, group, config.group!.minReady, deploymentSchedule);
  console.log(deployStatus("ok", "Runtime claims reached min-ready", `${claimed.length}/${config.group!.expectedReplicas}`));

  const fundedMembers: Array<Record<string, unknown>> = [];
  const fundedIntentIds = new Set<string>();
  let dnsMaterialization: Record<string, unknown> | undefined;
  const fundClaimedMembers = async (members: Record<string, unknown>[]) => {
    for (const member of members) {
      const intentId = requiredStringField(member, "intentId");
      if (fundedIntentIds.has(intentId)) {
        continue;
      }
      const runtimeSigner = requiredStringField(member, "runtimeSigner");
      const bootstrap = requiredGroupMemberBootstrap(group, intentId);
      const funding = await fundSession(config, {
        sessionId: "",
        jobId: bootstrap.jobId,
        operatorId: bootstrap.operatorId,
        processorId: bootstrap.processorId,
        jobSigner: runtimeSigner,
        deploymentIntent: groupMemberDeploymentIntent(group, bootstrap)
      });
      const sessionId = requiredStringField(funding, "sessionId");
      const memberDeploymentIntent = groupMemberDeploymentIntent(group, bootstrap);
      applyDeploymentIntentHostnames(config, funding);
      const fundingRefresh = await refreshDeploymentIntentFunding(config, memberDeploymentIntent);
      applyDeploymentIntentHostnames(config, funding, fundingRefresh);
      const deploymentIntentStatus = await readDeploymentIntent(config, memberDeploymentIntent);
      applyDeploymentIntentHostnames(config, funding, deploymentIntentStatus);
      const allocatedHostnames = requireDeploymentHostnames(config, `deployment intent group member ${bootstrap.memberId}`);
      fundedMembers.push({
        ...member,
        memberId: bootstrap.memberId,
        intentId: bootstrap.intentId,
        sessionId,
        funding,
        endpointHostname: allocatedHostnames.hostname,
        validationHostname: allocatedHostnames.validationHostname,
        operatorId: bootstrap.operatorId,
        processorId: bootstrap.processorId,
        processor: bootstrap.processor,
        gatewayId: bootstrap.gatewayId
      });
      fundedIntentIds.add(intentId);
      console.log(deployStatus("ok", "Funded HA member", `${bootstrap.memberId} session=${compactId(sessionId)}`));
      dnsMaterialization ??= await waitForDeploymentIntentDnsPropagated(config, memberDeploymentIntent, allocatedHostnames.hostname);
    }
  };
  try {
    await fundClaimedMembers(claimed);
    claimed = await waitForDeploymentIntentGroupClaims(config, group, config.group!.expectedReplicas, deploymentSchedule, {
      timeoutMs: numberEnv("SWITCHBOARD_DEPLOY_GROUP_CLAIM_GRACE_MS", 120_000),
      allowPartial: true
    });
    await fundClaimedMembers(claimed);

    for (const member of fundedMembers) {
      const sessionId = requiredStringField(member, "sessionId");
      const registration = await waitForRegistration(config, sessionId);
      member.registration = registration;
      console.log(deployStatus("ok", "Registered HA member", `${stringField(member, "memberId")} ${registration.txHash ? `tx=${registration.txHash}` : "observed on-chain"}`));
      await waitForDeploymentIntentRouteReconciled(config, groupMemberDeploymentIntent(group, requiredGroupMemberBootstrap(group, requiredStringField(member, "intentId"))));
      member.route = { status: "active" };
    }

    const publicProbe = await waitForPublicRouteAnySession(
      config,
      fundedMembers.map((member) => requiredStringField(member, "sessionId")),
      dnsMaterialization
    );
    console.log(deployStatus("ok", "Verified HTTPS route", `nonce=${publicProbe.nonce}`));

    const primaryMemberHostnames = {
      hostname: requiredStringField(fundedMembers[0], "endpointHostname"),
      validationHostname: stringField(fundedMembers[0], "validationHostname") ?? requiredStringField(fundedMembers[0], "endpointHostname")
    };
    const report = {
      ok: fundedMembers.length >= config.group!.minReady,
      runId: config.runId,
      deployment,
      deploymentIntentGroup: {
        groupId: group.groupId,
        relayUrl: config.relayUrl,
        members: fundedMembers,
        expectedReplicas: config.group!.expectedReplicas,
        minReady: config.group!.minReady,
        localSecret: {
          description: "Deployer-local deployment intent group token. Do not publish this report.",
          cliToken: group.cliToken
        },
        sensitiveFields: ["deploymentIntentGroup.localSecret.cliToken"]
      },
      session: {
        sessionId: requiredStringField(fundedMembers[0], "sessionId"),
        jobSigner: requiredStringField(fundedMembers[0], "runtimeSigner"),
        operatorId: requiredStringField(fundedMembers[0], "operatorId"),
        processor: stringField(fundedMembers[0], "processor"),
        processorId: requiredStringField(fundedMembers[0], "processorId"),
        hostname: primaryMemberHostnames.hostname,
        validationHostname: primaryMemberHostnames.validationHostname
      },
      hostnames: {
        public: primaryMemberHostnames.hostname,
        validation: primaryMemberHostnames.validationHostname
      },
      relay: { url: config.relayUrl },
      dnsMaterialization,
      publicProbe,
      lifecycle: {
        durationMinutes: config.durationMinutes,
        leaseSeconds: config.leaseSeconds,
        paymentMode: config.paymentMode,
        expectedQuoteAmount: config.expectedQuoteAmount,
        executionMs: config.executionMs,
        scheduleBufferMinutes: config.scheduleBufferMinutes,
        schedule: deploymentSchedule
      },
      artifacts: {
        runDir: config.runDir,
        buildConfigPath,
        metadataPath,
        reportPath
      }
    };
    await writeJson(reportPath, report);
    console.log(deployStatus("ok", "Wrote deployment report", reportPath));
    console.log(`[switchboard-deploy] report=${reportPath}`);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    }
  } catch (error) {
    await writeFailureReport(config, {
      stage: "group-post-runtime-route-registration",
      error: safeError(error),
      deployment,
      group: groupOutput(group),
      fundedMembers,
      dnsMaterialization
    });
    throw error;
  }
}

function printHelp(): void {
  console.log(`Usage:
  pnpm switchboard:internal:deploy-runner -- --yes

Required env:
  INGRESS_REGISTRY_ADDRESS   Hub TestNet ingress registry contract
  OPERATOR_ID                bytes32 operator ID used by hub-watcher
  SWITCHBOARD_DEPLOY_RELAY_URL        externally reachable control-plane URL, or RELAY_URL
  POLKADOT_SEED/POLKADOT_ADDRESS      Hub payment account for signed quote funding
  ACURAST_MAINNET_SEED       mainnet Acurast deploy mnemonic
  ACURAST_MAINNET_ADDRESS    expected mainnet Acurast account

Useful optional env/flags:
  Canonical hostname                 relay-allocated under ingress.<tld>
  --operator-id <bytes32>            default OPERATOR_ID
  --operator-ssh-host <host>         SSH host for gateway-agent/metadata-file recovery modes
  --operator-public-ip <ip>          Public gateway IP for DNS/probe helpers
  --route-activation-mode <mode>     relay-reconciled (default), control-plane, gateway-agent, or metadata-file
  --route-intent-url <url>           default http://127.0.0.1:18080/route-intents on operator host
  --manager-id <id>                  default ACURAST_MANAGER_ID
  --quote                            default; fund through a deployment-intent quote
  --payment-mode <mode>              quote only
  --validator-mode <mode>            local, acurast, or skip
  --real-validator                   deprecated alias for --validator-mode acurast
  --activate                         call validation-gated /v1/session-activations
  --record-fulfillment               internal/manual recovery only; also requires relay manual fulfillment recording
  --allow-manual-fulfillment         allow direct /v1/fulfillment-records calls that spend Hub DOT
  --duration-minutes <minutes>       derive lease seconds and execution runtime from one duration
  --lease-seconds <seconds>          derive Hub payment from nativePricePerSecond() * seconds, default 3600
  --schedule-buffer-minutes <minutes>
                                      extra execution runtime beyond duration, default 10 with --duration-minutes
  --dns                             legacy probe mode flag; deploy does not mint job DNS
  --job-acme                        job generates TLS key/CSR and relay signs cert through ACME DNS-01
  --cloudflare-zone-names <csv>      relay/operator DNS authority hint
  --execution-ms <ms>                default 900000, or duration plus buffer with --duration-minutes
  --json                            print final report JSON`);
}

function loadConfig(flags: Map<string, string | boolean>): HarnessConfig {
  const runId = stringFlag(flags, "run-id") ?? process.env.SWITCHBOARD_DEPLOY_RUN_ID ?? `${Math.floor(Date.now() / 1000)}`;
  const runDir = path.resolve(stringFlag(flags, "run-dir") ?? process.env.SWITCHBOARD_DEPLOY_RUN_DIR ?? path.join(rootDir, "tmp/switchboard-deploy", runId));
  const registryAddress = ethers.getAddress(requiredEnv("INGRESS_REGISTRY_ADDRESS"));
  const dnsEnabled = boolFlag(flags, "dns") || process.env.SWITCHBOARD_DEPLOY_DNS === "true";
  const certificateMode = certificateModeFlag(flags);
  if (
    stringFlag(flags, "hostname") ||
    stringFlag(flags, "hostname-suffix") ||
    stringFlag(flags, "hostname-suffixes") ||
    stringFlag(flags, "domain-pool") ||
    stringFlag(flags, "validation-hostname") ||
    stringFlag(flags, "certificate-hostnames") ||
    stringEnv("SWITCHBOARD_DEPLOY_HOSTNAME") ||
    stringEnv("SWITCHBOARD_DEPLOY_HOSTNAME_SUFFIX") ||
    stringEnv("SWITCHBOARD_DEPLOY_HOSTNAME_SUFFIXES") ||
    stringEnv("SWITCHBOARD_DEPLOY_VALIDATION_HOSTNAME") ||
    stringEnv("SWITCHBOARD_DEPLOY_CERTIFICATE_HOSTNAMES")
  ) {
    throw new Error("Canonical deploy hostnames are relay-allocated through deployment intents; use `switchboard hostname add` for customer domains after deploy.");
  }
  const relayUrl = stringFlag(flags, "relay-url") ?? process.env.SWITCHBOARD_DEPLOY_RELAY_URL ?? process.env.RELAY_URL;
  if (!relayUrl) {
    throw new Error("Set SWITCHBOARD_DEPLOY_RELAY_URL or RELAY_URL to an externally reachable control-plane URL");
  }
  assertExternallyReachableRelay(relayUrl, boolFlag(flags, "allow-local-relay"));

  const network = stringFlag(flags, "network") ?? process.env.ACURAST_NETWORK ?? "mainnet";
  if (network !== "mainnet" && network !== "canary") {
    throw new Error(`Unsupported Acurast network: ${network}`);
  }

  const cloudflareZoneNames = splitCsv(stringFlag(flags, "cloudflare-zone-names") ?? stringEnv("CLOUDFLARE_ZONE_NAMES") ?? "");
  const configuredIngressDomains = consumerIngressDomainsFromZones(cloudflareZoneNames);
  const explicitEndpointHostname =
    stringFlag(flags, "endpoint-hostname") ??
    stringEnv("SWITCHBOARD_DEPLOY_ENDPOINT_HOSTNAME");
  const explicitValidationHostname =
    stringFlag(flags, "validation-hostname") ??
    stringEnv("SWITCHBOARD_DEPLOY_VALIDATION_HOSTNAME");
  const hostname = explicitEndpointHostname ? normalizeDnsHostname(explicitEndpointHostname) : "";
  const validationHostname = explicitValidationHostname ? normalizeDnsHostname(explicitValidationHostname) : hostname;
  if (explicitValidationHostname && !hostname) {
    throw new Error("A validation hostname requires an explicit endpoint hostname; relay-allocated hostnames are learned after quote funding.");
  }
  if (certificateMode === "self-signed" && !hostname) {
    throw new Error(
      "Self-signed certificate mode requires --endpoint-hostname or SWITCHBOARD_DEPLOY_ENDPOINT_HOSTNAME. " +
        "Relay-allocated hostnames are only available after quote funding; use --job-acme for public deploys."
    );
  }
  const defaultCertificateHostnames = hostname;
  const certificateHostnames = splitCsv(
    stringFlag(flags, "certificate-hostnames") ?? stringEnv("SWITCHBOARD_DEPLOY_CERTIFICATE_HOSTNAMES") ?? defaultCertificateHostnames
  ).map(normalizeDnsHostname);
  if (hostname) {
    assertConsumerIngressHostname(hostname, "hostname");
    assertConsumerIngressHostnameAllowed(hostname, configuredIngressDomains, "hostname");
  }
  if (validationHostname) {
    assertConsumerIngressHostname(validationHostname, "validation hostname");
    assertConsumerIngressHostnameAllowed(validationHostname, configuredIngressDomains, "validation hostname");
  }
  for (const certificateHostname of certificateHostnames) {
    assertConsumerIngressHostname(certificateHostname, "certificate hostname");
    assertConsumerIngressHostnameAllowed(certificateHostname, configuredIngressDomains, "certificate hostname");
  }
  const configuredPublicProbeMode = stringFlag(flags, "public-probe-mode") ?? stringEnv("SWITCHBOARD_DEPLOY_PUBLIC_PROBE_MODE");
  const publicProbeMode = configuredPublicProbeMode ?? (dnsEnabled ? "dns" : "resolve");
  if (publicProbeMode !== "dns" && publicProbeMode !== "resolve") {
    throw new Error(`SWITCHBOARD_DEPLOY_PUBLIC_PROBE_MODE must be "dns" or "resolve", got ${publicProbeMode}`);
  }
  const dnsResolvers = splitCsv(process.env.SWITCHBOARD_DEPLOY_DNS_RESOLVERS ?? "1.1.1.1");
  const curlDohUrl =
    stringFlag(flags, "curl-doh-url") ??
    stringEnv("SWITCHBOARD_DEPLOY_CURL_DOH_URL") ??
    (publicProbeMode === "dns" ? "https://cloudflare-dns.com/dns-query" : undefined);
  const durationMinutes =
    optionalNumberFlag(flags, "duration-minutes") ??
    optionalNumberFlag(flags, "lease-minutes") ??
    optionalNumberEnv("SWITCHBOARD_DEPLOY_DURATION_MINUTES");
  const leaseSeconds =
    optionalNumberFlag(flags, "lease-seconds") ??
    optionalNumberEnv("SWITCHBOARD_DEPLOY_LEASE_SECONDS") ??
    (durationMinutes !== undefined ? durationMinutes * 60 : 3600);
  const scheduleBufferMinutes =
    durationMinutes !== undefined
      ? numberFlag(flags, "schedule-buffer-minutes", numberEnv("SWITCHBOARD_DEPLOY_SCHEDULE_BUFFER_MINUTES", 10))
      : optionalNumberFlag(flags, "schedule-buffer-minutes") ?? optionalNumberEnv("SWITCHBOARD_DEPLOY_SCHEDULE_BUFFER_MINUTES");
  const explicitExecutionMs = optionalNumberFlag(flags, "execution-ms") ?? optionalNumberEnv("ACURAST_EXECUTION_MS");
  const executionMs =
    explicitExecutionMs ??
    (durationMinutes !== undefined && scheduleBufferMinutes !== undefined
      ? (durationMinutes + scheduleBufferMinutes) * 60_000
      : 900_000);
  if (durationMinutes !== undefined && durationMinutes <= 0) {
    throw new Error("duration-minutes must be greater than zero");
  }
  if (leaseSeconds <= 0) {
    throw new Error("lease-seconds must be greater than zero");
  }
  if (executionMs <= 0) {
    throw new Error("execution-ms must be greater than zero");
  }
  const startDelayMs = numberFlag(flags, "start-delay-ms", numberEnv("ACURAST_START_DELAY_MS", 300_000));
  const runtimeTimeoutDefaultMs = Math.max(900_000, startDelayMs + executionMs + 300_000);
  const operatorProjectDir =
    stringFlag(flags, "operator-project-dir") ??
    process.env.SWITCHBOARD_DEPLOY_OPERATOR_PROJECT_DIR ??
    "/srv/switchboard";
  const operatorRouteActivationMode = routeActivationModeFlag(flags);
  if (operatorRouteActivationMode === "control-plane" && !stringEnv("PROOF_CONTROL_PLANE_TOKEN")) {
    throw new Error("route activation mode control-plane requires PROOF_CONTROL_PLANE_TOKEN; public deploys should use relay-reconciled");
  }
  const managerId =
    stringFlag(flags, "manager-id") ??
    process.env.ACURAST_MANAGER_ID;
  if (!managerId && !stringEnv("SWITCHBOARD_DEPLOY_PROCESSOR") && !stringEnv("ACURAST_INSTANT_MATCH_PROCESSORS")) {
    throw new Error("Missing --manager-id or ACURAST_MANAGER_ID when no processor is pinned");
  }
  const group = deploymentGroupConfigFromEnv();

  const config: HarnessConfig = {
    rootDir,
    runId,
    runDir,
    network,
    targetName: stringFlag(flags, "target") ?? process.env.SWITCHBOARD_TARGET ?? "polkadot-hub-testnet",
    registryAddress,
    relayUrl,
    operatorId: lowerHex32(stringFlag(flags, "operator-id") ?? requiredEnv("OPERATOR_ID")),
    gatewayId:
      stringFlag(flags, "gateway-id") ??
      stringEnv("SWITCHBOARD_DEPLOY_GATEWAY_ID") ??
      stringEnv("SWITCHBOARD_GATEWAY_ID") ??
      stringEnv("GATEWAY_ID") ??
      "",
    capabilityReportId: stringEnv("SWITCHBOARD_DEPLOY_CAPABILITY_REPORT_ID") ?? "",
    capabilityReportExpiresAt: stringEnv("SWITCHBOARD_DEPLOY_CAPABILITY_REPORT_EXPIRES_AT") ?? "",
    operatorPublicAddresses: stringArrayEnv("SWITCHBOARD_DEPLOY_OPERATOR_PUBLIC_ADDRESSES"),
    operatorSshHost: stringFlag(flags, "operator-ssh-host") ?? process.env.SWITCHBOARD_DEPLOY_OPERATOR_SSH_HOST ?? "",
    operatorPublicIp: stringFlag(flags, "operator-public-ip") ?? process.env.SWITCHBOARD_DEPLOY_OPERATOR_PUBLIC_IP ?? "",
    operatorProjectDir,
    operatorComposeEnvFile:
      stringFlag(flags, "operator-compose-env-file") ??
      process.env.SWITCHBOARD_DEPLOY_OPERATOR_COMPOSE_ENV_FILE ??
      path.posix.join(operatorProjectDir, ".operator-host/operator.env"),
    operatorComposeProfile: stringFlag(flags, "operator-compose-profile") ?? process.env.SWITCHBOARD_DEPLOY_OPERATOR_COMPOSE_PROFILE ?? "test-upstream",
    operatorRouteMetadataFile:
      stringFlag(flags, "operator-route-metadata-file") ??
      process.env.SWITCHBOARD_DEPLOY_OPERATOR_ROUTE_METADATA_FILE ??
      path.posix.join(operatorProjectDir, "docker/operator/routes.json"),
    operatorRouteActivationMode,
    operatorRouteIntentUrl:
      stringFlag(flags, "route-intent-url") ??
      process.env.SWITCHBOARD_DEPLOY_ROUTE_INTENT_URL ??
      "http://127.0.0.1:18080/route-intents",
    managerId: managerId ?? "",
    hostname,
    validationHostname,
    port: numberFlag(flags, "port", numberEnv("SWITCHBOARD_DEPLOY_PORT", 3443)),
    durationMinutes,
    leaseSeconds,
    paymentAmount: stringFlag(flags, "payment-amount") ?? stringEnv("SWITCHBOARD_DEPLOY_PAYMENT_AMOUNT"),
    paymentMode: paymentModeFlag(flags),
    expectedQuoteAmount: stringFlag(flags, "expected-quote-amount") ?? stringEnv("SWITCHBOARD_DEPLOY_EXPECTED_QUOTE_AMOUNT"),
    scheduleBufferMinutes,
    startDelayMs,
    executionMs,
    maxAllowedStartDelayMs: numberFlag(flags, "max-allowed-start-delay-ms", numberEnv("ACURAST_MAX_ALLOWED_START_DELAY_MS", 120_000)),
    instantMatchStartDelayMs: numberFlag(
      flags,
      "instant-match-start-delay-ms",
      numberEnv("ACURAST_INSTANT_MATCH_START_DELAY_MS", 120_000)
    ),
    maxCostPerExecution: stringFlag(flags, "max-cost-per-execution") ?? process.env.ACURAST_MAX_COST_PER_EXECUTION ?? "40000000000",
    pollIntervalMs: numberFlag(flags, "poll-interval-ms", numberEnv("SWITCHBOARD_DEPLOY_POLL_INTERVAL_MS", 10_000)),
    runtimeTimeoutMs: numberFlag(
      flags,
      "runtime-timeout-ms",
      numberEnv("SWITCHBOARD_DEPLOY_RUNTIME_TIMEOUT_MS", runtimeTimeoutDefaultMs)
    ),
    registrationTimeoutMs: numberFlag(flags, "registration-timeout-ms", numberEnv("SWITCHBOARD_DEPLOY_REGISTRATION_TIMEOUT_MS", 300_000)),
    routeTimeoutMs: numberFlag(flags, "route-timeout-ms", numberEnv("SWITCHBOARD_DEPLOY_ROUTE_TIMEOUT_MS", DEFAULT_ROUTE_ACTIVATION_TIMEOUT_MS)),
    certificateMode,
    certificateHostnames: unique(certificateHostnames),
    publicProbeInsecure:
      boolFlag(flags, "public-probe-insecure") ||
      process.env.SWITCHBOARD_DEPLOY_PUBLIC_PROBE_INSECURE === "true" ||
      certificateMode === "self-signed",
    jobControlToken: randomBytes(32).toString("base64url"),
    validatorMode: validatorModeFlag(flags),
    activationEnabled: boolFlag(flags, "activate") || process.env.SWITCHBOARD_DEPLOY_ACTIVATE === "true",
    fulfillmentEnabled: boolFlag(flags, "record-fulfillment") || process.env.SWITCHBOARD_DEPLOY_RECORD_FULFILLMENT === "true",
    fulfillmentDelayMs: numberFlag(flags, "fulfillment-delay-ms", numberEnv("SWITCHBOARD_DEPLOY_FULFILLMENT_DELAY_MS", 15_000)),
    fulfillmentIntervalMs: numberFlag(
      flags,
      "fulfillment-interval-ms",
      numberEnv("SWITCHBOARD_DEPLOY_FULFILLMENT_INTERVAL_MS", 14_400_000)
    ),
    dns: {
      enabled: dnsEnabled,
      zoneId: stringFlag(flags, "cloudflare-zone-id") ?? stringEnv("CLOUDFLARE_ZONE_ID"),
      zoneName: stringFlag(flags, "cloudflare-zone-name") ?? stringEnv("CLOUDFLARE_ZONE_NAME"),
      zoneNames: cloudflareZoneNames,
      ttl: numberFlag(flags, "dns-ttl", numberEnv("SWITCHBOARD_DEPLOY_DNS_TTL", 60)),
      proxied: boolFlag(flags, "dns-proxied") || process.env.SWITCHBOARD_DEPLOY_DNS_PROXIED === "true",
      waitTimeoutMs: numberFlag(flags, "dns-wait-timeout-ms", numberEnv("SWITCHBOARD_DEPLOY_DNS_WAIT_TIMEOUT_MS", 180_000)),
      resolvers: dnsResolvers,
      curlDohUrl,
      publicProbeMode,
      publicProbeModeExplicit: Boolean(configuredPublicProbeMode)
    },
    assumeYes: boolFlag(flags, "yes") || process.env.SWITCHBOARD_DEPLOY_ASSUME_YES === "true",
    group
  };
  if (
    config.fulfillmentEnabled &&
    !boolFlag(flags, "allow-manual-fulfillment") &&
    process.env.SWITCHBOARD_DEPLOY_ALLOW_MANUAL_FULFILLMENT !== "true"
  ) {
    throw new Error(
      "Direct --record-fulfillment spends Hub DOT and is disabled by default. " +
        "Use relay batched fulfillment for normal runs, or pass --allow-manual-fulfillment / " +
        "SWITCHBOARD_DEPLOY_ALLOW_MANUAL_FULFILLMENT=true for an explicit recovery test."
    );
  }
  return config;
}

function deploymentGroupConfigFromEnv(): DeploymentGroupConfig | undefined {
  if (process.env.SWITCHBOARD_DEPLOY_GROUP_MODE !== "true" && !stringEnv("SWITCHBOARD_DEPLOY_GROUP_MEMBERS")) {
    return undefined;
  }
  const raw = requiredEnv("SWITCHBOARD_DEPLOY_GROUP_MEMBERS");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("SWITCHBOARD_DEPLOY_GROUP_MEMBERS must be a non-empty JSON array");
  }
  const members = parsed.map((item, index): DeploymentGroupMemberConfig => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`SWITCHBOARD_DEPLOY_GROUP_MEMBERS[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    return {
      memberId: stringField(record, "memberId") ?? `member-${index + 1}`,
      operatorId: lowerHex32(requiredStringField(record, "operatorId")),
      processorId: lowerHex32(requiredStringField(record, "processorId")),
      processor: requiredStringField(record, "processor"),
      gatewayId: stringField(record, "gatewayId"),
      managerId: stringField(record, "managerId"),
      reportId: stringField(record, "reportId"),
      reportExpiresAt: stringField(record, "reportExpiresAt"),
      publicAddresses: stringArrayField(record, "publicAddresses")
    };
  });
  const expectedReplicas = numberEnv("SWITCHBOARD_DEPLOY_EXPECTED_REPLICAS", members.length);
  const minReady = numberEnv("SWITCHBOARD_DEPLOY_MIN_READY", expectedReplicas);
  if (expectedReplicas !== members.length) {
    throw new Error(`SWITCHBOARD_DEPLOY_EXPECTED_REPLICAS=${expectedReplicas} does not match ${members.length} group members`);
  }
  if (minReady <= 0 || minReady > expectedReplicas) {
    throw new Error("SWITCHBOARD_DEPLOY_MIN_READY must be between 1 and SWITCHBOARD_DEPLOY_EXPECTED_REPLICAS");
  }
  return {
    expectedReplicas,
    minReady,
    members
  };
}

function consumerIngressDomainsFromZones(cloudflareZoneNames: string[]): string[] {
  return unique(cloudflareZoneNames.map((zoneName) => normalizeDnsHostname(zoneName)).filter(isConsumerIngressDomain));
}

function isConsumerIngressDomain(value: string): boolean {
  const labels = normalizeDnsHostname(value).split(".");
  return labels.length === 2 && labels[0] === "ingress" && labels[1].length > 0;
}

function assertConsumerIngressHostname(value: string, label: string): void {
  const labels = normalizeDnsHostname(value).split(".");
  if (labels.length < 3 || labels[labels.length - 2] !== "ingress") {
    throw new Error(`${label} must be under an ingress.<tld> domain, got ${value}`);
  }
}

function assertConsumerIngressHostnameAllowed(value: string, configuredIngressDomains: string[], label: string): void {
  if (configuredIngressDomains.length === 0) return;
  const domain = normalizeDnsHostname(value).split(".").slice(-2).join(".");
  if (!configuredIngressDomains.includes(domain)) {
    throw new Error(`${label} ${value} is outside configured ingress zones: ${configuredIngressDomains.join(", ")}`);
  }
}

function isCanonicalConsumerIngressHostname(value: string): boolean {
  const hostname = normalizeDnsHostname(value);
  return switchboardDomainPool.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export function deploymentIntentHostnamesFromRecords(
  funding: Record<string, unknown> | undefined,
  status?: Record<string, unknown>
): { hostname?: string; validationHostname?: string } {
  const intent = objectField(status, "intent");
  const endpointHostname =
    stringField(intent, "endpointHostname") ??
    stringField(status, "endpointHostname") ??
    stringField(funding, "endpointHostname");
  if (!endpointHostname) {
    return {};
  }
  const validationHostname =
    stringField(intent, "validationHostname") ??
    stringField(status, "validationHostname") ??
    stringField(funding, "validationHostname") ??
    endpointHostname;
  return {
    hostname: normalizeDnsHostname(endpointHostname),
    validationHostname: normalizeDnsHostname(validationHostname)
  };
}

function applyDeploymentIntentHostnames(
  config: HarnessConfig,
  funding: Record<string, unknown> | undefined,
  status?: Record<string, unknown>
): boolean {
  const hostnames = deploymentIntentHostnamesFromRecords(funding, status);
  if (!hostnames.hostname) {
    return false;
  }
  config.hostname = hostnames.hostname;
  config.validationHostname = hostnames.validationHostname ?? hostnames.hostname;
  config.certificateHostnames = [config.hostname];
  if (!config.dns.publicProbeModeExplicit && isCanonicalConsumerIngressHostname(config.hostname)) {
    config.dns.publicProbeMode = "dns";
    config.dns.curlDohUrl ??= "https://cloudflare-dns.com/dns-query";
  }
  return true;
}

function requireDeploymentHostnames(config: HarnessConfig, label: string): { hostname: string; validationHostname: string } {
  if (!config.hostname) {
    throw new Error(`Relay did not allocate an endpoint hostname for ${label}`);
  }
  return {
    hostname: config.hostname,
    validationHostname: config.validationHostname || config.hostname
  };
}

function deploymentSessionHostnames(config: HarnessConfig): { hostname?: string; validationHostname?: string } {
  if (!config.hostname) {
    return {};
  }
  return requireDeploymentHostnames(config, "deployment session");
}

function deploymentReportHostnames(config: HarnessConfig): { public: string; validation: string } | undefined {
  if (!config.hostname) {
    return undefined;
  }
  const hostnames = requireDeploymentHostnames(config, "deployment report");
  return {
    public: hostnames.hostname,
    validation: hostnames.validationHostname
  };
}

async function maybeAuthorizeCertificateHostnames(
  config: HarnessConfig,
  input: {
    sessionId: string;
    jobId: string;
    processorId: string;
  }
): Promise<CertificateAuthorizationResult | undefined> {
  if (config.certificateMode !== "job-acme") {
    return undefined;
  }
  const extraHostnames = config.certificateHostnames.filter((hostname) => hostname !== config.hostname);
  if (extraHostnames.length === 0) {
    return undefined;
  }

  const response = await fetch(new URL("/v1/certificate-authorizations", config.relayUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...bearerAuthHeader(
        stringEnv("PROOF_CERTIFICATE_AUTHORIZATION_TOKEN") ?? stringEnv("SWITCHBOARD_DEPLOY_CERTIFICATE_AUTHORIZATION_TOKEN")
      )
    },
    body: JSON.stringify({
      sessionId: input.sessionId,
      hostnames: config.certificateHostnames,
      expiresAt: String(Math.floor(Date.now() / 1000) + (config.leaseSeconds ?? 3600) + 3600),
      source: {
        mode: "switchboard-deploy",
        runId: config.runId,
        jobId: input.jobId,
        operatorId: config.operatorId,
        processorId: input.processorId
      }
    })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`certificate hostname authorization failed: ${response.status} ${body}`);
  }
  return JSON.parse(body) as CertificateAuthorizationResult;
}

async function createSelfSignedCertificate(config: HarnessConfig): Promise<{
  certPath: string;
  keyPath: string;
  certBase64: string;
  keyBase64: string;
}> {
  const hostnames = requireDeploymentHostnames(config, "self-signed certificate");
  await mkdir(config.runDir, { recursive: true });
  const certPath = path.join(config.runDir, "tls.crt");
  const keyPath = path.join(config.runDir, "tls.key");
  const san = unique([hostnames.hostname, hostnames.validationHostname, ...config.certificateHostnames]).map((hostname) => `DNS:${hostname}`).join(",");
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "1",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    `/CN=${hostnames.hostname}`,
    "-addext",
    `subjectAltName=${san}`
  ]);

  return {
    certPath,
    keyPath,
    certBase64: Buffer.from(await readFile(certPath, "utf8"), "utf8").toString("base64"),
    keyBase64: Buffer.from(await readFile(keyPath, "utf8"), "utf8").toString("base64")
  };
}

function reportJobControl(config: HarnessConfig): Record<string, unknown> {
  return {
    endpoint: "/__proof/ingress/register",
    localSecret: {
      description: "Deployer-local job-control token. Do not publish this report.",
      token: config.jobControlToken
    },
    sensitiveFields: ["jobControl.localSecret.token"]
  };
}

async function createDeploymentIntent(
  config: HarnessConfig,
  input: {
    jobId: string;
    processorId: string;
  }
): Promise<DeploymentIntentBootstrap> {
  const body = buildDeploymentIntentCreateBody(config, input);
  const response = await fetch(new URL("/v1/deployment-intents", config.relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(numberEnv("SWITCHBOARD_DEPLOY_INTENT_CREATE_TIMEOUT_MS", 15_000))
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) as Record<string, any> : {};
  if (!response.ok || !json.ok) {
    throw new Error(`Deployment intent create failed: ${response.status} ${JSON.stringify(json)}`);
  }
  const intentId = requiredStringField(json, "intentId");
  const cliToken = requiredStringField(json, "cliToken");
  const job = requiredRecordField(json, "job");
  const env = requiredRecordField(job, "env");
  const jobToken = requiredStringField(job, "token");
  const envToken = requiredStringField(env, "SWITCHBOARD_INTENT_TOKEN");
  if (jobToken !== envToken) {
    throw new Error("Deployment intent response job.token does not match job.env.SWITCHBOARD_INTENT_TOKEN");
  }
  return {
    intentId,
    cliToken,
    env: {
      SWITCHBOARD_RELAY_URL: requiredStringField(env, "SWITCHBOARD_RELAY_URL"),
      SWITCHBOARD_INTENT_ID: requiredStringField(env, "SWITCHBOARD_INTENT_ID"),
      SWITCHBOARD_INTENT_TOKEN: envToken
    },
    intent: json.intent && typeof json.intent === "object" ? json.intent as Record<string, unknown> : undefined
  };
}

function parsePrecreatedDeployIntentPayload(): PrecreatedDeployIntentPayload | undefined {
  const raw = stringEnv("SWITCHBOARD_DEPLOY_PRECREATED_INTENT_JSON");
  if (!raw) return undefined;
  return parsePrecreatedDeployIntentPayloadJson(raw);
}

export function parsePrecreatedDeployIntentPayloadJson(raw: string): PrecreatedDeployIntentPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`SWITCHBOARD_DEPLOY_PRECREATED_INTENT_JSON is not valid JSON: ${safeError(error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SWITCHBOARD_DEPLOY_PRECREATED_INTENT_JSON must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const capacity = requiredRecordField(record, "capacity");
  const deploymentIntentRecord = requiredRecordField(record, "deploymentIntent");
  const env = requiredRecordField(deploymentIntentRecord, "env");
  const deploymentIntent: DeploymentIntentBootstrap = {
    intentId: requiredStringField(deploymentIntentRecord, "intentId"),
    cliToken: requiredStringField(deploymentIntentRecord, "cliToken"),
    env: {
      SWITCHBOARD_RELAY_URL: requiredStringField(env, "SWITCHBOARD_RELAY_URL"),
      SWITCHBOARD_INTENT_ID: requiredStringField(env, "SWITCHBOARD_INTENT_ID"),
      SWITCHBOARD_INTENT_TOKEN: requiredStringField(env, "SWITCHBOARD_INTENT_TOKEN")
    },
    intent: deploymentIntentRecord.intent && typeof deploymentIntentRecord.intent === "object" && !Array.isArray(deploymentIntentRecord.intent)
      ? deploymentIntentRecord.intent as Record<string, unknown>
      : undefined
  };
  if (deploymentIntent.env.SWITCHBOARD_INTENT_ID !== deploymentIntent.intentId) {
    throw new Error("Precreated deployment intent env SWITCHBOARD_INTENT_ID does not match intentId");
  }
  return {
    workflowId: requiredStringField(record, "workflowId"),
    jobId: requiredStringField(record, "jobId"),
    capacity: {
      operatorId: requiredStringField(capacity, "operatorId"),
      processorId: requiredStringField(capacity, "processorId"),
      processor: stringField(capacity, "processor"),
      gatewayId: stringField(capacity, "gatewayId"),
      managerId: stringField(capacity, "managerId")
    },
    deploymentIntent,
    sensitiveFields: Array.isArray(record.sensitiveFields) ? record.sensitiveFields.filter((item): item is string => typeof item === "string") : undefined
  };
}

export function validatePrecreatedDeployIntentPayload(
  payload: PrecreatedDeployIntentPayload,
  config: HarnessConfig,
  selected: { processor: string; processorId: string }
): void {
  assertEqualIgnoreCase(payload.capacity.operatorId, config.operatorId, "precreated intent operatorId");
  assertEqualIgnoreCase(payload.capacity.processorId, selected.processorId, "precreated intent processorId");
  if (payload.capacity.processor) {
    assertEqual(payload.capacity.processor, selected.processor, "precreated intent processor");
  }
  if (payload.capacity.gatewayId && config.gatewayId) {
    assertEqual(payload.capacity.gatewayId, config.gatewayId, "precreated intent gatewayId");
  }
  if (payload.capacity.managerId && config.managerId) {
    assertEqual(payload.capacity.managerId, config.managerId, "precreated intent managerId");
  }
  if (payload.deploymentIntent.env.SWITCHBOARD_RELAY_URL !== config.relayUrl) {
    throw new Error("Precreated deployment intent relay URL does not match runner relay URL");
  }
  if (!payload.sensitiveFields?.includes("deploymentIntent.cliToken") ||
      !payload.sensitiveFields.includes("deploymentIntent.env.SWITCHBOARD_INTENT_TOKEN")) {
    throw new Error("Precreated deployment intent payload is missing sensitive field markers");
  }
}

function parsePrecreatedDeployGroupPayload(): PrecreatedDeployGroupPayload | undefined {
  const raw = stringEnv("SWITCHBOARD_DEPLOY_PRECREATED_GROUP_JSON");
  if (!raw) return undefined;
  return parsePrecreatedDeployGroupPayloadJson(raw);
}

export function parsePrecreatedDeployGroupPayloadJson(raw: string): PrecreatedDeployGroupPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`SWITCHBOARD_DEPLOY_PRECREATED_GROUP_JSON is not valid JSON: ${safeError(error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SWITCHBOARD_DEPLOY_PRECREATED_GROUP_JSON must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const groupRecord = requiredRecordField(record, "group");
  const bootstrapRecord = requiredRecordField(record, "deploymentIntentGroup");
  const env = requiredRecordField(bootstrapRecord, "env");
  const members = recordArrayField(groupRecord, "members").map((member, index): DeploymentGroupMemberConfig => ({
    memberId: stringField(member, "memberId") ?? `member-${index + 1}`,
    operatorId: lowerHex32(requiredStringField(member, "operatorId")),
    processorId: lowerHex32(requiredStringField(member, "processorId")),
    processor: requiredStringField(member, "processor"),
    gatewayId: stringField(member, "gatewayId"),
    managerId: stringField(member, "managerId"),
    reportId: stringField(member, "reportId"),
    reportExpiresAt: stringField(member, "reportExpiresAt"),
    publicAddresses: stringArrayField(member, "publicAddresses")
  }));
  const bootstrapMembers = recordArrayField(bootstrapRecord, "members").map((member, index): DeploymentIntentGroupMemberBootstrap => {
    const configured = members[index];
    return {
      memberId: stringField(member, "memberId") ?? configured?.memberId ?? `member-${index + 1}`,
      intentId: requiredStringField(member, "intentId"),
      cliToken: requiredStringField(bootstrapRecord, "cliToken"),
      jobId: requiredStringField(member, "jobId"),
      operatorId: lowerHex32(requiredStringField(member, "operatorId")),
      processorId: lowerHex32(requiredStringField(member, "processorId")),
      processor: stringField(member, "processor") ?? configured?.processor,
      gatewayId: stringField(member, "gatewayId") ?? configured?.gatewayId,
      managerId: stringField(member, "managerId") ?? configured?.managerId,
      validationHostname: stringField(member, "validationHostname"),
      intent: member
    };
  });
  return {
    workflowId: requiredStringField(record, "workflowId"),
    deploymentMode: "group",
    jobId: requiredStringField(record, "jobId"),
    capacity: {
      operatorId: requiredStringField(requiredRecordField(record, "capacity"), "operatorId"),
      processorId: requiredStringField(requiredRecordField(record, "capacity"), "processorId"),
      processor: stringField(requiredRecordField(record, "capacity"), "processor"),
      gatewayId: stringField(requiredRecordField(record, "capacity"), "gatewayId"),
      managerId: stringField(requiredRecordField(record, "capacity"), "managerId")
    },
    group: {
      expectedReplicas: Number(requiredStringOrNumberField(groupRecord, "expectedReplicas")),
      minReady: Number(requiredStringOrNumberField(groupRecord, "minReady")),
      members
    },
    deploymentIntentGroup: {
      groupId: requiredStringField(bootstrapRecord, "groupId"),
      cliToken: requiredStringField(bootstrapRecord, "cliToken"),
      env: {
        SWITCHBOARD_RELAY_URL: requiredStringField(env, "SWITCHBOARD_RELAY_URL"),
        SWITCHBOARD_INTENT_GROUP_ID: requiredStringField(env, "SWITCHBOARD_INTENT_GROUP_ID"),
        SWITCHBOARD_INTENT_TOKEN: requiredStringField(env, "SWITCHBOARD_INTENT_TOKEN")
      },
      group: bootstrapRecord.group && typeof bootstrapRecord.group === "object" && !Array.isArray(bootstrapRecord.group)
        ? bootstrapRecord.group as Record<string, unknown>
        : undefined,
      members: bootstrapMembers
    },
    sensitiveFields: Array.isArray(record.sensitiveFields) ? record.sensitiveFields.filter((item): item is string => typeof item === "string") : undefined
  };
}

export function validatePrecreatedDeployGroupPayload(
  payload: PrecreatedDeployGroupPayload,
  config: HarnessConfig
): void {
  if (!config.group) {
    throw new Error("Precreated deployment intent group requires group config");
  }
  assertEqualIgnoreCase(payload.capacity.operatorId, config.operatorId, "group operatorId");
  if (payload.capacity.gatewayId && config.gatewayId) {
    assertEqual(payload.capacity.gatewayId, config.gatewayId, "group gatewayId");
  }
  if (payload.capacity.managerId && config.managerId) {
    assertEqual(payload.capacity.managerId, config.managerId, "group managerId");
  }
  if (payload.group.expectedReplicas !== config.group.expectedReplicas) {
    throw new Error(`Precreated deployment intent group expectedReplicas mismatch: expected ${config.group.expectedReplicas}, got ${payload.group.expectedReplicas}`);
  }
  if (payload.group.minReady !== config.group.minReady) {
    throw new Error(`Precreated deployment intent group minReady mismatch: expected ${config.group.minReady}, got ${payload.group.minReady}`);
  }
  if (payload.deploymentIntentGroup.env.SWITCHBOARD_RELAY_URL !== config.relayUrl) {
    throw new Error("Precreated deployment intent group relay URL does not match runner relay URL");
  }
  if (payload.deploymentIntentGroup.env.SWITCHBOARD_INTENT_GROUP_ID !== payload.deploymentIntentGroup.groupId) {
    throw new Error("Precreated deployment intent group env SWITCHBOARD_INTENT_GROUP_ID does not match groupId");
  }
  if (!payload.sensitiveFields?.includes("deploymentIntentGroup.cliToken") ||
      !payload.sensitiveFields.includes("deploymentIntentGroup.env.SWITCHBOARD_INTENT_TOKEN")) {
    throw new Error("Precreated deployment intent group payload is missing sensitive field markers");
  }
  const expectedMembers = config.group.members;
  if (payload.group.members.length !== expectedMembers.length || payload.deploymentIntentGroup.members.length !== expectedMembers.length) {
    throw new Error("Precreated deployment intent group member count does not match selected capacity");
  }
  for (const expected of expectedMembers) {
    const selected = payload.group.members.find((member) => member.memberId === expected.memberId);
    const bootstrap = payload.deploymentIntentGroup.members.find((member) => member.memberId === expected.memberId);
    if (!selected || !bootstrap) {
      throw new Error(`Precreated deployment intent group is missing member ${expected.memberId}`);
    }
    assertEqualIgnoreCase(selected.operatorId, expected.operatorId, `group member ${expected.memberId} operatorId`);
    assertEqualIgnoreCase(selected.processorId, expected.processorId, `group member ${expected.memberId} processorId`);
    assertEqual(selected.processor, expected.processor, `group member ${expected.memberId} processor`);
    if (expected.gatewayId) assertEqual(selected.gatewayId ?? "", expected.gatewayId, `group member ${expected.memberId} gatewayId`);
    assertEqualIgnoreCase(bootstrap.operatorId, expected.operatorId, `group bootstrap member ${expected.memberId} operatorId`);
    assertEqualIgnoreCase(bootstrap.processorId, expected.processorId, `group bootstrap member ${expected.memberId} processorId`);
    if (bootstrap.processor) assertEqual(bootstrap.processor, expected.processor, `group bootstrap member ${expected.memberId} processor`);
    if (expected.gatewayId && bootstrap.gatewayId) assertEqual(bootstrap.gatewayId, expected.gatewayId, `group bootstrap member ${expected.memberId} gatewayId`);
  }
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`Precreated deployment intent ${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function assertEqualIgnoreCase(actual: string, expected: string, label: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Precreated deployment intent ${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

async function createDeploymentIntentGroup(config: HarnessConfig): Promise<DeploymentIntentGroupBootstrap> {
  if (!config.group) {
    throw new Error("Deployment group config is required");
  }
  const body = buildDeploymentIntentGroupCreateBody({ ...config, group: config.group });
  const response = await fetch(new URL("/v1/deployment-intent-groups", config.relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(numberEnv("SWITCHBOARD_DEPLOY_INTENT_CREATE_TIMEOUT_MS", 15_000))
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) as Record<string, any> : {};
  if (!response.ok || !json.ok) {
    throw new Error(`Deployment intent group create failed: ${response.status} ${JSON.stringify(json)}`);
  }
  const groupId = requiredStringField(json, "groupId");
  const cliToken = requiredStringField(json, "cliToken");
  const job = requiredRecordField(json, "job");
  const env = requiredRecordField(job, "env");
  const jobToken = requiredStringField(job, "token");
  const envToken = requiredStringField(env, "SWITCHBOARD_INTENT_TOKEN");
  if (jobToken !== envToken) {
    throw new Error("Deployment intent group response job.token does not match job.env.SWITCHBOARD_INTENT_TOKEN");
  }
  const members = recordArrayField(json, "members").map((member, index): DeploymentIntentGroupMemberBootstrap => {
    const configured = config.group?.members[index];
    return {
      memberId: stringField(member, "memberId") ?? configured?.memberId ?? `member-${index + 1}`,
      intentId: requiredStringField(member, "intentId"),
      cliToken,
      jobId: requiredStringField(member, "jobId"),
      operatorId: requiredStringField(member, "operatorId"),
      processorId: requiredStringField(member, "processorId"),
      processor: stringField(member, "processor") ?? configured?.processor,
      gatewayId: stringField(member, "gatewayId") ?? configured?.gatewayId,
      managerId: stringField(member, "managerId") ?? configured?.managerId,
      validationHostname: stringField(member, "validationHostname"),
      intent: member
    };
  });
  return {
    groupId,
    cliToken,
    env: {
      SWITCHBOARD_RELAY_URL: requiredStringField(env, "SWITCHBOARD_RELAY_URL"),
      SWITCHBOARD_INTENT_GROUP_ID: requiredStringField(env, "SWITCHBOARD_INTENT_GROUP_ID"),
      SWITCHBOARD_INTENT_TOKEN: envToken
    },
    group: json.group && typeof json.group === "object" ? json.group as Record<string, unknown> : undefined,
    members
  };
}

export function buildDeploymentIntentCreateBody(
  config: DeploymentIntentCreateBodyConfig,
  input: {
    jobId: string;
    processorId: string;
  }
): Record<string, unknown> {
  return {
    paidSeconds: String(config.leaseSeconds ?? 3600),
    sessionLabel: `switchboard-deploy-${config.runId}`,
    jobId: input.jobId,
    operatorId: config.operatorId,
    processorId: input.processorId,
    ...(config.gatewayId ? { gatewayId: config.gatewayId } : {}),
    source: {
      mode: "switchboard-deploy",
      runId: config.runId,
      target: config.targetName
    }
  };
}

export function buildDeploymentIntentGroupCreateBody(
  config: DeploymentIntentCreateBodyConfig & { group: DeploymentGroupConfig }
): Record<string, unknown> {
  return {
    paidSeconds: String(config.leaseSeconds ?? 3600),
    sessionLabel: `switchboard-deploy-${config.runId}`,
    expectedReplicas: config.group.expectedReplicas,
    minReady: config.group.minReady,
    members: config.group.members.map((member) => ({
      memberId: member.memberId,
      jobId: hashStringBytes32(`${config.runId}:${member.memberId}:job`),
      operatorId: member.operatorId,
      processorId: member.processorId,
      processor: member.processor,
      gatewayId: member.gatewayId,
      managerId: member.managerId
    })),
    source: {
      mode: "switchboard-deploy-group",
      runId: config.runId,
      target: config.targetName
    }
  };
}

async function updateDeploymentIntentDeployment(
  config: HarnessConfig,
  deploymentIntent: DeploymentIntentBootstrap,
  input: {
    deploymentId: string;
    jobId: string;
    processor: string;
    processorId: string;
  }
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(`/v1/deployment-intents/${encodeURIComponent(deploymentIntent.intentId)}/deployment`, config.relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${deploymentIntent.cliToken}`
    },
    body: JSON.stringify({
      acurastDeploymentId: input.deploymentId,
      jobId: input.jobId,
      operatorId: config.operatorId,
      processorId: input.processorId,
      processor: input.processor,
      upstreamPort: config.port,
      source: {
        mode: "switchboard-deploy",
        runId: config.runId
      }
    }),
    signal: AbortSignal.timeout(numberEnv("SWITCHBOARD_DEPLOY_INTENT_UPDATE_TIMEOUT_MS", 15_000))
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok || json.ok !== true) {
    throw new Error(`Deployment intent update failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function updateDeploymentIntentGroupDeployment(
  config: HarnessConfig,
  group: DeploymentIntentGroupBootstrap,
  input: {
    deploymentId: string;
  }
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(`/v1/deployment-intent-groups/${encodeURIComponent(group.groupId)}/deployment`, config.relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${group.cliToken}`
    },
    body: JSON.stringify({
      acurastDeploymentId: input.deploymentId,
      upstreamPort: config.port,
      members: group.members.map((member) => ({
        intentId: member.intentId,
        jobId: member.jobId,
        operatorId: member.operatorId,
        processorId: member.processorId,
        processor: member.processor
      })),
      source: {
        mode: "switchboard-deploy-group",
        runId: config.runId
      }
    }),
    signal: AbortSignal.timeout(numberEnv("SWITCHBOARD_DEPLOY_INTENT_UPDATE_TIMEOUT_MS", 15_000))
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok || json.ok !== true) {
    throw new Error(`Deployment intent group update failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function readDeploymentIntentGroup(
  config: HarnessConfig,
  group: DeploymentIntentGroupBootstrap
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(`/v1/deployment-intent-groups/${encodeURIComponent(group.groupId)}`, config.relayUrl), {
    method: "GET",
    headers: {
      authorization: `Bearer ${group.cliToken}`
    },
    signal: AbortSignal.timeout(numberEnv("SWITCHBOARD_DEPLOY_INTENT_STATUS_TIMEOUT_MS", 60_000))
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok || json.ok !== true) {
    throw new Error(`Deployment intent group status failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function waitForDeploymentIntentGroupClaims(
  config: HarnessConfig,
  group: DeploymentIntentGroupBootstrap,
  targetCount: number,
  schedule: DeploymentSchedule | undefined,
  options: { timeoutMs?: number; allowPartial?: boolean } = {}
): Promise<Record<string, unknown>[]> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + (options.timeoutMs ?? config.runtimeTimeoutMs);
  await waitForScheduledJobStart(schedule, deadlineAt);
  let lastMembers: Record<string, unknown>[] = [];
  while (Date.now() <= deadlineAt) {
    const status = await readDeploymentIntentGroup(config, group);
    const groupRecord = requiredRecordField(status, "group");
    const members = recordArrayField(groupRecord, "members");
    const claimed = members.filter((member) => stringField(member, "runtimeSigner"));
    lastMembers = claimed;
    if (claimed.length >= targetCount) {
      return claimed;
    }
    logWaitStatus(
      "Waiting for HA runtime claims",
      `claimed=${claimed.length}/${targetCount}; elapsed ${formatDuration(Date.now() - startedAt)}`,
      `${claimed.length}:${targetCount}`
    );
    await sleep(config.pollIntervalMs);
  }
  if (options.allowPartial) {
    return lastMembers;
  }
  throw new Error(`Timed out waiting for ${targetCount} HA runtime claims after ${deadlineAt - startedAt}ms`);
}

function groupMemberDeploymentIntent(
  group: DeploymentIntentGroupBootstrap,
  member: DeploymentIntentGroupMemberBootstrap
): DeploymentIntentBootstrap {
  return {
    intentId: member.intentId,
    cliToken: group.cliToken,
    groupId: group.groupId,
    env: {
      SWITCHBOARD_RELAY_URL: group.env.SWITCHBOARD_RELAY_URL,
      SWITCHBOARD_INTENT_ID: member.intentId,
      SWITCHBOARD_INTENT_TOKEN: group.env.SWITCHBOARD_INTENT_TOKEN
    },
    intent: member.intent
  };
}

function requiredGroupMemberBootstrap(
  group: DeploymentIntentGroupBootstrap,
  intentId: string
): DeploymentIntentGroupMemberBootstrap {
  const member = group.members.find((candidate) => candidate.intentId === intentId);
  if (!member) {
    throw new Error(`Deployment intent group ${group.groupId} did not include member ${intentId}`);
  }
  return member;
}

function groupOutput(group: DeploymentIntentGroupBootstrap): Record<string, unknown> {
  return {
    groupId: group.groupId,
    members: group.members.map((member) => ({
      memberId: member.memberId,
      intentId: member.intentId,
      operatorId: member.operatorId,
      processorId: member.processorId,
      processor: member.processor,
      gatewayId: member.gatewayId
    }))
  };
}

async function refreshDeploymentIntentFunding(
  config: HarnessConfig,
  deploymentIntent: DeploymentIntentBootstrap
): Promise<Record<string, unknown>> {
  const timeoutMs = numberEnv("SWITCHBOARD_DEPLOY_INTENT_UPDATE_TIMEOUT_MS", 60_000);
  try {
    const response = await fetch(new URL(`/v1/deployment-intents/${encodeURIComponent(deploymentIntent.intentId)}/funding-refresh`, config.relayUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${deploymentIntent.cliToken}`
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!response.ok || json.ok !== true) {
      throw new Error(`Deployment intent funding refresh failed: ${response.status} ${JSON.stringify(json)}`);
    }
    return json;
  } catch (error) {
    if (!isTimeoutError(error)) {
      throw error;
    }
    const status = await readDeploymentIntent(config, deploymentIntent);
    const funding = objectField(objectField(status, "intent"), "funding");
    if (stringField(funding, "status") === "funded") {
      console.log(deployStatus("info", "Funding refresh timed out; resuming from intent status"));
      return status;
    }
    throw error;
  }
}

async function waitForDeploymentIntentRouteReconciled(
  config: HarnessConfig,
  deploymentIntent: DeploymentIntentBootstrap
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let last: Record<string, unknown> | undefined;
  while (Date.now() - startedAt <= config.routeTimeoutMs) {
    const response = await fetch(new URL(`/v1/deployment-intents/${encodeURIComponent(deploymentIntent.intentId)}/route-refresh`, config.relayUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${deploymentIntent.cliToken}`
      },
      signal: AbortSignal.timeout(numberEnv("SWITCHBOARD_DEPLOY_INTENT_ROUTE_TIMEOUT_MS", 60_000))
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) as Record<string, unknown> : {};
    last = json;
    const route = objectField(json, "route") ?? objectField(objectField(json, "intent"), "route");
    if (response.ok && json.ok === true && stringField(route, "status") === "active") {
      return json;
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Deployment intent route refresh unauthorized: ${response.status} ${JSON.stringify(json)}`);
    }

    const reason = stringField(json, "reason") ?? stringField(json, "error") ?? `http_${response.status}`;
    logWaitStatus(
      "Waiting for route activation",
      `status=${stringField(route, "status") ?? "pending"} reason=${reason}; elapsed ${formatDuration(Date.now() - startedAt)}`,
      `${stringField(route, "status") ?? "pending"}:${reason}`
    );
    await sleep(config.pollIntervalMs);
  }

  throw new Error(`Timed out waiting for network route activation after ${config.routeTimeoutMs}ms; last=${JSON.stringify(last)}`);
}

async function readDeploymentIntent(
  config: HarnessConfig,
  deploymentIntent: DeploymentIntentBootstrap
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(`/v1/deployment-intents/${encodeURIComponent(deploymentIntent.intentId)}`, config.relayUrl), {
    method: "GET",
    headers: {
      authorization: `Bearer ${deploymentIntent.cliToken}`
    },
    signal: AbortSignal.timeout(numberEnv("SWITCHBOARD_DEPLOY_INTENT_STATUS_TIMEOUT_MS", 60_000))
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok || json.ok !== true) {
    throw new Error(`Deployment intent status failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function waitForDeploymentIntentDnsPropagated(
  config: HarnessConfig,
  deploymentIntent: DeploymentIntentBootstrap,
  hostname: string
): Promise<Record<string, unknown> | undefined> {
  if (config.dns.publicProbeMode !== "dns" || !isCanonicalConsumerIngressHostname(hostname)) {
    return undefined;
  }

  const expectedHostname = normalizeDnsHostname(hostname);
  const startedAt = Date.now();
  let lastDns: Record<string, unknown> | undefined;
  while (Date.now() - startedAt <= config.dns.waitTimeoutMs) {
    const status = await readDeploymentIntent(config, deploymentIntent);
    const intent = requiredRecordField(status, "intent");
    const dns = objectField(intent, "dns");
    if (!dns) {
      logWaitStatus(
        "Waiting for canonical DNS",
        `${expectedHostname} status=missing; elapsed ${formatDuration(Date.now() - startedAt)}`,
        `${expectedHostname}:missing`
      );
      await sleep(config.pollIntervalMs);
      continue;
    }

    lastDns = dns;
    const dnsHostname = stringField(dns, "hostname");
    const state = stringField(dns, "status") ?? "unknown";
    const targetIp = stringField(dns, "targetIp");
    if (dnsHostname && normalizeDnsHostname(dnsHostname) !== expectedHostname) {
      throw new Error(`Canonical DNS materialization hostname mismatch: expected ${expectedHostname}, relay reported ${dnsHostname}`);
    }
    if (state === "propagated") {
      console.log(deployStatus("ok", "Published DNS", `${expectedHostname} -> ${targetIp ?? "unknown"}`));
      return dns;
    }
    if (state === "failed") {
      throw new Error(`Canonical DNS materialization failed for ${expectedHostname}: ${stringField(dns, "lastError") ?? JSON.stringify(dns)}`);
    }

    logWaitStatus(
      "Waiting for canonical DNS",
      `${expectedHostname} status=${state}${targetIp ? ` target=${targetIp}` : ""}; elapsed ${formatDuration(Date.now() - startedAt)}`,
      `${expectedHostname}:${state}:${targetIp ?? ""}`
    );
    await sleep(config.pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for canonical DNS materialization for ${expectedHostname} after ${config.dns.waitTimeoutMs}ms; last=${JSON.stringify(lastDns)}`
  );
}

async function waitForDeploymentIntentClaimed(
  config: HarnessConfig,
  deploymentIntent: DeploymentIntentBootstrap,
  expectedRuntimeSigner: string
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= config.registrationTimeoutMs) {
    const status = await readDeploymentIntent(config, deploymentIntent);
    const intent = requiredRecordField(status, "intent");
    const runtimeSigner = stringField(intent, "runtimeSigner");
    if (runtimeSigner) {
      if (ethers.getAddress(runtimeSigner) !== ethers.getAddress(expectedRuntimeSigner)) {
        throw new Error(`Deployment intent claimed by ${runtimeSigner}, expected ${expectedRuntimeSigner}`);
      }
      console.log(deployStatus("ok", "Deployment intent claimed", runtimeSigner));
      return intent;
    }
    logWaitStatus("Waiting for deployment intent claim", `elapsed ${formatDuration(Date.now() - startedAt)}`, "pending");
    await sleep(config.pollIntervalMs);
  }
  throw new Error(`Timed out waiting for deployment intent ${deploymentIntent.intentId} to be claimed`);
}

async function selectProcessor(config: HarnessConfig): Promise<string> {
  const explicit = stringEnv("SWITCHBOARD_DEPLOY_PROCESSOR") ?? stringEnv("ACURAST_INSTANT_MATCH_PROCESSORS")?.split(",")[0];
  if (explicit) {
    return explicit;
  }

  const result = await run(
    "pnpm",
    [
      "--silent",
      "acurast:list-processors",
      "--",
      "--network",
      config.network,
      "--manager-id",
      config.managerId,
      "--limit",
      "1",
      "--available-for-ms",
      String(config.executionMs),
      "--start-delay-ms",
      String(config.startDelayMs),
      "--json"
    ],
    { env: acurastEnv(config) }
  );
  const parsed = JSON.parse(result.stdout) as { selected?: Array<{ processor?: string }> };
  const processor = parsed.selected?.[0]?.processor;
  if (!processor) {
    throw new Error(`No processor selected from manager ${config.managerId}`);
  }
  return processor;
}

async function assertRelayHealthy(relayUrl: string): Promise<void> {
  const response = await fetch(new URL("/health", relayUrl), {
    headers: {
      accept: "application/json"
    }
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Relay health check failed (${response.status}): ${body}`);
  }
}

async function deployAcurastJob(
  config: HarnessConfig,
  buildConfigPath: string,
  processor: string,
  deploymentIntent: DeploymentIntentBootstrap | DeploymentIntentGroupBootstrap,
  jobConfig: AcurastJobConfigFile
): Promise<{ deploymentId: string; txHash: string; output: string }> {
  const result = await run("pnpm", ["--silent", "acurast:deploy-express:direct", "--", "--yes"], {
    env: {
      ...acurastEnv(config),
      ACURAST_DEPLOYMENT_PROFILE: "smoke",
      ACURAST_START_DELAY_MS: String(config.startDelayMs),
      ACURAST_EXECUTION_MS: String(config.executionMs),
      ACURAST_MAX_ALLOWED_START_DELAY_MS: String(config.maxAllowedStartDelayMs),
      ACURAST_INSTANT_MATCH_START_DELAY_MS: String(config.instantMatchStartDelayMs),
      ACURAST_MAX_COST_PER_EXECUTION: config.maxCostPerExecution,
      ACURAST_INSTANT_MATCH_PROCESSORS: stringEnv("ACURAST_INSTANT_MATCH_PROCESSORS") ?? processor,
      ACURAST_REPLICAS: stringEnv("ACURAST_REPLICAS"),
      ACURAST_COMPACT_ENV: "true",
      ...includedAcurastEnvironment(),
      ...consumerJobRuntimeEnvironment(config, jobConfig, deploymentIntent),
      SWITCHBOARD_BUILD_CONFIG_FILE: buildConfigPath
    },
    stream: true
  });

  const combined = `${result.stdout}\n${result.stderr}`;
  const match = combined.match(/Direct deploy registered: deploymentId=([0-9]+) tx=(0x[0-9a-fA-F]+)/);
  if (!match) {
    throw new Error("Could not parse direct deploy deployment ID from output");
  }

  return {
    deploymentId: match[1],
    txHash: match[2],
    output: combined
  };
}

async function updateAcurastJobEnv(
  config: HarnessConfig,
  input: {
    deploymentId: string;
    buildConfigPath: string;
  }
): Promise<void> {
  await run("pnpm", ["--silent", "acurast:update-env-express", "--", "--deployment-id", input.deploymentId], {
    env: {
      ...acurastEnv(config),
      ACURAST_DEPLOYMENT_PROFILE: "smoke",
      ACURAST_COMPACT_ENV: "true",
      ...includedAcurastEnvironment(),
      SWITCHBOARD_CONTROL_TOKEN: config.jobControlToken,
      SWITCHBOARD_BUILD_CONFIG_FILE: input.buildConfigPath
    },
    stream: true
  });
}

function consumerJobRuntimeEnvironment(
  config: HarnessConfig,
  jobConfig: AcurastJobConfigFile,
  deploymentIntent: DeploymentIntentBootstrap | DeploymentIntentGroupBootstrap
): Record<string, string> {
  const intentEnv =
    "members" in deploymentIntent
      ? {
          SWITCHBOARD_RELAY_URL: deploymentIntent.env.SWITCHBOARD_RELAY_URL,
          SWITCHBOARD_INTENT_GROUP_ID: deploymentIntent.env.SWITCHBOARD_INTENT_GROUP_ID,
          SWITCHBOARD_INTENT_TOKEN: deploymentIntent.env.SWITCHBOARD_INTENT_TOKEN
        }
      : {
          SWITCHBOARD_RELAY_URL: deploymentIntent.env.SWITCHBOARD_RELAY_URL,
          SWITCHBOARD_INTENT_ID: deploymentIntent.env.SWITCHBOARD_INTENT_ID,
          SWITCHBOARD_INTENT_TOKEN: deploymentIntent.env.SWITCHBOARD_INTENT_TOKEN
        };
  return {
    SWITCHBOARD_CONFIG: JSON.stringify({
      PORT: jobConfig.PORT,
      SWITCHBOARD_HOST: jobConfig.SWITCHBOARD_HOST,
      SWITCHBOARD_AUTO_REGISTER: jobConfig.SWITCHBOARD_AUTO_REGISTER,
      ...intentEnv,
      SWITCHBOARD_INTENT_POLL_MS: jobConfig.SWITCHBOARD_INTENT_POLL_MS,
      SWITCHBOARD_INTENT_MAX_ATTEMPTS: jobConfig.SWITCHBOARD_INTENT_MAX_ATTEMPTS,
      SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS: jobConfig.SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS,
      SWITCHBOARD_CERTIFICATE_MODE: jobConfig.SWITCHBOARD_CERTIFICATE_MODE,
      SWITCHBOARD_CERTIFICATE_REQUEST_TIMEOUT_MS: jobConfig.SWITCHBOARD_CERTIFICATE_REQUEST_TIMEOUT_MS,
      SWITCHBOARD_RELAY_DIAGNOSTICS: jobConfig.SWITCHBOARD_RELAY_DIAGNOSTICS,
      SWITCHBOARD_RELAY_DIAGNOSTICS_TIMEOUT_MS: jobConfig.SWITCHBOARD_RELAY_DIAGNOSTICS_TIMEOUT_MS,
      SWITCHBOARD_DEMO_VERSION: jobConfig.SWITCHBOARD_DEMO_VERSION,
      ...(process.env.SWITCHBOARD_DEPLOY_ENABLE_JOB_CONTROL === "true"
        ? { SWITCHBOARD_CONTROL_TOKEN: config.jobControlToken }
        : {})
    })
  };
}

async function readManagedExtraBuildConfig(): Promise<Record<string, string>> {
  const filePath = stringEnv("SWITCHBOARD_DEPLOY_EXTRA_BUILD_CONFIG_FILE");
  if (!filePath) return {};

  const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([key, value]) => {
      if (!key.startsWith("SWITCHBOARD_MANAGED_")) {
        throw new Error(`SWITCHBOARD_DEPLOY_EXTRA_BUILD_CONFIG_FILE may only contain SWITCHBOARD_MANAGED_* keys, got ${key}`);
      }
      if (value === undefined || value === null) return [];
      return [[key, typeof value === "string" ? value : JSON.stringify(value)]];
    })
  );
}

async function waitForRuntimeObservation(
  deploymentIntent: DeploymentIntentBootstrap,
  config: HarnessConfig,
  schedule?: DeploymentSchedule
): Promise<RuntimeObservation> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + config.runtimeTimeoutMs;
  const registerDeadlineAt = jobControlPlaneRegisterDeadline(schedule, startedAt);
  const runtimeStatusIntervalMs = Math.max(1_000, numberEnv("SWITCHBOARD_DEPLOY_RUNTIME_STATUS_INTERVAL_MS", 15_000));
  await waitForScheduledJobStart(schedule, deadlineAt);

  while (Date.now() <= Math.min(deadlineAt, registerDeadlineAt)) {
    const status = await readDeploymentIntent(config, deploymentIntent);
    const intent = requiredRecordField(status, "intent");
    const jobSigner = stringField(intent, "runtimeSigner");
    const candidateIps = stringArrayField(intent, "upstreamIps");
    const explicitUpstreamIp = stringEnv("SWITCHBOARD_DEPLOY_UPSTREAM_IP");
    if (explicitUpstreamIp && !candidateIps.includes(explicitUpstreamIp)) {
      candidateIps.unshift(explicitUpstreamIp);
    }
    if (jobSigner && candidateIps.length > 0) {
      return {
        jobSigner: ethers.getAddress(jobSigner),
        serverListening: true,
        candidateIps
      };
    }

    const remainingTimeoutMs = Math.min(deadlineAt, registerDeadlineAt) - Date.now();
    if (remainingTimeoutMs <= 0) {
      break;
    }
    const nextCheckMs = Math.min(runtimeStatusIntervalMs, remainingTimeoutMs);
    logWaitStatus(
      "Waiting for job to be launched",
      `signer=${Boolean(jobSigner)} ips=${candidateIps.length}; ${maxStartTimeStatus(schedule, config)}; next check in ${formatDuration(nextCheckMs)}`,
      `${Boolean(jobSigner)}:${candidateIps.length}:${maxStartTimeState(schedule, config)}`
    );
    await sleep(nextCheckMs);
  }

  if (Date.now() >= registerDeadlineAt) {
    throw new Error(JOB_CONTROL_PLANE_REGISTER_TIMEOUT_MESSAGE);
  }
  throw new Error(`Timed out waiting for Acurast runtime claim after ${config.runtimeTimeoutMs}ms`);
}

function jobControlPlaneRegisterDeadline(schedule: DeploymentSchedule | undefined, startedAt: number): number {
  const timeoutMs = Math.max(
    1_000,
    numberEnv("SWITCHBOARD_DEPLOY_JOB_REGISTER_TIMEOUT_MS", DEFAULT_JOB_CONTROL_PLANE_REGISTER_TIMEOUT_MS)
  );
  return (schedule?.startMs ?? startedAt) + timeoutMs;
}

async function waitForScheduledJobStart(schedule: DeploymentSchedule | undefined, deadlineAt: number): Promise<void> {
  if (!schedule?.startMs) {
    return;
  }
  const waitMs = schedule.startMs - Date.now();
  if (waitMs <= 0) {
    return;
  }
  const remainingTimeoutMs = deadlineAt - Date.now();
  if (remainingTimeoutMs <= 0) {
    return;
  }
  console.log(deployStatus("wait", "Waiting for job start time", `${schedule.startIso} in ${formatDuration(waitMs)}`));
  await sleep(Math.min(waitMs, remainingTimeoutMs));
}

function maxStartTimeStatus(schedule: DeploymentSchedule | undefined, config: HarnessConfig): string {
  if (!schedule?.startMs) {
    return "max start time unknown";
  }
  const maxStartMs = schedule.startMs + config.maxAllowedStartDelayMs;
  const remainingMs = maxStartMs - Date.now();
  if (remainingMs >= 0) {
    return `max start time in ${formatDuration(remainingMs)}`;
  }
  return `max start time passed ${formatDuration(Math.abs(remainingMs))} ago`;
}

function maxStartTimeState(schedule: DeploymentSchedule | undefined, config: HarnessConfig): string {
  if (!schedule?.startMs) {
    return "unknown";
  }
  const maxStartMs = schedule.startMs + config.maxAllowedStartDelayMs;
  return maxStartMs - Date.now() >= 0 ? "before-max-start" : "after-max-start";
}

async function selectReachableUpstream(config: HarnessConfig, candidateIps: string[]): Promise<string> {
  const explicit = stringEnv("SWITCHBOARD_DEPLOY_UPSTREAM_IP");
  const candidates = explicit ? [explicit] : candidateIps;
  const errors: string[] = [];

  for (const ip of candidates) {
    const nonce = `direct-${config.runId}-${ip.replaceAll(".", "-")}`;
    const url = `https://${config.hostname}:${config.port}/.well-known/proofcomputer/challenge?nonce=${nonce}`;
    const result = await run(
      "ssh",
      [
        "-F",
        "/dev/null",
        "-o",
        "BatchMode=yes",
        config.operatorSshHost,
        "curl",
        ...(config.publicProbeInsecure ? ["-k"] : []),
        "-sS",
        "--connect-timeout",
        "5",
        "--max-time",
        "10",
        "--resolve",
        `${config.hostname}:${config.port}:${ip}`,
        url
      ],
      { allowFailure: true }
    );
    if (result.exitCode === 0) {
      const parsed = parseJsonObject(result.stdout);
      if (parsed?.nonce === nonce) {
        return ip;
      }
    }
    errors.push(`${ip}: ${result.stderr || result.stdout}`);
  }

  throw new Error(`No upstream IP was reachable from ${config.operatorSshHost}: ${errors.join("; ")}`);
}

async function selectHttpReachableUpstream(config: HarnessConfig, candidateIps: string[]): Promise<string> {
  const explicit = stringEnv("SWITCHBOARD_DEPLOY_UPSTREAM_IP");
  const candidates = explicit ? [explicit] : candidateIps;
  const errors: string[] = [];

  for (const ip of candidates) {
    const result = await run(
      "ssh",
      [
        "-F",
        "/dev/null",
        "-o",
        "BatchMode=yes",
        config.operatorSshHost,
        "curl",
        "-sS",
        "--connect-timeout",
        "5",
        "--max-time",
        "10",
        `http://${ip}:${config.port}/status`
      ],
      { allowFailure: true }
    );
    if (result.exitCode === 0) {
      const parsed = parseJsonObject(result.stdout);
      if (parsed?.ok === true) {
        return ip;
      }
    }
    errors.push(`${ip}: ${result.stderr || result.stdout}`);
  }

  throw new Error(`No HTTP control upstream IP was reachable from ${config.operatorSshHost}: ${errors.join("; ")}`);
}

function selectUpstreamCandidate(config: HarnessConfig, candidateIps: string[]): string {
  const explicit = stringEnv("SWITCHBOARD_DEPLOY_UPSTREAM_IP");
  if (explicit) {
    return explicit;
  }
  const candidate = candidateIps[0];
  if (!candidate) {
    throw new Error("No upstream IP candidates were reported by the job");
  }
  return candidate;
}

async function updateOperatorRouteMetadata(config: HarnessConfig, route: RouteMetadata): Promise<void> {
  const existingRaw = await run("ssh", [
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    config.operatorSshHost,
    "cat",
    config.operatorRouteMetadataFile
  ]);
  const existing = parseRouteMetadata(existingRaw.stdout);
  const routeIndex = existing.routes.findIndex(
    (candidate) => candidate.sessionId.toLowerCase() === route.sessionId.toLowerCase() || candidate.routeId === route.routeId
  );
  if (routeIndex >= 0) {
    existing.routes[routeIndex] = route;
  } else {
    existing.routes.push(route);
  }

  const localRouteFile = path.join(config.runDir, "routes.json");
  await writeJson(localRouteFile, existing);
  await run("ssh", [
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    config.operatorSshHost,
    "mkdir",
    "-p",
    path.posix.dirname(config.operatorRouteMetadataFile)
  ]);
  await run("rsync", [
    "-av",
    "-e",
    "ssh -F /dev/null -o BatchMode=yes",
    localRouteFile,
    `${config.operatorSshHost}:${config.operatorRouteMetadataFile}`
  ]);
}

async function activateOperatorRoute(config: HarnessConfig, route: RouteIntentPayload): Promise<void> {
  if (config.operatorRouteActivationMode === "control-plane") {
    await postControlPlaneRouteIntent(config, route);
    return;
  }
  if (config.operatorRouteActivationMode === "metadata-file") {
    await updateOperatorRouteMetadata(config, route);
    await restartHubWatcher(config);
    return;
  }

  await postGatewayAgentRouteIntent(config, route);
}

async function postControlPlaneRouteIntent(config: HarnessConfig, route: RouteIntentPayload): Promise<void> {
  const response = await fetch(new URL("/v1/route-intents", config.relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...bearerAuthHeader(requiredEnv("PROOF_CONTROL_PLANE_TOKEN"))
    },
    body: `${JSON.stringify(route)}\n`
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`control-plane route intent post failed: ${response.status} ${responseBody}`);
  }
  assertRouteIntentResponse(parseRequiredJsonObject(responseBody));
}

async function postGatewayAgentRouteIntent(config: HarnessConfig, route: RouteIntentPayload): Promise<void> {
  const body = `${JSON.stringify(route)}\n`;
  if (isLocalOperatorUrl(config.operatorRouteIntentUrl)) {
    const remoteCommand =
      "curl -sS --fail-with-body -X POST -H 'content-type: application/json' --data-binary @- " +
      shellSingleQuote(config.operatorRouteIntentUrl);
    const result = await run(
      "ssh",
      [
        "-F",
        "/dev/null",
        "-o",
        "BatchMode=yes",
        config.operatorSshHost,
        remoteCommand
      ],
      { input: body, allowFailure: true }
    );
    if (result.exitCode !== 0) {
      throw new Error(`gateway-agent route intent post failed over SSH: ${result.stderr || result.stdout}`);
    }
    assertRouteIntentResponse(parseRequiredJsonObject(result.stdout));
    return;
  }

  const response = await fetch(config.operatorRouteIntentUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`gateway-agent route intent post failed: ${response.status} ${responseBody}`);
  }
  assertRouteIntentResponse(parseRequiredJsonObject(responseBody));
}

async function restartHubWatcher(config: HarnessConfig): Promise<void> {
  await run(
    "ssh",
    [
      "-F",
      "/dev/null",
      "-o",
      "BatchMode=yes",
      config.operatorSshHost,
      "sudo",
      "-n",
      "docker",
      "compose",
      "--env-file",
      config.operatorComposeEnvFile,
      "--profile",
      config.operatorComposeProfile,
      "--project-directory",
      config.operatorProjectDir,
      "up",
      "-d",
      "--force-recreate",
      "hub-watcher"
    ],
    { stream: true }
  );
}

async function fundSession(
  config: HarnessConfig,
  input: {
    sessionId: string;
    jobId: string;
    operatorId?: string;
    processorId: string;
    jobSigner: string;
    deploymentIntent: DeploymentIntentBootstrap;
  }
): Promise<Record<string, unknown>> {
  if (config.paymentMode === "quote") {
    return fundQuotedSession(config, input);
  }

  const result = await run("pnpm", ["--silent", "hub:fund-evm-session"], {
    env: {
      SWITCHBOARD_TARGET: config.targetName,
      INGRESS_REGISTRY_ADDRESS: config.registryAddress,
      SESSION_ID: input.sessionId,
      JOB_ID: input.jobId,
      OPERATOR_ID: input.operatorId ?? config.operatorId,
      PROCESSOR_ID: input.processorId,
      ENDPOINT_HOSTNAME: config.hostname,
      JOB_SIGNER_ADDRESS: input.jobSigner,
      ...(config.paymentAmount ? { NATIVE_PAYMENT_AMOUNT: config.paymentAmount } : { LEASE_SECONDS: String(config.leaseSeconds ?? 3600) }),
      CONFIRMATIONS: "1"
    }
  });
  const funded = parseRequiredJsonObject(result.stdout);
  return {
    ...funded,
    sessionId: input.sessionId
  };
}

async function fundQuotedSession(
  config: HarnessConfig,
  input: {
    sessionId: string;
    jobId: string;
    operatorId?: string;
    processorId: string;
    jobSigner: string;
    deploymentIntent: DeploymentIntentBootstrap;
  }
): Promise<Record<string, unknown>> {
  if (config.paymentAmount) {
    throw new Error("SWITCHBOARD_DEPLOY_PAYMENT_AMOUNT/--payment-amount is not supported for signed asset quotes; quote amount is computed by the control plane");
  }

  let result: Awaited<ReturnType<typeof run>>;
  try {
    const args = [
      "--silent",
      "hub:fund-native-asset-quote",
      "--",
      "--yes",
      "--relay-url",
      config.relayUrl,
      "--deployment-intent-id",
      input.deploymentIntent.intentId,
      "--intent-token",
      input.deploymentIntent.cliToken,
      "--paid-seconds",
      String(config.leaseSeconds ?? 3600),
      "--session-label",
      `switchboard-deploy-${config.runId}`,
      "--confirmations",
      "1"
    ];
    if (config.expectedQuoteAmount) {
      args.push("--quote-cap-amount", config.expectedQuoteAmount);
    }
    if (input.deploymentIntent.groupId) {
      args.push("--deployment-intent-group-id", input.deploymentIntent.groupId);
      args.push("--group-member-intent-id", input.deploymentIntent.intentId);
    }
    result = await run("pnpm", args, {
      env: {
        SWITCHBOARD_TARGET: config.targetName,
        INGRESS_REGISTRY_ADDRESS: config.registryAddress,
        SWITCHBOARD_INTENT_ID: input.deploymentIntent.intentId,
        SWITCHBOARD_INTENT_CLI_TOKEN: input.deploymentIntent.cliToken,
        JOB_ID: input.jobId,
        JOB_SIGNER_ADDRESS: input.jobSigner,
        OPERATOR_ID: input.operatorId ?? config.operatorId,
        PROCESSOR_ID: input.processorId,
        PAID_SECONDS: String(config.leaseSeconds ?? 3600),
        SWITCHBOARD_QUOTE_CAP_AMOUNT: config.expectedQuoteAmount
      },
      stream: false
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Hub quote funding helper failed before returning a funding result for deployment intent ${input.deploymentIntent.intentId}. ` +
        `The helper error should identify whether it failed during quote retrieval/resume, approval, or fundWithAssetQuote: ${message}`
    );
  }
  const funded = parseRequiredJsonObject(result.stdout);
  const quote = requiredRecordField(funded, "quote");
  const sessionId = requiredStringField(quote, "sessionId");
  const txs = Array.isArray(funded.txs) ? funded.txs as Array<Record<string, unknown>> : [];
  const fundingTx = txs.find((tx) => stringField(tx, "action") === "fundWithAssetQuote") ?? txs[txs.length - 1];

  return {
    ...funded,
    action: "fund-quoted-session",
    sessionId,
    endpointHostname: stringField(funded, "endpointHostname"),
    validationHostname: stringField(funded, "validationHostname"),
    paymentAmount: requiredStringField(quote, "amount"),
    txHash: stringField(fundingTx, "txHash"),
    fundingTxHash: stringField(fundingTx, "txHash")
  };
}

async function triggerJobRegistration(
  config: HarnessConfig,
  input: {
    upstreamIp: string;
    sessionId: string;
    jobId: string;
    processorId: string;
  }
): Promise<Record<string, unknown>> {
  const payload = {
    token: config.jobControlToken,
    relayUrl: config.relayUrl,
    chainId: getSwitchboardTarget(config.targetName).expectedChainId?.toString() ?? String(process.env.CHAIN_ID ?? ""),
    registryAddress: config.registryAddress,
    sessionId: input.sessionId,
    jobId: input.jobId,
    operatorId: config.operatorId,
    processorId: input.processorId,
    endpointHostname: config.hostname,
    nonce: "1",
    deadline: String(Math.floor(Date.now() / 1000) + 900)
  };
  const body = `${JSON.stringify(payload)}\n`;
  const url =
    config.certificateMode === "job-acme"
      ? `http://${input.upstreamIp}:${config.port}/__proof/ingress/register`
      : `https://${config.hostname}:${config.port}/__proof/ingress/register`;
  const curlArgs = [
    "curl",
    "-sS",
    "--fail-with-body",
    "-X",
    "POST",
    "-H",
    "content-type: application/json",
    "--connect-timeout",
    "10",
    "--max-time",
    String(Math.ceil(numberEnv("SWITCHBOARD_DEPLOY_JOB_CONTROL_TIMEOUT_MS", 480_000) / 1000)),
    ...(config.certificateMode === "job-acme"
      ? []
      : [
          ...(config.publicProbeInsecure ? ["-k"] : []),
          "--resolve",
          `${config.hostname}:${config.port}:${input.upstreamIp}`
        ]),
    "--data-binary",
    "@-",
    url
  ];
  const attempts = numberEnv("SWITCHBOARD_DEPLOY_JOB_CONTROL_ATTEMPTS", 3);
  const retryMs = numberEnv("SWITCHBOARD_DEPLOY_JOB_CONTROL_RETRY_MS", 10_000);
  let lastFailure = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await run(
      "ssh",
      [
        "-F",
        "/dev/null",
        "-o",
        "BatchMode=yes",
        config.operatorSshHost,
        curlArgs.map(shellSingleQuote).join(" ")
      ],
      { input: body, allowFailure: true }
    );
    if (result.exitCode === 0) {
      return parseRequiredJsonObject(result.stdout);
    }
    lastFailure = [result.stderr, result.stdout].filter((value) => value.trim().length > 0).join("\n");
    if (attempt < attempts) {
      console.log(deployStatus("warn", "Job registration control failed", `attempt ${attempt}/${attempts}; retrying`));
      await sleep(retryMs);
    }
  }
  throw new Error(`job registration control request failed: ${lastFailure}`);
}

async function triggerJobCertificate(
  config: HarnessConfig,
  input: {
    upstreamIp: string;
    sessionId: string;
    jobId: string;
    processorId: string;
  }
): Promise<Record<string, unknown>> {
  const payload = {
    token: config.jobControlToken,
    relayUrl: config.relayUrl,
    chainId: getSwitchboardTarget(config.targetName).expectedChainId?.toString() ?? String(process.env.CHAIN_ID ?? ""),
    registryAddress: config.registryAddress,
    sessionId: input.sessionId,
    jobId: input.jobId,
    operatorId: config.operatorId,
    processorId: input.processorId,
    endpointHostname: config.hostname,
    nonce: "1",
    deadline: String(Math.floor(Date.now() / 1000) + 900)
  };
  const body = `${JSON.stringify(payload)}\n`;
  const result = await run(
    "ssh",
    [
      "-F",
      "/dev/null",
      "-o",
      "BatchMode=yes",
      config.operatorSshHost,
      [
        "curl",
        "-sS",
        "--fail-with-body",
        "-X",
        "POST",
        "-H",
        "content-type: application/json",
        "--connect-timeout",
        "10",
        "--max-time",
        String(Math.ceil(numberEnv("SWITCHBOARD_DEPLOY_JOB_CONTROL_TIMEOUT_MS", 480_000) / 1000)),
        "--data-binary",
        "@-",
        `http://${input.upstreamIp}:${config.port}/__proof/ingress/certificate`
      ]
        .map(shellSingleQuote)
        .join(" ")
    ],
    { input: body, allowFailure: true }
  );
  if (result.exitCode !== 0) {
    const details = [result.stderr, result.stdout].filter((value) => value.trim().length > 0).join("\n");
    throw new Error(`job certificate control request failed: ${details}`);
  }
  return parseRequiredJsonObject(result.stdout);
}

async function waitForRegistration(
  config: HarnessConfig,
  sessionId: string
): Promise<RegistrationObservation> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= config.registrationTimeoutMs) {
    const session = await readSession(config, sessionId);
    if (session.registered === true) {
      return { source: "hub-read", event: session };
    } else {
      logWaitStatus(
        "Waiting for on-chain registration",
        `elapsed ${formatDuration(Date.now() - startedAt)}; next check in ${formatDuration(config.pollIntervalMs)}`,
        "pending"
      );
    }

    await sleep(config.pollIntervalMs);
  }

  throw new Error(`Timed out waiting for registration after ${config.registrationTimeoutMs}ms`);
}

async function enrichRegistrationFromPublicStatus(
  config: HarnessConfig,
  registration: RegistrationObservation,
  dnsMaterialization?: Record<string, unknown>
): Promise<RegistrationObservation> {
  if (registration.txHash) {
    return registration;
  }
  const status = await readPublicRuntimeStatus(config, dnsMaterialization);
  const runtimeRegistration = objectField(status, "registration");
  const relayResponse = objectField(runtimeRegistration, "relayResponse");
  const txHash = stringField(relayResponse, "txHash");
  if (!txHash) {
    return registration;
  }
  return {
    ...registration,
    txHash,
    blockNumber: optionalNumberField(relayResponse, "blockNumber"),
    event: objectField(relayResponse, "event") ?? registration.event,
    source: "runtime-status"
  };
}

async function readPublicRuntimeStatus(
  config: HarnessConfig,
  dnsMaterialization?: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const result = await run(
    "curl",
    [...publicRouteCurlArgs(config, dnsMaterialization), `https://${config.hostname}/status`],
    { allowFailure: true }
  );
  if (result.exitCode !== 0) {
    return undefined;
  }
  return parseJsonObject(result.stdout);
}

async function readSession(config: HarnessConfig, sessionId: string): Promise<Record<string, unknown>> {
  const result = await run("pnpm", ["--silent", "hub:read-session"], {
    env: {
      SWITCHBOARD_TARGET: config.targetName,
      INGRESS_REGISTRY_ADDRESS: config.registryAddress,
      SESSION_ID: sessionId
    }
  });
  return parseRequiredJsonObject(result.stdout);
}

async function inspectAcurastDeployment(config: HarnessConfig, deploymentId: string): Promise<Record<string, unknown>> {
  const result = await run("pnpm", ["--silent", "acurast:inspect-express", "--", "--deployment-id", deploymentId, "--events", "--json"], {
    env: acurastEnv(config)
  });
  return parseRequiredJsonObject(result.stdout);
}

async function waitForPublicRoute(
  config: HarnessConfig,
  sessionId: string,
  dnsMaterialization?: Record<string, unknown>
): Promise<{ nonce: string; response: Record<string, unknown> }> {
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt <= config.routeTimeoutMs) {
    attempt += 1;
    const nonce = `public-${config.runId}-${attempt}`;
    const curlArgs = publicRouteCurlArgs(config, dnsMaterialization);
    curlArgs.push(`https://${config.hostname}/.well-known/proofcomputer/challenge?nonce=${nonce}`);
    const result = await run(
      "curl",
      curlArgs,
      { allowFailure: true }
    );
    if (result.exitCode === 0) {
      const parsed = parseJsonObject(result.stdout);
      if (
        parsed?.nonce === nonce &&
        typeof parsed.sessionId === "string" &&
        parsed.sessionId.toLowerCase() === sessionId.toLowerCase()
      ) {
        return {
          nonce,
          response: parsed
        };
      }
    }

    logWaitStatus(
      "Waiting for public HTTPS route",
      `elapsed ${formatDuration(Date.now() - startedAt)}; next check in ${formatDuration(config.pollIntervalMs)}`,
      "pending"
    );
    await sleep(config.pollIntervalMs);
  }

  throw new Error(`Timed out waiting for public route after ${config.routeTimeoutMs}ms`);
}

async function waitForPublicRouteAnySession(
  config: HarnessConfig,
  sessionIds: string[],
  dnsMaterialization?: Record<string, unknown>
): Promise<{ nonce: string; response: Record<string, unknown> }> {
  const expected = new Set(sessionIds.map((sessionId) => sessionId.toLowerCase()));
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt <= config.routeTimeoutMs) {
    attempt += 1;
    const nonce = `public-${config.runId}-${attempt}`;
    const curlArgs = publicRouteCurlArgs(config, dnsMaterialization);
    curlArgs.push(`https://${config.hostname}/.well-known/proofcomputer/challenge?nonce=${nonce}`);
    const result = await run("curl", curlArgs, { allowFailure: true });
    if (result.exitCode === 0) {
      const parsed = parseJsonObject(result.stdout);
      if (
        parsed?.nonce === nonce &&
        typeof parsed.sessionId === "string" &&
        expected.has(parsed.sessionId.toLowerCase())
      ) {
        return {
          nonce,
          response: parsed
        };
      }
    }

    logWaitStatus(
      "Waiting for public HTTPS route",
      `elapsed ${formatDuration(Date.now() - startedAt)}; next check in ${formatDuration(config.pollIntervalMs)}`,
      "pending"
    );
    await sleep(config.pollIntervalMs);
  }

  throw new Error(`Timed out waiting for public HA route after ${config.routeTimeoutMs}ms`);
}

function publicRouteCurlArgs(config: HarnessConfig, dnsMaterialization?: Record<string, unknown>): string[] {
  const curlArgs = [
    ...(config.publicProbeInsecure ? ["-k"] : []),
    "-sS",
    "--connect-timeout",
    "10",
    "--max-time",
    "15"
  ];
  if (config.dns.publicProbeMode === "resolve") {
    const resolveIp = config.operatorPublicIp || stringField(dnsMaterialization, "targetIp");
    if (!resolveIp) {
      throw new Error("Public probe mode resolve requires --operator-public-ip or propagated relay DNS targetIp");
    }
    curlArgs.push("--resolve", `${config.hostname}:443:${resolveIp}`);
  } else if (config.dns.curlDohUrl) {
    curlArgs.push("--doh-url", config.dns.curlDohUrl);
  }
  return curlArgs;
}

async function runValidationStage(
  config: HarnessConfig,
  input: {
    reportPath: string;
    sessionId: string;
    hostname: string;
    deploymentId: string;
  }
): Promise<Record<string, unknown> | undefined> {
  if (config.validatorMode === "skip") {
    return undefined;
  }
  if (config.validatorMode === "acurast") {
    return runAcurastValidator(config, input);
  }
  return runLocalValidator(config, input);
}

async function createValidatorWorkPackages(
  config: HarnessConfig,
  input: {
    sessionId: string;
    hostname: string;
    deploymentId: string;
  }
): Promise<Record<string, unknown> | undefined> {
  if (config.validatorMode === "skip") {
    return undefined;
  }
  const intervalSeconds = numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_WORK_INTERVAL_SECONDS", 300);
  const checkTimeoutMs = numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_TIMEOUT_MS", 15_000);
  const leaseSeconds = config.leaseSeconds ?? 3600;
  const bufferSeconds = Math.max(3600, (config.scheduleBufferMinutes ?? 10) * 60);
  const expiresAt = new Date(Date.now() + (leaseSeconds + bufferSeconds) * 1000).toISOString();
  const count = validatorTargetCount(config);
  const relayUrls = await validatorWorkPackageRelayUrls(config);
  const authHeader = bearerAuthHeader(requiredEnv("PROOF_CONTROL_PLANE_TOKEN"));
  const work: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index += 1) {
    const slot = index + 1;
    const workId = ethers.keccak256(
      ethers.solidityPacked(
        ["bytes32", "string", "string", "uint256"],
        [input.sessionId, input.hostname, input.deploymentId, slot]
      )
    );
    const payload = {
      workId,
      sessionId: input.sessionId,
      hostname: input.hostname,
      deploymentId: input.deploymentId,
      operatorId: config.operatorId,
      mode: "route_open",
      port: 443,
      intervalSeconds,
      checkTimeoutMs,
      expiresAt,
      source: {
        mode: "switchboard-deploy",
        runId: config.runId,
        durationMinutes: config.durationMinutes,
        leaseSeconds: config.leaseSeconds,
        workIndex: slot,
        workCount: count
      }
    };
    let primaryWork: Record<string, unknown> | undefined;
    for (const relayUrl of relayUrls) {
      const response = await fetch(new URL("/v1/validator-work-packages", relayUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeader
        },
        body: JSON.stringify(payload)
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`validator work package creation failed on ${relayUrl}: ${response.status} ${body}`);
      }
      primaryWork ??= requiredRecordField(parseRequiredJsonObject(body), "work");
    }
    work.push(primaryWork ?? payload);
  }
  return {
    ok: true,
    relays: relayUrls,
    count,
    work
  };
}

async function validatorWorkPackageRelayUrls(config: HarnessConfig): Promise<string[]> {
  const urls = [config.relayUrl];
  try {
    const response = await fetch(new URL("/v1/network-manifest", config.relayUrl), {
      headers: {
        accept: "application/json"
      },
      signal: AbortSignal.timeout(5000)
    });
    if (response.ok) {
      const body = await response.json() as { manifest?: { relays?: Array<{ active?: boolean; apiBaseUrl?: string }> } };
      for (const relay of body.manifest?.relays ?? []) {
        if (relay.active === false || !relay.apiBaseUrl) {
          continue;
        }
        urls.push(relay.apiBaseUrl);
      }
    }
  } catch (error) {
    console.log(deployStatus("warn", "Validator relay discovery skipped", error instanceof Error ? error.message : String(error)));
  }
  return unique(urls.map((value) => new URL(value).toString()));
}

async function runLocalValidator(
  config: HarnessConfig,
  input: {
    reportPath: string;
    sessionId: string;
    hostname: string;
    deploymentId: string;
  }
): Promise<Record<string, unknown>> {
  const result = await run("pnpm", [
    "--silent",
    "switchboard:validator:run",
    "--",
    "--session-id",
    input.sessionId,
    "--hostname",
    input.hostname,
    "--control-plane-url",
    config.relayUrl,
    "--deployment-id",
    input.deploymentId,
    "--operator-id",
    config.operatorId,
    "--validator-id",
    `proof-validator-local-${config.runId}`,
    "--json"
  ]);
  const parsed = parseRequiredJsonObject(result.stdout);
  const report = requiredRecordField(parsed, "report");
  return {
    mode: "local",
    reportId: requiredStringField(report, "reportId"),
    success: Boolean(report.success),
    signer: stringField(report.signature, "signer"),
    submitted: parsed.submitted,
    report
  };
}

async function runAcurastValidator(
  config: HarnessConfig,
  input: {
    sessionId: string;
    hostname: string;
    deploymentId: string;
  }
): Promise<Record<string, unknown>> {
  requiredEnv("VALIDATOR_REPORT_SEED", stringEnv("PROOF_VALIDATOR_REPORT_SEED"));
  const validatorProcessors = await selectValidatorProcessors(config);
  const targetCount = validatorTargetCount(config);
  const requiredDeployments = validatorRequiredReports(config);
  const validatorExecutionMs = numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_EXECUTION_MS", config.executionMs);
  const validatorStartDelayMs = numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_START_DELAY_MS", 300_000);
  const validatorControlPlaneUrl = stringEnv("SWITCHBOARD_DEPLOY_VALIDATOR_CONTROL_PLANE_URL") ?? config.relayUrl;

  const deploymentAttempts: Array<Record<string, unknown>> = [];
  const deployments: Array<{ deploymentId: string; txHash: string; processor: string; validatorId: string }> = [];
  for (const [index, validatorProcessor] of validatorProcessors.entries()) {
    if (deployments.length >= targetCount) {
      break;
    }
    const slot = deployments.length + 1;
    const validatorId = `acurast-validator-${config.runId}-${slot}`;
    const validatorConfigPath = path.join(config.runDir, `validator-config-${slot}.json`);
    await writeJson(validatorConfigPath, {
      VALIDATION_SESSION_ID: input.sessionId,
      VALIDATION_HOSTNAME: input.hostname,
      PROOF_CONTROL_PLANE_URL: validatorControlPlaneUrl,
      TARGET_DEPLOYMENT_ID: input.deploymentId,
      OPERATOR_ID: config.operatorId,
      VALIDATOR_ID: validatorId,
      VALIDATION_MODE: "route_open",
      VALIDATION_TIMEOUT_MS: String(numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_TIMEOUT_MS", 15_000)),
      VALIDATOR_WORK_MODE: "poll",
      VALIDATOR_WORK_POLL: "true",
      VALIDATOR_WORK_RUN_MS: String(validatorExecutionMs),
      VALIDATOR_WORK_POLL_INTERVAL_MS: String(numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_WORK_POLL_INTERVAL_MS", 30_000)),
      VALIDATOR_WORK_LEASE_SECONDS: String(numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_WORK_LEASE_SECONDS", 120)),
      VALIDATOR_WORK_MAX_ITEMS: "1"
    });

    console.log(
      deployStatus(
        "info",
        "Validator processor",
        `${compactId(validatorProcessor)} validator=${slot}/${targetCount} candidate=${index + 1}/${validatorProcessors.length}`
      )
    );
    const validatorScriptIpfs = stringEnv("SWITCHBOARD_VALIDATOR_SCRIPT_IPFS") ?? stringEnv("PROOF_VALIDATOR_SCRIPT_IPFS");
    if (!validatorScriptIpfs) {
      throw new Error(
        "Real validator deployment now requires SWITCHBOARD_VALIDATOR_SCRIPT_IPFS/PROOF_VALIDATOR_SCRIPT_IPFS from the private switchboard-validator pin workflow."
      );
    }
    const result = await run("pnpm", ["--silent", "acurast:deploy-express:direct", "--", "--yes"], {
      env: {
        ...acurastEnv(config),
        ACURAST_ENTRYPOINT: "validator-job",
        ACURAST_SCRIPT_IPFS: validatorScriptIpfs,
        SWITCHBOARD_SKIP_BUNDLE_BUILD: "true",
        ACURAST_STAGE_DIR: path.join(rootDir, "dist/acurast/route-validator"),
        ACURAST_PROJECT_NAME: "switchboard-validator",
        ACURAST_DEPLOYMENT_PROFILE: "smoke",
        ACURAST_START_DELAY_MS: String(validatorStartDelayMs),
        ACURAST_EXECUTION_MS: String(validatorExecutionMs),
        ACURAST_MAX_ALLOWED_START_DELAY_MS: String(numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_MAX_ALLOWED_START_DELAY_MS", 120_000)),
        ACURAST_INSTANT_MATCH_START_DELAY_MS: String(numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_INSTANT_MATCH_START_DELAY_MS", 120_000)),
        ACURAST_MAX_COST_PER_EXECUTION: stringEnv("SWITCHBOARD_DEPLOY_VALIDATOR_MAX_COST_PER_EXECUTION") ?? config.maxCostPerExecution,
        ACURAST_ACK_TIMEOUT_MS: String(numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_ACK_TIMEOUT_MS", numberEnv("ACURAST_ACK_TIMEOUT_MS", 240_000))),
        ACURAST_ACK_INTERVAL_MS: String(numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_ACK_INTERVAL_MS", numberEnv("ACURAST_ACK_INTERVAL_MS", 10_000))),
        ACURAST_INSTANT_MATCH_PROCESSORS: validatorProcessor,
        ACURAST_COMPACT_ENV: "true",
        ACURAST_INCLUDE_ENV: "VALIDATOR_REPORT_SEED",
        VALIDATOR_REPORT_SEED: requiredEnv("VALIDATOR_REPORT_SEED", stringEnv("PROOF_VALIDATOR_REPORT_SEED")),
        SWITCHBOARD_BUILD_CONFIG_FILE: validatorConfigPath
      },
      stream: true,
      allowFailure: true
    });
    const combined = `${result.stdout}\n${result.stderr}`;
    const match = combined.match(/Direct deploy registered: deploymentId=([0-9]+) tx=(0x[0-9a-fA-F]+)/);
    const attempt = {
      processor: validatorProcessor,
      exitCode: result.exitCode,
      deploymentId: match?.[1],
      txHash: match?.[2],
      failure: result.exitCode === 0 ? undefined : summarizeValidatorDeploymentFailure(combined)
    };
    deploymentAttempts.push(attempt);
    if (result.exitCode === 0) {
      if (!match) {
        throw new Error("Could not parse validator deployment ID from output");
      }
      deployments.push({
        deploymentId: match[1],
        txHash: match[2],
        processor: validatorProcessor,
        validatorId
      });
      console.log(deployStatus("ok", "Validator deployment", `deployment=${match[1]} validator=${slot}/${targetCount}`));
      continue;
    }
    console.log(
      deployStatus(
        "warn",
        "Validator deployment attempt failed",
        `processor=${compactId(validatorProcessor)} deployment=${match?.[1] ?? "unknown"}`
      )
    );
  }
  if (deployments.length < requiredDeployments) {
    throw new Error(
      `Only ${deployments.length}/${requiredDeployments} quorum-capable validator deployments acknowledged (${targetCount} target): ${JSON.stringify(deploymentAttempts)}`
    );
  }
  if (deployments.length < targetCount) {
    console.log(deployStatus("warn", "Validator deployments degraded", `${deployments.length}/${targetCount}; continuing quorum=${requiredDeployments}`));
  }

  const reports = await waitForStoredValidationReports(config, {
    sessionId: input.sessionId,
    hostname: input.hostname,
    requiredReports: validatorRequiredReports(config),
    requiredSuccesses: validatorRequiredSuccesses(config),
    timeoutMs: numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_REPORT_TIMEOUT_MS", validatorStartDelayMs + validatorExecutionMs + 300_000)
  });
  const latestReport = reports.at(-1) ?? {};
  return {
    mode: "acurast",
    deployments,
    deploymentAttempts,
    reportId: requiredStringField(requiredRecordField(latestReport, "report"), "reportId"),
    success: reports.every((report) => Boolean(requiredRecordField(report, "report").success)),
    signer: stringField(latestReport, "signer"),
    storedReports: reports
  };
}

function rewriteUrlOrigin(rawUrl: string, targetOrigin: string): string {
  try {
    const url = new URL(rawUrl);
    const origin = new URL(targetOrigin);
    url.protocol = origin.protocol;
    url.hostname = origin.hostname;
    url.port = origin.port;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function summarizeValidatorDeploymentFailure(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.slice(-8).join(" | ").slice(0, 1200);
}

async function selectValidatorProcessors(config: HarnessConfig): Promise<string[]> {
  const explicit = stringEnv("SWITCHBOARD_DEPLOY_VALIDATOR_PROCESSOR");
  if (explicit) {
    return unique(splitCsv(explicit));
  }
  const targetCount = validatorTargetCount(config);
  const attemptsPerValidator = Math.max(1, numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_PROCESSOR_ATTEMPTS", 2));
  const limit = targetCount * attemptsPerValidator;
  const result = await run(
    "pnpm",
    [
      "--silent",
      "acurast:list-processors",
      "--",
      "--network",
      config.network,
      "--manager-id",
      config.managerId,
      "--limit",
      String(limit),
      "--available-for-ms",
      String(numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_EXECUTION_MS", 180_000)),
      "--start-delay-ms",
      String(numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_START_DELAY_MS", 300_000)),
      "--json"
    ],
    { env: acurastEnv(config) }
  );
  const parsed = JSON.parse(result.stdout) as { selected?: Array<{ processor?: string }> };
  const processors = unique((parsed.selected ?? []).map((item) => item.processor).filter((item): item is string => Boolean(item)));
  if (processors.length === 0) {
    throw new Error(`No validator processor selected from manager ${config.managerId}`);
  }
  return processors;
}

function validatorTargetCount(config: HarnessConfig): number {
  if (config.validatorMode !== "acurast") {
    return 1;
  }
  return Math.max(1, numberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_COUNT", 3));
}

function validatorRequiredReports(config: HarnessConfig): number {
  const targetCount = validatorTargetCount(config);
  const configured = optionalNumberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_REQUIRED_REPORTS");
  const required = configured ?? Math.min(2, targetCount);
  if (required > targetCount) {
    throw new Error(`SWITCHBOARD_DEPLOY_VALIDATOR_REQUIRED_REPORTS=${required} exceeds validator target count ${targetCount}`);
  }
  return Math.max(1, required);
}

function validatorRequiredSuccesses(config: HarnessConfig): number {
  const requiredReports = validatorRequiredReports(config);
  const configured = optionalNumberEnv("SWITCHBOARD_DEPLOY_VALIDATOR_REQUIRED_SUCCESSES");
  const required = configured ?? requiredReports;
  if (required > requiredReports) {
    throw new Error(`SWITCHBOARD_DEPLOY_VALIDATOR_REQUIRED_SUCCESSES=${required} exceeds required reports ${requiredReports}`);
  }
  return Math.max(1, required);
}

async function waitForStoredValidationReports(
  config: HarnessConfig,
  input: {
    sessionId: string;
    hostname: string;
    requiredReports: number;
    requiredSuccesses: number;
    timeoutMs: number;
  }
): Promise<Record<string, unknown>[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= input.timeoutMs) {
    const url = new URL("/v1/validation-reports", config.relayUrl);
    url.searchParams.set("sessionId", input.sessionId);
    url.searchParams.set("hostname", input.hostname);
    url.searchParams.set("limit", String(Math.max(5, input.requiredReports * 3)));
    const response = await fetch(url, {
      headers: bearerAuthHeader(stringEnv("PROOF_VALIDATION_READ_TOKEN"))
    });
    const bodyText = await response.text();
    if (response.ok) {
      const body = parseRequiredJsonObject(bodyText);
      const reports = Array.isArray(body.reports) ? body.reports as Record<string, unknown>[] : [];
      const distinctReports = latestReportsByValidatorIdentity(reports);
      const successful = distinctReports.filter((report) => Boolean((report as Record<string, any>).report?.success) === true);
      if (distinctReports.length >= input.requiredReports && successful.length >= input.requiredSuccesses) {
        return successful.slice(-input.requiredSuccesses);
      }
    }

    logWaitStatus(
      "Waiting for stored validator reports",
      `required=${input.requiredReports}/${input.requiredSuccesses}`,
      `${input.requiredReports}:${input.requiredSuccesses}`
    );
    await sleep(config.pollIntervalMs);
  }
  throw new Error(`Timed out waiting for validator reports after ${input.timeoutMs}ms`);
}

function latestReportsByValidatorIdentity(reports: Record<string, unknown>[]): Record<string, unknown>[] {
  const byValidator = new Map<string, Record<string, unknown>>();
  for (const item of reports) {
    const identity = storedValidationReportIdentity(item);
    const existing = byValidator.get(identity);
    if (!existing || storedValidationReportCheckedAt(item) >= storedValidationReportCheckedAt(existing)) {
      byValidator.set(identity, item);
    }
  }
  return [...byValidator.values()].sort((left, right) =>
    storedValidationReportIdentity(left).localeCompare(storedValidationReportIdentity(right))
  );
}

function storedValidationReportIdentity(item: Record<string, unknown>): string {
  const report = item.report && typeof item.report === "object" && !Array.isArray(item.report) ? item.report as Record<string, unknown> : {};
  const validator =
    report.validator && typeof report.validator === "object" && !Array.isArray(report.validator)
      ? report.validator as Record<string, unknown>
      : {};
  const signer = stringField(item, "signer") ?? "unknown-signer";
  const validatorId = stringField(validator, "validatorId");
  const deploymentId = stringField(validator, "deploymentId");
  return [signer, validatorId ?? "unknown-validator", deploymentId ?? ""].join(":");
}

function storedValidationReportCheckedAt(item: Record<string, unknown>): number {
  const report = item.report && typeof item.report === "object" && !Array.isArray(item.report) ? item.report as Record<string, unknown> : {};
  const checkedAtUnixSeconds = numberField(report, "checkedAtUnixSeconds");
  if (checkedAtUnixSeconds !== undefined) {
    return checkedAtUnixSeconds;
  }
  const checkedAt = stringField(report, "checkedAt");
  const parsed = checkedAt ? Date.parse(checkedAt) : Number.NaN;
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

async function activatePaidSession(
  config: HarnessConfig,
  input: {
    sessionId: string;
    hostname: string;
    validationReportId?: string;
  }
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL("/v1/session-activations", config.relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...bearerAuthHeader(requiredEnv("PROOF_CONTROL_PLANE_TOKEN"))
    },
    body: JSON.stringify({
      sessionId: input.sessionId,
      hostname: input.hostname,
      validationReportId: input.validationReportId,
      requireSuccessfulValidation: true
    })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`session activation failed: ${response.status} ${body}`);
  }
  return parseRequiredJsonObject(body);
}

async function recordFulfillmentStage(
  config: HarnessConfig,
  input: {
    sessionId: string;
    hostname: string;
  }
): Promise<Record<string, unknown>> {
  const session = await readSession(config, input.sessionId);
  const amounts = defaultFulfillmentAmounts(session);
  const payload = {
    sessionId: input.sessionId,
    hostname: input.hostname,
    operatorRecipient: requiredStringField(session, "operatorRecipient"),
    validatorRecipient: requiredStringField(session, "validatorRecipient"),
    proofRecipient: requiredStringField(session, "proofRecipient"),
    operatorAmount: amounts.operatorAmount.toString(),
    validatorAmount: amounts.validatorAmount.toString(),
    proofAmount: amounts.proofAmount.toString(),
    requiredReports: validatorRequiredReports(config),
    requiredSuccesses: validatorRequiredSuccesses(config),
    policyHash: stringField(session, "policyHash")
  };
  const response = await fetch(new URL("/v1/fulfillment-records", config.relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...bearerAuthHeader(requiredEnv("PROOF_CONTROL_PLANE_TOKEN"))
    },
    body: JSON.stringify(payload)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`fulfillment recording failed: ${response.status} ${body}`);
  }
  return {
    ...parseRequiredJsonObject(body),
    requestedAmounts: {
      operatorAmount: amounts.operatorAmount.toString(),
      validatorAmount: amounts.validatorAmount.toString(),
      proofAmount: amounts.proofAmount.toString(),
      entitlement: amounts.entitlement.toString(),
      elapsedSeconds: amounts.elapsedSeconds.toString()
    }
  };
}

async function recordFulfillmentLoop(
  config: HarnessConfig,
  input: {
    sessionId: string;
    hostname: string;
  }
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const records: Record<string, unknown>[] = [];
  let attempts = 0;
  let nextDelayMs = config.fulfillmentDelayMs;
  let session = await readSession(config, input.sessionId);
  const expiresAtMs = Number(requiredStringField(session, "expiresAt")) * 1000;
  const runUntilMs = config.durationMinutes ? expiresAtMs : startedAt + config.fulfillmentDelayMs + config.fulfillmentIntervalMs;

  while (Date.now() < runUntilMs) {
    if (nextDelayMs > 0) {
      console.log(deployStatus("wait", "Waiting before fulfillment accounting", `${nextDelayMs}ms`));
      await sleep(Math.min(nextDelayMs, Math.max(0, runUntilMs - Date.now())));
    }
    attempts += 1;
    try {
      const record = await recordFulfillmentStage(config, input);
      records.push(record);
      console.log(deployStatus("ok", "Fulfillment transaction", String(record.txHash)));
      session = await readSession(config, input.sessionId);
      if (!config.durationMinutes || Date.now() >= Number(requiredStringField(session, "expiresAt")) * 1000) {
        break;
      }
      nextDelayMs = config.fulfillmentIntervalMs;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isRetryableFulfillmentError(message)) {
        throw error;
      }
      console.log(deployStatus("wait", "Fulfillment pending", message.slice(0, 240)));
      nextDelayMs = config.fulfillmentIntervalMs;
    }
  }
  if (records.length === 0) {
    throw new Error(`No fulfillment records were accepted after ${attempts} attempts`);
  }

  return {
    ok: true,
    action: "record-fulfillment-loop",
    attempts,
    records,
    txHash: stringField(records.at(-1), "txHash"),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString()
  };
}

function isRetryableFulfillmentError(message: string): boolean {
  return (
    message.includes("insufficient_successful_validation_reports") ||
    message.includes("insufficient_validation_reports") ||
    message.includes("nonzero_release_requires_successful_result") ||
    message.includes("invalid_fulfillment_period") ||
    message.includes("contract_preflight_failed")
  );
}

function defaultFulfillmentAmounts(session: Record<string, unknown>): {
  entitlement: bigint;
  elapsedSeconds: bigint;
  operatorAmount: bigint;
  validatorAmount: bigint;
  proofAmount: bigint;
} {
  const serviceAmount = BigInt(requiredStringField(session, "serviceAmount"));
  const paidSeconds = BigInt(requiredStringField(session, "paidSeconds"));
  const fulfilledUntil = BigInt(requiredStringField(session, "fulfilledUntil"));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const elapsedSeconds = now > fulfilledUntil ? now - fulfilledUntil : 0n;
  const entitlement = paidSeconds > 0n ? (serviceAmount * elapsedSeconds) / paidSeconds : 0n;
  const operatorAmount = capAmount(entitlement, BigInt(requiredStringField(session, "maxOperatorBps")));
  const validatorAmount = capAmount(entitlement, BigInt(requiredStringField(session, "maxValidatorBps")));
  const remaining = entitlement > operatorAmount + validatorAmount ? entitlement - operatorAmount - validatorAmount : 0n;
  const proofCap = capAmount(entitlement, BigInt(requiredStringField(session, "maxProofBps")));
  const proofAmount = proofCap < remaining ? proofCap : remaining;
  return {
    entitlement,
    elapsedSeconds,
    operatorAmount,
    validatorAmount,
    proofAmount
  };
}

function capAmount(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / 10_000n;
}

function parseRouteMetadata(raw: string): RouteMetadataFile {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return { routes: parsed.map(parseRoute) };
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { routes?: unknown }).routes)) {
    return {
      routes: ((parsed as { routes: unknown[] }).routes).map(parseRoute)
    };
  }
  throw new Error("Route metadata file must contain a routes array");
}

function parseRoute(value: unknown): RouteMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid route metadata entry");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    typeof record.hostname !== "string" ||
    typeof record.upstreamHost !== "string" ||
    typeof record.upstreamPort !== "number"
  ) {
    throw new Error(`Invalid route metadata entry: ${JSON.stringify(value)}`);
  }
  return {
    routeId: typeof record.routeId === "string" ? record.routeId : undefined,
    sessionId: record.sessionId,
    hostname: record.hostname,
    publicHostname: typeof record.publicHostname === "string" ? record.publicHostname : undefined,
    validationHostname: typeof record.validationHostname === "string" ? record.validationHostname : undefined,
    customerHostnames: Array.isArray(record.customerHostnames)
      ? record.customerHostnames.filter((value): value is string => typeof value === "string")
      : undefined,
    hostnameRole: parseHostnameRole(record.hostnameRole),
    upstreamHost: record.upstreamHost,
    upstreamPort: record.upstreamPort
  };
}

function parseHostnameRole(value: unknown): RouteMetadata["hostnameRole"] | undefined {
  return value === "legacy" || value === "ha_public" || value === "validation" ? value : undefined;
}

function numberField(record: Record<string, unknown>, name: string): number {
  const value = record[name];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Expected numeric ${name}, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function optionalNumberField(record: unknown, name: string): number | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const value = (record as Record<string, unknown>)[name];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function sessionRouteExpiresAt(session: Record<string, unknown>): number {
  const expiresAt = numberField(session, "expiresAt");
  const activationDeadline = numberField(session, "activationDeadline");
  return Math.max(expiresAt, activationDeadline);
}

function stringField(record: unknown, name: string): string | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const value = (record as Record<string, unknown>)[name];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
}

function stringArrayField(record: unknown, name: string): string[] {
  if (!record || typeof record !== "object") {
    return [];
  }
  const value = (record as Record<string, unknown>)[name];
  return Array.isArray(value) ? unique(value.filter((item): item is string => typeof item === "string" && item.length > 0)) : [];
}

function recordArrayField(record: unknown, name: string): Record<string, unknown>[] {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return [];
  }
  const value = (record as Record<string, unknown>)[name];
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function objectField(record: unknown, name: string): Record<string, unknown> | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  const value = (record as Record<string, unknown>)[name];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requiredStringField(record: unknown, name: string): string {
  const value = stringField(record, name);
  if (!value) {
    throw new Error(`Expected string field ${name}`);
  }
  return value;
}

function requiredStringOrNumberField(record: unknown, name: string): string | number {
  if (!record || typeof record !== "object") {
    throw new Error(`Expected record with field ${name}`);
  }
  const value = (record as Record<string, unknown>)[name];
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`Expected string or number field ${name}`);
  }
  return value;
}

function requiredRecordField(record: unknown, name: string): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    throw new Error(`Expected record with field ${name}`);
  }
  const value = (record as Record<string, unknown>)[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected object field ${name}`);
  }
  return value as Record<string, unknown>;
}

function sessionOutput(session: any): Record<string, unknown> {
  return {
    developer: String(session.developer),
    asset: String(session.asset),
    amountPaid: session.amountPaid?.toString(),
    serviceAmount: session.serviceAmount?.toString(),
    setupFee: session.setupFee?.toString(),
    validationFeeCap: session.validationFeeCap?.toString(),
    pricePerSecond: session.pricePerSecond?.toString(),
    paidSeconds: session.paidSeconds?.toString(),
    expiresAt: session.expiresAt?.toString(),
    quoteId: String(session.quoteId),
    policyHash: String(session.policyHash),
    jobId: String(session.jobId),
    expectedJobSigner: String(session.expectedJobSigner),
    operatorId: String(session.operatorId),
    processorId: String(session.processorId),
    endpointHash: String(session.endpointHash),
    salt: String(session.salt),
    operatorRecipient: String(session.operatorRecipient),
    validatorRecipient: String(session.validatorRecipient),
    proofRecipient: String(session.proofRecipient),
    maxOperatorBps: session.maxOperatorBps?.toString(),
    maxValidatorBps: session.maxValidatorBps?.toString(),
    maxProofBps: session.maxProofBps?.toString(),
    registered: Boolean(session.registered),
    nextNonce: session.nextNonce?.toString(),
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

function parseDeploymentSchedule(output: string | undefined): DeploymentSchedule | undefined {
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
    endUnixSeconds: Number.isFinite(endMs) ? Math.floor(endMs / 1000) : undefined,
    startMs: Number.isFinite(startMs) ? startMs : undefined,
    endMs: Number.isFinite(endMs) ? endMs : undefined
  };
}

function isLocalOperatorUrl(rawUrl: string): boolean {
  const hostname = new URL(rawUrl).hostname;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function assertRouteIntentResponse(response: Record<string, unknown>): void {
  if (response.ok !== true || !response.route || typeof response.route !== "object") {
    throw new Error(`gateway-agent route intent post returned an unexpected response: ${JSON.stringify(response)}`);
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function acurastEnv(config: HarnessConfig): Record<string, string> {
  return {
    ACURAST_NETWORK: config.network,
    ACURAST_MAX_NETWORK_REQUESTS: process.env.ACURAST_MAX_NETWORK_REQUESTS ?? "1000",
    ...(process.env.ACURAST_ENABLE_DEVTOOLS ? { ACURAST_ENABLE_DEVTOOLS: process.env.ACURAST_ENABLE_DEVTOOLS } : {}),
    ...(process.env.ACURAST_ENTRYPOINT ? { ACURAST_ENTRYPOINT: process.env.ACURAST_ENTRYPOINT } : {}),
    ...(process.env.ACURAST_RPC ? { ACURAST_RPC: process.env.ACURAST_RPC } : {}),
    ...(process.env.ACURAST_CANARY_RPC ? { ACURAST_CANARY_RPC: process.env.ACURAST_CANARY_RPC } : {})
  };
}

function includedAcurastEnvironment(): Record<string, string> {
  const include = process.env.ACURAST_INCLUDE_ENV;
  if (!include) {
    return {};
  }

  const env: Record<string, string> = {
    ACURAST_INCLUDE_ENV: include
  };
  for (const key of include.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const value = process.env[key];
    if (!value) {
      throw new Error(`${key} is listed in ACURAST_INCLUDE_ENV but is not set`);
    }
    env[key] = value;
  }
  return env;
}

function assertExternallyReachableRelay(relayUrl: string, allowLocal: boolean): void {
  if (allowLocal) {
    return;
  }

  const hostname = new URL(relayUrl).hostname;
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("10.") ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
  ) {
    throw new Error(
      `Relay URL ${relayUrl} looks local/private; pass an externally reachable SWITCHBOARD_DEPLOY_RELAY_URL or --allow-local-relay`
    );
  }
}

function accountIdBytes32(address: string): string {
  return `0x${Buffer.from(decodeAddress(address)).toString("hex")}`;
}

function hashStringBytes32(value: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(value));
}

function lowerHex32(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Expected a bytes32 hex string");
  }
  return value.toLowerCase();
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFailureReport(config: HarnessConfig, value: Record<string, unknown>): Promise<void> {
  const failurePath = path.join(config.runDir, "failure-report.json");
  await writeJson(failurePath, {
    ok: false,
    runId: config.runId,
    writtenAt: new Date().toISOString(),
    ...value
  });
  console.error(deployStatus("error", "Wrote failure report", failurePath));
  console.error(`[switchboard-deploy] failure report=${failurePath}`);
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseRequiredJsonObject(raw: string): Record<string, unknown> {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    throw new Error(`Expected JSON object output, got: ${raw.slice(0, 500)}`);
  }
  return parsed;
}

function parseArgs(args: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
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
  }
  return { flags };
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function certificateModeFlag(flags: Map<string, string | boolean>): HarnessConfig["certificateMode"] {
  const value =
    stringFlag(flags, "certificate-mode") ??
    (boolFlag(flags, "job-acme") ? "job-acme" : undefined) ??
    stringEnv("SWITCHBOARD_DEPLOY_CERTIFICATE_MODE") ??
    (process.env.SWITCHBOARD_DEPLOY_JOB_ACME === "true" ? "job-acme" : undefined) ??
    "self-signed";
  if (value !== "self-signed" && value !== "job-acme") {
    throw new Error(`Unsupported certificate mode: ${value}`);
  }
  return value;
}

function routeActivationModeFlag(flags: Map<string, string | boolean>): HarnessConfig["operatorRouteActivationMode"] {
  const value =
    stringFlag(flags, "route-activation-mode") ??
    stringEnv("SWITCHBOARD_DEPLOY_ROUTE_ACTIVATION_MODE") ??
    "relay-reconciled";
  if (value !== "relay-reconciled" && value !== "control-plane" && value !== "gateway-agent" && value !== "metadata-file") {
    throw new Error(`Unsupported route activation mode: ${value}`);
  }
  return value;
}

function paymentModeFlag(flags: Map<string, string | boolean>): HarnessConfig["paymentMode"] {
  const value =
    stringFlag(flags, "payment-mode") ??
    (boolFlag(flags, "quote") ? "quote" : undefined) ??
    stringEnv("SWITCHBOARD_DEPLOY_PAYMENT_MODE") ??
    "quote";
  if (value !== "public-price" && value !== "quote") {
    throw new Error(`Unsupported payment mode: ${value}`);
  }
  if (value === "public-price") {
    throw new Error("switchboard deploy now requires signed quote funding through relay deployment intents");
  }
  return value;
}

function validatorModeFlag(flags: Map<string, string | boolean>): HarnessConfig["validatorMode"] {
  const value =
    stringFlag(flags, "validator-mode") ??
    (boolFlag(flags, "real-validator") ? "acurast" : undefined) ??
    (boolFlag(flags, "skip-validator") ? "skip" : undefined) ??
    stringEnv("SWITCHBOARD_DEPLOY_VALIDATOR_MODE") ??
    "local";
  if (value !== "local" && value !== "acurast" && value !== "skip") {
    throw new Error(`Unsupported validator mode: ${value}`);
  }
  return value;
}

function deployRunnerMode(): "full" | "acurast-submit-only" | "acurast-group-submit-only" {
  const value = stringEnv("SWITCHBOARD_DEPLOY_RUNNER_MODE") ?? "full";
  if (value === "full" || value === "acurast-submit-only" || value === "acurast-group-submit-only") {
    return value;
  }
  throw new Error(`Unsupported SWITCHBOARD_DEPLOY_RUNNER_MODE: ${value}`);
}

function numberFlag(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  return optionalNumberFlag(flags, name) ?? fallback;
}

function numberEnv(name: string, fallback: number): number {
  return optionalNumberEnv(name) ?? fallback;
}

function optionalNumberFlag(flags: Map<string, string | boolean>, name: string): number | undefined {
  const value = stringFlag(flags, name);
  return value ? parseNonNegativeInteger(name, value) : undefined;
}

function optionalNumberEnv(name: string): number | undefined {
  const value = process.env[name];
  return value ? parseNonNegativeInteger(name, value) : undefined;
}

function stringEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function stringArrayEnv(name: string): string[] {
  const value = stringEnv(name);
  if (!value) {
    return [];
  }
  try {
    const json = JSON.parse(value) as unknown;
    if (Array.isArray(json)) {
      return json.filter((item): item is string => typeof item === "string" && item.length > 0);
    }
  } catch {
    // Fall through to comma-separated parsing for manual env overrides.
  }
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function bearerAuthHeader(token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function requiredEnv(name: string, fallback?: string): string {
  const value = stringEnv(name) ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseNonNegativeInteger(name: string, value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
    const cause = safeErrorCause(error.cause);
    if (cause !== undefined) {
      serialized.cause = cause;
    }
    return serialized;
  }
  return {
    message: String(error)
  };
}

function safeErrorCause(cause: unknown): Record<string, unknown> | string | undefined {
  if (cause === undefined || cause === null) {
    return undefined;
  }

  if (cause instanceof Error) {
    const details: Record<string, unknown> = {
      name: cause.name,
      message: cause.message
    };
    const record = cause as unknown as Record<string, unknown>;
    for (const key of ["code", "errno", "syscall", "address", "port", "host", "hostname"]) {
      const value = record[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        details[key] = value;
      }
    }
    return details;
  }

  if (typeof cause === "object") {
    const details: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(cause as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        details[key] = value;
      }
    }
    return Object.keys(details).length > 0 ? details : String(cause);
  }

  return String(cause);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

async function run(
  command: string,
  args: string[],
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    stream?: boolean;
    allowFailure?: boolean;
    input?: string;
  } = {}
): Promise<RunResult & { exitCode: number }> {
  const mapped = mapSwitchboardDeployPnpmScript(command, args, options.env);
  if (mapped) {
    command = mapped.command;
    args = mapped.args;
    options = {
      ...options,
      cwd: mapped.cwd ?? options.cwd,
      env: {
        ...mapped.env,
        ...options.env
      }
    };
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? rootDir,
      env: {
        ...process.env,
        ...Object.fromEntries(Object.entries(options.env ?? {}).filter(([, value]) => value !== undefined))
      },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    const childStdin = child.stdin;
    if (!childStdout || !childStderr || (options.input !== undefined && !childStdin)) {
      reject(new Error(`Failed to open stdio pipes for ${command}`));
      return;
    }

    childStdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (options.stream) {
        process.stdout.write(text);
      }
    });
    childStderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (options.stream) {
        process.stderr.write(text);
      }
    });
    if (options.input !== undefined) {
      childStdin?.end(options.input);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`${command} ${redactedArgs(args).join(" ")} failed with ${exitCode}: ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export function mapSwitchboardDeployPnpmScript(
  command: string,
  args: string[],
  env: Record<string, string | undefined> | undefined
): { command: string; args: string[]; env: Record<string, string | undefined>; cwd?: string } | undefined {
  return mapPackagedPnpmScript(command, args, env) ?? mapSourcePnpmScript(command, args, env);
}

function redactedArgs(args: string[]): string[] {
  const secretFlags = new Set([
    "--cli-token",
    "--intent-token",
    "--read-token",
    "--encryption-key"
  ]);
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [flag, inlineValue] = arg.split("=", 2);
    if (secretFlags.has(flag)) {
      redacted.push(inlineValue === undefined ? arg : `${flag}=[redacted]`);
      if (inlineValue === undefined && index + 1 < args.length) {
        redacted.push("[redacted]");
        index += 1;
      }
      continue;
    }
    redacted.push(arg);
  }
  return redacted;
}

function mapPackagedPnpmScript(
  command: string,
  args: string[],
  env: Record<string, string | undefined> | undefined
): { command: string; args: string[]; env: Record<string, string | undefined>; cwd?: string } | undefined {
  const internalDir = process.env.SWITCHBOARD_INTERNAL_BIN_DIR;
  if (!internalDir || command !== "pnpm" || args[0] !== "--silent") {
    return undefined;
  }

  const scriptName = args[1];
  const forwarded = args[2] === "--" ? args.slice(3) : args.slice(2);
  const assetsDir = process.env.SWITCHBOARD_PACKAGED_ASSETS_DIR;
  const baseEnv: Record<string, string | undefined> = {
    SWITCHBOARD_WORK_DIR: rootDir,
    SWITCHBOARD_INTERNAL_BIN_DIR: internalDir,
    SWITCHBOARD_PACKAGED_ASSETS_DIR: assetsDir
  };
  const nodeScript = (name: string, scriptArgs = forwarded, extraEnv: Record<string, string | undefined> = {}) => ({
    command: process.execPath,
    args: [path.join(internalDir, `${name}.js`), ...scriptArgs],
    env: {
      ...baseEnv,
      ...extraEnv
    }
  });

  if (scriptName === "acurast:list-processors") {
    return nodeScript("acurast-list-processors");
  }
  if (scriptName === "acurast:deploy-express:direct") {
    const bundleName = packagedJobBundleName(env?.ACURAST_ENTRYPOINT);
    return nodeScript("acurast-express", ["deploy-direct", ...forwarded], {
      SWITCHBOARD_PREBUILT_JOB_BUNDLE: assetsDir && bundleName ? path.join(assetsDir, "jobs", bundleName, "bundle.cjs") : undefined
    });
  }
  if (scriptName === "acurast:update-env-express") {
    return nodeScript("acurast-express", ["update-env", ...forwarded]);
  }
  if (scriptName === "acurast:inspect-express") {
    return nodeScript("acurast-express", ["inspect", ...forwarded]);
  }
  if (scriptName === "hub:fund-evm-session") {
    return nodeScript("hub-fund-evm-session");
  }
  if (scriptName === "hub:fund-native-asset-quote") {
    return nodeScript("hub-fund-native-asset-quote", forwarded);
  }
  if (scriptName === "hub:read-session") {
    return nodeScript("hub-read-session");
  }
  if (scriptName === "switchboard:validator:run") {
    return nodeScript("route-validator", forwarded);
  }

  return undefined;
}

const sourcePnpmScripts = new Set([
  "acurast:list-processors",
  "acurast:deploy-express:direct",
  "acurast:update-env-express",
  "acurast:inspect-express",
  "hub:fund-evm-session",
  "hub:fund-native-asset-quote",
  "hub:read-session",
  "switchboard:validator:run"
]);

function mapSourcePnpmScript(
  command: string,
  args: string[],
  env: Record<string, string | undefined> | undefined
): { command: string; args: string[]; env: Record<string, string | undefined>; cwd: string } | undefined {
  if (command !== "pnpm" || args[0] !== "--silent" || !sourcePnpmScripts.has(args[1] ?? "")) {
    return undefined;
  }
  return {
    command,
    args,
    cwd: cliPackageDir,
    env: {
      SWITCHBOARD_WORK_DIR: rootDir,
      DOTENV_CONFIG_PATH: env?.DOTENV_CONFIG_PATH ?? process.env.DOTENV_CONFIG_PATH ?? path.join(rootDir, ".env")
    }
  };
}

function packagedJobBundleName(_entrypoint: string | undefined): undefined {
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
