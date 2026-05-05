import { lookup } from "node:dns/promises";

export interface RelayDiagnosticsResult {
  relayHost: string;
  relayProtocol: string;
  healthUrl: string;
  dns: {
    ok: boolean;
    addresses?: Array<{ address: string; family: number }>;
    error?: Record<string, unknown>;
  };
  health: {
    ok: boolean;
    status?: number;
    statusText?: string;
    elapsedMs: number;
    bodyPreview?: string;
    error?: Record<string, unknown>;
  };
}

export async function runRelayDiagnostics(rawRelayUrl: string, timeoutMs: number): Promise<RelayDiagnosticsResult> {
  const relayUrl = new URL(rawRelayUrl);
  const healthUrl = new URL("/health", relayUrl);
  const dns = await diagnoseDns(relayUrl.hostname);
  const health = await diagnoseHealth(healthUrl, timeoutMs);
  return {
    relayHost: relayUrl.host,
    relayProtocol: relayUrl.protocol,
    healthUrl: `${healthUrl.protocol}//${healthUrl.host}${healthUrl.pathname}`,
    dns,
    health
  };
}

async function diagnoseDns(hostname: string): Promise<RelayDiagnosticsResult["dns"]> {
  try {
    const addresses = await lookup(hostname, { all: true });
    return {
      ok: true,
      addresses: addresses.map((item) => ({
        address: item.address,
        family: item.family
      }))
    };
  } catch (error) {
    return {
      ok: false,
      error: safeNetworkError(error)
    };
  }
}

async function diagnoseHealth(healthUrl: URL, timeoutMs: number): Promise<RelayDiagnosticsResult["health"]> {
  const startedAt = Date.now();
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: {
        accept: "application/json"
      },
      signal: abortController.signal
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      elapsedMs: Date.now() - startedAt,
      bodyPreview: truncate(body, 500)
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: safeNetworkError(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function safeNetworkError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const details: Record<string, unknown> = {
      name: error.name,
      message: truncate(error.message)
    };
    const cause = safeNetworkErrorCause(error.cause);
    if (cause !== undefined) {
      details.cause = cause;
    }
    return details;
  }

  return {
    name: typeof error,
    message: truncate(String(error))
  };
}

function safeNetworkErrorCause(cause: unknown): Record<string, unknown> | string | undefined {
  if (cause === undefined || cause === null) {
    return undefined;
  }

  if (cause instanceof Error) {
    const details: Record<string, unknown> = {
      name: cause.name,
      message: truncate(cause.message)
    };
    const record = cause as unknown as Record<string, unknown>;
    for (const key of ["code", "errno", "syscall", "address", "port", "host", "hostname"]) {
      const value = record[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        details[key] = value;
      }
    }
    return details;
  }

  if (typeof cause === "object") {
    const details: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(cause as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        details[key] = value;
      }
    }
    return Object.keys(details).length > 0 ? details : truncate(String(cause));
  }

  return truncate(String(cause));
}

function truncate(value: string, maxLength = 1000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
