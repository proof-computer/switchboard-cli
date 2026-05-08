import "dotenv/config";
import http, { type Server as HttpServer } from "node:http";
import https, { type ServerOptions as HttpsServerOptions } from "node:https";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import tls from "node:tls";
import express, { type Request } from "express";

import {
  buildIngressRegistrationRequest,
  createSwitchboardRouter,
  maybeAcurastJobSigner,
  privateKeyJobSigner,
  requestCertificateWithRelay,
  registerIngressWithRelay,
  SwitchboardCertificateError,
  type SwitchboardCertificateFailureStage,
  type SwitchboardJobSigner
} from "../runtime/index.js";
import { recoverRegistrationSigner } from "../registration.js";
import { renderDemoPage as renderExpressDemoPage } from "./express-demo-page.js";
import { runRelayDiagnostics } from "./relay-diagnostics.js";

declare const __SWITCHBOARD_BUILD_CONFIG__: string | undefined;

const switchboardConfig = readSwitchboardConfig();
const runtimeConfig: Record<string, string> = {};
const port = Number(configValue("PORT") ?? "3000");
const host = configValue("SWITCHBOARD_HOST") ?? "127.0.0.1";
const rawDeploymentId = envValue("DEPLOYMENT_ID") ?? acurastDeploymentId();
const deploymentId = acurastDeploymentSequence(rawDeploymentId) ?? rawDeploymentId;
const remoteLog = createRemoteLogger();
let tlsConfig = readTlsConfig();
let protocol = tlsConfig ? "https" : "http";
let server: HttpServer;
const demoState: DemoState = {
  startedAt: new Date().toISOString(),
  challengeCount: 0
};

const app = express();
app.use(express.json());
app.use(
  createSwitchboardRouter({
    sessionId: currentSessionId,
    jobId: currentJobId,
    deploymentId,
    onChallenge: (event) => {
      demoState.challengeCount += 1;
      demoState.lastChallengeAt = new Date().toISOString();
      demoState.lastChallenge = {
        nonceLength: event.nonce.length,
        userAgent: event.userAgent,
        remoteAddress: event.remoteAddress
      };
      void remoteLog("challenge-hit", {
        nonceLength: event.nonce.length,
        userAgent: event.userAgent,
        remoteAddress: event.remoteAddress
      });
    }
  })
);

app.get("/", async (request, response) => {
  response.type("html").send(renderExpressDemoPage(await demoStatus()));
});

app.get("/styles.css", async (request, response) => {
  response.status(404).type("text").send("Not found\n");
});

