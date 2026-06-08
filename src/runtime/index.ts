import type { Request, Response as ExpressResponse, Router } from "express";
import { Router as createRouter } from "express";
import * as acme from "acme-client";
import { ethers } from "ethers";

import {
  buildSwitchboardChallengeResult,
  SWITCHBOARD_CHALLENGE_PATH,
  type SwitchboardChallengeConfig
} from "./challenge.js";
import {
  certificateRequestDigest,
  csrPemHash,
  signCertificateRequest,
  type CertificateRequestPayload
} from "../certificate-request.js";
import {
  endpointHash,
  normalizeRegistration,
  registrationDigest,
  signRegistration,
  type RegistrationPayload
} from "../registration.js";
import {
  decryptProofLogRecord,
  encryptProofLogRecord,
  generateProofLogEncryptionKey,
  type ProofLogEncryptedRecord
} from "../proof-log-crypto.js";
import {
  gatewayUpstreamAdmissionDigest,
  type GatewayUpstreamAdmissionPayload
} from "./gateway-upstream-admission.js";

export {
  GATEWAY_UPSTREAM_ADMISSION_REQUEST_DOMAIN,
  GATEWAY_UPSTREAM_OBSERVATION_DOMAIN,
  gatewayUpstreamAdmissionDigest,
  gatewayUpstreamAdmissionId,
  gatewayUpstreamObservationDigest,
  normalizeGatewayUpstreamAdmissionPayload,
  normalizeGatewayUpstreamObservationPayload,
  normalizeSecp256k1SignatureForDigest,
  recoverGatewayUpstreamAdmissionSigner,
  type GatewayUpstreamAdmissionPayload,
  type GatewayUpstreamObservationPayload,
  type SignedGatewayUpstreamObservation
} from "./gateway-upstream-admission.js";

export interface SwitchboardTransportSecurityOptions {
  allowInsecureHttp?: boolean;
}

export function requireSecureSwitchboardUrl(
  rawUrl: string | URL,
  label: string,
  options: SwitchboardTransportSecurityOptions = {}
): URL {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(rawUrl);
  } catch (error) {
    throw new Error(`${label} must be a valid URL`, { cause: error });
  }

  if (url.protocol === "https:") {
    return url;
  }
  if (url.protocol === "http:" && options.allowInsecureHttp === true) {
    return url;
  }
  if (url.protocol === "http:") {
    throw new Error(`${label} must use https://; set allowInsecureHttp only for controlled local tests or labs`);
  }
  throw new Error(`${label} must use https://; unsupported URL protocol ${url.protocol}`);
}

export interface SwitchboardRegistrationConfig {
  relayUrl: string;
  chainId: string | number | bigint;
  registryAddress: string;
  sessionId: string;
  jobId: string;
  operatorId: string;
  processorId: string;
  endpointHostname?: string;
  endpointHash?: string;
  nonce?: string | number | bigint;
  deadline?: string | number | bigint;
  jobSigner?: SwitchboardJobSigner;
  jobSignerPrivateKey?: string;
  requestTimeoutMs?: number;
  allowInsecureHttp?: boolean;
}

export interface SwitchboardCertificateConfig {
  relayUrl: string;
  chainId: string | number | bigint;
  registryAddress: string;
  sessionId: string;
  hostname: string;
  csrPem?: string;
  privateKeyPem?: string;
  nonce?: string | number | bigint;
  deadline?: string | number | bigint;
  jobSigner?: SwitchboardJobSigner;
  jobSignerPrivateKey?: string;
  requestTimeoutMs?: number;
  certificateKeyAlgorithm?: SwitchboardCertificateKeyAlgorithm;
  onProgress?: (progress: SwitchboardCertificateRequestProgress) => void | Promise<void>;
  allowInsecureHttp?: boolean;
}

export type SwitchboardCertificateKeyAlgorithm = "ecdsa-p256" | "rsa-2048";

