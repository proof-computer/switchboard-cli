export interface CloudflareDnsRecord {
  id: string;
  zoneId: string;
  zoneName?: string;
  name: string;
  type: CloudflareDnsRecordType;
  content: string;
  ttl: number;
  proxied?: boolean;
}

export type CloudflareDnsRecordType = "A" | "TXT" | "CNAME";

export interface UpsertCloudflareARecordInput {
  apiToken: string;
  hostname: string;
  content: string;
  zoneId?: string;
  zoneName?: string;
  zoneNames?: string[];
  ttl?: number;
  proxied?: boolean;
  comment?: string;
  apiBaseUrl?: string;
}

export interface CreateCloudflareTxtRecordInput {
  apiToken: string;
  hostname: string;
  content: string;
  zoneId?: string;
  zoneName?: string;
  zoneNames?: string[];
  ttl?: number;
  comment?: string;
  apiBaseUrl?: string;
}

export interface UpsertCloudflareCnameRecordInput {
  apiToken: string;
  hostname: string;
  content: string;
  zoneId?: string;
  zoneName?: string;
  zoneNames?: string[];
  ttl?: number;
  comment?: string;
  apiBaseUrl?: string;
}

export interface DeleteCloudflareDnsRecordInput {
  apiToken: string;
  zoneId: string;
  recordId: string;
  apiBaseUrl?: string;
}

interface CloudflareZone {
  id: string;
  name: string;
}

interface CloudflareRecordResponse {
  id: string;
  zone_id?: string;
  zone_name?: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied?: boolean;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  messages?: Array<{ code?: number; message?: string }>;
  result: T;
}

export function normalizeDnsHostname(value: string): string {
  return normalizeDnsName(value, false);
}

export function normalizeDnsRecordName(value: string): string {
  return normalizeDnsName(value, true);
}

function normalizeDnsName(value: string, allowUnderscore: boolean): string {
  const hostname = value.trim().replace(/\.$/, "").toLowerCase();
  if (!hostname || hostname.includes("://") || hostname.length > 253) {
    throw new Error(`Invalid DNS hostname: ${value}`);
  }

  const labels = hostname.split(".");
  for (const label of labels) {
    const labelPattern = allowUnderscore
      ? /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/
      : /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    if (!labelPattern.test(label)) {
      throw new Error(`Invalid DNS hostname label "${label}" in ${value}`);
    }
  }
  return hostname;
}

export function inferCloudflareZoneName(hostname: string): string {
  const normalized = normalizeDnsRecordName(hostname);
  const labels = normalized.split(".");
  if (labels.length < 2) {
    throw new Error(`Cannot infer Cloudflare zone from hostname: ${hostname}`);
  }
  return labels.slice(-2).join(".");
}

export function selectCloudflareZoneName(hostname: string, zoneNames: string[] = []): string {
  const normalizedHostname = normalizeDnsRecordName(hostname);
  const normalizedZones = unique(
    zoneNames
      .map((zoneName) => zoneName.trim())
      .filter((zoneName) => zoneName.length > 0)
      .map(normalizeDnsHostname)
  ).sort((left, right) => right.length - left.length);

  const match = normalizedZones.find(
    (zoneName) => normalizedHostname === zoneName || normalizedHostname.endsWith(`.${zoneName}`)
  );
  if (match) return match;
  if (normalizedZones.length > 0) {
    throw new Error(`Hostname ${hostname} is outside configured Cloudflare zones`);
  }
  return inferCloudflareZoneName(normalizedHostname);
}

export function candidateCloudflareZoneNames(hostname: string, zoneNames: string[] = []): string[] {
  const selected = selectCloudflareZoneName(hostname, zoneNames);
  return unique([selected, ...parentZoneCandidates(selected)]);
}

