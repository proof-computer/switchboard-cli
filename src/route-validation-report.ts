import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import tls from "node:tls";

import { signReportPayload, type ReportSignature, type ReportSignatureScheme } from "./report-signing.js";

export interface RouteValidationInput {
  sessionId: string;
  hostname: string;
  deploymentId?: string;
  operatorId?: string;
  gatewayId?: string;
  operatorSignals?: OperatorValidationSignals;
  validatorId?: string;
  validatorDeploymentId?: string;
  validatorDeviceAddress?: string;
  mode?: "route_open" | "reachability";
  port?: number;
  nonce?: string;
  timeoutMs?: number;
  signingKey?: string;
  signingScheme?: ReportSignatureScheme;
  signingSs58Format?: number;
  /** @deprecated Use signingKey with signingScheme instead. */
  signingPrivateKey?: string;
}

export interface RouteValidationReport {
  version: 1;
  kind: "switchboard.route-validation";
  reportId: string;
  mode: "route_open" | "reachability";
  checkedAt: string;
  checkedAtUnixSeconds: number;
  success: boolean;
  failureReason?: string;
  latencyMs: number;
  nonce: string;
  target: {
    sessionId: string;
    deploymentId?: string;
    hostname: string;
    endpoint: string;
    port: number;
    operatorId?: string;
    gatewayId?: string;
  };
  operatorSignals?: OperatorValidationSignals;
  validator: {
    validatorId: string;
    deploymentId?: string;
    deviceAddress?: string;
  };
  dns: {
    ok: boolean;
    addresses: string[];
    error?: string;
  };
  tls: {
    ok: boolean;
    elapsedMs: number;
    remoteAddress?: string;
    authorized?: boolean;
    authorizationError?: string;
    certificate?: {
      subject?: string;
      subjectAltName?: string;
      subjectAltNames?: string[];
      issuer?: string;
      validFrom?: string;
      validTo?: string;
      fingerprint256?: string;
      rawSha256?: string;
    };
    error?: string;
  };
  http: {
    health: HttpProbeResult;
    challenge: HttpProbeResult & {
      nonceMatched: boolean;
      sessionMatched: boolean;
      response?: Record<string, unknown>;
    };
    status: HttpProbeResult & {
      registration?: string;
      certificate?: string;
      challengeCount?: number;
    };
    page: HttpProbeResult & {
      matched: boolean;
    };
  };
  checks: {
    dns: boolean;
    tls: boolean;
    health: boolean;
    challengeNonce: boolean;
    challengeSession: boolean;
    page: boolean;
  };
  signature?: ReportSignature;
}

export interface OperatorValidationSignals {
  sampledAt: string;
  source?: string;
  capability?: {
    available: boolean;
    reportId?: string;
    signer?: string;
    reportedAt?: string;
    expiresAt?: string;
    operatorId?: string;
    gatewayId?: string;
    managerIds?: string[];
    routeCapacity?: number;
    activeRouteCount?: number;
    processorMatched?: boolean;
    publicAddressMatched?: boolean;
    error?: string;
  };
  gateway?: {
    reachable: boolean;
    operatorId?: string;
    gatewayId?: string;
    configVersion?: string;
    routeInstalled?: boolean;
    routeActive?: boolean;
    routeExpiresAt?: string;
    matchedHostnames?: string[];
    activeRouteCount?: number;
    storedRouteCount?: number;
    processorDiscoveryFresh?: boolean;
    reportedProcessorCount?: number;
    error?: string;
  };
  proxy?: Record<string, unknown>;
}

export interface HttpProbeResult {
  ok: boolean;
  url: string;
  status?: number;
  elapsedMs: number;
  textPreview?: string;
  error?: string;
  json?: unknown;
}

const ROUTE_VALIDATION_REPORT_DOMAIN = "switchboard.route-validation.v1";