export type SwitchboardCertificateRequestProgressStage = "csr_generation" | "request_signing" | "relay_request" | "relay_response";

export interface SwitchboardCertificateRequestProgress {
  stage: SwitchboardCertificateRequestProgressStage;
  hostname: string;
}

export interface SwitchboardJobSigner {
  getAddress(): Promise<string>;
  signRegistration(input: {
    chainId: string | number | bigint;
    registryAddress: string;
    registration: RegistrationPayload;
  }): Promise<string>;
  signCertificateRequest(input: {
    chainId: string | number | bigint;
    registryAddress: string;
    certificateRequest: CertificateRequestPayload;
  }): Promise<string>;
  signGatewayUpstreamAdmission?(input: {
    request: GatewayUpstreamAdmissionPayload;
  }): Promise<string>;
}

export interface AcurastRuntimeStd {
  job?: {
    getPublicKeys?: () => unknown;
  };
  signers?: {
    secp256k1?: {
      sign?: (payload: string) => string | Promise<string>;
    };
  };
}

export interface SwitchboardRegistrationRequest {
  registration: RegistrationPayload;
  signature: string;
}

export interface SwitchboardRegistrationResult extends SwitchboardRegistrationRequest {
  relayResponse: unknown;
}

export interface SwitchboardCertificateSigningRequest {
  privateKeyPem: string;
  csrPem: string;
}

export interface SwitchboardCertificateRelayRequest {
  certificateRequest: CertificateRequestPayload;
  csrPem: string;
  signature: string;
}

export interface SwitchboardCertificateResult extends SwitchboardCertificateRelayRequest {
  privateKeyPem?: string;
  relayResponse: {
    hostname?: string;
    certificatePem?: string;
    issuer?: string;
    notAfter?: string;
    [key: string]: unknown;
  };
}

export type SwitchboardCertificateFailureStage =
  | "hostname_config"
  | "certificate_config"
  | "certificate_lock"
  | "certificate_request"
  | "csr_generation"
  | "request_signing"
  | "relay_request"
  | "certificate_install"
  | "certificate_authorization"
  | "acme_issuance"
  | "relay_response";

export interface SwitchboardCertificateErrorOptions {
  stage: SwitchboardCertificateFailureStage;
  hostname?: string;
  status?: number;
  relayResponse?: unknown;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class SwitchboardCertificateError extends Error {
  readonly stage: SwitchboardCertificateFailureStage;
  readonly hostname: string | undefined;
  readonly status: number | undefined;
  readonly relayResponse: unknown;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, options: SwitchboardCertificateErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SwitchboardCertificateError";
    this.stage = options.stage;
    this.hostname = options.hostname;
    this.status = options.status;
    this.relayResponse = options.relayResponse;
    this.details = options.details;
  }
}

export interface SwitchboardLogRecord {
  timestamp: string;
  event: string;
  context?: string;
  sessionId?: string;
  jobId?: string;
  deploymentId?: string;
  runtime?: Record<string, unknown>;
  envPresence?: Record<string, boolean>;
  details?: Record<string, unknown>;
}

export interface SwitchboardRemoteLoggerConfig {
  logUrl?: string;
  writeToken?: string;
  encryptionKey?: string;
  context?: string;
  timeoutMs?: number;
  baseRecord?: () => Record<string, unknown>;
  onError?: (error: unknown, event: string) => void;
  allowInsecureHttp?: boolean;
}

export interface SwitchboardLogSinkEvent {
  sequence: number;
  receivedAt: string;
  encrypted: ProofLogEncryptedRecord;
}