app.get("/status", async (_request, response) => {
  response.json(await demoStatus());
});

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/__proof/ingress/register", async (request, response) => {
  try {
    assertControlToken(request);
    applyRuntimeRegistrationConfig(parseRuntimeRegistrationRequest(request.body));
    demoState.registration = {
      state: "triggered",
      endpointHostname: requiredConfig("ENDPOINT_HOSTNAME"),
      relayHost: safeUrlHost(requiredConfig("RELAY_URL")),
      updatedAt: new Date().toISOString()
    };
    void remoteLog("registration-control-triggered", {
      endpointHostname: requiredConfig("ENDPOINT_HOSTNAME"),
      relayHost: safeUrlHost(requiredConfig("RELAY_URL")),
      sessionId: currentSessionId(),
      jobId: currentJobId()
    });

    const result = await maybeRegisterIngress(1);
    if (result === "registered") {
      void runCertificateLoop();
    }

    response.json({
      ok: true,
      result,
      sessionId: currentSessionId(),
      jobId: currentJobId(),
      registration: demoState.registration,
      certificate: demoState.certificate
    });
  } catch (error) {
    const status = error instanceof ControlError ? error.statusCode : 500;
    void remoteLog("registration-control-failed", {
      error: safeError(error),
      sessionId: currentSessionId(),
      jobId: currentJobId()
    });
    response.status(status).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/__proof/ingress/certificate", async (request, response) => {
  try {
    assertControlToken(request);
    applyRuntimeRegistrationConfig(parseRuntimeRegistrationRequest(request.body));
    void remoteLog("certificate-control-triggered", {
      endpointHostname: requiredConfig("ENDPOINT_HOSTNAME"),
      relayHost: safeUrlHost(requiredConfig("RELAY_URL")),
      sessionId: currentSessionId(),
      jobId: currentJobId()
    });
    void runCertificateLoop();

    response.json({
      ok: true,
      sessionId: currentSessionId(),
      jobId: currentJobId(),
      certificate: demoState.certificate
    });
  } catch (error) {
    const status = error instanceof ControlError ? error.statusCode : 500;
    void remoteLog("certificate-control-failed", {
      error: safeError(error),
      sessionId: currentSessionId(),
      jobId: currentJobId()
    });
    response.status(status).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

process.on("uncaughtException", (error) => {
  console.error(error);
  const forceExit = setTimeout(() => process.exit(1), 1000);
  forceExit.unref();
  void remoteLog("uncaught-exception", { error: safeError(error) }).finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  console.error(reason);
  void remoteLog("unhandled-rejection", { error: safeError(reason) });
  process.exitCode = 1;
});

void remoteLog("process-start", {
  argv: process.argv.slice(0, 2).map((value) => pathBasename(value))
});
void logJobSignerReady();

server = createServer(tlsConfig);
void startServer({ runRegistration: true, scheduleExit: true });

async function runRegistrationLoop(): Promise<void> {
  if (switchboardIntentGroupConfigured()) {
    await runSwitchboardIntentGroupLoop();
    return;
  }

  if (switchboardIntentConfigured()) {
    await runSwitchboardIntentLoop();
    return;
  }

  const retryMs = numberEnv("SWITCHBOARD_REGISTRATION_RETRY_MS", 30_000);
  const maxAttempts = numberEnv("SWITCHBOARD_REGISTRATION_MAX_ATTEMPTS", 1);

  for (let attempt = 1; maxAttempts === 0 || attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await maybeRegisterIngress(attempt);
      if (result === "registered") {
        await runCertificateLoop();
        return;
      }
      if (result === "skipped") {
        return;
      }
    } catch (error) {
      console.error(error);
      const willRetry = maxAttempts === 0 || attempt < maxAttempts;
      demoState.registration = {
        ...(demoState.registration ?? {}),
        state: "failed",
        attempt,
        retryMs: willRetry ? retryMs : undefined,
        error: safeError(error),
        updatedAt: new Date().toISOString()
      };
      void remoteLog("registration-failed", {
        attempt,
        maxAttempts,
        retryMs: willRetry ? retryMs : undefined,
        error: safeError(error)
      });
      if (!willRetry) {
        process.exitCode = 1;
        return;
      }
    }

    await sleep(retryMs);
  }
}

async function runSwitchboardIntentGroupLoop(): Promise<void> {
  const relayUrl = requiredConfig("SWITCHBOARD_RELAY_URL");
  const groupId = requiredConfig("SWITCHBOARD_INTENT_GROUP_ID");
  const intentToken = requiredConfig("SWITCHBOARD_INTENT_TOKEN");
  allowAcurastHostname(relayUrl);

  const signer = await switchboardJobSigner();
  const runtimeSigner = await signer.signer.getAddress();
  const processorIdentity = acurastProcessorIdentity();
  demoState.signerMode = signer.mode;
  demoState.jobSigner = runtimeSigner;

  const response = await claimSwitchboardIntentGroup({
    relayUrl,
    groupId,
    intentToken,
    runtimeSigner,
    signerMode: signer.mode,
    processorIdentity
  });
  const intentId = stringRecordField(response, "intentId") ?? stringRecordField(response.intent, "intentId");
  if (!intentId) {
    throw new Error("Switchboard group claim response did not include a child intentId");
  }
  runtimeConfig.SWITCHBOARD_INTENT_ID = intentId;
  runtimeConfig.SWITCHBOARD_INTENT_TOKEN = intentToken;
  await runSwitchboardIntentLoop();
}

async function runSwitchboardIntentLoop(): Promise<void> {
  const relayUrl = requiredConfig("SWITCHBOARD_RELAY_URL");
  const intentId = requiredConfig("SWITCHBOARD_INTENT_ID");
  const intentToken = requiredConfig("SWITCHBOARD_INTENT_TOKEN");
  allowAcurastHostname(relayUrl);

  const retryMs = numberEnv("SWITCHBOARD_INTENT_POLL_MS", numberEnv("SWITCHBOARD_REGISTRATION_RETRY_MS", 30_000));
  const maxAttempts = numberEnv("SWITCHBOARD_INTENT_MAX_ATTEMPTS", 0);
  const signer = await switchboardJobSigner();
  const runtimeSigner = await signer.signer.getAddress();
  demoState.signerMode = signer.mode;
  demoState.jobSigner = runtimeSigner;

  await claimSwitchboardIntent({
    relayUrl,
    intentId,
    intentToken,
    runtimeSigner,
    signerMode: signer.mode
  });
  await reportSwitchboardIntentHealth({
    relayUrl,
    intentId,
    intentToken,
    state: "waiting_funding",
    details: { runtimeSigner }
  });

  for (let attempt = 1; maxAttempts === 0 || attempt <= maxAttempts; attempt += 1) {
    try {
      const runtime = await fetchSwitchboardIntentRuntimeConfig({ relayUrl, intentId, intentToken });
      const gatewayId = gatewayIdFromRuntimeResponse(runtime);
      if (gatewayId) {
        demoState.gatewayId = gatewayId;
        runtimeConfig.GATEWAY_ID = runtimeConfig.GATEWAY_ID ?? gatewayId;
      }
      if (!runtime.ok) {
        demoState.registration = {
          state: runtime.state ?? "waiting_funding",
          attempt,
          relayHost: safeUrlHost(relayUrl),
          updatedAt: new Date().toISOString()
        };
        void remoteLog("deployment-intent-waiting", {
          attempt,
          state: runtime.state,
          intent: runtime.intent
        });
        await reportSwitchboardIntentHealth({
          relayUrl,
          intentId,
          intentToken,
          state: runtime.state === "waiting_quote" ? "waiting_quote" : "waiting_funding",
          details: { attempt }
        });
        await sleep(retryMs);
        continue;
      }

      if (!runtime.config) {
        throw new Error("Switchboard runtime config response missing config");
      }
      applySwitchboardRuntimeConfig(runtime.config);
      await reportSwitchboardIntentHealth({
        relayUrl,
        intentId,
        intentToken,
        state: "config_received",
        details: {
          sessionId: currentSessionId(),
          endpointHostname: configValue("ENDPOINT_HOSTNAME")
        }
      });
      const result = await maybeRegisterIngress(attempt);
      if (result === "registered") {
        await reportSwitchboardIntentHealth({
          relayUrl,
          intentId,
          intentToken,
          state: "registered",
          details: { sessionId: currentSessionId() }
        });
        await runCertificateLoop();
        await reportSwitchboardIntentHealth({
          relayUrl,
          intentId,
          intentToken,
          state: "ready",
          details: {
            sessionId: currentSessionId(),
            endpointHostname: configValue("ENDPOINT_HOSTNAME")
          }
        });
      }
      return;
    } catch (error) {
      console.error(error);
      const willRetry = maxAttempts === 0 || attempt < maxAttempts;
      demoState.registration = {
        ...(demoState.registration ?? {}),
        state: "failed",
        attempt,
        retryMs: willRetry ? retryMs : undefined,
        error: safeError(error),
        updatedAt: new Date().toISOString()
      };
      void remoteLog("deployment-intent-loop-failed", {
        attempt,
        maxAttempts,
        retryMs: willRetry ? retryMs : undefined,
        error: safeError(error)
      });
      await reportSwitchboardIntentHealth({
        relayUrl,
        intentId,
        intentToken,
        state: willRetry ? "waiting_funding" : "failed",
        message: error instanceof Error ? error.message : String(error),
        details: { attempt }
      }).catch(() => undefined);
      if (!willRetry) {
        process.exitCode = 1;
        return;
      }
      await sleep(retryMs);
    }
  }
}

async function runCertificateLoop(): Promise<void> {
  if (certificateMode() !== "job-acme") {
    return;
  }

  const retryMs = numberEnv("SWITCHBOARD_CERTIFICATE_RETRY_MS", numberEnv("SWITCHBOARD_REGISTRATION_RETRY_MS", 30_000));
  const maxAttempts = numberEnv("SWITCHBOARD_CERTIFICATE_MAX_ATTEMPTS", 0);

  for (let attempt = 1; maxAttempts === 0 || attempt <= maxAttempts; attempt += 1) {
    try {
      await reportCertificateIntentHealth("certificate_requesting", {
        attempt,
        stage: "certificate_request",
        hostnames: certificateRequestHostnamesIfConfigured(configValue("ENDPOINT_HOSTNAME"))
      });
      await maybeRequestManagedCertificate(attempt);
      return;
    } catch (error) {
      console.error(error);
      const willRetry = maxAttempts === 0 || attempt < maxAttempts;
      const certificateError = asSwitchboardCertificateError(error, {
        stage: "certificate_request"
      });
      const retryAfterMs = certificateRetryAfterMs(certificateError);
      const nextRetryMs = retryAfterMs ?? retryMs;
      const errorDetails = switchboardCertificateErrorDetails(certificateError);
      demoState.certificate = {
        ...(demoState.certificate ?? {}),
        state: willRetry ? "requesting" : "failed",
        attempt,
        retryMs: willRetry ? nextRetryMs : undefined,
        retryExhausted: !willRetry,
        ...errorDetails,
        updatedAt: new Date().toISOString()
      };
      void remoteLog("certificate-request-failed", {
        attempt,
        maxAttempts,
        retryMs: willRetry ? nextRetryMs : undefined,
        retryExhausted: !willRetry,
        ...errorDetails
      });
      await reportCertificateIntentHealth(willRetry ? "certificate_requesting" : "failed", {
        attempt,
        maxAttempts,
        retryMs: willRetry ? nextRetryMs : undefined,
        retryExhausted: !willRetry,
        ...errorDetails
      });
      if (!willRetry) {
        process.exitCode = 1;
        throw certificateError;
      }
      await sleep(nextRetryMs);
    }
  }
}

async function maybeRegisterIngress(attempt: number): Promise<"registered" | "skipped"> {
  const missing = requiredRegistrationEnv().filter((name) => !configValue(name));
  if (missing.length > 0) {
    console.log(`Switchboard registration skipped; missing ${missing.join(", ")}`);
    demoState.registration = {
      state: "skipped",
      reason: "missing-env",
      missing,
      attempt,
      updatedAt: new Date().toISOString()
    };
    void remoteLog("registration-skipped", { reason: "missing-env", missing, attempt });
    return "skipped";
  }

  const signer = await switchboardJobSigner();
  const jobSigner = await signer.signer.getAddress();
  demoState.signerMode = signer.mode;
  demoState.jobSigner = jobSigner;
  demoState.registration = {
    state: "registering",
    attempt,
    endpointHostname: requiredConfig("ENDPOINT_HOSTNAME"),
    relayHost: safeUrlHost(requiredConfig("RELAY_URL")),
    updatedAt: new Date().toISOString()
  };
  void remoteLog("registration-attempt", {
    attempt,
    relayHost: safeUrlHost(requiredConfig("RELAY_URL")),
    endpointHostname: requiredConfig("ENDPOINT_HOSTNAME"),
    signerMode: signer.mode,
    jobSigner
  });

  const result = await registerIngressWithRelay({
    relayUrl: requiredConfig("RELAY_URL"),
    chainId: requiredConfig("CHAIN_ID"),
    registryAddress: requiredConfig("INGRESS_REGISTRY_ADDRESS"),
    sessionId: requiredConfig("SESSION_ID"),
    jobId: requiredConfig("JOB_ID"),
    operatorId: requiredConfig("OPERATOR_ID"),
    processorId: requiredConfig("PROCESSOR_ID"),
    endpointHostname: requiredConfig("ENDPOINT_HOSTNAME"),
    nonce: configValue("NONCE"),
    deadline: configValue("DEADLINE"),
    jobSigner: signer.signer,
    requestTimeoutMs: Number(configValue("CONTRACT_CALL_TIMEOUT_MS") ?? "120000")
  });
  const relayResponse = sanitizeRelayResponse(result.relayResponse);
  console.log(`Switchboard registered: ${JSON.stringify(relayResponse)}`);
  demoState.registration = {
    state: "registered",
    attempt,
    endpointHostname: requiredConfig("ENDPOINT_HOSTNAME"),
    relayHost: safeUrlHost(requiredConfig("RELAY_URL")),
    relayResponse,
    registeredAt: new Date().toISOString()
  };
  void remoteLog("registration-succeeded", { attempt, signerMode: signer.mode, relayResponse });
  return "registered";
}

function requiredRegistrationEnv(): string[] {
  return [
    "RELAY_URL",
    "CHAIN_ID",
    "INGRESS_REGISTRY_ADDRESS",
    "SESSION_ID",
    "JOB_ID",
    "OPERATOR_ID",
    "PROCESSOR_ID",
    "ENDPOINT_HOSTNAME"
  ];
}

interface RuntimeRegistrationRequest {
  RELAY_URL: string;
  CHAIN_ID: string;
  INGRESS_REGISTRY_ADDRESS: string;
  SESSION_ID: string;
  JOB_ID: string;
  OPERATOR_ID: string;
  PROCESSOR_ID: string;
  GATEWAY_ID?: string;
  ENDPOINT_HOSTNAME: string;
  NONCE?: string;
  DEADLINE?: string;
}

class ControlError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function parseRuntimeRegistrationRequest(body: unknown): RuntimeRegistrationRequest {
  if (!body || typeof body !== "object") {
    throw new ControlError(400, "Request body must be a JSON object");
  }

  const record = body as Record<string, unknown>;
  return {
    RELAY_URL: requiredBodyString(record, "relayUrl"),
    CHAIN_ID: requiredBodyString(record, "chainId"),
    INGRESS_REGISTRY_ADDRESS: requiredBodyString(record, "registryAddress"),
    SESSION_ID: requiredBodyString(record, "sessionId"),
    JOB_ID: requiredBodyString(record, "jobId"),
    OPERATOR_ID: requiredBodyString(record, "operatorId"),
    PROCESSOR_ID: requiredBodyString(record, "processorId"),
    GATEWAY_ID: optionalBodyString(record, "gatewayId"),
    ENDPOINT_HOSTNAME: requiredBodyString(record, "endpointHostname"),
    NONCE: optionalBodyString(record, "nonce"),
    DEADLINE: optionalBodyString(record, "deadline")
  };
}

function applyRuntimeRegistrationConfig(config: RuntimeRegistrationRequest): void {
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) {
      runtimeConfig[key] = value;
    }
  }
}

