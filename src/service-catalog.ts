import { z } from "zod";

import {
  signReportPayload,
  verifyReportSignature,
  type ReportSignature,
  type ReportSignatureScheme
} from "./report-signing.js";

export const SERVICE_CATALOG_DOMAIN = "switchboard.service-catalog.v1";

export const serviceRoleSchema = z.enum([
  "control-api",
  "control-mutator",
  "relay",
  "quote-signer",
  "manifest-builder",
  "gateway",
  "validator",
  "explorer",
  "operator-intake",
  "job-manager",
  "other"
]);

export const serviceStateSchema = z.enum(["candidate", "active", "degraded", "draining", "disabled"]);

const urlSchema = z.string().min(1);

const serviceCatalogMemberSchema = z.object({
  serviceId: z.string().min(1),
  role: serviceRoleSchema.optional(),
  state: serviceStateSchema.default("active"),
  apiBaseUrl: urlSchema.optional(),
  statusUrl: urlSchema.optional(),
  validationReportUrl: urlSchema.optional(),
  controlPlaneUrl: urlSchema.optional(),
  serviceSigner: z.string().min(1).optional(),
  acurastDeploymentId: z.string().min(1).optional(),
  acurastJobId: z.string().min(1).optional(),
  scriptHash: z.string().min(1).optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  weight: z.number().int().positive().optional(),
  effectiveAt: z.string().min(1).optional(),
  expiresAt: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const serviceCatalogSchema = z.object({
  version: z.literal(1),
  role: serviceRoleSchema,
  sequence: z.number().int().nonnegative(),
  issuedAt: z.string().min(1),
  effectiveAt: z.string().min(1).optional(),
  expiresAt: z.string().min(1).optional(),
  members: z.array(serviceCatalogMemberSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const signedServiceCatalogSchema = z.object({
  catalog: serviceCatalogSchema,
  signature: z.object({
    scheme: z.enum(["substrate-sr25519", "eip191-secp256k1"]),
    domain: z.string().min(1),
    signer: z.string().min(1),
    signature: z.string().min(1),
    signedAt: z.string().min(1),
    publicKey: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
    ss58Format: z.number().int().nonnegative().optional()
  })
});

export type ServiceRole = z.output<typeof serviceRoleSchema>;
export type ServiceState = z.output<typeof serviceStateSchema>;
export type ServiceCatalog = z.output<typeof serviceCatalogSchema>;
export type ServiceCatalogMember = z.output<typeof serviceCatalogMemberSchema>;
export type SignedServiceCatalog = z.output<typeof signedServiceCatalogSchema>;

// Input shape accepted by the mainnet catalog builder for each relay entry in
// PROOF_SERVICE_CATALOG_RELAYS_JSON / PROOF_NETWORK_MANIFEST_RELAYS_JSON. The
// older shape used a boolean `active` flag; the typed `state` field now drives
// catalog state directly so canary/draining members can be advertised without
// a bespoke ops script.
export const relayCatalogInputEntrySchema = z
  .object({
    relayId: z.string().min(1),
    apiBaseUrl: z.string().url(),
    validationReportUrl: z.string().url().optional(),
    controlPlaneUrl: z.string().url().optional(),
    state: serviceStateSchema.optional(),
    active: z.boolean().optional(),
    weight: z.number().int().positive().optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const relayCatalogInputArraySchema = z.array(relayCatalogInputEntrySchema);

export type RelayCatalogInputEntry = z.output<typeof relayCatalogInputEntrySchema>;

// Input shape for a control-api catalog entry. Mirrors the relay input schema
// so the same managed CLI build path can produce both catalogs from a typed
// JSON spec instead of the parallel ad-hoc env reads in the legacy script.
export const controlApiCatalogInputEntrySchema = z
  .object({
    serviceId: z.string().min(1),
    apiBaseUrl: z.string().url(),
    state: serviceStateSchema.optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    weight: z.number().int().positive().optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const controlApiCatalogInputArraySchema = z.array(controlApiCatalogInputEntrySchema);

export type ControlApiCatalogInputEntry = z.output<typeof controlApiCatalogInputEntrySchema>;

export interface ControlApiCatalogMemberDefaults {
  defaultCapabilities?: string[];
}

export function controlApiCatalogMemberFromInput(
  entry: ControlApiCatalogInputEntry,
  defaults: ControlApiCatalogMemberDefaults = {}
): ServiceCatalogMember {
  return {
    serviceId: entry.serviceId,
    role: "control-api",
    state: entry.state ?? "active",
    apiBaseUrl: entry.apiBaseUrl,
    weight: entry.weight,
    capabilities: entry.capabilities ?? defaults.defaultCapabilities,
    metadata: entry.metadata
  };
}

export interface RelayCatalogMemberDefaults {
  defaultCapabilities?: string[];
}

export function relayCatalogMemberFromInput(
  entry: RelayCatalogInputEntry,
  defaults: RelayCatalogMemberDefaults = {}
): ServiceCatalogMember {
  const state = resolveRelayCatalogInputState(entry);
  const validationReportUrl =
    entry.validationReportUrl ?? new URL("/v1/validation-reports", entry.apiBaseUrl).toString();
  return {
    serviceId: entry.relayId,
    role: "relay",
    state,
    apiBaseUrl: entry.apiBaseUrl,
    validationReportUrl,
    controlPlaneUrl: entry.controlPlaneUrl,
    weight: entry.weight,
    capabilities: entry.capabilities ?? defaults.defaultCapabilities,
    metadata: entry.metadata
  };
}

function resolveRelayCatalogInputState(entry: RelayCatalogInputEntry): ServiceState {
  if (entry.state) {
    if (entry.active === false && entry.state !== "disabled") {
      throw new Error(
        `Relay catalog entry ${entry.relayId} sets state=${entry.state} but active=false; remove the legacy active flag`
      );
    }
    return entry.state;
  }
  if (entry.active === false) return "disabled";
  return "active";
}

export interface SignServiceCatalogOptions {
  scheme?: ReportSignatureScheme;
  ss58Format?: number;
  signedAt?: string;
}

export interface VerifyServiceCatalogOptions {
  expectedSigner?: string;
  now?: Date;
  allowExpired?: boolean;
}

export interface ActiveServiceCatalogMemberOptions {
  now?: Date;
  includeDegraded?: boolean;
  includeDraining?: boolean;
}

export async function signServiceCatalog(
  catalog: ServiceCatalog,
  signingKey: string,
  options: SignServiceCatalogOptions = {}
): Promise<SignedServiceCatalog> {
  const normalized = normalizeServiceCatalog(catalog);
  return {
    catalog: normalized,
    signature: await signReportPayload(signingKey, SERVICE_CATALOG_DOMAIN, normalized, {
      scheme: options.scheme,
      ss58Format: options.ss58Format,
      signedAt: options.signedAt
    })
  };
}

export async function verifySignedServiceCatalog(
  input: unknown,
  options: VerifyServiceCatalogOptions = {}
): Promise<{ catalog: ServiceCatalog; signer: string; signature: ReportSignature }> {
  const signed = parseSignedServiceCatalog(input);
  if (signed.signature.domain !== SERVICE_CATALOG_DOMAIN) {
    throw new Error(`Unexpected service catalog signature domain ${signed.signature.domain}`);
  }
  if (!options.allowExpired && serviceCatalogExpired(signed.catalog, options.now)) {
    throw new Error("Service catalog is expired");
  }
  const signer = await verifyReportSignature(signed.catalog, signed.signature);
  if (options.expectedSigner && !sameSigner(signer, options.expectedSigner)) {
    throw new Error(`Service catalog signer ${signer} does not match expected signer ${options.expectedSigner}`);
  }
  return {
    catalog: signed.catalog,
    signer,
    signature: signed.signature
  };
}

export function parseServiceCatalog(input: unknown): ServiceCatalog {
  return normalizeServiceCatalog(serviceCatalogSchema.parse(input));
}

export function parseSignedServiceCatalog(input: unknown): SignedServiceCatalog {
  const signed = signedServiceCatalogSchema.parse(input);
  return {
    catalog: normalizeServiceCatalog(signed.catalog),
    signature: signed.signature
  };
}

export function normalizeServiceCatalog(catalog: ServiceCatalog): ServiceCatalog {
  return {
    ...catalog,
    members: catalog.members.map((member) => normalizeServiceCatalogMember(catalog.role, member))
  };
}

export function normalizeServiceCatalogMember(role: ServiceRole, member: ServiceCatalogMember): ServiceCatalogMember {
  return {
    ...member,
    role: member.role ?? role,
    state: member.state ?? "active",
    apiBaseUrl: member.apiBaseUrl ? normalizeBaseUrl(member.apiBaseUrl) : undefined,
    statusUrl: member.statusUrl ? normalizeUrl(member.statusUrl) : undefined,
    validationReportUrl: member.validationReportUrl ? normalizeUrl(member.validationReportUrl) : undefined,
    controlPlaneUrl: member.controlPlaneUrl ? normalizeUrl(member.controlPlaneUrl) : undefined
  };
}

export function serviceCatalogExpired(catalog: ServiceCatalog, now = new Date()): boolean {
  return Boolean(catalog.expiresAt && Date.parse(catalog.expiresAt) <= now.getTime());
}

export function activeServiceCatalogMembers(
  catalog: ServiceCatalog,
  options: ActiveServiceCatalogMemberOptions = {}
): ServiceCatalogMember[] {
  const now = options.now ?? new Date();
  return normalizeServiceCatalog(catalog).members.filter((member) => {
    if (member.state === "disabled" || member.state === "candidate") return false;
    if (member.state === "degraded" && !options.includeDegraded) return false;
    if (member.state === "draining" && !options.includeDraining) return false;
    if (member.effectiveAt && Date.parse(member.effectiveAt) > now.getTime()) return false;
    if (member.expiresAt && Date.parse(member.expiresAt) <= now.getTime()) return false;
    return true;
  });
}

export function serviceCatalogMembersByRole(
  catalogs: ServiceCatalog[],
  options: ActiveServiceCatalogMemberOptions = {}
): Partial<Record<ServiceRole, ServiceCatalogMember[]>> {
  const byRole: Partial<Record<ServiceRole, ServiceCatalogMember[]>> = {};
  for (const catalog of catalogs) {
    const role = catalog.role;
    byRole[role] = [...(byRole[role] ?? []), ...activeServiceCatalogMembers(catalog, options)];
  }
  return byRole;
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

export function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function sameSigner(left: string, right: string): boolean {
  if (/^0x[0-9a-fA-F]+$/.test(left) && /^0x[0-9a-fA-F]+$/.test(right)) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}