export {
  buildSwitchboardChallengeResult,
  decryptProofLogRecord,
  encryptProofLogRecord,
  generateProofLogEncryptionKey,
  SWITCHBOARD_CHALLENGE_PATH,
  type ProofLogEncryptedRecord
};
export type {
  SwitchboardChallengeConfig,
  SwitchboardChallengeError,
  SwitchboardChallengeEvent,
  SwitchboardChallengeRequest,
  SwitchboardChallengeResponse,
  SwitchboardChallengeResult
} from "./challenge.js";
export function createSwitchboardRouter(config: SwitchboardChallengeConfig): Router {
  const router = createRouter();

  router.get(SWITCHBOARD_CHALLENGE_PATH, (request: Request, response: ExpressResponse) => {
    const result = buildSwitchboardChallengeResult(config, {
      nonce: request.query.nonce,
      path: request.path,
      userAgent: request.header("user-agent"),
      remoteAddress: request.ip
    });
    response.status(result.statusCode);
    for (const [name, value] of Object.entries(result.headers)) {
      response.setHeader(name, value);
    }
    response.json(result.body);
  });

  return router;
}

export function privateKeyJobSigner(privateKey: string): SwitchboardJobSigner {
  const wallet = new ethers.Wallet(privateKey);

  return {
    async getAddress() {
      return wallet.getAddress();
    },
    async signRegistration(input) {
      return signRegistration(wallet, input.chainId, input.registryAddress, input.registration);
    },
    async signCertificateRequest(input) {
      return signCertificateRequest(wallet, input.chainId, input.registryAddress, input.certificateRequest);
    },
    async signGatewayUpstreamAdmission(input) {
      return wallet.signingKey.sign(gatewayUpstreamAdmissionDigest(input.request)).serialized;
    }
  };
}

export function maybeAcurastJobSigner(std: AcurastRuntimeStd | undefined = (globalThis as any)._STD_): SwitchboardJobSigner | undefined {
  if (typeof std?.job?.getPublicKeys !== "function" || typeof std?.signers?.secp256k1?.sign !== "function") {
    return undefined;
  }

  return acurastJobSigner(std);
}

export function acurastJobSigner(std: AcurastRuntimeStd = requiredAcurastStd()): SwitchboardJobSigner {
  const getPublicKeys = std.job?.getPublicKeys;
  const sign = std.signers?.secp256k1?.sign;
  if (typeof getPublicKeys !== "function" || typeof sign !== "function") {
    throw new Error("Acurast _STD_.job.getPublicKeys and _STD_.signers.secp256k1.sign are required");
  }

  let addressPromise: Promise<string> | undefined;
  const getAddress = async () => {
    addressPromise ??= Promise.resolve(getPublicKeys.call(std.job)).then((publicKeys) =>
      addressFromSecp256k1PublicKey(secP256k1PublicKey(publicKeys))
    );
    return addressPromise;
  };

  return {
    getAddress,
    async signRegistration(input) {
      const digest = registrationDigest(input.chainId, input.registryAddress, input.registration);
      return signAcurastSecp256k1Digest(sign, digest, await getAddress(), std);
    },
    async signCertificateRequest(input) {
      const digest = certificateRequestDigest(input.chainId, input.registryAddress, input.certificateRequest);
      return signAcurastSecp256k1Digest(sign, digest, await getAddress(), std);
    },
    async signGatewayUpstreamAdmission(input) {
      const digest = gatewayUpstreamAdmissionDigest(input.request);
      return signAcurastSecp256k1Digest(sign, digest, await getAddress(), std);
    }
  };
}

export async function buildIngressRegistrationRequest(
  config: SwitchboardRegistrationConfig
): Promise<SwitchboardRegistrationRequest> {
  const jobSigner = config.jobSigner ?? localJobSigner(config.jobSignerPrivateKey);
  const registration = normalizeRegistration({
    sessionId: config.sessionId,
    jobId: config.jobId,
    jobSigner: await jobSigner.getAddress(),
    operatorId: config.operatorId,
    processorId: config.processorId,
    endpointHash: resolveEndpointHash(config),
    nonce: config.nonce ?? "1",
    deadline: config.deadline ?? Math.floor(Date.now() / 1000) + 600
  });
  const signature = await jobSigner.signRegistration({
    chainId: config.chainId,
    registryAddress: config.registryAddress,
    registration
  });

  return { registration, signature };
}