export async function upsertCloudflareARecord(input: UpsertCloudflareARecordInput): Promise<CloudflareDnsRecord> {
  const hostname = normalizeDnsHostname(input.hostname);
  const zone = await resolveCloudflareZone(input, hostname);
  const existing = await listCloudflareDnsRecords({
    apiToken: input.apiToken,
    apiBaseUrl: input.apiBaseUrl,
    zoneId: zone.id,
    type: "A",
    hostname
  });
  const payload = {
    type: "A",
    name: hostname,
    content: input.content,
    ttl: input.ttl ?? 60,
    proxied: input.proxied ?? false,
    ...(input.comment ? { comment: input.comment } : {})
  };

  const path =
    existing.length > 0
      ? `/zones/${encodeURIComponent(zone.id)}/dns_records/${encodeURIComponent(existing[0].id)}`
      : `/zones/${encodeURIComponent(zone.id)}/dns_records`;
  const method = existing.length > 0 ? "PATCH" : "POST";
  const record = await cloudflareFetch<CloudflareRecordResponse>(input.apiToken, path, {
    apiBaseUrl: input.apiBaseUrl,
    method,
    body: JSON.stringify(payload)
  });

  return toDnsRecord(record, zone);
}

export async function createCloudflareTxtRecord(input: CreateCloudflareTxtRecordInput): Promise<CloudflareDnsRecord> {
  const hostname = normalizeDnsRecordName(input.hostname);
  const zone = await resolveCloudflareZone(input, hostname);
  const payload = {
    type: "TXT",
    name: hostname,
    content: input.content,
    ttl: input.ttl ?? 60,
    ...(input.comment ? { comment: input.comment } : {})
  };
  const record = await cloudflareFetch<CloudflareRecordResponse>(
    input.apiToken,
    `/zones/${encodeURIComponent(zone.id)}/dns_records`,
    {
      apiBaseUrl: input.apiBaseUrl,
      method: "POST",
      body: JSON.stringify(payload)
    }
  );

  return toDnsRecord(record, zone);
}

export async function upsertCloudflareCnameRecord(input: UpsertCloudflareCnameRecordInput): Promise<CloudflareDnsRecord> {
  const hostname = normalizeDnsRecordName(input.hostname);
  const content = normalizeDnsRecordName(input.content);
  const zone = await resolveCloudflareZone(input, hostname);
  const existingCnames = await listCloudflareDnsRecords({
    apiToken: input.apiToken,
    apiBaseUrl: input.apiBaseUrl,
    zoneId: zone.id,
    type: "CNAME",
    hostname
  });
  // RFC 1034: a CNAME cannot coexist with other record types at the same
  // name. Cloudflare rejects the POST with `81053` if A/AAAA records still
  // exist, so clear them first when the caller is asking for a CNAME.
  if (existingCnames.length === 0) {
    for (const recordType of ["A", "AAAA"] as const) {
      const conflicting = await listCloudflareDnsRecords({
        apiToken: input.apiToken,
        apiBaseUrl: input.apiBaseUrl,
        zoneId: zone.id,
        type: recordType,
        hostname
      });
      for (const conflict of conflicting) {
        await deleteCloudflareDnsRecord({
          apiToken: input.apiToken,
          apiBaseUrl: input.apiBaseUrl,
          zoneId: zone.id,
          recordId: conflict.id
        });
      }
    }
  }
  const payload = {
    type: "CNAME",
    name: hostname,
    content,
    ttl: input.ttl ?? 60,
    ...(input.comment ? { comment: input.comment } : {})
  };

  const path =
    existingCnames.length > 0
      ? `/zones/${encodeURIComponent(zone.id)}/dns_records/${encodeURIComponent(existingCnames[0].id)}`
      : `/zones/${encodeURIComponent(zone.id)}/dns_records`;
  const method = existingCnames.length > 0 ? "PATCH" : "POST";
  const record = await cloudflareFetch<CloudflareRecordResponse>(input.apiToken, path, {
    apiBaseUrl: input.apiBaseUrl,
    method,
    body: JSON.stringify(payload)
  });

  return toDnsRecord(record, zone);
}

export async function deleteCloudflareDnsRecord(input: DeleteCloudflareDnsRecordInput): Promise<void> {
  await cloudflareFetch<unknown>(
    input.apiToken,
    `/zones/${encodeURIComponent(input.zoneId)}/dns_records/${encodeURIComponent(input.recordId)}`,
    {
      apiBaseUrl: input.apiBaseUrl,
      method: "DELETE"
    }
  );
}

