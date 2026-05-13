import { createHash } from "node:crypto";

import {
  verifySignedNetworkManifest,
  type NetworkManifest,
  type NetworkManifestCatalogRef
} from "./network-manifest.js";
import {
  activeServiceCatalogMembers,
  normalizeBaseUrl,
  verifySignedServiceCatalog,
  type ServiceCatalog,
  type ServiceCatalogMember,
  type ServiceRole,
  type ServiceState
} from "./service-catalog.js";

export interface ServiceDiscoveryConfig {
  manifestUrlCandidates: string[];
  expectedManifestSigner?: string;
  allowUnpinnedManifestSigner?: boolean;
  expectedChainId?: string | number | bigint;
  requiredCatalogs?: Array<ServiceRole | string>;
  fetchImpl?: typeof fetch;
  now?: Date;
  allowExpiredManifest?: boolean;
  allowExpiredCatalogs?: boolean;
}

export interface ResolvedServiceCatalog {
  key: string;
  ref: NetworkManifestCatalogRef;
  catalog: ServiceCatalog;
  signer: string;
}

export interface ResolvedServiceDiscovery {
  manifestUrl: string;
  manifest: NetworkManifest;
  manifestSigner: string;
  catalogs: Record<string, ResolvedServiceCatalog>;
  membersByRole: Partial<Record<ServiceRole, ServiceCatalogMember[]>>;
}

export interface RelayDiscoveryMember {
  relayId: string;
  apiBaseUrl?: string;
  validationReportUrl?: string;
  controlPlaneUrl?: string;
  weight?: number;
  state?: ServiceState;
  active?: boolean;
  metadata?: Record<string, unknown>;
}