export async function validateSwitchboardRoute(input: RouteValidationInput): Promise<RouteValidationReport> {
  const startedAt = Date.now();
  const checkedAt = new Date();
  const port = input.port ?? 443;
  const timeoutMs = input.timeoutMs ?? 10_000;
  const nonce = input.nonce ?? `validation-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const endpoint = `https://${input.hostname}/`;
  const [dns, tlsProbe, health, challenge, status, page] = await Promise.all([
    probeDns(input.hostname),
    probeTls(input.hostname, port, timeoutMs),
    fetchJsonProbe(`https://${input.hostname}/health`, timeoutMs),
    fetchJsonProbe(`https://${input.hostname}/.well-known/proofcomputer/challenge?nonce=${encodeURIComponent(nonce)}`, timeoutMs),
    fetchJsonProbe(`https://${input.hostname}/status`, timeoutMs),
    fetchTextProbe(endpoint, timeoutMs)
  ]);
  const challengeJson = objectJson(challenge.json);
  const statusJson = objectJson(status.json);
  const nonceMatched = challengeJson?.nonce === nonce;
  const sessionMatched = String(challengeJson?.sessionId ?? "").toLowerCase() === input.sessionId.toLowerCase();
  const pageText = page.textPreview ?? "";
  const pageMatched = page.ok && (pageText.includes("Switchboard demo") || pageText.includes("Switchboard"));
  const checks = {
    dns: dns.ok,
    tls: tlsProbe.ok,
    health: health.ok,
    challengeNonce: challenge.ok && nonceMatched,
    challengeSession: challenge.ok && sessionMatched,
    page: pageMatched
  };
  const mode = input.mode ?? "route_open";
  const success =
    mode === "reachability"
      ? checks.dns && checks.tls
      : checks.dns && checks.tls && checks.health && checks.challengeNonce && checks.challengeSession;
  const unsignedReport: Omit<RouteValidationReport, "signature"> = {
    version: 1,
    kind: "switchboard.route-validation",
    reportId: `route-validation-${Math.floor(checkedAt.getTime() / 1000)}-${randomBytes(4).toString("hex")}`,
    mode,
    checkedAt: checkedAt.toISOString(),
    checkedAtUnixSeconds: Math.floor(checkedAt.getTime() / 1000),
    success,
    failureReason: success ? undefined : validationFailureReason(checks, mode),
    latencyMs: Date.now() - startedAt,
    nonce,
    target: {
      sessionId: input.sessionId,
      deploymentId: input.deploymentId,
      hostname: input.hostname,
      endpoint,
      port,
      operatorId: input.operatorId,
      gatewayId: input.gatewayId
    },
    operatorSignals: input.operatorSignals,
    validator: {
      validatorId: input.validatorId ?? "switchboard-cli",
      deploymentId: input.validatorDeploymentId,
      deviceAddress: input.validatorDeviceAddress
    },
    dns,
    tls: tlsProbe,
    http: {
      health,
      challenge: {
        ...challenge,
        nonceMatched,
        sessionMatched,
        response: challengeJson
      },
      status: {
        ...status,
        registration: stringNestedField(statusJson, "registration", "state"),
        certificate: stringNestedField(statusJson, "certificate", "state"),
        challengeCount: numberNestedField(statusJson, "challenges", "count")
      },
      page: {
        ...page,
        matched: pageMatched
      }
    },
    checks
  };

  const signingKey = input.signingKey ?? input.signingPrivateKey;
  return signingKey
    ? {
        ...unsignedReport,
        signature: await signReportPayload(signingKey, ROUTE_VALIDATION_REPORT_DOMAIN, unsignedReport, {
          scheme: input.signingScheme,
          ss58Format: input.signingSs58Format
        })
      }
    : unsignedReport;
}

async function probeDns(hostname: string): Promise<RouteValidationReport["dns"]> {
  try {
    const addresses = (await lookup(hostname, { all: true })).map((item) => item.address);
    return {
      ok: addresses.length > 0,
      addresses
    };
  } catch (error) {
    return {
      ok: false,
      addresses: [],
      error: safeErrorMessage(error)
    };
  }
}