export async function registerIngressWithRelay(
  config: SwitchboardRegistrationConfig
): Promise<SwitchboardRegistrationResult> {
  const relayUrl = requireSecureSwitchboardUrl(config.relayUrl, "Switchboard relay URL", config);
  const request = await buildIngressRegistrationRequest(config);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), config.requestTimeoutMs ?? 10_000);
  const response = await fetch(new URL("/v1/ingress-registrations", relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    signal: abortController.signal,
    body: JSON.stringify(request)
  }).finally(() => clearTimeout(timeout));

  const relayResponse = await response.json();
  if (!response.ok) {
    throw new Error(`Relay registration failed: ${JSON.stringify(relayResponse)}`);
  }

  return {
    ...request,
    relayResponse
  };
}

export async function createSwitchboardCertificateSigningRequest(
  hostname: string,
  options: { keyAlgorithm?: SwitchboardCertificateKeyAlgorithm } = {}
): Promise<SwitchboardCertificateSigningRequest> {
  const normalizedHostname = hostname.trim().toLowerCase();
  const keyAlgorithm = normalizeSwitchboardCertificateKeyAlgorithm(options.keyAlgorithm, normalizedHostname);
  const privateKey =
    keyAlgorithm === "rsa-2048"
      ? await acme.crypto.createPrivateRsaKey(2048)
      : await acme.crypto.createPrivateEcdsaKey("P-256");
  const [, csr] = await acme.crypto.createCsr({
    commonName: normalizedHostname,
    altNames: [normalizedHostname]
  }, privateKey);
  return {
    privateKeyPem: privateKey.toString("utf8"),
    csrPem: csr.toString("utf8")
  };
}

export async function buildIngressCertificateRequest(
  config: SwitchboardCertificateConfig
): Promise<SwitchboardCertificateRelayRequest & { privateKeyPem?: string }> {
  const timeoutContext = createSwitchboardCertificateTimeoutContext(config.requestTimeoutMs ?? 120_000);
  try {
    return await buildIngressCertificateRequestWithContext(config, timeoutContext);
  } finally {
    clearSwitchboardCertificateTimeoutContext(timeoutContext);
  }
}

async function buildIngressCertificateRequestWithContext(
  config: SwitchboardCertificateConfig,
  timeoutContext: SwitchboardCertificateTimeoutContext
): Promise<SwitchboardCertificateRelayRequest & { privateKeyPem?: string }> {
  const jobSigner = config.jobSigner ?? localJobSigner(config.jobSignerPrivateKey);
  const hostname = config.hostname.trim().toLowerCase();
  const certificateKeyAlgorithm = normalizeSwitchboardCertificateKeyAlgorithm(config.certificateKeyAlgorithm, hostname);
  let csr: SwitchboardCertificateSigningRequest | { csrPem: string; privateKeyPem?: string };
  if (config.csrPem == null) {
    await config.onProgress?.({ stage: "csr_generation", hostname });
    csr = await runSwitchboardCertificateStage(timeoutContext, "csr_generation", hostname, () =>
      createSwitchboardCertificateSigningRequest(hostname, { keyAlgorithm: certificateKeyAlgorithm })
    );
  } else {
    csr = { csrPem: config.csrPem, privateKeyPem: config.privateKeyPem };
  }
  await config.onProgress?.({ stage: "request_signing", hostname });
  const jobSignerAddress = await runSwitchboardCertificateStage(timeoutContext, "request_signing", hostname, () =>
    jobSigner.getAddress()
  );
  const certificateRequest: CertificateRequestPayload = {
    sessionId: ethers.hexlify(config.sessionId),
    jobSigner: jobSignerAddress,
    hostname,
    csrHash: csrPemHash(csr.csrPem),
    nonce: config.nonce ?? Date.now(),
    deadline: config.deadline ?? Math.floor(Date.now() / 1000) + 600
  };
  const signature = await runSwitchboardCertificateStage(timeoutContext, "request_signing", hostname, () =>
    jobSigner.signCertificateRequest({
      chainId: config.chainId,
      registryAddress: config.registryAddress,
      certificateRequest
    })
  );

  return {
    certificateRequest,
    csrPem: csr.csrPem,
    signature,
    privateKeyPem: csr.privateKeyPem
  };
}

