import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  controlApiCatalogInputArraySchema,
  controlApiCatalogMemberFromInput,
  relayCatalogInputArraySchema,
  relayCatalogMemberFromInput,
  signServiceCatalog,
  type ControlApiCatalogInputEntry,
  type RelayCatalogInputEntry,
  type ServiceCatalog,
  type SignedServiceCatalog
} from "../../../src/service-catalog.js";
import type { ReportSignatureScheme } from "../../../src/report-signing.js";
import type { CatalogIo } from "./io.js";
import { defaultCatalogIo } from "./io.js";

export const CATALOG_BUILD_SPEC_VERSION = 1;

export const catalogBuildSpecSchema = z
  .object({
    version: z.literal(CATALOG_BUILD_SPEC_VERSION).default(CATALOG_BUILD_SPEC_VERSION),
    ttlSeconds: z.number().int().positive().optional(),
    sequence: z.number().int().nonnegative().optional(),
    issuedAt: z.string().min(1).optional(),
    controlApiDefaultCapabilities: z.array(z.string().min(1)).optional(),
    relayDefaultCapabilities: z.array(z.string().min(1)).optional(),
    controlApi: controlApiCatalogInputArraySchema.default([]),
    relays: relayCatalogInputArraySchema.default([])
  })
  .strict();

export type CatalogBuildSpec = z.output<typeof catalogBuildSpecSchema>;

const DEFAULT_TTL_SECONDS = 2 * 24 * 60 * 60;
const DEFAULT_CONTROL_API_CAPABILITIES = [
  "quotes",
  "manifest",
  "validation-work",
  "certificates",
  "customer-hostnames"
];
const DEFAULT_RELAY_CAPABILITIES = ["validation-reports", "settlement", "peer-backfill"];
const DEFAULT_CONTROL_API_SERVICE_ID = "control-bootstrap";

export interface CatalogBuildInput {
  controlApi: ControlApiCatalogInputEntry[];
  relays: RelayCatalogInputEntry[];
  signingKey: string;
  scheme: ReportSignatureScheme;
  ss58Format: number;
  ttlSeconds: number;
  sequence: number;
  issuedAt: string;
  controlApiDefaultCapabilities: string[];
  relayDefaultCapabilities: string[];
}

export interface SignedCatalogsBundle {
  controlApi: SignedServiceCatalog;
  relays: SignedServiceCatalog;
}

export interface CatalogBuildResult {
  bundle: SignedCatalogsBundle;
  json: string;
  issuedAt: string;
  sequence: number;
  signer: string;
}

export async function buildSignedCatalogs(input: CatalogBuildInput): Promise<CatalogBuildResult> {
  if (input.controlApi.length === 0) {
    throw new Error("Catalog build requires at least one control-api entry");
  }
  if (input.relays.length === 0) {
    throw new Error("Catalog build requires at least one relay entry");
  }

  const expiresAt = new Date(Date.parse(input.issuedAt) + input.ttlSeconds * 1000).toISOString();
  const signOptions = { scheme: input.scheme, ss58Format: input.ss58Format };

  const controlApiCatalog: ServiceCatalog = {
    version: 1,
    role: "control-api",
    sequence: input.sequence,
    issuedAt: input.issuedAt,
    expiresAt,
    members: input.controlApi.map((entry) =>
      controlApiCatalogMemberFromInput(entry, { defaultCapabilities: input.controlApiDefaultCapabilities })
    )
  };
  const relayCatalog: ServiceCatalog = {
    version: 1,
    role: "relay",
    sequence: input.sequence,
    issuedAt: input.issuedAt,
    expiresAt,
    members: input.relays.map((entry) =>
      relayCatalogMemberFromInput(entry, { defaultCapabilities: input.relayDefaultCapabilities })
    )
  };

  const [controlApi, relays] = await Promise.all([
    signServiceCatalog(controlApiCatalog, input.signingKey, signOptions),
    signServiceCatalog(relayCatalog, input.signingKey, signOptions)
  ]);

  const bundle: SignedCatalogsBundle = { controlApi, relays };
  return {
    bundle,
    json: `${JSON.stringify(bundle, null, 2)}\n`,
    issuedAt: input.issuedAt,
    sequence: input.sequence,
    signer: relays.signature.signer
  };
}

export interface CatalogBuildSourceLoader {
  flags: Map<string, string | boolean>;
  env?: NodeJS.ProcessEnv;
}

export interface RunCatalogBuildOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: CatalogIo;
  /** Used by tests; replaces the default file write. */
  writer?: CatalogBundleWriter;
  /** Used by tests; replaces the spec file reader. */
  readSpecFile?: (filePath: string) => Promise<string>;
}

export type CatalogBundleWriter = (input: { filePath: string; content: string }) => Promise<void>;

