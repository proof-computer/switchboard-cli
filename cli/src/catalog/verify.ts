import {
  discoverServices,
  type ResolvedServiceDiscovery
} from "../../../src/service-discovery.js";
import type { CatalogIo } from "./io.js";
import { defaultCatalogIo } from "./io.js";

export interface RunCatalogVerifyOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: CatalogIo;
  fetchImpl?: typeof fetch;
}

export interface CatalogVerifyResult {
  manifestUrl: string;
  manifestSigner: string;
  catalogs: Array<{
    key: string;
    url: string;
    signer: string;
    role: string;
    sequence: number;
    issuedAt: string;
    expiresAt?: string;
    activeMemberCount: number;
  }>;
  requiredCatalogs: string[];
  ok: true;
}

export async function runCatalogVerify(options: RunCatalogVerifyOptions): Promise<CatalogVerifyResult> {
  const io = options.io ?? defaultCatalogIo();
  const env = options.env ?? process.env;

  const manifestUrl =
    stringFlag(options.flags, "manifest-url") ?? env.PROOF_NETWORK_MANIFEST_URL;
  if (!manifestUrl) {
    throw new Error(
      "switchboard catalog verify requires --manifest-url <url> or PROOF_NETWORK_MANIFEST_URL set"
    );
  }
  const expectedSigner =
    stringFlag(options.flags, "manifest-signer") ?? env.PROOF_NETWORK_MANIFEST_SIGNER;
  if (!expectedSigner && !boolFlag(options.flags, "allow-unpinned-signer")) {
    throw new Error(
      "Pin --manifest-signer <signer> (or PROOF_NETWORK_MANIFEST_SIGNER), or pass --allow-unpinned-signer to opt out"
    );
  }
  const requiredCatalogs = csvFlag(options.flags, "required") ?? csvFromEnv(env, "PROOF_REQUIRED_CATALOGS") ?? [];
  const allowExpired = boolFlag(options.flags, "allow-expired");

  const discovery = await discoverServices({
    manifestUrlCandidates: [manifestUrl],
    expectedManifestSigner: expectedSigner,
    allowUnpinnedManifestSigner: !expectedSigner,
    requiredCatalogs,
    allowExpiredManifest: allowExpired,
    allowExpiredCatalogs: allowExpired,
    fetchImpl: options.fetchImpl
  });

  const result = summarizeDiscovery(discovery, requiredCatalogs);

  if (boolFlag(options.flags, "json")) {
    io.log(JSON.stringify(result, null, 2));
  } else {
    printHumanReadable(result, io);
  }

  return result;
}

function summarizeDiscovery(
  discovery: ResolvedServiceDiscovery,
  requiredCatalogs: string[]
): CatalogVerifyResult {
  return {
    manifestUrl: discovery.manifestUrl,
    manifestSigner: discovery.manifestSigner,
    catalogs: Object.entries(discovery.catalogs).map(([key, resolved]) => ({
      key,
      url: resolved.ref.url,
      signer: resolved.signer,
      role: resolved.catalog.role,
      sequence: resolved.catalog.sequence,
      issuedAt: resolved.catalog.issuedAt,
      expiresAt: resolved.catalog.expiresAt,
      activeMemberCount: (discovery.membersByRole[resolved.catalog.role] ?? []).length
    })),
    requiredCatalogs,
    ok: true
  };
}

function printHumanReadable(result: CatalogVerifyResult, io: CatalogIo): void {
  io.log(`manifest        : ${result.manifestUrl}`);
  io.log(`manifest signer : ${result.manifestSigner}`);
  if (result.requiredCatalogs.length > 0) {
    io.log(`required        : ${result.requiredCatalogs.join(", ")}`);
  }
  if (result.catalogs.length === 0) {
    io.log(`catalogs        : (none referenced by manifest)`);
    return;
  }
  io.log(`catalogs (${result.catalogs.length}):`);
  for (const catalog of result.catalogs) {
    io.log(`  - ${catalog.key} (${catalog.role})`);
    io.log(`      url       : ${catalog.url}`);
    io.log(`      signer    : ${catalog.signer}`);
    io.log(`      sequence  : ${catalog.sequence}`);
    io.log(`      issuedAt  : ${catalog.issuedAt}`);
    if (catalog.expiresAt) {
      io.log(`      expiresAt : ${catalog.expiresAt}`);
    }
    io.log(`      members   : ${catalog.activeMemberCount} active`);
  }
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function csvFlag(flags: Map<string, string | boolean>, name: string): string[] | undefined {
  const value = stringFlag(flags, name);
  if (!value) return undefined;
  const list = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return list.length > 0 ? list : undefined;
}

function csvFromEnv(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const value = env[name];
  if (!value) return undefined;
  const list = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return list.length > 0 ? list : undefined;
}