export async function requestCertificateWithRelay(
  config: SwitchboardCertificateConfig,
  fetchImpl: typeof fetch = fetch
): Promise<SwitchboardCertificateResult> {
  const relayUrl = requireSecureSwitchboardUrl(config.relayUrl, "Switchboard relay URL", config);
  const timeoutContext = createSwitchboardCertificateTimeoutContext(config.requestTimeoutMs ?? 120_000);
  let request: SwitchboardCertificateRelayRequest & { privateKeyPem?: string };
  let response: Response;
  try {
    request = await buildIngressCertificateRequestWithContext(config, timeoutContext);
    await config.onProgress?.({ stage: "relay_request", hostname: request.certificateRequest.hostname });
    try {
      response = await runSwitchboardCertificateStage(timeoutContext, "relay_request", request.certificateRequest.hostname, (signal) =>
        fetchImpl(new URL("/v1/certificates", relayUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          signal,
          body: JSON.stringify({
            certificateRequest: request.certificateRequest,
            csrPem: request.csrPem,
            signature: request.signature
          })
        })
      );
    } catch (error) {
      if (error instanceof SwitchboardCertificateError) {
        throw error;
      }
      const hostname = request.certificateRequest.hostname;
      throw new SwitchboardCertificateError(
        `Relay certificate request failed for ${hostname}: ${certificateFetchErrorMessage(error)}`,
        {
          stage: "relay_request",
          hostname,
          relayResponse: {
            error: "runtime_fetch_aborted",
            classification: "runtime_fetch_aborted"
          },
          details: {
            classification: "runtime_fetch_aborted",
            error: certificateFetchErrorDetails(error)
          },
          cause: error
        }
      );
    }
  } finally {
    clearSwitchboardCertificateTimeoutContext(timeoutContext);
  }

  const relayResponse = (await responseJsonOrText(response)) as SwitchboardCertificateResult["relayResponse"];
  await config.onProgress?.({ stage: "relay_response", hostname: request.certificateRequest.hostname });
  if (!response.ok) {
    const hostname = config.hostname.trim().toLowerCase();
    throw new SwitchboardCertificateError(
      `Relay certificate request failed for ${hostname}: ${response.status} ${JSON.stringify(relayResponse)}`,
      {
        stage: certificateFailureStageForRelayResponse(response.status, relayResponse),
        hostname,
        status: response.status,
        relayResponse
      }
    );
  }

  return {
    ...request,
    relayResponse
  };
}

interface SwitchboardCertificateTimeoutContext {
  controller: AbortController;
  signal: AbortSignal;
  timeout: ReturnType<typeof setTimeout>;
  timeoutMs: number;
  timedOut: boolean;
}

function createSwitchboardCertificateTimeoutContext(timeoutMs: number): SwitchboardCertificateTimeoutContext {
  const controller = new AbortController();
  const context: SwitchboardCertificateTimeoutContext = {
    controller,
    signal: controller.signal,
    timeout: undefined as unknown as ReturnType<typeof setTimeout>,
    timeoutMs,
    timedOut: false
  };
  context.timeout = setTimeout(() => {
    context.timedOut = true;
    controller.abort();
  }, timeoutMs);
  return context;
}

function clearSwitchboardCertificateTimeoutContext(context: SwitchboardCertificateTimeoutContext): void {
  clearTimeout(context.timeout);
}