export async function runCatalogBuild(options: RunCatalogBuildOptions): Promise<CatalogBuildResult> {
  const env = options.env ?? process.env;
  const io = options.io ?? defaultCatalogIo();

  const specFile = stringFlag(options.flags, "spec") ?? stringFlag(options.flags, "spec-file") ?? env.PROOF_SERVICE_CATALOG_SPEC_FILE;
  const spec = specFile
    ? await loadCatalogBuildSpec(specFile, options.readSpecFile)
    : catalogBuildSpecFromEnv(env);

  const signingKey =
    stringFlag(options.flags, "signing-key") ??
    nonEmptyEnv(env, "PROOF_SERVICE_CATALOG_SIGNING_KEY") ??
    nonEmptyEnv(env, "PROOF_MAINNET_MANIFEST_SIGNING_KEY");
  if (!signingKey) {
    throw new Error(
      "Catalog build requires a signing key. Set PROOF_SERVICE_CATALOG_SIGNING_KEY (preferred) or PROOF_MAINNET_MANIFEST_SIGNING_KEY."
    );
  }

  const scheme = (stringFlag(options.flags, "signing-scheme") ??
    env.PROOF_SERVICE_CATALOG_SIGNING_SCHEME ??
    env.PROOF_NETWORK_MANIFEST_SIGNING_SCHEME ??
    "substrate-sr25519") as ReportSignatureScheme;
  const ss58Format = numberFromEnv(
    env,
    "PROOF_SERVICE_CATALOG_SS58_FORMAT",
    numberFromEnv(env, "PROOF_NETWORK_MANIFEST_SS58_FORMAT", 42)
  );
  const ttlSeconds =
    spec.ttlSeconds ?? numberFromEnv(env, "PROOF_SERVICE_CATALOG_TTL_SECONDS", DEFAULT_TTL_SECONDS);
  const issuedAt = spec.issuedAt ?? new Date().toISOString();
  const sequence =
    spec.sequence ?? numberFromEnv(env, "PROOF_SERVICE_CATALOG_SEQUENCE", Math.floor(Date.parse(issuedAt) / 1000));

  const result = await buildSignedCatalogs({
    controlApi: spec.controlApi,
    relays: spec.relays,
    signingKey,
    scheme,
    ss58Format,
    ttlSeconds,
    sequence,
    issuedAt,
    controlApiDefaultCapabilities: spec.controlApiDefaultCapabilities ?? DEFAULT_CONTROL_API_CAPABILITIES,
    relayDefaultCapabilities: spec.relayDefaultCapabilities ?? DEFAULT_RELAY_CAPABILITIES
  });

  const outputFile =
    stringFlag(options.flags, "output") ??
    stringFlag(options.flags, "output-file") ??
    env.PROOF_SERVICE_CATALOGS_OUTPUT_FILE;
  const stdout = boolFlag(options.flags, "stdout") || (!outputFile && !options.writer);

  if (outputFile) {
    const writer = options.writer ?? defaultBundleWriter;
    await writer({ filePath: outputFile, content: result.json });
    io.log(
      `Wrote signed service catalogs to ${outputFile}: issuedAt=${result.issuedAt} sequence=${result.sequence} signer=${result.signer}`
    );
  } else if (stdout) {
    process.stdout.write(result.json);
  }

  return result;
}

async function loadCatalogBuildSpec(
  filePath: string,
  reader?: (filePath: string) => Promise<string>
): Promise<CatalogBuildSpec> {
  const resolved = path.resolve(filePath);
  const raw = reader ? await reader(resolved) : await readFile(resolved, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return catalogBuildSpecSchema.parse(parsed);
}

function catalogBuildSpecFromEnv(env: NodeJS.ProcessEnv): CatalogBuildSpec {
  const controlApiBaseUrl = env.PROOF_CONTROL_PLANE_URL;
  if (!controlApiBaseUrl) {
    throw new Error(
      "Catalog build needs either --spec <file> or PROOF_CONTROL_PLANE_URL set in env. None were provided."
    );
  }

  const controlApi: ControlApiCatalogInputEntry[] = [
    {
      serviceId: env.PROOF_CONTROL_API_SERVICE_ID ?? DEFAULT_CONTROL_API_SERVICE_ID,
      apiBaseUrl: controlApiBaseUrl,
      state: "active",
      capabilities: csvFromEnv(env, "PROOF_CONTROL_API_CAPABILITIES")
    }
  ];

  const rawRelays = jsonFromEnv(env, "PROOF_SERVICE_CATALOG_RELAYS_JSON") ?? jsonFromEnv(env, "PROOF_NETWORK_MANIFEST_RELAYS_JSON");
  if (rawRelays === undefined) {
    throw new Error(
      "Catalog build needs PROOF_SERVICE_CATALOG_RELAYS_JSON or PROOF_NETWORK_MANIFEST_RELAYS_JSON set with at least one relay."
    );
  }
  const relays = relayCatalogInputArraySchema.parse(rawRelays);
  if (relays.length === 0) {
    throw new Error("PROOF_SERVICE_CATALOG_RELAYS_JSON must contain at least one relay entry");
  }

  return catalogBuildSpecSchema.parse({
    controlApi,
    relays,
    relayDefaultCapabilities: csvFromEnv(env, "PROOF_RELAY_SERVICE_CAPABILITIES")
  });
}

const defaultBundleWriter: CatalogBundleWriter = async ({ filePath, content }) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpFile, content, "utf8");
  await rename(tmpFile, filePath);
};

function csvFromEnv(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const value = env[name];
  if (!value) return undefined;
  const list = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return list.length > 0 ? list : undefined;
}

function jsonFromEnv(env: NodeJS.ProcessEnv, name: string): unknown {
  const value = env[name];
  if (!value) return undefined;
  return JSON.parse(value);
}

function numberFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function nonEmptyEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value && value.length > 0 ? value : undefined;
}