function assertControlToken(request: Request): void {
  const expected = configValue("SWITCHBOARD_CONTROL_TOKEN");
  if (!expected) {
    throw new ControlError(403, "Job control endpoint is disabled");
  }
  const authorization = request.header("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const bodyToken =
    request.body && typeof request.body === "object" && typeof (request.body as Record<string, unknown>).token === "string"
      ? String((request.body as Record<string, unknown>).token)
      : undefined;
  if (bearer !== expected && bodyToken !== expected) {
    throw new ControlError(401, "Invalid job control token");
  }
}

function requiredBodyString(record: Record<string, unknown>, name: string): string {
  const value = optionalBodyString(record, name);
  if (!value) {
    throw new ControlError(400, `Missing ${name}`);
  }
  return value;
}

function optionalBodyString(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
}

function stringRecordField(record: unknown, name: string): string | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  return optionalBodyString(record as Record<string, unknown>, name);
}

function currentSessionId(): string {
  return configValue("SESSION_ID") ?? "local-session";
}

function currentJobId(): string | undefined {
  return configValue("JOB_ID");
}

function certificateMode(): string {
  return configValue("SWITCHBOARD_CERTIFICATE_MODE") ?? "env";
}

async function maybeRequestManagedCertificate(attempt?: number): Promise<void> {
  if (certificateMode() !== "job-acme") {
    return;
  }

  const missing = requiredRegistrationEnv().filter((name) => !configValue(name));
  if (missing.length > 0) {
    demoState.certificate = {
      state: "skipped",
      reason: "missing-env",
      missing,
      updatedAt: new Date().toISOString()
    };
    void remoteLog("certificate-skipped", { reason: "missing-env", missing });
    return;
  }

  const signer = await switchboardJobSigner();
  const jobSigner = await signer.signer.getAddress();
  const hostnames = certificateRequestHostnames();
  demoState.signerMode = signer.mode;
  demoState.jobSigner = jobSigner;
  demoState.certificate = {
    state: "requesting",
    attempt,
    hostname: hostnames[0],
    hostnames,
    relayHost: safeUrlHost(requiredConfig("RELAY_URL")),
    updatedAt: new Date().toISOString()
  };

  const certificates: ManagedCertificate[] = [];
  for (const hostname of hostnames) {
    void remoteLog("certificate-request-started", {
      attempt,
      hostname,
      relayHost: safeUrlHost(requiredConfig("RELAY_URL")),
      endpointHostname: requiredConfig("ENDPOINT_HOSTNAME"),
      signerMode: signer.mode,
      jobSigner
    });

    let result: Awaited<ReturnType<typeof requestCertificateWithRelay>>;
    try {
      result = await requestCertificateWithRelay({
        relayUrl: requiredConfig("RELAY_URL"),
        chainId: requiredConfig("CHAIN_ID"),
        registryAddress: requiredConfig("INGRESS_REGISTRY_ADDRESS"),
        sessionId: requiredConfig("SESSION_ID"),
        hostname,
        jobSigner: signer.signer,
        requestTimeoutMs: Number(configValue("SWITCHBOARD_CERTIFICATE_REQUEST_TIMEOUT_MS") ?? "240000")
      });
    } catch (error) {
      throw asSwitchboardCertificateError(error, {
        stage: "certificate_request",
        hostname
      });
    }
    const certificatePem = result.relayResponse.certificatePem;
    if (!certificatePem || !result.privateKeyPem) {
      throw new SwitchboardCertificateError(
        `Relay certificate response did not include certificatePem or local privateKeyPem for ${hostname}`,
        {
          stage: "relay_response",
          hostname,
          relayResponse: result.relayResponse
        }
      );
    }

    certificates.push({
      hostname: String(result.relayResponse.hostname ?? hostname),
      cert: certificatePem,
      key: result.privateKeyPem,
      issuer: typeof result.relayResponse.issuer === "string" ? result.relayResponse.issuer : undefined,
      notAfter: typeof result.relayResponse.notAfter === "string" ? result.relayResponse.notAfter : undefined
    });
    void remoteLog("certificate-issued", {
      hostname: result.relayResponse.hostname,
      issuer: result.relayResponse.issuer,
      notAfter: result.relayResponse.notAfter
    });
  }

  demoState.certificate = {
    state: "issued",
    hostname: certificates[0]?.hostname,
    hostnames: certificates.map((certificate) => certificate.hostname),
    certificates: certificates.map((certificate) => ({
      hostname: certificate.hostname,
      issuer: certificate.issuer,
      notAfter: certificate.notAfter
    })),
    issuedAt: new Date().toISOString()
  };
  await restartServerWithTls(tlsOptionsForManagedCertificates(certificates));
}

