import { createHash } from "node:crypto";

import { normalizeDnsHostname } from "./cloudflare-dns.js";

export const CANONICAL_CONSUMER_INGRESS_DOMAIN_POOL = [
  "ingress.digital",
  "ingress.directory",
  "ingress.guru",
  "ingress.team",
  "ingress.works"
] as const;

export const CANONICAL_CONSUMER_INGRESS_DOMAIN_POOL_CSV = CANONICAL_CONSUMER_INGRESS_DOMAIN_POOL.join(",");

export function parseDomainPool(value: string | undefined, fallback: readonly string[] = []): string[] {
  const configured = splitCsv(value ?? "");
  const domains = configured.length > 0 ? configured : fallback;
  return [...new Set(domains.map(normalizeDnsHostname))];
}

export function selectDomainFromPool(domains: readonly string[], seed: string): string {
  if (domains.length === 0) {
    throw new Error("Domain pool must include at least one domain");
  }
  if (domains.length === 1) {
    return domains[0];
  }

  const digest = createHash("sha256").update(seed).digest();
  return domains[digest.readUInt32BE(0) % domains.length];
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