async function resolveCloudflareZone(
  input: { apiToken: string; apiBaseUrl?: string; zoneId?: string; zoneName?: string; zoneNames?: string[] },
  hostname: string
): Promise<CloudflareZone> {
  const hasZonePool = input.zoneNames != null && input.zoneNames.length > 0;
  const zoneNames = input.zoneName
    ? [normalizeDnsHostname(input.zoneName)]
    : hasZonePool
      ? candidateCloudflareZoneNames(hostname, input.zoneNames)
      : [inferCloudflareZoneName(hostname)];
  const zoneName = zoneNames[0];
  if (input.zoneId) {
    return {
      id: input.zoneId,
      name: zoneName
    };
  }

  for (const candidateZoneName of zoneNames) {
    const search = new URLSearchParams({
      name: candidateZoneName,
      status: "active",
      per_page: "50"
    });
    const zones = await cloudflareFetch<CloudflareZone[]>(input.apiToken, `/zones?${search.toString()}`, {
      apiBaseUrl: input.apiBaseUrl,
      method: "GET"
    });
    const zone = zones.find((candidate) => candidate.name === candidateZoneName);
    if (zone) return zone;
  }
  throw new Error(`Cloudflare zone "${zoneNames.join('" or "')}" was not found or is not active`);
}

async function listCloudflareDnsRecords(input: {
  apiToken: string;
  apiBaseUrl?: string;
  zoneId: string;
  type: CloudflareDnsRecordType | "AAAA";
  hostname: string;
}): Promise<CloudflareRecordResponse[]> {
  const search = new URLSearchParams({
    type: input.type,
    name: input.hostname,
    per_page: "50"
  });
  return cloudflareFetch<CloudflareRecordResponse[]>(
    input.apiToken,
    `/zones/${encodeURIComponent(input.zoneId)}/dns_records?${search.toString()}`,
    {
      apiBaseUrl: input.apiBaseUrl,
      method: "GET"
    }
  );
}

async function cloudflareFetch<T>(
  apiToken: string,
  path: string,
  options: { apiBaseUrl?: string; method: string; body?: string }
): Promise<T> {
  if (!apiToken) {
    throw new Error("Missing Cloudflare API token");
  }

  const response = await fetch(`${options.apiBaseUrl ?? "https://api.cloudflare.com/client/v4"}${path}`, {
    method: options.method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    body: options.body
  });
  const raw = await response.text();
  let parsed: CloudflareEnvelope<T> | undefined;
  try {
    parsed = JSON.parse(raw) as CloudflareEnvelope<T>;
  } catch {
    // Keep the original response body for provider diagnostics.
  }

  if (!response.ok || parsed?.success === false || !parsed) {
    const errors = parsed?.errors?.map((error) => `${error.code ?? "unknown"} ${error.message ?? ""}`.trim());
    const detail = errors && errors.length > 0 ? errors.join("; ") : raw.slice(0, 500);
    throw new Error(`Cloudflare API ${options.method} ${path} failed (${response.status}): ${detail}`);
  }

  return parsed.result;
}

function toDnsRecord(record: CloudflareRecordResponse, zone: CloudflareZone): CloudflareDnsRecord {
  if (record.type !== "A" && record.type !== "TXT" && record.type !== "CNAME") {
    throw new Error(`Expected Cloudflare A/TXT/CNAME record response, got ${record.type}`);
  }
  return {
    id: record.id,
    zoneId: record.zone_id ?? zone.id,
    zoneName: record.zone_name ?? zone.name,
    name: record.type === "A" ? normalizeDnsHostname(record.name) : normalizeDnsRecordName(record.name),
    type: record.type,
    content: record.content,
    ttl: record.ttl,
    proxied: record.type === "A" ? record.proxied ?? false : undefined
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function parentZoneCandidates(zoneName: string): string[] {
  const labels = normalizeDnsHostname(zoneName).split(".");
  const candidates: string[] = [];
  for (let index = 1; index <= labels.length - 2; index += 1) {
    candidates.push(labels.slice(index).join("."));
  }
  return candidates;
}
