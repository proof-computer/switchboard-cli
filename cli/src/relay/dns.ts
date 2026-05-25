import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  candidateCloudflareZoneNames,
  deleteCloudflareDnsRecord,
  inferCloudflareZoneName,
  normalizeDnsHostname,
  upsertCloudflareCnameRecord,
  type CloudflareDnsRecord
} from "../../../src/cloudflare-dns.js";
import { validateCnameTarget as defaultValidateCnameTarget, type CnameValidationResult } from "../../../src/customer-hostname.js";
import { parseRelayDeploymentSpec, type RelayDeploymentSpec } from "../../../src/relay-deployment-spec.js";

export interface RelayDnsIo {
  log: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

const DEFAULT_IO: RelayDnsIo = {
  log: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line)
};

interface ResolvedRelayDns {
  hostname: string;
  cnameTarget: string;
  ttl: number;
  comment?: string;
  apiToken: string;
  zoneId?: string;
  zoneName?: string;
  zoneNames?: string[];
}

interface ResolveOptions {
  spec: RelayDeploymentSpec;
  env: NodeJS.ProcessEnv;
  /** When true, the API token is not required (e.g. plan/verify against public DNS only). */
  tokenOptional?: boolean;
}

function resolveRelayDns(options: ResolveOptions): ResolvedRelayDns {
  const { spec, env, tokenOptional } = options;
  if (!spec.dns) {
    throw new Error(
      `relay ${spec.relayId} has no dns block in its spec; nothing to manage. Add a dns.cnameTarget to relays/${spec.relayId}.json.`
    );
  }
  const hostname = normalizeDnsHostname(new URL(spec.apiBaseUrl).hostname);
  const cnameTarget = normalizeDnsHostname(spec.dns.cnameTarget);
  const apiToken = env.CLOUDFLARE_API_TOKEN ?? "";
  if (!tokenOptional && apiToken.length === 0) {
    throw new Error("relay dns: CLOUDFLARE_API_TOKEN is required for write operations");
  }
  return {
    hostname,
    cnameTarget,
    ttl: spec.dns.ttl,
    comment: spec.dns.comment,
    apiToken,
    zoneId: env.CLOUDFLARE_ZONE_ID,
    zoneName: env.CLOUDFLARE_ZONE_NAME,
    zoneNames: csvEnv(env.CLOUDFLARE_ZONE_NAMES)
  };
}

export interface ApplyRelayDnsResult {
  hostname: string;
  cnameTarget: string;
  record: CloudflareDnsRecord;
}

export async function applyRelayDns(spec: RelayDeploymentSpec, env: NodeJS.ProcessEnv): Promise<ApplyRelayDnsResult> {
  const resolved = resolveRelayDns({ spec, env });
  const record = await upsertCloudflareCnameRecord({
    apiToken: resolved.apiToken,
    hostname: resolved.hostname,
    content: resolved.cnameTarget,
    ttl: resolved.ttl,
    comment: resolved.comment ?? `switchboard relay dns apply ${spec.relayId}`,
    ...(resolved.zoneId ? { zoneId: resolved.zoneId } : {}),
    ...(resolved.zoneName ? { zoneName: resolved.zoneName } : {}),
    ...(resolved.zoneNames && resolved.zoneNames.length > 0 ? { zoneNames: resolved.zoneNames } : {})
  });
  return { hostname: resolved.hostname, cnameTarget: resolved.cnameTarget, record };
}

export async function removeRelayDns(spec: RelayDeploymentSpec, env: NodeJS.ProcessEnv): Promise<{
  hostname: string;
  removedRecordId?: string;
}> {
  const resolved = resolveRelayDns({ spec, env });
  // The list step inside upsertCloudflareCnameRecord already proves the
  // record exists; for delete we need a recordId, so do a list ourselves.
  const listResp = await fetchCloudflareList({
    apiToken: resolved.apiToken,
    hostname: resolved.hostname,
    type: "CNAME",
    zoneId: resolved.zoneId,
    zoneName: resolved.zoneName,
    zoneNames: resolved.zoneNames
  });
  if (listResp.length === 0) {
    return { hostname: resolved.hostname };
  }
  const target = listResp[0];
  await deleteCloudflareDnsRecord({
    apiToken: resolved.apiToken,
    zoneId: target.zone_id,
    recordId: target.id
  });
  return { hostname: resolved.hostname, removedRecordId: target.id };
}