async function runSwitchboardCertificateStage<T>(
  context: SwitchboardCertificateTimeoutContext,
  stage: SwitchboardCertificateFailureStage,
  hostname: string | undefined,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  try {
    return await new Promise<T>((resolve, reject) => {
      if (context.signal.aborted) {
        reject(switchboardCertificateTimeoutError(context, stage, hostname));
        return;
      }
      const onAbort = () => reject(switchboardCertificateTimeoutError(context, stage, hostname));
      context.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => work(context.signal))
        .then(resolve, reject)
        .finally(() => context.signal.removeEventListener("abort", onAbort));
    });
  } catch (error) {
    if (context.timedOut && isAbortError(error)) {
      throw switchboardCertificateTimeoutError(context, stage, hostname, error);
    }
    throw error;
  }
}

function switchboardCertificateTimeoutError(
  context: SwitchboardCertificateTimeoutContext,
  stage: SwitchboardCertificateFailureStage,
  hostname: string | undefined,
  cause?: unknown
): SwitchboardCertificateError {
  const suffix = hostname ? ` for ${hostname}` : "";
  return new SwitchboardCertificateError(
    `Switchboard certificate request timed out during ${stage}${suffix} after ${context.timeoutMs}ms`,
    {
      stage,
      hostname,
      relayResponse: {
        error: "certificate_request_timeout",
        stage,
        timeoutMs: context.timeoutMs
      },
      details: {
        timeoutMs: context.timeoutMs,
        timeoutStage: stage
      },
      cause
    }
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function normalizeSwitchboardCertificateKeyAlgorithm(
  value: unknown,
  hostname?: string
): SwitchboardCertificateKeyAlgorithm {
  if (value === undefined || value === null || value === "") {
    return "ecdsa-p256";
  }
  if (value === "ecdsa-p256" || value === "rsa-2048") {
    return value;
  }
  const certificateKeyAlgorithm = String(value);
  throw new SwitchboardCertificateError(
    `Invalid Switchboard certificate key algorithm ${JSON.stringify(certificateKeyAlgorithm)}; expected ecdsa-p256 or rsa-2048`,
    {
      stage: "certificate_config",
      hostname,
      details: {
        certificateKeyAlgorithm,
        validCertificateKeyAlgorithms: ["ecdsa-p256", "rsa-2048"]
      }
    }
  );
}

function certificateFailureStageForRelayResponse(
  status: number,
  relayResponse: SwitchboardCertificateResult["relayResponse"]
): SwitchboardCertificateFailureStage {
  const relayError = stringRecordField(relayResponse, "error");
  if (relayError === "certificate_hostname_lock_unavailable" || status === 423) {
    return "certificate_lock";
  }
  if (relayError === "certificate_hostname_not_authorized" || relayError === "certificate_hostname_byo_tls") {
    return "certificate_authorization";
  }
  if (relayError === "certificate_issuance_failed") {
    return "acme_issuance";
  }
  if (status === 400 && (relayError === "invalid_hostname" || relayError === "invalid_request")) {
    return "hostname_config";
  }
  return "relay_response";
}

function certificateFetchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function certificateFetchErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }
  return {
    message: String(error)
  };
}

async function responseJsonOrText(response: globalThis.Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { body: text };
  }
}

