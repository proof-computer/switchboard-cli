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
  | "certificate_lock"
  | "certificate_request"
  | "certificate_authorization"
  | "acme_issuance"
  | "relay_response";

export interface SwitchboardCertificateErrorOptions {
  stage: SwitchboardCertificateFailureStage;
  hostname?: string;
  status?: number;
  relayResponse?: unknown;
  cause?: unknown;
}

export class SwitchboardCertificateError extends Error {
  readonly stage: SwitchboardCertificateFailureStage;
  readonly hostname: string | undefined;
  readonly status: number | undefined;
  readonly relayResponse: unknown;

  constructor(message: string, options: SwitchboardCertificateErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SwitchboardCertificateError";
    this.stage = options.stage;
    this.hostname = options.hostname;
    this.status = options.status;
    this.relayResponse = options.relayResponse;
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
  const request = await buildIngressRegistrationRequest(config);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), config.requestTimeoutMs ?? 10_000);
  const response = await fetch(new URL("/v1/ingress-registrations", config.relayUrl), {
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
  hostname: string
): Promise<SwitchboardCertificateSigningRequest> {
  const normalizedHostname = hostname.trim().toLowerCase();
  const [privateKey, csr] = await acme.crypto.createCsr({
    commonName: normalizedHostname,
    altNames: [normalizedHostname]
  });
  return {
    privateKeyPem: privateKey.toString("utf8"),
    csrPem: csr.toString("utf8")
  };
}

export async function buildIngressCertificateRequest(
  config: SwitchboardCertificateConfig
): Promise<SwitchboardCertificateRelayRequest & { privateKeyPem?: string }> {
  const jobSigner = config.jobSigner ?? localJobSigner(config.jobSignerPrivateKey);
  const csr =
    config.csrPem == null
      ? await createSwitchboardCertificateSigningRequest(config.hostname)
      : { csrPem: config.csrPem, privateKeyPem: config.privateKeyPem };
  const certificateRequest: CertificateRequestPayload = {
    sessionId: ethers.hexlify(config.sessionId),
    jobSigner: await jobSigner.getAddress(),
    hostname: config.hostname.trim().toLowerCase(),
    csrHash: csrPemHash(csr.csrPem),
    nonce: config.nonce ?? Date.now(),
    deadline: config.deadline ?? Math.floor(Date.now() / 1000) + 600
  };
  const signature = await jobSigner.signCertificateRequest({
    chainId: config.chainId,
    registryAddress: config.registryAddress,
    certificateRequest
  });

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
  const request = await buildIngressCertificateRequest(config);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), config.requestTimeoutMs ?? 120_000);
  const response = await fetchImpl(new URL("/v1/certificates", config.relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    signal: abortController.signal,
    body: JSON.stringify({
      certificateRequest: request.certificateRequest,
      csrPem: request.csrPem,
      signature: request.signature
    })
  }).finally(() => clearTimeout(timeout));

  const relayResponse = (await responseJsonOrText(response)) as SwitchboardCertificateResult["relayResponse"];
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
      const response = await fetch(config.logUrl!, {
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
}): Promise<Array<SwitchboardLogRecord & { sequence: number; receivedAt: string }>> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), input.timeoutMs ?? 10_000);
  try {
    const response = await fetch(input.readUrl, {
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
