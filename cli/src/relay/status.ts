import type { RelayCatalogInputEntry } from "../../../src/service-catalog.js";

export interface RelayStatusResult {
  relayId: string;
  apiBaseUrl: string;
  state?: string;
  health: ProbeOutcome;
  relayStatus: ProbeOutcome<RelayStatusBody>;
  relayCatalog: ProbeOutcome<RelayCatalogProbeBody>;
}

export interface ProbeOutcome<T = unknown> {
  url: string;
  ok: boolean;
  httpStatus?: number;
  durationMs: number;
  error?: string;
  body?: T;
}

interface RelayStatusBody {
  relayId?: string;
  recorderCoordinatorAddress?: string;
  recorderCoordinatorEnabled?: boolean;
  peerBackfillEnabled?: boolean;
  settlementLeadership?: { relayId?: string };
}

interface RelayCatalogProbeBody {
  catalog?: { role?: string; members?: Array<{ serviceId?: string; state?: string }> };
}

export interface ProbeRelayOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function probeRelay(
  entry: RelayCatalogInputEntry,
  options: ProbeRelayOptions = {}
): Promise<RelayStatusResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const baseUrl = entry.apiBaseUrl.replace(/\/+$/, "");

  const [health, relayStatus, relayCatalog] = await Promise.all([
    probeJson<unknown>(`${baseUrl}/health`, fetchImpl, timeoutMs),
    probeJson<RelayStatusBody>(`${baseUrl}/v1/relay-status`, fetchImpl, timeoutMs),
    probeJson<RelayCatalogProbeBody>(`${baseUrl}/v1/service-catalogs/relay`, fetchImpl, timeoutMs)
  ]);

  return {
    relayId: entry.relayId,
    apiBaseUrl: entry.apiBaseUrl,
    state: entry.state ?? (entry.active === false ? "disabled" : "active"),
    health,
    relayStatus,
    relayCatalog
  };
}

async function probeJson<T>(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<ProbeOutcome<T>> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
    const durationMs = Date.now() - start;
    if (!response.ok) {
      return { url, ok: false, httpStatus: response.status, durationMs };
    }
    let body: T | undefined;
    try {
      const text = await response.text();
      body = (text.length > 0 ? (JSON.parse(text) as T) : undefined);
    } catch (error) {
      return {
        url,
        ok: response.ok,
        httpStatus: response.status,
        durationMs,
        error: `failed to parse JSON: ${(error as Error).message}`
      };
    }
    return { url, ok: true, httpStatus: response.status, durationMs, body };
  } catch (error) {
    return {
      url,
      ok: false,
      durationMs: Date.now() - start,
      error: (error as Error).message
    };
  } finally {
    clearTimeout(timer);
  }
}

export function summarizeRelayStatus(result: RelayStatusResult): string[] {
  const lines: string[] = [];
  lines.push(`relay ${result.relayId} (${result.state ?? "unknown"}) @ ${result.apiBaseUrl}`);
  lines.push(`  ${formatProbe("health", result.health)}`);
  lines.push(`  ${formatProbe("relay-status", result.relayStatus)}`);
  if (result.relayStatus.body) {
    const body = result.relayStatus.body;
    if (body.relayId) lines.push(`    relayId reported by service: ${body.relayId}`);
    if (typeof body.recorderCoordinatorEnabled === "boolean") {
      lines.push(`    recorderCoordinatorEnabled: ${body.recorderCoordinatorEnabled}`);
    }
    if (typeof body.peerBackfillEnabled === "boolean") {
      lines.push(`    peerBackfillEnabled: ${body.peerBackfillEnabled}`);
    }
  }
  lines.push(`  ${formatProbe("service-catalogs/relay", result.relayCatalog)}`);
  if (result.relayCatalog.body?.catalog?.members) {
    const ids = result.relayCatalog.body.catalog.members.map((member) => `${member.serviceId}=${member.state}`);
    lines.push(`    catalog members: ${ids.join(", ")}`);
  }
  return lines;
}

function formatProbe(label: string, outcome: ProbeOutcome): string {
  if (outcome.ok) {
    return `${label}: ok (${outcome.httpStatus ?? "?"} in ${outcome.durationMs}ms) ${outcome.url}`;
  }
  const status = outcome.httpStatus ? `http=${outcome.httpStatus}` : `error=${outcome.error ?? "unknown"}`;
  return `${label}: FAIL (${status}, ${outcome.durationMs}ms) ${outcome.url}`;
}