async function switchboardJobSigner(): Promise<{ signer: SwitchboardJobSigner; mode: string }> {
  const acurastSigner = maybeAcurastJobSigner();
  if (acurastSigner) {
    return { signer: acurastSigner, mode: "acurast-secp256k1" };
  }

  const privateKey = envValue("JOB_SIGNER_PRIVATE_KEY");
  if (privateKey) {
    return { signer: privateKeyJobSigner(privateKey), mode: "private-key" };
  }

  throw new Error("Missing Acurast secp256k1 runtime signer and JOB_SIGNER_PRIVATE_KEY fallback");
}

function certificateRequestHostnames(): string[] {
  return certificateRequestHostnamesIfConfigured(requiredConfig("ENDPOINT_HOSTNAME"));
}

function certificateRequestHostnamesIfConfigured(endpointHostname: string | undefined): string[] {
  const configured = splitCsv(configValue("SWITCHBOARD_CERTIFICATE_HOSTNAMES") ?? "");
  const hostnames = configured.length > 0 ? configured : endpointHostname ? [endpointHostname] : [];
  return [...new Set(hostnames.map((hostname) => hostname.trim().replace(/\.$/, "").toLowerCase()).filter(Boolean))];
}

function tlsOptionsForManagedCertificates(certificates: ManagedCertificate[]): HttpsServerOptions {
  if (certificates.length === 0) {
    throw new Error("At least one managed certificate is required");
  }
  const contexts = new Map(
    certificates.map((certificate) => [
      certificate.hostname.toLowerCase(),
      tls.createSecureContext({
        cert: certificate.cert,
        key: certificate.key
      })
    ])
  );
  const defaultCertificate = certificates[0];
  const defaultContext = contexts.get(defaultCertificate.hostname.toLowerCase());

  return {
    cert: defaultCertificate.cert,
    key: defaultCertificate.key,
    SNICallback: (servername, callback) => {
      const context = contexts.get(servername.trim().replace(/\.$/, "").toLowerCase()) ?? defaultContext;
      if (!context) {
        callback(new Error("No TLS context available"));
        return;
      }
      callback(null, context);
    }
  };
}

async function runSignerSmoke(): Promise<void> {
  const signer = await switchboardJobSigner();
  const registryAddress = configValue("INGRESS_REGISTRY_ADDRESS") ?? "0x1000000000000000000000000000000000000000";
  const chainId = configValue("CHAIN_ID") ?? "31337";
  const request = await buildIngressRegistrationRequest({
    relayUrl: "http://127.0.0.1",
    chainId,
    registryAddress,
    sessionId: "0x1111111111111111111111111111111111111111111111111111111111111111",
    jobId: "0x2222222222222222222222222222222222222222222222222222222222222222",
    operatorId: "0x3333333333333333333333333333333333333333333333333333333333333333",
    processorId: "0x4444444444444444444444444444444444444444444444444444444444444444",
    endpointHostname: "signer-smoke.ingress.works",
    nonce: "1",
    deadline: "4102444800",
    jobSigner: signer.signer
  });
  const recovered = recoverRegistrationSigner(chainId, registryAddress, request.registration, request.signature);
  void remoteLog("signer-smoke-succeeded", {
    signerMode: signer.mode,
    jobSigner: request.registration.jobSigner,
    recovered,
    matched: recovered.toLowerCase() === request.registration.jobSigner.toLowerCase(),
    signatureBytes: Math.floor((request.signature.length - 2) / 2)
  });
}

