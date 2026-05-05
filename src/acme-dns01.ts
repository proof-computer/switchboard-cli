import { Resolver, resolveCname, resolveTxt } from "node:dns/promises";

import * as acme from "acme-client";

import {
  createCloudflareTxtRecord,
  deleteCloudflareDnsRecord,
  normalizeDnsHostname,
  normalizeDnsRecordName,
  type CloudflareDnsRecord
} from "./cloudflare-dns.js";

interface AcmeAuthorization {
  url?: string;
  identifier?: {
    value?: string;
  };
}

interface AcmeChallenge {
  url?: string;
  type?: string;
}

export interface AcmeDns01CloudflareConfig {
  apiToken: string;
  zoneId?: string;
  zoneName?: string;
  zoneNames?: string[];
  ttl?: number;
  apiBaseUrl?: string;
}

export interface IssueAcmeCertificateForCsrInput {
  hostname: string;
  csrPem: string;
  email: string;
  termsOfServiceAgreed: boolean;
  directoryUrl?: string;
  accountKeyPem?: string;
  accountUrl?: string;
  externalAccountBinding?: {
    kid: string;
    hmacKey: string;
  };
  cloudflare: AcmeDns01CloudflareConfig;
  dnsResolvers?: string[];
  dnsWaitTimeoutMs?: number;
  dnsPollIntervalMs?: number;
  skipClientChallengeVerification?: boolean;
  dns01Challenge?: (challenge: AcmeDns01ChallengeRequest) => Promise<AcmeDns01ChallengeAction | undefined>;
  logger?: (message: string) => void;
}

export interface AcmeDns01ChallengeRequest {
  hostname: string;
  challengeName: string;
  value: string;
}

export type AcmeDns01ChallengeAction =
  | {
      mode: "cloudflare";
      recordName?: string;
      waitForName?: string;
      comment?: string;
    }
  | {
      mode: "manual";
      waitForName?: string;
    };

export interface IssueAcmeCertificateForCsrResult {
  hostname: string;
  certificatePem: string;
  issuedAt: string;
  issuer?: string;
  notBefore?: string;
  notAfter?: string;
  directoryUrl: string;
}

export async function issueAcmeCertificateForCsr(
  input: IssueAcmeCertificateForCsrInput
): Promise<IssueAcmeCertificateForCsrResult> {
  const hostname = normalizeDnsHostname(input.hostname);
  assertCsrCoversOnlyHostname(input.csrPem, hostname);

  const directoryUrl = input.directoryUrl ?? acme.directory.letsencrypt.staging;
  const accountKey = input.accountKeyPem ?? (await acme.crypto.createPrivateKey()).toString("utf8");
  const client = new acme.Client({
    directoryUrl,
    accountKey,
    accountUrl: input.accountUrl,
    externalAccountBinding: input.externalAccountBinding
  });
  const challengeRecords = new Map<string, CloudflareDnsRecord>();

  const certificatePem = await client.auto({
    csr: input.csrPem,
    email: input.email,
    termsOfServiceAgreed: input.termsOfServiceAgreed,
    challengePriority: ["dns-01"],
    skipChallengeVerification: input.skipClientChallengeVerification ?? true,
    challengeCreateFn: async (authz: AcmeAuthorization, challenge: AcmeChallenge, keyAuthorization: string) => {
      if (challenge.type !== "dns-01") {
        throw new Error(`Unsupported ACME challenge type: ${challenge.type ?? "unknown"}`);
      }

      const challengeName = dns01ChallengeHostname(authz);
      const action =
        (await input.dns01Challenge?.({
          hostname,
          challengeName,
          value: keyAuthorization
        })) ?? { mode: "cloudflare" as const };
      const waitForName = action.waitForName ?? challengeName;

      if (action.mode === "manual") {
        input.logger?.(`[acme] waiting for manual TXT ${waitForName}`);
        await waitForDnsTxtValue({
          hostname: waitForName,
          expectedValue: keyAuthorization,
          resolvers: input.dnsResolvers ?? ["1.1.1.1"],
          timeoutMs: input.dnsWaitTimeoutMs ?? 180_000,
          pollIntervalMs: input.dnsPollIntervalMs ?? 5_000,
          logger: input.logger
        });
        return;
      }

      const recordName = action.recordName ?? challengeName;
      input.logger?.(`[acme] creating TXT ${recordName}`);
      const record = await createCloudflareTxtRecord({
        apiToken: input.cloudflare.apiToken,
        apiBaseUrl: input.cloudflare.apiBaseUrl,
        zoneId: input.cloudflare.zoneId,
        zoneName: input.cloudflare.zoneName,
        zoneNames: input.cloudflare.zoneNames,
        hostname: recordName,
        content: keyAuthorization,
        ttl: input.cloudflare.ttl ?? 60,
        comment: action.comment ?? `switchboard acme dns-01 ${hostname}`
      });
      challengeRecords.set(challengeKey(authz, challenge), record);
      await waitForDnsTxtValue({
        hostname: waitForName,
        expectedValue: keyAuthorization,
        resolvers: input.dnsResolvers ?? ["1.1.1.1"],
        timeoutMs: input.dnsWaitTimeoutMs ?? 180_000,
        pollIntervalMs: input.dnsPollIntervalMs ?? 5_000,
        logger: input.logger
      });
    },
    challengeRemoveFn: async (authz: AcmeAuthorization, challenge: AcmeChallenge) => {
      const record = challengeRecords.get(challengeKey(authz, challenge));
      if (!record) {
        return;
      }
      input.logger?.(`[acme] deleting TXT ${record.name}`);
      await deleteCloudflareDnsRecord({
        apiToken: input.cloudflare.apiToken,
        apiBaseUrl: input.cloudflare.apiBaseUrl,
        zoneId: record.zoneId,
        recordId: record.id
      });
      challengeRecords.delete(challengeKey(authz, challenge));
    }
  });

  const info = acme.crypto.readCertificateInfo(certificatePem);
  return {
    hostname,
    certificatePem,
    issuedAt: new Date().toISOString(),
    issuer: info.issuer.commonName,
    notBefore: info.notBefore?.toISOString(),
    notAfter: info.notAfter?.toISOString(),
    directoryUrl
  };
}