/**
 * Default resolvers for relay DNS validation. Excludes the laptop's
 * system resolver because local recursors (Tailscale, NetworkManager,
 * etc.) can hold a stale negative cache long after a fresh CNAME has
 * propagated to public DNS, producing spurious drift on the very first
 * verify after `apply`.
 */
const DEFAULT_VERIFY_RESOLVERS = ["1.1.1.1", "8.8.8.8"] as const;

export type RelayDnsValidateCnameTarget = (input: {
  customerHostname: string;
  expectedTarget: string;
  resolvers?: string[];
  maxDepth?: number;
}) => Promise<CnameValidationResult>;

export async function verifyRelayDns(
  spec: RelayDeploymentSpec,
  env: NodeJS.ProcessEnv,
  options: { resolvers?: string[]; validateCnameTarget?: RelayDnsValidateCnameTarget } = {}
): Promise<CnameValidationResult> {
  const resolved = resolveRelayDns({ spec, env, tokenOptional: true });
  const validateCnameTarget = options.validateCnameTarget ?? defaultValidateCnameTarget;
  return validateCnameTarget({
    customerHostname: resolved.hostname,
    expectedTarget: resolved.cnameTarget,
    resolvers: options.resolvers ?? [...DEFAULT_VERIFY_RESOLVERS]
  });
}

export interface RelayDnsSubcommandArgs {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: RelayDnsIo;
  cwd?: string;
  validateCnameTarget?: RelayDnsValidateCnameTarget;
}

/**
 * `switchboard relay dns {plan|apply|verify|remove} <relay-id>`.
 *
 * `plan` and `verify` rely only on public DNS resolution and do not need
 * a Cloudflare API token. `apply` and `remove` mutate Cloudflare and
 * require `CLOUDFLARE_API_TOKEN`.
 */
export async function runRelayDnsSubcommand(args: RelayDnsSubcommandArgs): Promise<void> {
  const io = args.io ?? DEFAULT_IO;
  const env = args.env ?? process.env;
  const cwd = args.cwd ?? process.cwd();
  const positionals = args.positionals ?? [];
  const verb = positionals[2];
  const relayId = positionals[3];
  if (!verb || !["plan", "apply", "verify", "remove"].includes(verb)) {
    throw new Error("Usage: switchboard relay dns {plan|apply|verify|remove} <relay-id>");
  }
  if (!relayId || !/^[a-z0-9-]+$/.test(relayId)) {
    throw new Error(`relay dns ${verb} <relay-id>: relay-id must be lowercase letters, digits, or '-'`);
  }
  const specFlag = stringFlag(args.flags, "spec") ?? stringFlag(args.flags, "spec-file");
  const specPath = specFlag ?? path.join(cwd, "relays", `${relayId}.json`);
  const raw = await readFile(specPath, "utf8").catch(() => {
    throw new Error(`Spec ${specPath} not found. Run \`switchboard relay scaffold ${relayId}\` first.`);
  });
  const spec = parseRelayDeploymentSpec(JSON.parse(raw));
  if (spec.relayId !== relayId) {
    throw new Error(`Spec at ${specPath} declares relayId=${spec.relayId}, but command was invoked for ${relayId}`);
  }

  const resolversFlag = stringFlag(args.flags, "resolvers");
  const resolvers = resolversFlag
    ? resolversFlag
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : undefined;

  if (verb === "plan") {
    io.log(`relay dns plan ${relayId}`);
    if (!spec.dns) {
      io.log("  hostname     : (no dns block in spec — nothing to manage)");
      return;
    }
    const validation = await verifyRelayDns(spec, env, { resolvers, validateCnameTarget: args.validateCnameTarget });
    io.log(`  hostname     : ${new URL(spec.apiBaseUrl).hostname}`);
    io.log(`  cnameTarget  : ${spec.dns.cnameTarget}`);
    io.log(`  ttl          : ${spec.dns.ttl}`);
    io.log("");
    if (validation.ok) {
      io.log("  current state: ok (CNAME chain matches expected target)");
    } else {
      io.log("  current state: drift");
      for (const result of validation.results) {
        io.log(`    ${result.resolver}: ${result.ok ? "ok" : `drift (${result.error ?? "no match"})`}`);
        if (result.chain.length > 0) {
          io.log(`      chain: ${result.chain.join(" -> ")}`);
        }
      }
    }
    return;
  }

  if (verb === "apply") {
    const result = await applyRelayDns(spec, env);
    io.log(`relay dns apply ${relayId}`);
    io.log(`  hostname    : ${result.hostname}`);
    io.log(`  cnameTarget : ${result.cnameTarget}`);
    io.log(`  recordId    : ${result.record.id}`);
    io.log(`  zone        : ${result.record.zoneName ?? result.record.zoneId}`);
    return;
  }

  if (verb === "remove") {
    const result = await removeRelayDns(spec, env);
    io.log(`relay dns remove ${relayId}`);
    io.log(`  hostname : ${result.hostname}`);
    if (result.removedRecordId) {
      io.log(`  deleted  : ${result.removedRecordId}`);
    } else {
      io.log("  deleted  : (none — no existing CNAME)");
    }
    return;
  }

  if (verb === "verify") {
    const validation = await verifyRelayDns(spec, env, { resolvers, validateCnameTarget: args.validateCnameTarget });
    io.log(`relay dns verify ${relayId}`);
    io.log(`  hostname     : ${validation.customerHostname}`);
    io.log(`  expectedTgt  : ${validation.expectedTarget}`);
    for (const result of validation.results) {
      io.log(`  ${result.resolver}: ${result.ok ? "ok" : `drift (${result.error ?? "no match"})`}`);
      if (result.chain.length > 0) {
        io.log(`    chain: ${result.chain.join(" -> ")}`);
      }
    }
    if (!validation.ok) {
      throw new Error(`relay dns verify ${relayId}: drift detected on at least one resolver`);
    }
    return;
  }
}