async function probeTls(hostname: string, port: number, timeoutMs: number): Promise<RouteValidationReport["tls"]> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: hostname,
      port,
      servername: hostname,
      rejectUnauthorized: false
    });
    let done = false;
    const finish = (result: Omit<RouteValidationReport["tls"], "elapsedMs">) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve({
        ...result,
        elapsedMs: Date.now() - startedAt
      });
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: "timeout" }));
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      finish({
        ok: true,
        remoteAddress: socket.remoteAddress,
        authorized: socket.authorized,
        authorizationError:
          typeof socket.authorizationError === "string" ? socket.authorizationError : socket.authorizationError?.message,
        certificate: certificate && Object.keys(certificate).length > 0 ? certificateSummary(certificate) : undefined
      });
    });
    socket.once("error", (error) => finish({ ok: false, error: safeErrorMessage(error) }));
  });
}

async function fetchJsonProbe(url: string, timeoutMs: number): Promise<HttpProbeResult> {
  const startedAt = Date.now();
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: abortController.signal,
      headers: {
        accept: "application/json,text/html;q=0.9,*/*;q=0.8"
      }
    });
    const text = await response.text();
    const probe = {
      ok: response.ok,
      url,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      textPreview: text.slice(0, 4000)
    };
    if (!probe.ok) {
      return probe;
    }
    try {
      return {
        ...probe,
        json: JSON.parse(text)
      };
    } catch (error) {
      return {
        ...probe,
        ok: false,
        error: `invalid JSON: ${safeErrorMessage(error)}`
      };
    }
  } catch (error) {
    return {
      ok: false,
      url,
      elapsedMs: Date.now() - startedAt,
      error: safeErrorMessage(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextProbe(url: string, timeoutMs: number): Promise<HttpProbeResult> {
  const startedAt = Date.now();
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: abortController.signal,
      headers: {
        accept: "application/json,text/html;q=0.9,*/*;q=0.8"
      }
    });
    const text = await response.text();
    return {
      ok: response.ok,
      url,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      textPreview: text.slice(0, 4000)
    };
  } catch (error) {
    return {
      ok: false,
      url,
      elapsedMs: Date.now() - startedAt,
      error: safeErrorMessage(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function certificateSummary(certificate: tls.PeerCertificate): RouteValidationReport["tls"]["certificate"] {
  return {
    subject: distinguishedName(certificate.subject),
    subjectAltName: certificate.subjectaltname,
    subjectAltNames: parseSubjectAltNames(certificate.subjectaltname),
    issuer: distinguishedName(certificate.issuer),
    validFrom: certificate.valid_from,
    validTo: certificate.valid_to,
    fingerprint256: certificate.fingerprint256,
    rawSha256: certificate.raw ? createHash("sha256").update(certificate.raw).digest("hex") : undefined
  };
}

function parseSubjectAltNames(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const names = value
    .split(",")
    .map((item) => item.trim())
    .map((item) => item.replace(/^DNS:/i, "").trim().toLowerCase())
    .filter((item) => item.length > 0);
  return names.length > 0 ? names : undefined;
}

function distinguishedName(value: tls.PeerCertificate["subject"]): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return Object.entries(value)
    .map(([key, item]) => `${key}=${String(item)}`)
    .join(",");
}

function validationFailureReason(checks: RouteValidationReport["checks"], mode: RouteValidationReport["mode"]): string {
  if (!checks.dns) {
    return "dns_failed";
  }
  if (!checks.tls) {
    return "tls_failed";
  }
  if (mode === "reachability") {
    return "unknown";
  }
  if (!checks.health) {
    return "health_failed";
  }
  if (!checks.challengeNonce) {
    return "challenge_nonce_mismatch";
  }
  if (!checks.challengeSession) {
    return "challenge_session_mismatch";
  }
  return "unknown";
}

function objectJson(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringNestedField(record: Record<string, unknown> | undefined, parent: string, field: string): string | undefined {
  const parentValue = objectJson(record?.[parent]);
  const value = parentValue?.[field];
  return typeof value === "string" ? value : undefined;
}

function numberNestedField(record: Record<string, unknown> | undefined, parent: string, field: string): number | undefined {
  const parentValue = objectJson(record?.[parent]);
  const value = parentValue?.[field];
  return typeof value === "number" ? value : undefined;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