export function assertCsrCoversHostname(csrPem: string, hostname: string): void {
  const normalized = normalizeDnsHostname(hostname);
  const candidates = csrHostnames(csrPem);
  if (!candidates.includes(normalized)) {
    throw new Error(`CSR does not cover hostname ${normalized}`);
  }
}

export function assertCsrCoversOnlyHostname(csrPem: string, hostname: string): void {
  const normalized = normalizeDnsHostname(hostname);
  const candidates = csrHostnames(csrPem);
  if (candidates.length !== 1 || candidates[0] !== normalized) {
    throw new Error(`CSR must cover only hostname ${normalized}; got ${candidates.join(", ") || "none"}`);
  }
}

export function csrHostnames(csrPem: string): string[] {
  const domains = acme.crypto.readCsrDomains(csrPem);
  const candidates = [domains.commonName, ...domains.altNames]
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeDnsHostname(value));
  return [...new Set(candidates)];
}

export function dns01ChallengeHostname(authz: AcmeAuthorization): string {
  const value = authz.identifier?.value;
  if (!value) {
    throw new Error("ACME authorization did not include an identifier value");
  }
  const domain = normalizeDnsHostname(value.replace(/^\*\./, ""));
  return `_acme-challenge.${domain}`;
}

export async function waitForDnsTxtValue(input: {
  hostname: string;
  expectedValue: string;
  resolvers: string[];
  timeoutMs: number;
  pollIntervalMs: number;
  logger?: (message: string) => void;
}): Promise<Record<string, string[]>> {
  const hostname = normalizeDnsRecordName(input.hostname);
  const startedAt = Date.now();
  let lastResults: Record<string, string[]> = {};

  while (Date.now() - startedAt <= input.timeoutMs) {
    const results: Record<string, string[]> = {};
    for (const resolverName of input.resolvers) {
      try {
        results[resolverName] = await resolveTxtValues(hostname, resolverName);
      } catch {
        results[resolverName] = [];
      }
    }
    lastResults = results;
    const allResolved = input.resolvers.every((resolverName) => results[resolverName]?.includes(input.expectedValue));
    if (allResolved) {
      return results;
    }

    input.logger?.(`[acme] waiting for TXT ${hostname}`);
    await sleep(input.pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for DNS TXT ${hostname} after ${input.timeoutMs}ms; last=${JSON.stringify(lastResults)}`
  );
}

async function resolveTxtValues(hostname: string, resolverName: string): Promise<string[]> {
  const records = resolverName === "system" ? await resolveTxtFollowingCname(hostname) : await resolveTxtWithServer(hostname, resolverName);
  return records.map((chunks) => chunks.join(""));
}

async function resolveTxtWithServer(hostname: string, resolverName: string): Promise<string[][]> {
  const resolver = new Resolver();
  resolver.setServers([resolverName]);
  try {
    return await resolver.resolveTxt(hostname);
  } catch (error) {
    const cnames = await resolver.resolveCname(hostname).catch(() => []);
    if (cnames.length === 0) {
      throw error;
    }
    return resolver.resolveTxt(normalizeDnsRecordName(cnames[0]));
  }
}

async function resolveTxtFollowingCname(hostname: string): Promise<string[][]> {
  try {
    return await resolveTxt(hostname);
  } catch (error) {
    const cnames = await resolveCname(hostname).catch(() => []);
    if (cnames.length === 0) {
      throw error;
    }
    return resolveTxt(normalizeDnsRecordName(cnames[0]));
  }
}

function challengeKey(authz: AcmeAuthorization, challenge: AcmeChallenge): string {
  return `${authz.url ?? authz.identifier?.value ?? "unknown"}:${challenge.url ?? challenge.type ?? "unknown"}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
