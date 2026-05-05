import { readFile } from "node:fs/promises";

import {
  parseSignedServiceCatalog,
  serviceCatalogExpired,
  verifySignedServiceCatalog,
  type SignedServiceCatalog
} from "../../../src/service-catalog.js";
import type { CatalogIo } from "./io.js";
import { defaultCatalogIo } from "./io.js";

export interface RunCatalogInspectOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: CatalogIo;
  fetchImpl?: typeof fetch;
}

export interface InspectedCatalog {
  source: string;
  signed: SignedServiceCatalog;
  signer: string;
  expired: boolean;
}

export async function runCatalogInspect(options: RunCatalogInspectOptions): Promise<InspectedCatalog[]> {
  const io = options.io ?? defaultCatalogIo();
  const fetchImpl = options.fetchImpl ?? fetch;

  const filePath = stringFlag(options.flags, "file");
  const url = stringFlag(options.flags, "url");
  const expectedSigner = stringFlag(options.flags, "signer") ?? options.env?.PROOF_NETWORK_MANIFEST_SIGNER;
  const allowExpired = boolFlag(options.flags, "allow-expired");
  const json = boolFlag(options.flags, "json");

  if (!filePath && !url) {
    throw new Error("switchboard catalog inspect requires --file <path> or --url <url>");
  }
  if (filePath && url) {
    throw new Error("switchboard catalog inspect accepts --file or --url, not both");
  }

  const inspected = filePath
    ? await inspectFile(filePath, expectedSigner, allowExpired)
    : await inspectAllRolesFromUrl(url!, expectedSigner, allowExpired, fetchImpl);

  if (json) {
    io.log(JSON.stringify(inspected, null, 2));
  } else {
    for (const entry of inspected) {
      printHumanReadable(entry, io);
    }
  }
  return inspected;
}

async function inspectFile(
  filePath: string,
  expectedSigner: string | undefined,
  allowExpired: boolean
): Promise<InspectedCatalog[]> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const entries: Array<{ source: string; signed: unknown }> = [];

  if (looksLikeSignedCatalog(parsed)) {
    entries.push({ source: filePath, signed: parsed });
  } else if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (looksLikeSignedCatalog(value)) {
        entries.push({ source: `${filePath}#${key}`, signed: value });
      }
    }
  }

  if (entries.length === 0) {
    throw new Error(`No signed catalogs found in ${filePath}`);
  }

  return Promise.all(entries.map(({ source, signed }) => verifyOne(source, signed, expectedSigner, allowExpired)));
}

async function inspectAllRolesFromUrl(
  url: string,
  expectedSigner: string | undefined,
  allowExpired: boolean,
  fetchImpl: typeof fetch
): Promise<InspectedCatalog[]> {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}: ${body.slice(0, 500)}`);
  }
  const parsed = JSON.parse(body) as unknown;
  if (looksLikeSignedCatalog(parsed)) {
    return [await verifyOne(url, parsed, expectedSigner, allowExpired)];
  }
  if (parsed && typeof parsed === "object") {
    const keyed = Object.entries(parsed as Record<string, unknown>).filter(([, value]) => looksLikeSignedCatalog(value));
    if (keyed.length === 0) {
      throw new Error(`No signed catalogs found at ${url}`);
    }
    return Promise.all(keyed.map(([key, value]) => verifyOne(`${url}#${key}`, value, expectedSigner, allowExpired)));
  }
  throw new Error(`No signed catalogs found at ${url}`);
}

async function verifyOne(
  source: string,
  signed: unknown,
  expectedSigner: string | undefined,
  allowExpired: boolean
): Promise<InspectedCatalog> {
  const verified = await verifySignedServiceCatalog(signed, {
    expectedSigner,
    allowExpired
  });
  return {
    source,
    signed: parseSignedServiceCatalog(signed),
    signer: verified.signer,
    expired: serviceCatalogExpired(verified.catalog)
  };
}

function looksLikeSignedCatalog(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Boolean(record.catalog && record.signature);
}

function printHumanReadable(entry: InspectedCatalog, io: CatalogIo): void {
  const catalog = entry.signed.catalog;
  io.log(`${entry.source}`);
  io.log(`  role        : ${catalog.role}`);
  io.log(`  sequence    : ${catalog.sequence}`);
  io.log(`  issuedAt    : ${catalog.issuedAt}`);
  io.log(`  expiresAt   : ${catalog.expiresAt ?? "(none)"}${entry.expired ? "  EXPIRED" : ""}`);
  io.log(`  signer      : ${entry.signer}`);
  io.log(`  members (${catalog.members.length}):`);
  for (const member of catalog.members) {
    const url = member.apiBaseUrl ?? member.controlPlaneUrl ?? member.statusUrl ?? "(no url)";
    io.log(`    - ${member.serviceId}  state=${member.state}  ${url}`);
  }
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}