function stringRecordField(record: unknown, name: string): string | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const value = (record as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createEncryptedSwitchboardLogger(
  config: SwitchboardRemoteLoggerConfig
): (event: string, details?: Record<string, unknown>) => Promise<void> {
  if (!config.logUrl) {
    return async () => undefined;
  }
  if (!config.encryptionKey) {
    return async (event) => {
      config.onError?.(new Error("Encrypted Switchboard logging requires SWITCHBOARD_LOG_ENCRYPTION_KEY"), event);
    };
  }

  return async (event: string, details: Record<string, unknown> = {}) => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), config.timeoutMs ?? 5_000);
    try {
      const record: SwitchboardLogRecord = {
        ...config.baseRecord?.(),
        timestamp: new Date().toISOString(),
        event,
        context: config.context,
        details
      };
      const encrypted = encryptProofLogRecord(config.encryptionKey!, record);
      const logUrl = requireSecureSwitchboardUrl(config.logUrl!, "Switchboard log URL", config);
      const response = await fetch(logUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.writeToken ? { authorization: `Bearer ${config.writeToken}` } : {})
        },
        signal: abortController.signal,
        body: JSON.stringify({ encrypted })
      });
      if (!response.ok) {
        throw new Error(`Encrypted Switchboard log failed: ${response.status} ${await response.text()}`);
      }
    } catch (error) {
      config.onError?.(error, event);
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function readEncryptedSwitchboardLogs(input: {
  readUrl: string;
  readToken?: string;
  encryptionKey: string;
  timeoutMs?: number;
  allowInsecureHttp?: boolean;
}): Promise<Array<SwitchboardLogRecord & { sequence: number; receivedAt: string }>> {
  const readUrl = requireSecureSwitchboardUrl(input.readUrl, "Switchboard log read URL", input);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), input.timeoutMs ?? 10_000);
  try {
    const response = await fetch(readUrl, {
      headers: {
        accept: "application/json",
        ...(input.readToken ? { authorization: `Bearer ${input.readToken}` } : {})
      },
      signal: abortController.signal
    });
    const body = await response.json() as { events?: SwitchboardLogSinkEvent[] };
    if (!response.ok) {
      throw new Error(`Encrypted Switchboard log read failed: ${response.status} ${JSON.stringify(body)}`);
    }

    return (body.events ?? []).map((event) => ({
      ...decryptProofLogRecord<SwitchboardLogRecord>(input.encryptionKey, event.encrypted),
      sequence: event.sequence,
      receivedAt: event.receivedAt
    }));
  } finally {
    clearTimeout(timeout);
  }
}

function localJobSigner(privateKey: string | undefined): SwitchboardJobSigner {
  const acurastSigner = maybeAcurastJobSigner();
  if (acurastSigner) {
    return acurastSigner;
  }

  if (!privateKey) {
    throw new Error(
      "JOB_SIGNER_PRIVATE_KEY is required outside the Acurast runtime. In Acurast, _STD_.job.getPublicKeys and _STD_.signers.secp256k1.sign are used automatically."
    );
  }

  return privateKeyJobSigner(privateKey);
}

function requiredAcurastStd(): AcurastRuntimeStd {
  const std = (globalThis as any)._STD_;
  if (!std) {
    throw new Error("Acurast _STD_ runtime object is not available");
  }
  return std;
}

async function signAcurastSecp256k1Digest(
  sign: (payload: string) => string | Promise<string>,
  digest: string,
  expectedAddress: string,
  std: AcurastRuntimeStd
): Promise<string> {
  const rawSignature = await Promise.resolve(sign.call(std.signers?.secp256k1, digest));
  return normalizeAcurastSecp256k1Signature(rawSignature, digest, expectedAddress);
}

function secP256k1PublicKey(publicKeys: unknown): string {
  const parsed = typeof publicKeys === "string" ? parsePublicKeys(publicKeys) : publicKeys;
  const key = (parsed as { secp256k1?: unknown } | null | undefined)?.secp256k1;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Acurast job public keys did not include secp256k1");
  }
  return key;
}

function parsePublicKeys(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { secp256k1: value };
  }
}

function addressFromSecp256k1PublicKey(publicKey: string): string {
  return ethers.computeAddress(hex(publicKey));
}

export function normalizeAcurastSecp256k1Signature(
  rawSignature: string,
  digest: string,
  expectedAddress: string
): string {
  const parsed = parseAcurastSecp256k1Signature(rawSignature);
  const expected = ethers.getAddress(expectedAddress);
  const vCandidates = parsed.v == null ? [27, 28] : [normalizeV(parsed.v)];

  for (const v of vCandidates) {
    const normalized = normalizeSignatureS(parsed.r, parsed.s, v);
    if (normalized == null) {
      continue;
    }

    const signature = serializeSignature(normalized.r, normalized.s, normalized.v);
    try {
      if (ethers.getAddress(ethers.recoverAddress(digest, signature)) === expected) {
        return signature;
      }
    } catch {
      continue;
    }
  }

  throw new Error("Acurast secp256k1 signature could not be recovered to the job public key");
}