async function demoStatus(): Promise<Record<string, unknown>> {
  await resolveDemoJobSigner();
  const endpointHostname = configValue("ENDPOINT_HOSTNAME");
  const certificateHostnames = certificateRequestHostnamesIfConfigured(endpointHostname);
  const customerHostnames = certificateHostnames.filter((hostname) => hostname !== endpointHostname);
  const publicUrl = endpointHostname ? `https://${endpointHostname}/` : undefined;
  const challengeUrl = endpointHostname ? `${publicUrl}.well-known/proofcomputer/challenge?nonce=demo` : undefined;
  const registration = demoState.registration ?? inferredRegistrationState();
  const certificate = demoState.certificate ?? inferredCertificateState();

  return {
    ok: true,
    name: "Switchboard",
    now: new Date().toISOString(),
    startedAt: demoState.startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    local: {
      protocol,
      host,
      port,
      url: `${protocol}://${host}:${port}/`
    },
    public: {
      hostname: endpointHostname,
      customerHostnames,
      certificateHostnames,
      url: publicUrl,
      challengeUrl
    },
    ids: {
      deploymentId,
      sessionId: currentSessionId(),
      jobId: currentJobId(),
      jobSigner: demoState.jobSigner,
      signerMode: demoState.signerMode
    },
    routing: {
      relayUrl: configValue("RELAY_URL"),
      relayHost: configValue("RELAY_URL") ? safeUrlHost(requiredConfig("RELAY_URL")) : undefined,
      operatorId: configValue("OPERATOR_ID"),
      processorId: configValue("PROCESSOR_ID"),
      gatewayId: demoState.gatewayId ?? configValue("GATEWAY_ID"),
      registryAddress: configValue("INGRESS_REGISTRY_ADDRESS"),
      chainId: configValue("CHAIN_ID")
    },
    registration,
    certificate,
    challenges: {
      count: demoState.challengeCount,
      lastAt: demoState.lastChallengeAt,
      last: demoState.lastChallenge
    },
    acurast: acurastRuntimeStatus(),
    relayDiagnostics: demoState.relayDiagnostics,
    runtime: runtimeSummary(),
    network: networkAddressSummary(),
    envPresence: envPresence([...requiredRegistrationEnv(), "GATEWAY_ID", "JOB_SIGNER_PRIVATE_KEY", ...remoteLogEnvNames()])
  };
}

async function resolveDemoJobSigner(): Promise<void> {
  if (demoState.jobSigner) {
    return;
  }

  try {
    const signer = await switchboardJobSigner();
    demoState.signerMode = signer.mode;
    demoState.jobSigner = await signer.signer.getAddress();
  } catch {
    // The page should still render in local/demo modes without signer access.
  }
}

async function logJobSignerReady(): Promise<void> {
  try {
    const signer = await switchboardJobSigner();
    const jobSigner = await signer.signer.getAddress();
    demoState.signerMode = signer.mode;
    demoState.jobSigner = jobSigner;
    void remoteLog("job-signer-ready", {
      signerMode: signer.mode,
      jobSigner
    });
  } catch (error) {
    void remoteLog("job-signer-unavailable", {
      error: safeError(error)
    });
  }
}

function inferredRegistrationState(): Record<string, unknown> {
  const missing = requiredRegistrationEnv().filter((name) => !configValue(name));
  if (missing.length > 0) {
    return {
      state: "not-configured",
      missing
    };
  }

  return {
    state: "pending"
  };
}

function inferredCertificateState(): Record<string, unknown> {
  if (protocol === "https") {
    return {
      state: "active",
      mode: certificateMode()
    };
  }

  if (certificateMode() === "job-acme") {
    return {
      state: "pending",
      mode: "job-acme"
    };
  }

  return {
    state: "not-requested",
    mode: certificateMode()
  };
}

function networkAddressSummary(): Array<Record<string, unknown>> {
  return Object.entries(networkInterfaces()).flatMap(([name, values]) =>
    (values ?? []).map((value) => ({
      name,
      address: value.address,
      family: value.family,
      internal: value.internal,
      cidr: value.cidr
    }))
  );
}

function publicNetworkAddresses(): string[] {
  return unique(
    networkAddressSummary()
      .filter((item) => item.internal === false && (item.family === "IPv4" || item.family === 4))
      .map((item) => (typeof item.address === "string" ? item.address : undefined))
      .filter((value): value is string => Boolean(value))
  );
}