export async function discoverServices(config: ServiceDiscoveryConfig): Promise<ResolvedServiceDiscovery> {
  if (!config.expectedManifestSigner && !config.allowUnpinnedManifestSigner) {
    throw new Error("expectedManifestSigner is required for service discovery");
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const manifest = await fetchVerifiedManifest(config, fetchImpl);
  const now = config.now ?? new Date();
  const catalogs: Record<string, ResolvedServiceCatalog> = {};
  const membersByRole: Partial<Record<ServiceRole, ServiceCatalogMember[]>> = {};

  for (const [key, ref] of Object.entries(manifest.manifest.catalogs ?? {})) {
    try {
      const catalog = await fetchVerifiedCatalog(ref, { ...config, now }, fetchImpl);
      catalogs[key] = {
        key,
        ref,
        catalog: catalog.catalog,
        signer: catalog.signer
      };
      const activeMembers = activeServiceCatalogMembers(catalog.catalog, {
        now,
        includeDegraded: true
      });
      membersByRole[catalog.catalog.role] = [...(membersByRole[catalog.catalog.role] ?? []), ...activeMembers];
    } catch (error) {
      if (ref.required || config.requiredCatalogs?.includes(key) || config.requiredCatalogs?.includes(catalogKeyToRole(key))) {
        throw error;
      }
    }
  }

  for (const required of config.requiredCatalogs ?? []) {
    if (!catalogs[required] && !membersByRole[catalogKeyToRole(required)]) {
      throw new Error(`Required service catalog ${required} was not resolved`);
    }
  }

  return {
    manifestUrl: manifest.url,
    manifest: manifest.manifest,
    manifestSigner: manifest.signer,
    catalogs,
    membersByRole
  };
}

export function resolveControlApiEndpoints(discovery: ResolvedServiceDiscovery): string[] {
  const catalogUrls = (discovery.membersByRole["control-api"] ?? [])
    .map((member) => member.apiBaseUrl ?? member.controlPlaneUrl)
    .filter((url): url is string => Boolean(url))
    .map((url) => normalizeBaseUrl(url));
  if (catalogUrls.length > 0) {
    return uniqueStrings(catalogUrls);
  }

  const legacyUrls = [
    discovery.manifest.controlPlane?.apiBaseUrl,
    ...(discovery.manifest.relays ?? [])
      .filter((relay) => (relay.active ?? true) !== false)
      .map((relay) => relay.controlPlaneUrl ?? relay.apiBaseUrl)
  ].filter((url): url is string => Boolean(url));
  return uniqueStrings(legacyUrls.map((url) => normalizeBaseUrl(url)));
}

export function resolveRelayMembers(discovery: ResolvedServiceDiscovery): RelayDiscoveryMember[] {
  const catalogMembers = discovery.membersByRole.relay ?? [];
  if (catalogMembers.length > 0) {
    return catalogMembers.map(serviceCatalogMemberToRelay);
  }
  return (discovery.manifest.relays ?? [])
    .filter((relay) => (relay.active ?? true) !== false)
    .map((relay) => ({
      relayId: relay.relayId,
      apiBaseUrl: relay.apiBaseUrl ? normalizeBaseUrl(relay.apiBaseUrl) : undefined,
      validationReportUrl: relay.validationReportUrl,
      controlPlaneUrl: relay.controlPlaneUrl,
      weight: relay.weight,
      state: relay.active === false ? "disabled" : "active",
      active: relay.active,
      metadata: relay.metadata
    }));
}

export function resolveRelayInventoryMembers(discovery: ResolvedServiceDiscovery): RelayDiscoveryMember[] {
  const relayCatalog = Object.values(discovery.catalogs).find((catalog) => catalog.catalog.role === "relay");
  if (relayCatalog) {
    return relayCatalog.catalog.members.map(serviceCatalogMemberToRelay);
  }
  return (discovery.manifest.relays ?? []).map((relay) => ({
    relayId: relay.relayId,
    apiBaseUrl: relay.apiBaseUrl ? normalizeBaseUrl(relay.apiBaseUrl) : undefined,
    validationReportUrl: relay.validationReportUrl,
    controlPlaneUrl: relay.controlPlaneUrl,
    weight: relay.weight,
    state: relay.active === false ? "disabled" : "active",
    active: relay.active,
    metadata: relay.metadata
  }));
}

export function resolveValidationReportSubmitUrls(discovery: ResolvedServiceDiscovery): string[] {
  return uniqueStrings(
    resolveRelayMembers(discovery)
      .map((relay) => relay.validationReportUrl ?? (relay.apiBaseUrl ? new URL("/v1/validation-reports", relay.apiBaseUrl).toString() : undefined))
      .filter((url): url is string => Boolean(url))
  );
}

export function resolveSettlementRelayMembers(discovery: ResolvedServiceDiscovery): RelayDiscoveryMember[] {
  return resolveRelayMembers(discovery).filter((relay) => serviceMemberSettlementCapable(relay));
}

export function serviceCatalogMemberToRelay(member: ServiceCatalogMember): RelayDiscoveryMember {
  return {
    relayId: member.serviceId,
    apiBaseUrl: member.apiBaseUrl,
    validationReportUrl: member.validationReportUrl ?? (member.apiBaseUrl ? new URL("/v1/validation-reports", member.apiBaseUrl).toString() : undefined),
    controlPlaneUrl: member.controlPlaneUrl,
    weight: member.weight,
    state: member.state,
    active: member.state === "active" || member.state === "degraded",
    metadata: relayMemberMetadata(member)
  };
}

export function catalogKeyToRole(key: string): ServiceRole {
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();
  if (normalized === "control-apis") return "control-api";
  if (normalized === "controlapi") return "control-api";
  if (normalized === "relays") return "relay";
  if (normalized === "gateways") return "gateway";
  if (normalized === "validators") return "validator";
  if (normalized === "explorers") return "explorer";
  if (normalized === "operator-intakes") return "operator-intake";
  if (normalized === "job-managers") return "job-manager";
  return normalized as ServiceRole;
}

async function fetchVerifiedManifest(
  config: ServiceDiscoveryConfig,
  fetchImpl: typeof fetch
): Promise<{ url: string; manifest: NetworkManifest; signer: string }> {
  const failures = [];
  for (const url of config.manifestUrlCandidates.filter((candidate) => candidate.length > 0)) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          accept: "application/json"
        }
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`${response.status} ${body.slice(0, 500)}`);
      }
      const verified = await verifySignedNetworkManifest(JSON.parse(body), {
        expectedSigner: config.expectedManifestSigner,
        now: config.now,
        allowExpired: config.allowExpiredManifest
      });
      const expectedChainId = config.expectedChainId?.toString();
      if (expectedChainId && verified.manifest.chain.chainId !== expectedChainId) {
        throw new Error(`network manifest chain ${verified.manifest.chain.chainId} does not match expected ${expectedChainId}`);
      }
      return {
        url,
        manifest: verified.manifest,
        signer: verified.signer
      };
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Service discovery manifest fetch failed: ${failures.join("; ")}`);
}

async function fetchVerifiedCatalog(
  ref: NetworkManifestCatalogRef,
  config: ServiceDiscoveryConfig & { now: Date },
  fetchImpl: typeof fetch
): Promise<{ catalog: ServiceCatalog; signer: string }> {
  const response = await fetchImpl(ref.url, {
    headers: {
      accept: "application/json"
    }
  });
  const bodyBytes = Buffer.from(await response.arrayBuffer());
  const body = bodyBytes.toString("utf8");
  if (!response.ok) {
    throw new Error(`service catalog fetch failed for ${ref.url}: ${response.status} ${body.slice(0, 500)}`);
  }
  if (!ref.signer && !ref.digest) {
    throw new Error(`service catalog ${ref.url} must declare signer or digest`);
  }
  if (ref.digest) {
    const actualDigest = `0x${createHash("sha256").update(bodyBytes).digest("hex")}`;
    if (actualDigest.toLowerCase() !== ref.digest.toLowerCase()) {
      throw new Error(`service catalog ${ref.url} digest mismatch`);
    }
  }
  const verified = await verifySignedServiceCatalog(JSON.parse(body), {
    expectedSigner: ref.signer,
    now: config.now,
    allowExpired: config.allowExpiredCatalogs
  });
  if (ref.maxStaleSeconds !== undefined && !config.allowExpiredCatalogs) {
    const issuedAtMs = Date.parse(verified.catalog.issuedAt);
    if (!Number.isFinite(issuedAtMs)) {
      throw new Error(`service catalog ${ref.url} has invalid issuedAt`);
    }
    if (config.now.getTime() - issuedAtMs > ref.maxStaleSeconds * 1000) {
      throw new Error(`service catalog ${ref.url} is older than maxStaleSeconds=${ref.maxStaleSeconds}`);
    }
  }
  return verified;
}

function serviceMemberSettlementCapable(relay: RelayDiscoveryMember): boolean {
  const capabilities = Array.isArray(relay.metadata?.capabilities) ? relay.metadata.capabilities : undefined;
  if (!capabilities) {
    return true;
  }
  return capabilities.includes("settlement") || capabilities.includes("fulfillment");
}

function relayMemberMetadata(member: ServiceCatalogMember): Record<string, unknown> | undefined {
  if (!member.metadata && !member.capabilities) {
    return undefined;
  }
  return {
    ...(member.metadata ?? {}),
    ...(member.capabilities ? { capabilities: member.capabilities } : {})
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function relayMemberAddressForLeadership(member: RelayDiscoveryMember): { relayId: string; active?: boolean; weight?: number } {
  return {
    relayId: member.relayId,
    active: member.active,
    weight: member.weight
  };
}