function parseAcurastSecp256k1Signature(rawSignature: string): { r: bigint; s: bigint; v?: number } {
  const bytes = ethers.getBytes(hex(rawSignature));
  if (bytes.length === 64 || bytes.length === 65) {
    return {
      r: bytesToBigInt(bytes.slice(0, 32)),
      s: bytesToBigInt(bytes.slice(32, 64)),
      v: bytes.length === 65 ? bytes[64] : undefined
    };
  }

  if (bytes[0] === 0x30) {
    return parseDerSignature(bytes);
  }

  throw new Error(`Unsupported Acurast secp256k1 signature length: ${bytes.length} bytes`);
}

function parseDerSignature(bytes: Uint8Array): { r: bigint; s: bigint } {
  let offset = 0;
  if (bytes[offset++] !== 0x30) {
    throw new Error("Invalid DER signature sequence");
  }
  const sequenceLength = derLength(bytes, offset);
  offset = sequenceLength.nextOffset;
  if (offset + sequenceLength.length !== bytes.length) {
    throw new Error("Invalid DER signature length");
  }
  const r = derInteger(bytes, offset);
  offset = r.nextOffset;
  const s = derInteger(bytes, offset);
  return { r: bytesToBigInt(trimIntegerBytes(r.value)), s: bytesToBigInt(trimIntegerBytes(s.value)) };
}

function derInteger(bytes: Uint8Array, offset: number): { value: Uint8Array; nextOffset: number } {
  if (bytes[offset++] !== 0x02) {
    throw new Error("Invalid DER signature integer");
  }
  const length = derLength(bytes, offset);
  const value = bytes.slice(length.nextOffset, length.nextOffset + length.length);
  return { value, nextOffset: length.nextOffset + length.length };
}

function derLength(bytes: Uint8Array, offset: number): { length: number; nextOffset: number } {
  const first = bytes[offset++];
  if (first < 0x80) {
    return { length: first, nextOffset: offset };
  }
  const lengthBytes = first & 0x7f;
  if (lengthBytes === 0 || lengthBytes > 2) {
    throw new Error("Unsupported DER signature length");
  }
  let length = 0;
  for (let index = 0; index < lengthBytes; index += 1) {
    length = (length << 8) + bytes[offset++];
  }
  return { length, nextOffset: offset };
}

function trimIntegerBytes(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start += 1;
  }
  const trimmed = bytes.slice(start);
  if (trimmed.length > 32) {
    throw new Error("Invalid DER secp256k1 integer length");
  }
  return trimmed;
}

const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const SECP256K1_HALF_N = SECP256K1_N / 2n;

function normalizeSignatureS(r: bigint, s: bigint, v: number): { r: bigint; s: bigint; v: number } | null {
  if (v !== 27 && v !== 28) {
    return null;
  }
  if (s > SECP256K1_HALF_N) {
    return { r, s: SECP256K1_N - s, v: v === 27 ? 28 : 27 };
  }
  return { r, s, v };
}

function normalizeV(v: number): number {
  return v < 27 ? v + 27 : v;
}

function serializeSignature(r: bigint, s: bigint, v: number): string {
  return `${ethers.toBeHex(r, 32)}${ethers.toBeHex(s, 32).slice(2)}${ethers.toBeHex(v, 1).slice(2)}`;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(ethers.hexlify(bytes));
}

function hex(value: string): string {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function resolveEndpointHash(config: SwitchboardRegistrationConfig): string {
  if (config.endpointHash) {
    return config.endpointHash;
  }
  if (config.endpointHostname) {
    return endpointHash(config.endpointHostname);
  }

  throw new Error("endpointHostname or endpointHash is required");
}