function requiredConfig(name: string): string {
  const value = configValue(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
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

function configValue(name: string): string | undefined {
  for (const candidate of configNameCandidates(name)) {
    const value = runtimeConfig[candidate] ?? envValue(candidate) ?? switchboardConfig[candidate];
    if (value) {
      return value;
    }
  }
  return undefined;
}

function configNameCandidates(name: string): string[] {
  if (name.startsWith("SWITCHBOARD_")) {
    return [name, `PROOF_INGRESS_${name.slice("SWITCHBOARD_".length)}`];
  }
  return [name];
}

interface AcurastProcessorIdentity {
  processorId?: string;
  processor?: string;
  address?: string;
  raw?: unknown;
  source: "_STD_.job.getProcessorId" | "_STD_.device.getAddress";
}

function acurastProcessorIdentity(): AcurastProcessorIdentity {
  const std = (globalThis as any)._STD_;
  const jobProcessor = std?.job?.getProcessorId;
  if (typeof jobProcessor === "function") {
    const identity = normalizeAcurastProcessorIdentity(jobProcessor.call(std.job), "_STD_.job.getProcessorId");
    if (identity) return identity;
  }
  const deviceAddress = std?.device?.getAddress;
  if (typeof deviceAddress === "function") {
    const identity = normalizeAcurastProcessorIdentity(deviceAddress.call(std.device), "_STD_.device.getAddress");
    if (identity) return identity;
  }
  throw new Error("Switchboard group intent requires Acurast processor identity from _STD_.job.getProcessorId() or _STD_.device.getAddress()");
}

function normalizeAcurastProcessorIdentity(
  raw: unknown,
  source: AcurastProcessorIdentity["source"]
): AcurastProcessorIdentity | undefined {
  if (typeof raw === "string" && raw.length > 0) {
    return hex32String(raw)
      ? { processorId: raw, raw, source }
      : { processor: raw, address: raw, raw, source };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const processorId = stringRecordField(record, "processorId") ?? stringRecordField(record, "id");
  const processor = stringRecordField(record, "processor") ?? stringRecordField(record, "address") ?? stringRecordField(record, "deviceAddress");
  const address = stringRecordField(record, "address") ?? stringRecordField(record, "deviceAddress") ?? processor;
  if (processorId || processor || address) {
    return {
      processorId: processorId && hex32String(processorId) ? processorId : undefined,
      processor,
      address,
      raw,
      source
    };
  }
  return undefined;
}

function hex32String(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function switchboardIntentConfigured(): boolean {
  return Boolean(configValue("SWITCHBOARD_RELAY_URL") && configValue("SWITCHBOARD_INTENT_ID") && configValue("SWITCHBOARD_INTENT_TOKEN"));
}

function switchboardIntentGroupConfigured(): boolean {
  return Boolean(configValue("SWITCHBOARD_RELAY_URL") && configValue("SWITCHBOARD_INTENT_GROUP_ID") && configValue("SWITCHBOARD_INTENT_TOKEN"));
}

async function claimSwitchboardIntent(input: {
  relayUrl: string;
  intentId: string;
  intentToken: string;
  runtimeSigner: string;
  signerMode: string;
}): Promise<void> {
  const response = await switchboardIntentFetch(input, "claim", {
    runtimeSigner: input.runtimeSigner,
    acurastJobId: acurastDeploymentId(),
    acurastDeploymentId: deploymentId,
    signerMode: input.signerMode,
    upstreamIps: publicNetworkAddresses(),
    source: {
      runtime: runtimeSummary()
    }
  });
  void remoteLog("deployment-intent-claimed", {
    intentId: input.intentId,
    runtimeSigner: input.runtimeSigner,
    response
  });
}

async function claimSwitchboardIntentGroup(input: {
  relayUrl: string;
  groupId: string;
  intentToken: string;
  runtimeSigner: string;
  signerMode: string;
  processorIdentity: AcurastProcessorIdentity;
}): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(`/v1/deployment-intent-groups/${encodeURIComponent(input.groupId)}/claim`, input.relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.intentToken}`
    },
    body: JSON.stringify({
      runtimeSigner: input.runtimeSigner,
      acurastJobId: acurastDeploymentId(),
      acurastDeploymentId: deploymentId,
      signerMode: input.signerMode,
      upstreamIps: publicNetworkAddresses(),
      processorId: input.processorIdentity.processorId,
      processor: input.processorIdentity.processor,
      processorAddress: input.processorIdentity.address,
      processorIdentity: input.processorIdentity,
      source: {
        runtime: runtimeSummary()
      }
    }),
    signal: AbortSignal.timeout(numberEnv("SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS", 60_000))
  });
  const responseBody = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Switchboard intent group claim failed: ${response.status} ${JSON.stringify(responseBody)}`);
  }
  void remoteLog("deployment-intent-group-claimed", {
    groupId: input.groupId,
    runtimeSigner: input.runtimeSigner,
    processorIdentity: input.processorIdentity,
    response: responseBody
  });
  return responseBody;
}

async function reportSwitchboardIntentHealth(input: {
  relayUrl: string;
  intentId: string;
  intentToken: string;
  state: "starting" | "claimed" | "waiting_quote" | "waiting_funding" | "config_received" | "registering" | "registered" | "certificate_requesting" | "ready" | "failed";
  message?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await switchboardIntentFetch(input, "health", {
    state: input.state,
    message: input.message,
    details: input.details
  });
}

async function reportCertificateIntentHealth(
  state: "certificate_requesting" | "failed",
  details: Record<string, unknown>
): Promise<void> {
  if (!switchboardIntentConfigured()) {
    return;
  }
  await reportSwitchboardIntentHealth({
    relayUrl: requiredConfig("SWITCHBOARD_RELAY_URL"),
    intentId: requiredConfig("SWITCHBOARD_INTENT_ID"),
    intentToken: requiredConfig("SWITCHBOARD_INTENT_TOKEN"),
    state,
    details
  }).catch(() => undefined);
}

async function fetchSwitchboardIntentRuntimeConfig(input: {
  relayUrl: string;
  intentId: string;
  intentToken: string;
}): Promise<SwitchboardRuntimeConfigResponse> {
  const response = await fetch(new URL(`/v1/deployment-intents/${encodeURIComponent(input.intentId)}/runtime-config`, input.relayUrl), {
    method: "GET",
    headers: {
      authorization: `Bearer ${input.intentToken}`
    },
    signal: AbortSignal.timeout(numberEnv("SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS", 60_000))
  });
  const body = await response.json() as SwitchboardRuntimeConfigResponse;
  if (response.status === 202) {
    return body;
  }
  if (!response.ok || !body.ok) {
    throw new Error(`Switchboard runtime config failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function switchboardIntentFetch(
  input: { relayUrl: string; intentId: string; intentToken: string },
  endpoint: "claim" | "health",
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(`/v1/deployment-intents/${encodeURIComponent(input.intentId)}/${endpoint}`, input.relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.intentToken}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(numberEnv("SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS", 60_000))
  });
  const responseBody = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Switchboard intent ${endpoint} failed: ${response.status} ${JSON.stringify(responseBody)}`);
  }
  return responseBody;
}

function applySwitchboardRuntimeConfig(config: SwitchboardRuntimeConfig): void {
  applyRuntimeRegistrationConfig({
    RELAY_URL: requiredRuntimeConfig(config.relayUrl, "relayUrl"),
    CHAIN_ID: requiredRuntimeConfig(config.chainId, "chainId"),
    INGRESS_REGISTRY_ADDRESS: requiredRuntimeConfig(config.registryAddress, "registryAddress"),
    SESSION_ID: requiredRuntimeConfig(config.sessionId, "sessionId"),
    JOB_ID: requiredRuntimeConfig(config.jobId, "jobId"),
    OPERATOR_ID: requiredRuntimeConfig(config.operatorId, "operatorId"),
    PROCESSOR_ID: requiredRuntimeConfig(config.processorId, "processorId"),
    GATEWAY_ID: config.gatewayId,
    ENDPOINT_HOSTNAME: requiredRuntimeConfig(config.endpointHostname, "endpointHostname")
  });
  runtimeConfig.SWITCHBOARD_CERTIFICATE_MODE = config.certificateMode ?? "job-acme";
  runtimeConfig.SWITCHBOARD_CERTIFICATE_HOSTNAMES = (config.certificateHostnames ?? [config.endpointHostname]).filter(Boolean).join(",");
}

function gatewayIdFromRuntimeResponse(response: SwitchboardRuntimeConfigResponse): string | undefined {
  return (
    response.config?.gatewayId ??
    stringRecordField((response.intent as Record<string, unknown> | undefined)?.allocation, "gatewayId") ??
    stringRecordField(response.intent, "gatewayId")
  );
}

function requiredRuntimeConfig(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Switchboard runtime config missing ${name}`);
  }
  return value;
}

interface SwitchboardRuntimeConfigResponse {
  ok: boolean;
  state?: string;
  intent?: Record<string, unknown>;
  config?: SwitchboardRuntimeConfig;
}

interface SwitchboardRuntimeConfig {
  relayUrl?: string;
  chainId?: string;
  registryAddress?: string;
  sessionId?: string;
  jobId?: string;
  operatorId?: string;
  processorId?: string;
  gatewayId?: string;
  endpointHostname?: string;
  certificateMode?: string;
  certificateHostnames?: string[];
}

function readSwitchboardConfig(): Record<string, string> {
  const raw = envValue("SWITCHBOARD_CONFIG") ?? envValue("PROOF_INGRESS_CONFIG") ?? buildConfigValue();
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

function acurastDeploymentId(): string | undefined {
  const getId = (globalThis as any)._STD_?.job?.getId;
  if (typeof getId !== "function") {
    return undefined;
  }

  const id = getId();
  return typeof id === "string" ? id : JSON.stringify(id);
}

function acurastDeploymentSequence(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (/^[0-9]+$/.test(value)) {
    return value;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const id = (parsed as { id?: unknown }).id;
      if (typeof id === "number" && Number.isInteger(id) && id >= 0) {
        return String(id);
      }
      if (typeof id === "string" && /^[0-9]+$/.test(id)) {
        return id;
      }
    }
    if (Array.isArray(parsed) && parsed.length >= 2) {
      const id = parsed[1];
      if (typeof id === "number" && Number.isInteger(id) && id >= 0) {
        return String(id);
      }
      if (typeof id === "string" && /^[0-9]+$/.test(id)) {
        return id;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

interface DemoState {
  startedAt: string;
  challengeCount: number;
  lastChallengeAt?: string;
  lastChallenge?: Record<string, unknown>;
  signerMode?: string;
  jobSigner?: string;
  registration?: Record<string, unknown>;
  certificate?: Record<string, unknown>;
  relayDiagnostics?: Record<string, unknown>;
  gatewayId?: string;
}

interface ManagedCertificate {
  hostname: string;
  cert: string;
  key: string;
  issuer?: string;
  notAfter?: string;
}

type RemoteLogDetails = Record<string, unknown>;

function createServer(options: HttpsServerOptions | undefined): HttpServer {
  return options ? https.createServer(options, app) : http.createServer(app);
}

async function startServer(options: { runRegistration: boolean; scheduleExit: boolean }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      console.log(`Express app listening on ${protocol}://${host}:${port}`);
      void remoteLog("server-listening", { host, port, protocol });
      if (options.scheduleExit) {
        scheduleProcessExit();
      }
      if (configValue("SWITCHBOARD_SIGNER_SMOKE") === "true") {
        void runSignerSmoke().catch((error) => {
          console.error(error);
          void remoteLog("signer-smoke-failed", { error: safeError(error) });
        });
      }
      if (configValue("SWITCHBOARD_RELAY_DIAGNOSTICS") === "true") {
        void runRelayDiagnosticsOnce().catch((error) => {
          console.error(error);
          void remoteLog("relay-diagnostics-failed", { error: safeError(error) });
        });
      }
      if (options.runRegistration) {
        if (configValue("SWITCHBOARD_AUTO_REGISTER") === "false") {
          void remoteLog("registration-skipped", { reason: "auto-register-disabled" });
        } else {
          void runRegistrationLoop();
        }
      }
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function runRelayDiagnosticsOnce(): Promise<void> {
  const relayUrl = configValue("RELAY_URL") ?? configValue("SWITCHBOARD_RELAY_URL");
  if (!relayUrl) {
    void remoteLog("relay-diagnostics-skipped", { reason: "missing-relay-url" });
    return;
  }

  const timeoutMs = numberEnv("SWITCHBOARD_RELAY_DIAGNOSTICS_TIMEOUT_MS", 10_000);
  const result = await runRelayDiagnostics(relayUrl, timeoutMs);
  demoState.relayDiagnostics = {
    ...result,
    checkedAt: new Date().toISOString()
  };
  void remoteLog("relay-diagnostics", { ...result });
}

async function restartServerWithTls(options: HttpsServerOptions): Promise<void> {
  if (protocol === "https" && "setSecureContext" in server && typeof (server as https.Server).setSecureContext === "function") {
    (server as https.Server).setSecureContext(options);
    tlsConfig = options;
    void remoteLog("server-tls-context-updated", { protocol });
    return;
  }

  await closeServer(server);
  tlsConfig = options;
  protocol = "https";
  server = createServer(tlsConfig);
  await startServer({ runRegistration: false, scheduleExit: false });
}

async function closeServer(target: HttpServer): Promise<void> {
  if (!target.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    target.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

// Stub for builder-supplied TLS material. The SWITCHBOARD_TLS_*_PEM env
// vars cannot ride `setEnvironments` today (PEMs exceed the chain's ~996-byte
// plaintext cap), so this read path is dormant in production. The planned
// secrets service will populate process.env at boot before the relay reads
// these values; once that ships, builders can bring their own cert/key
// material without code changes here.
//
// See docs/knowledge/raw-inputs/2026-05-03-acurast-runtime-secrets-service-direction.md
// and docs/acurast-deployment-harness.md (#acurast-setenvironments-runtime-caps).
function readTlsConfig(): HttpsServerOptions | undefined {
  const cert =
    configValue("SWITCHBOARD_TLS_CERT_PEM") ??
    base64ConfigValue("SWITCHBOARD_TLS_CERT_PEM_BASE64") ??
    fileConfigValue("SWITCHBOARD_TLS_CERT_FILE");
  const key =
    configValue("SWITCHBOARD_TLS_KEY_PEM") ??
    base64ConfigValue("SWITCHBOARD_TLS_KEY_PEM_BASE64") ??
    fileConfigValue("SWITCHBOARD_TLS_KEY_FILE");
  if (!cert && !key) {
    return undefined;
  }
  if (!cert || !key) {
    throw new Error("Both SWITCHBOARD_TLS_CERT_PEM and SWITCHBOARD_TLS_KEY_PEM are required for HTTPS");
  }

  return { cert, key };
}

function base64ConfigValue(name: string): string | undefined {
  const value = configValue(name);
  return value ? Buffer.from(value, "base64").toString("utf8") : undefined;
}

function fileConfigValue(name: string): string | undefined {
  const value = configValue(name);
  return value ? readFileSync(value, "utf8") : undefined;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function createRemoteLogger(): (event: string, details?: RemoteLogDetails) => Promise<void> {
  return async () => undefined;
}

function allowAcurastHostname(rawUrl: string): void {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return;
  }

  const addAllowedHostnames = (globalThis as any)._STD_?.net?.addAllowedHostnames;
  if (typeof addAllowedHostnames !== "function") {
    return;
  }

  try {
    void Promise.resolve(addAllowedHostnames([hostname])).catch((error) => {
      console.warn(`Acurast hostname allowlist failed for ${hostname}: ${safeError(error).message}`);
    });
  } catch (error) {
    console.warn(`Acurast hostname allowlist failed for ${hostname}: ${safeError(error).message}`);
  }
}

function runtimeSummary(): RemoteLogDetails {
  const std = (globalThis as any)._STD_;
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    hasStd: Boolean(std),
    hasStdEnv: Boolean(std?.env),
    hasStdJobGetId: typeof std?.job?.getId === "function",
    hasStdJobGetProcessorId: typeof std?.job?.getProcessorId === "function",
    hasStdJobGetPublicKeys: typeof std?.job?.getPublicKeys === "function",
    hasStdDeviceGetAddress: typeof std?.device?.getAddress === "function",
    hasStdSignersSecp256k1: typeof std?.signers?.secp256k1?.sign === "function",
    hasStdChains: Boolean(std?.chains),
    hasStdNetAddAllowedHostnames: typeof std?.net?.addAllowedHostnames === "function",
    hasEnvironmentFunction: typeof (globalThis as any).environment === "function",
    appVersion: typeof std?.app_info?.version === "string" ? std.app_info.version : undefined
  };
}

function acurastRuntimeStatus(): Record<string, unknown> | undefined {
  const scheduleEndMs = optionalNumberConfig("ACURAST_SCHEDULE_END_MS");
  const executionMs = optionalNumberConfig("ACURAST_EXECUTION_MS");
  if (scheduleEndMs === undefined && executionMs === undefined) {
    return undefined;
  }
  return {
    scheduleEndMs,
    scheduleEndIso: scheduleEndMs === undefined ? undefined : new Date(scheduleEndMs).toISOString(),
    executionMs
  };
}

function envPresence(names: string[]): Record<string, boolean> {
  return Object.fromEntries(unique(names).map((name) => [name, Boolean(configValue(name))]));
}

function remoteLogEnvNames(): string[] {
  return [
    "SWITCHBOARD_CONFIG",
    "SWITCHBOARD_SIGNER_SMOKE",
    "SWITCHBOARD_REGISTRATION_RETRY_MS",
    "SWITCHBOARD_REGISTRATION_MAX_ATTEMPTS",
    "SWITCHBOARD_EXIT_AFTER_MS",
    "SWITCHBOARD_TLS_CERT_PEM",
    "SWITCHBOARD_TLS_CERT_PEM_BASE64",
    "SWITCHBOARD_TLS_CERT_FILE",
    "SWITCHBOARD_TLS_KEY_PEM",
    "SWITCHBOARD_TLS_KEY_PEM_BASE64",
    "SWITCHBOARD_TLS_KEY_FILE",
    "SWITCHBOARD_CERTIFICATE_MODE",
    "SWITCHBOARD_CERTIFICATE_REQUEST_TIMEOUT_MS",
    "SWITCHBOARD_RELAY_DIAGNOSTICS",
    "SWITCHBOARD_RELAY_DIAGNOSTICS_TIMEOUT_MS",
    "ACURAST_SCHEDULE_END_MS",
    "ACURAST_EXECUTION_MS"
  ];
}

function safeNetworkInterfaces(): Record<string, Array<Record<string, unknown>>> {
  return Object.fromEntries(
    Object.entries(networkInterfaces()).map(([name, values]) => [
      name,
      (values ?? []).map((value) => ({
        address: value.address,
        family: value.family,
        internal: value.internal,
        cidr: value.cidr
      }))
    ])
  );
}

function scheduleProcessExit(): void {
  const exitAfterMsRaw = configValue("SWITCHBOARD_EXIT_AFTER_MS");
  if (!exitAfterMsRaw) {
    return;
  }

  const exitAfterMs = Number(exitAfterMsRaw);
  if (!Number.isFinite(exitAfterMs) || exitAfterMs <= 0) {
    void remoteLog("process-exit-skipped", { reason: "invalid-exit-after-ms" });
    return;
  }

  void remoteLog("process-exit-scheduled", { exitAfterMs });
  setTimeout(() => {
    void gracefulExit(0, "configured-exit-after-ms", { exitAfterMs });
  }, exitAfterMs);
}

function numberEnv(name: string, fallback: number): number {
  const raw = configValue(name);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function optionalNumberConfig(name: string): number | undefined {
  const raw = configValue(name);
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asSwitchboardCertificateError(
  error: unknown,
  fallback: { stage: SwitchboardCertificateFailureStage; hostname?: string }
): SwitchboardCertificateError {
  if (error instanceof SwitchboardCertificateError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new SwitchboardCertificateError(message, {
    ...fallback,
    cause: error
  });
}

function switchboardCertificateErrorDetails(error: SwitchboardCertificateError): Record<string, unknown> {
  const details: Record<string, unknown> = {
    stage: error.stage,
    error: safeCertificateError(error)
  };
  if (error.hostname) {
    details.hostname = error.hostname;
  }
  if (error.status !== undefined) {
    details.status = error.status;
  }
  const relayError = stringRecordField(error.relayResponse, "error");
  if (relayError) {
    details.relayError = relayError;
  }
  if (error.relayResponse !== undefined) {
    details.relayResponse = sanitizeRelayResponse(error.relayResponse);
  }
  return details;
}

function safeCertificateError(error: SwitchboardCertificateError): Record<string, unknown> {
  return {
    name: error.name,
    message: truncate(error.message),
    stage: error.stage,
    hostname: error.hostname,
    status: error.status
  };
}

function certificateRetryAfterMs(error: SwitchboardCertificateError): number | undefined {
  const relayError = stringRecordField(error.relayResponse, "error");
  if (relayError !== "certificate_hostname_lock_unavailable") {
    return undefined;
  }
  const retryAfterMs = numberRecordField(error.relayResponse, "retryAfterMs");
  if (retryAfterMs !== undefined && retryAfterMs >= 0) {
    return retryAfterMs;
  }
  const retryAfterSeconds = numberRecordField(error.relayResponse, "retryAfterSeconds");
  return retryAfterSeconds !== undefined && retryAfterSeconds >= 0 ? retryAfterSeconds * 1000 : undefined;
}

function numberRecordField(record: unknown, name: string): number | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const value = (record as Record<string, unknown>)[name];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function gracefulExit(
  code: number,
  reason: string,
  details: RemoteLogDetails = {}
): Promise<void> {
  const forceExit = setTimeout(() => process.exit(code), 3000);
  forceExit.unref();
  try {
    await remoteLog("process-exiting", { reason, code, ...details });
    await closeServer(server);
  } finally {
    process.exit(code);
  }
}

function safeUrlHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return "invalid-url";
  }
}

function safeError(error: unknown): { name: string; message: string; cause?: Record<string, unknown> | string } {
  if (error instanceof Error) {
    const serialized = {
      name: error.name,
      message: truncate(error.message)
    };
    const cause = safeErrorCause(error.cause);
    return cause === undefined ? serialized : { ...serialized, cause };
  }

  return {
    name: typeof error,
    message: truncate(String(error))
  };
}

function sanitizeRelayResponse(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeRelayResponse);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
      const normalized = key.toLowerCase();
      if (
        normalized === "token" ||
        normalized.endsWith("token") ||
        normalized === "authorization" ||
        normalized === "secret"
      ) {
        return [key, "[redacted]"];
      }
      return [key, sanitizeRelayResponse(nested)];
    })
  );
}

function safeErrorCause(cause: unknown): Record<string, unknown> | string | undefined {
  if (cause === undefined || cause === null) {
    return undefined;
  }

  if (cause instanceof Error) {
    const details: Record<string, unknown> = {
      name: cause.name,
      message: truncate(cause.message)
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
    return Object.keys(details).length > 0 ? details : truncate(String(cause));
  }

  return truncate(String(cause));
}

function truncate(value: string, maxLength = 1000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function pathBasename(value: string): string {
  const match = value.match(/[^/\\]+$/);
  return match?.[0] ?? value;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