interface CloudflareListItem {
  id: string;
  zone_id: string;
  zone_name?: string;
  name: string;
  type: string;
  content: string;
}

async function fetchCloudflareList(input: {
  apiToken: string;
  hostname: string;
  type: "CNAME";
  zoneId?: string;
  zoneName?: string;
  zoneNames?: string[];
  apiBaseUrl?: string;
}): Promise<CloudflareListItem[]> {
  const apiBaseUrl = input.apiBaseUrl ?? "https://api.cloudflare.com/client/v4";
  const headers = {
    authorization: `Bearer ${input.apiToken}`,
    accept: "application/json"
  };
  let zoneId = input.zoneId;
  if (!zoneId) {
    const zoneNames = input.zoneName
      ? [normalizeDnsHostname(input.zoneName)]
      : input.zoneNames && input.zoneNames.length > 0
        ? candidateCloudflareZoneNames(input.hostname, input.zoneNames)
        : [inferCloudflareZoneName(input.hostname)];
    for (const zoneName of zoneNames) {
      const search = new URLSearchParams({ name: zoneName, status: "active", per_page: "50" });
      const zoneRes = await fetch(`${apiBaseUrl}/zones?${search.toString()}`, { headers });
      const zoneJson = (await zoneRes.json()) as { success?: boolean; result?: Array<{ id: string; name: string }> };
      const zone = zoneJson.result?.find((candidate) => candidate.name === zoneName);
      if (zone) {
        zoneId = zone.id;
        break;
      }
    }
    if (!zoneId) {
      throw new Error(`Cloudflare zone "${zoneNames.join('" or "')}" was not found or is not active`);
    }
  }
  const search = new URLSearchParams({ type: input.type, name: input.hostname, per_page: "50" });
  const res = await fetch(`${apiBaseUrl}/zones/${encodeURIComponent(zoneId)}/dns_records?${search.toString()}`, { headers });
  const json = (await res.json()) as { success?: boolean; result?: CloudflareListItem[] };
  return json.result ?? [];
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function csvEnv(value: string | undefined): string[] | undefined {
  if (!value || value.trim().length === 0) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
