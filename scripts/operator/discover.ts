#!/usr/bin/env node
import "dotenv/config";

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import {
  acurastNetworkFrom,
  classifyProcessorReadiness,
  discoverManagerProcessors,
  rpcForAcurastNetwork,
  type AcurastNetwork,
  type ProcessorInfo,
  type ProcessorReadinessStatus
} from "../../src/acurast-manager.js";
import { processorRefToId } from "../../src/operator-capability.js";

interface ParsedArgs {
  flags: Map<string, string | boolean>;
}

type HarnessStatus = ProcessorReadinessStatus | "route_failed" | "config_blocked";
type DiscoverySummary = Record<HarnessStatus, number> & {
  cachedReady: number;
  activeIngressProcessors: number;
  activeIngressSessions: number;
};

interface ProcessorHarnessResult {
  processor: string;
  processorId?: string;
  heartbeatIso: string | null;
  heartbeatAgeSeconds: number | null;
  version: unknown;
  status: HarnessStatus;
  reasons: string[];
  cachedReady: boolean;
  lastReadyAt?: string;
  readyUntil?: string;
  activeIngress: ActiveIngressUse[];
}

interface GatewayCheckResult {
  gatewayAgentUrl: string;
  agent: CheckResult & {
    health?: unknown;
    capabilityReport?: unknown;
    routeState?: unknown;
    routeStateError?: string;
  };
  publicAddress?: string;
  publicPort: number;
  publicTcp?: CheckResult;
  smokeRoute?: CheckResult;
}

interface CheckResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  elapsedMs?: number;
}

export interface ActiveIngressUse {
  routeId: string;
  sessionId: string;
  hostname: string;
  processorId: string;
  operatorId?: string;
  expiresAt?: number;
  expiresAtIso?: string;
}

export interface OperatorDiscoveryProcessorState {
  processor: string;
  processorId?: string;
  managerId: string;
  lastCheckedAt: string;
  lastStatus: HarnessStatus;
  lastReadyAt?: string;
  readyUntil?: string;
  heartbeatIso: string | null;
  heartbeatAgeSeconds: number | null;
  reasons: string[];
  activeIngress: ActiveIngressUse[];
}

export interface OperatorDiscoveryState {
  version: 1;
  updatedAt: string;
  processors: Record<string, OperatorDiscoveryProcessorState>;
  activeIngress: Record<string, ActiveIngressUse[]>;
}

interface DiscoveryReport {
  version: 1;
  kind: "switchboard.operator.discovery";
  checkedAt: string;
  network: AcurastNetwork;
  rpcUrl: string;
  managerId: string;
  gateway: GatewayCheckResult;
  inventory: {
    chainTimestampIso: string;
    chainLagSeconds: number;
    totalProcessors: number;
    selectedProcessors: number;
    recentProcessors: number;
    availableProcessors?: number;
    recentAvailableProcessors?: number;
    availabilityWindow?: {
      proposedStartIso: string;
      proposedEndIso: string;
    };
  };
  state: {
    enabled: boolean;
    file?: string;
    readyTtlMs: number;
    recentCheckTtlMs: number;
    loadedProcessorCount: number;
    updatedProcessorCount?: number;
  };
  activeIngress: {
    processorCount: number;
    sessionCount: number;
    byProcessor: Record<string, ActiveIngressUse[]>;
  };
  summary: DiscoverySummary;
  processors: ProcessorHarnessResult[];
  suggestedEnv: Record<string, string>;
}

const DEFAULT_DISCOVERY_STATE_FILE = "~/.proof-index/operator-discovery-state.json";
const DEFAULT_READY_TTL_MS = 24 * 60 * 60 * 1000;

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (boolFlag(parsed.flags, "help")) {
    printOperatorDiscoverUsage();
    return;
  }
  await runOperatorDiscover(parsed.flags);
}

export async function runOperatorDiscover(flags: Map<string, string | boolean>): Promise<void> {
  const network = acurastNetworkFrom(stringFlag(flags, "network") ?? process.env.ACURAST_NETWORK);
  const managerId = managerIdFromFlags(flags);
  if (!managerId) {
    throw new Error("Set ACURAST_MANAGER_ID/OPERATOR_MANAGER_IDS or pass --manager-id <id>");
  }

  const rpcUrl = stringFlag(flags, "rpc-url") ?? rpcForAcurastNetwork(network);
  const maxAgeSeconds = numberFlag(flags, "max-age-seconds", 900);
  const checkAvailability = !boolFlag(flags, "skip-availability") && !boolFlag(flags, "no-available");
  const availabilityDurationMs = numberFlag(flags, "available-for-ms", 300_000);
  const publicPort = numberFlag(flags, "public-port", 443);
  const publicAddress = stringFlag(flags, "public-address") ?? firstCsv(process.env.OPERATOR_PUBLIC_ADDRESSES ?? process.env.GATEWAY_PUBLIC_ADDRESSES ?? "");
  const gatewayAgentUrl = stringFlag(flags, "gateway-agent-url") ?? process.env.GATEWAY_AGENT_URL ?? "http://127.0.0.1:18080";
  const timeoutMs = numberFlag(flags, "timeout-ms", 5_000);
  const stateEnabled = !boolFlag(flags, "no-state");
  const stateFile = expandHomePath(stringFlag(flags, "state-file") ?? process.env.OPERATOR_DISCOVERY_STATE_FILE ?? DEFAULT_DISCOVERY_STATE_FILE);
  const readyTtlMs = numberFlag(
    flags,
    "ready-ttl-ms",
    numberEnv("OPERATOR_DISCOVERY_READY_TTL_MS", DEFAULT_READY_TTL_MS)
  );
  const recentCheckTtlMs = numberFlag(flags, "recent-check-ttl-ms", readyTtlMs);
  const processorLimit = numberFlag(flags, "limit", 0);
  const previousState = stateEnabled ? await loadDiscoveryState(stateFile) : emptyDiscoveryState();
  const checkedAt = new Date();

  const inventory = await discoverManagerProcessors({
    network,
    managerId,
    rpcUrl,
    maxAgeSeconds,
    checkAvailability,
    startDelayMs: numberFlag(flags, "start-delay-ms", 120_000),
    durationMs: availabilityDurationMs,
    processorFilter: processorLimit > 0
      ? (processors) =>
          selectNextProcessorRefs(processors, previousState, {
            now: checkedAt,
            limit: processorLimit,
            recentCheckTtlMs
          })
      : undefined
  });
  const gateway = await checkGateway({
    gatewayAgentUrl,
    publicAddress,
    publicPort,
    timeoutMs,
    smokeHostname: stringFlag(flags, "smoke-hostname"),
    smokeUpstreamHost: stringFlag(flags, "smoke-upstream-host") ?? "tls-test-upstream",
    smokeUpstreamPort: numberFlag(flags, "smoke-upstream-port", 3443),
    keepSmokeRoute: boolFlag(flags, "keep-smoke-route")
  });
  const activeIngressByProcessor = activeIngressUsesByProcessor(extractActiveIngressUses(gateway.agent.routeState));
  const processors = inventory.processors.map((processor) =>
    processorResult(processor, {
      maxAgeSeconds,
      requireAvailability: checkAvailability,
      gateway,
      activeIngress: activeIngressByProcessor.get(processorRefToId(processor.processor) ?? processor.processor) ?? [],
      previousState: previousState.processors[processorStateKey(processor.processor, processorRefToId(processor.processor))],
      checkedAt,
      readyTtlMs
    })
  );
  const suggestedEnv = suggestedOperatorEnv({
    managerId,
    publicAddress,
    failedProcessors: processors.filter((processor) => processor.status !== "ready").map((processor) => processor.processor)
  });
  const report: DiscoveryReport = {
    version: 1,
    kind: "switchboard.operator.discovery",
    checkedAt: checkedAt.toISOString(),
    network,
    rpcUrl,
    managerId,
    gateway,
    inventory: {
      chainTimestampIso: inventory.chainTimestampIso,
      chainLagSeconds: inventory.chainLagSeconds,
      totalProcessors: inventory.totalProcessors,
      selectedProcessors: inventory.processors.length,
      recentProcessors: inventory.recentProcessors,
      availableProcessors: inventory.availableProcessors,
      recentAvailableProcessors: inventory.recentAvailableProcessors,
      availabilityWindow: inventory.availabilityWindow
    },
    state: {
      enabled: stateEnabled,
      file: stateEnabled ? stateFile : undefined,
      readyTtlMs,
      recentCheckTtlMs,
      loadedProcessorCount: Object.keys(previousState.processors).length
    },
    activeIngress: activeIngressReport(activeIngressByProcessor),
    summary: summarize(processors, activeIngressByProcessor),
    processors,
    suggestedEnv
  };
  if (stateEnabled) {
    const nextState = updateDiscoveryState(previousState, report, { readyTtlMs });
    await saveDiscoveryState(stateFile, nextState);
    report.state.updatedProcessorCount = Object.keys(nextState.processors).length;
  }

  const writeEnvPath = stringFlag(flags, "write-env");
  if (writeEnvPath) {
    await mkdir(path.dirname(writeEnvPath), { recursive: true });
    await writeFile(writeEnvPath, renderEnv(suggestedEnv), "utf8");
  }

  if (boolFlag(flags, "json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printHumanReport(report, writeEnvPath);
}

function processorResult(
  processor: ProcessorInfo,
  options: {
    maxAgeSeconds: number;
    requireAvailability: boolean;
    gateway: GatewayCheckResult;
    activeIngress: ActiveIngressUse[];
    previousState?: OperatorDiscoveryProcessorState;
    checkedAt: Date;
    readyTtlMs: number;
  }
): ProcessorHarnessResult {
  const readiness = classifyProcessorReadiness(processor, {
    maxAgeSeconds: options.maxAgeSeconds,
    requireAvailability: options.requireAvailability
  });
  const reasons = [...readiness.reasons];
  let status: HarnessStatus = readiness.status;

  if (status === "ready" && !options.gateway.agent.ok) {
    status = "config_blocked";
    reasons.push("gateway-agent health/capability check failed");
  }
  if (status === "ready" && options.gateway.publicTcp?.skipped) {
    status = "config_blocked";
    reasons.push("gateway public address is not configured");
  }
  if (status === "ready" && options.gateway.publicTcp && !options.gateway.publicTcp.ok) {
    status = "route_failed";
    reasons.push("gateway public TCP check failed");
  }
  if (status === "ready" && options.gateway.smokeRoute && !options.gateway.smokeRoute.ok) {
    status = "route_failed";
    reasons.push("gateway SNI smoke route failed");
  }

  const previousReadyUntilMs = options.previousState?.readyUntil ? Date.parse(options.previousState.readyUntil) : Number.NaN;
  const cachedReady = Number.isFinite(previousReadyUntilMs) && previousReadyUntilMs > options.checkedAt.getTime();
  const lastReadyAt = status === "ready" ? options.checkedAt.toISOString() : options.previousState?.lastReadyAt;
  const readyUntil =
    status === "ready"
      ? new Date(options.checkedAt.getTime() + options.readyTtlMs).toISOString()
      : options.previousState?.readyUntil;

  return {
    processor: processor.processor,
    processorId: processorRefToId(processor.processor),
    heartbeatIso: processor.heartbeatIso,
    heartbeatAgeSeconds: processor.heartbeatAgeSeconds,
    version: processor.version,
    status,
    reasons,
    cachedReady,
    lastReadyAt,
    readyUntil,
    activeIngress: options.activeIngress
  };
}

async function checkGateway(input: {
  gatewayAgentUrl: string;
  publicAddress?: string;
  publicPort: number;
  timeoutMs: number;
  smokeHostname?: string;
  smokeUpstreamHost: string;
  smokeUpstreamPort: number;
  keepSmokeRoute: boolean;
}): Promise<GatewayCheckResult> {
  const agent = await checkGatewayAgent(input.gatewayAgentUrl, input.timeoutMs);
  const publicHost = input.publicAddress ? hostFromPublicAddress(input.publicAddress) : undefined;
  const publicTcp = publicHost ? await checkTcp(publicHost, input.publicPort, input.timeoutMs) : skipped("no public address configured");
  const smokeRoute =
    input.smokeHostname && publicHost
      ? await checkSmokeRoute({
          gatewayAgentUrl: input.gatewayAgentUrl,
          hostname: input.smokeHostname,
          publicHost,
          publicPort: input.publicPort,
          upstreamHost: input.smokeUpstreamHost,
          upstreamPort: input.smokeUpstreamPort,
          timeoutMs: input.timeoutMs,
          keepSmokeRoute: input.keepSmokeRoute
        })
      : input.smokeHostname
        ? skipped("no public address configured")
        : skipped("pass --smoke-hostname to test SNI passthrough");

  return {
    gatewayAgentUrl: input.gatewayAgentUrl,
    agent,
    publicAddress: input.publicAddress,
    publicPort: input.publicPort,
    publicTcp,
    smokeRoute
  };
}

async function checkGatewayAgent(gatewayAgentUrl: string, timeoutMs: number): Promise<GatewayCheckResult["agent"]> {
  const started = Date.now();
  try {
    const health = await fetchJson(new URL("/health", gatewayAgentUrl), timeoutMs);
    let capabilityReport: unknown;
    let routeState: unknown;
    let routeStateError: string | undefined;
    try {
      capabilityReport = await fetchJson(new URL("/reports/gateway-capability", gatewayAgentUrl), timeoutMs);
    } catch (error) {
      return {
        ok: false,
        elapsedMs: Date.now() - started,
        health,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
    try {
      routeState = await fetchJson(new URL("/route-intents", gatewayAgentUrl), timeoutMs);
    } catch (error) {
      routeStateError = error instanceof Error ? error.message : String(error);
    }
    return {
      ok: true,
      elapsedMs: Date.now() - started,
      health,
      capabilityReport,
      routeState,
      routeStateError
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function checkSmokeRoute(input: {
  gatewayAgentUrl: string;
  hostname: string;
  publicHost: string;
  publicPort: number;
  upstreamHost: string;
  upstreamPort: number;
  timeoutMs: number;
  keepSmokeRoute: boolean;
}): Promise<CheckResult> {
  const routeId = `operator-discovery-${Date.now()}`;
  const sessionId = `0x${randomBytes(32).toString("hex")}`;
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const started = Date.now();
  try {
    const response = await fetchWithTimeout(new URL("/route-intents", input.gatewayAgentUrl), input.timeoutMs, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routeId,
        sessionId,
        hostname: input.hostname,
        upstreamHost: input.upstreamHost,
        upstreamPort: input.upstreamPort,
        expiresAt,
        source: {
          mode: "operator-discovery"
        }
      })
    });
    if (!response.ok) {
      throw new Error(`gateway-agent route smoke setup failed: ${response.status} ${await response.text()}`);
    }

    const tlsCheck = await checkTls(input.publicHost, input.publicPort, input.hostname, input.timeoutMs);
    if (!tlsCheck.ok) {
      throw new Error(tlsCheck.reason ?? "TLS smoke route failed");
    }

    return {
      ok: true,
      elapsedMs: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      reason: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (!input.keepSmokeRoute) {
      await fetchWithTimeout(new URL(`/route-intents/${encodeURIComponent(routeId)}`, input.gatewayAgentUrl), input.timeoutMs, {
        method: "DELETE"
      }).catch(() => undefined);
    }
  }
}

async function fetchJson(url: URL, timeoutMs: number): Promise<unknown> {
  const response = await fetchWithTimeout(url, timeoutMs);
  if (!response.ok) {
    throw new Error(`${url.pathname} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function fetchWithTimeout(url: URL, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function checkTcp(host: string, port: number, timeoutMs: number): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (result: CheckResult) => {
      socket.destroy();
      resolve({
        ...result,
        elapsedMs: Date.now() - started
      });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ ok: true }));
    socket.once("timeout", () => finish({ ok: false, reason: "TCP connection timed out" }));
    socket.once("error", (error) => finish({ ok: false, reason: error.message }));
  });
}

function checkTls(host: string, port: number, servername: string, timeoutMs: number): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = tls.connect({
      host,
      port,
      servername,
      rejectUnauthorized: false
    });
    const finish = (result: CheckResult) => {
      socket.destroy();
      resolve({
        ...result,
        elapsedMs: Date.now() - started
      });
    };
    socket.setTimeout(timeoutMs);
    socket.once("secureConnect", () => finish({ ok: true }));
    socket.once("timeout", () => finish({ ok: false, reason: "TLS connection timed out" }));
    socket.once("error", (error) => finish({ ok: false, reason: error.message }));
  });
}

function suggestedOperatorEnv(input: {
  managerId: string;
  publicAddress?: string;
  failedProcessors: string[];
}): Record<string, string> {
  return {
    OPERATOR_MANAGER_IDS: input.managerId,
    OPERATOR_PROCESSOR_DISCOVERY_ENABLED: "true",
    OPERATOR_PROCESSORS: "",
    OPERATOR_EXCLUDED_PROCESSORS: input.failedProcessors.join(","),
    OPERATOR_PUBLIC_ADDRESSES: input.publicAddress ?? "",
    GATEWAY_ROUTE_CAPACITY: process.env.GATEWAY_ROUTE_CAPACITY ?? "500"
  };
}

function summarize(processors: ProcessorHarnessResult[], activeIngressByProcessor = new Map<string, ActiveIngressUse[]>()): DiscoverySummary {
  const statuses: HarnessStatus[] = ["ready", "offline_stale", "schedule_conflicted", "route_failed", "config_blocked"];
  const summary = Object.fromEntries(statuses.map((status) => [status, 0])) as DiscoverySummary;
  summary.cachedReady = 0;
  summary.activeIngressProcessors = activeIngressByProcessor.size;
  summary.activeIngressSessions = [...activeIngressByProcessor.values()].reduce((total, uses) => total + uses.length, 0);
  for (const processor of processors) {
    summary[processor.status] += 1;
    if (processor.cachedReady) {
      summary.cachedReady += 1;
    }
  }
  return summary;
}

function printHumanReport(report: DiscoveryReport, writeEnvPath: string | undefined): void {
  console.log(`Network: ${report.network}`);
  console.log(`Manager ID: ${report.managerId}`);
  console.log(`RPC: ${report.rpcUrl}`);
  console.log(`Gateway agent: ${statusLine(report.gateway.agent)}`);
  console.log(`Public TCP: ${statusLine(report.gateway.publicTcp)}`);
  console.log(`SNI smoke route: ${statusLine(report.gateway.smokeRoute)}`);
  console.log(
    `Processors: ${report.inventory.totalProcessors} total, ${report.inventory.selectedProcessors} selected, ${report.inventory.recentProcessors} recent, ${report.summary.ready} ready, ${report.summary.cachedReady} cached-ready, ${report.summary.activeIngressProcessors} in use`
  );
  if (report.state.enabled) {
    console.log(
      `State: ${report.state.file} (${report.state.loadedProcessorCount} loaded, ${report.state.updatedProcessorCount ?? report.state.loadedProcessorCount} stored)`
    );
  }
  console.log("");
  for (const processor of report.processors) {
    console.log(
      [
        processor.status.padEnd(18),
        processor.processor,
        processor.heartbeatAgeSeconds !== null ? `age=${processor.heartbeatAgeSeconds}s` : "age=unknown",
        processor.cachedReady ? "cachedReady=true" : undefined,
        processor.activeIngress.length > 0 ? `activeIngress=${processor.activeIngress.length}` : undefined,
        processor.reasons[0]
      ].filter(Boolean).join(" ")
    );
  }
  console.log("");
  console.log("Suggested env:");
  process.stdout.write(renderEnv(report.suggestedEnv));
  if (writeEnvPath) {
    console.log(`\nWrote suggested env to ${writeEnvPath}`);
  }
}

export function printOperatorDiscoverUsage(): void {
  console.log(`Usage: switchboard gateway discover --manager-id <id> --public-address <ip-or-host> [options]

Options:
  --network <mainnet|canary>       Acurast network, default ACURAST_NETWORK or mainnet
  --rpc-url <url>                  Override Acurast RPC URL
  --gateway-agent-url <url>        Default http://127.0.0.1:18080
  --public-address <ip-or-host>    Gateway NAT/public address to test
  --public-port <port>             Default 443
  --available                     Check schedule conflicts for the default window; enabled by default
  --skip-availability             Skip Acurast existing-job/schedule conflict checks
  --available-for-ms <ms>          Check schedule conflicts for a custom duration
  --limit <n>                      Test the next n processors not checked recently
  --smoke-hostname <hostname>      Temporarily route and TLS-probe this SNI name
  --state-file <path>              Default OPERATOR_DISCOVERY_STATE_FILE or ${DEFAULT_DISCOVERY_STATE_FILE}
  --ready-ttl-ms <ms>              Recent-ready TTL, default ${DEFAULT_READY_TTL_MS}
  --recent-check-ttl-ms <ms>       Recent-check TTL for --limit, default ready TTL
  --no-state                      Do not read or write discovery state
  --write-env <path>               Write suggested gateway env values
  --json                          Print JSON report

Alias:
  pnpm gateway:discover -- --manager-id <id> --public-address <ip-or-host>`);
}

function statusLine(result: CheckResult | undefined): string {
  if (!result) {
    return "skipped";
  }
  if (result.skipped) {
    return `skipped (${result.reason})`;
  }
  return result.ok ? `ok${result.elapsedMs === undefined ? "" : ` (${result.elapsedMs}ms)`}` : `failed (${result.reason})`;
}

function renderEnv(env: Record<string, string>): string {
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function skipped(reason: string): CheckResult {
  return {
    ok: true,
    skipped: true,
    reason
  };
}

export function extractActiveIngressUses(routeState: unknown, nowSeconds = Math.floor(Date.now() / 1000)): ActiveIngressUse[] {
  const record = objectRecord(routeState);
  if (!record) {
    return [];
  }
  const rawRoutes = arrayField(record, "activeRoutes") ?? arrayField(record, "routes") ?? [];
  const uses: ActiveIngressUse[] = [];

  for (const rawRoute of rawRoutes) {
    const route = objectRecord(rawRoute);
    if (!route) {
      continue;
    }
    const source = objectRecord(route.source);
    if (stringField(source, "mode") === "operator-discovery") {
      continue;
    }
    const expiresAt = numberField(route, "expiresAt");
    if (expiresAt !== undefined && expiresAt <= nowSeconds) {
      continue;
    }
    const processorId = stringField(source, "processorId");
    const normalizedProcessorId = processorId ? processorRefToId(processorId) ?? processorId.toLowerCase() : undefined;
    if (!normalizedProcessorId) {
      continue;
    }
    const sessionId = stringField(route, "sessionId");
    const hostname = stringField(route, "hostname");
    uses.push({
      routeId: stringField(route, "routeId") ?? sessionId ?? "unknown-route",
      sessionId: sessionId ?? "unknown-session",
      hostname: hostname ?? "unknown-hostname",
      processorId: normalizedProcessorId,
      operatorId: stringField(source, "operatorId"),
      expiresAt,
      expiresAtIso: expiresAt ? new Date(expiresAt * 1000).toISOString() : undefined
    });
  }

  return uses;
}

export function activeIngressUsesByProcessor(uses: ActiveIngressUse[]): Map<string, ActiveIngressUse[]> {
  const result = new Map<string, ActiveIngressUse[]>();
  for (const use of uses) {
    const processorId = processorRefToId(use.processorId) ?? use.processorId.toLowerCase();
    const current = result.get(processorId) ?? [];
    current.push(use);
    result.set(processorId, current);
  }
  return result;
}

function activeIngressReport(activeIngressByProcessor: Map<string, ActiveIngressUse[]>): DiscoveryReport["activeIngress"] {
  const byProcessor = Object.fromEntries([...activeIngressByProcessor.entries()]);
  return {
    processorCount: activeIngressByProcessor.size,
    sessionCount: [...activeIngressByProcessor.values()].reduce((total, uses) => total + uses.length, 0),
    byProcessor
  };
}

export function selectNextProcessorRefs(
  processors: string[],
  state: OperatorDiscoveryState,
  options: { now: Date; limit: number; recentCheckTtlMs: number }
): string[] {
  if (options.limit <= 0) {
    return processors;
  }
  return processors
    .filter((processor) => !processorCheckedRecently(processor, state, options.now, options.recentCheckTtlMs))
    .slice(0, options.limit);
}

export function updateDiscoveryState(
  previous: OperatorDiscoveryState,
  report: DiscoveryReport,
  options: { readyTtlMs: number }
): OperatorDiscoveryState {
  const checkedAtMs = Date.parse(report.checkedAt);
  const processors: Record<string, OperatorDiscoveryProcessorState> = { ...previous.processors };
  for (const processor of report.processors) {
    const key = processorStateKey(processor.processor, processor.processorId);
    const prior = processors[key];
    processors[key] = {
      processor: processor.processor,
      processorId: processor.processorId,
      managerId: report.managerId,
      lastCheckedAt: report.checkedAt,
      lastStatus: processor.status,
      lastReadyAt: processor.status === "ready" ? report.checkedAt : prior?.lastReadyAt,
      readyUntil:
        processor.status === "ready"
          ? new Date(checkedAtMs + options.readyTtlMs).toISOString()
          : prior?.readyUntil,
      heartbeatIso: processor.heartbeatIso,
      heartbeatAgeSeconds: processor.heartbeatAgeSeconds,
      reasons: processor.reasons,
      activeIngress: processor.activeIngress
    };
  }

  return {
    version: 1,
    updatedAt: report.checkedAt,
    processors,
    activeIngress: report.activeIngress.byProcessor
  };
}

async function loadDiscoveryState(filePath: string): Promise<OperatorDiscoveryState> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<OperatorDiscoveryState>;
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      processors: parsed.processors && typeof parsed.processors === "object" ? parsed.processors : {},
      activeIngress: parsed.activeIngress && typeof parsed.activeIngress === "object" ? parsed.activeIngress : {}
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return emptyDiscoveryState();
  }
}

async function saveDiscoveryState(filePath: string, state: OperatorDiscoveryState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function emptyDiscoveryState(): OperatorDiscoveryState {
  return {
    version: 1,
    updatedAt: "",
    processors: {},
    activeIngress: {}
  };
}

function processorStateKey(processor: string, processorId?: string): string {
  return processorId ?? processor;
}

function processorCheckedRecently(
  processor: string,
  state: OperatorDiscoveryState,
  now: Date,
  recentCheckTtlMs: number
): boolean {
  const processorId = processorRefToId(processor);
  const item = state.processors[processorStateKey(processor, processorId)];
  const lastCheckedAtMs = item?.lastCheckedAt ? Date.parse(item.lastCheckedAt) : Number.NaN;
  return Number.isFinite(lastCheckedAtMs) && now.getTime() - lastCheckedAtMs < recentCheckTtlMs;
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayField(record: Record<string, unknown>, name: string): unknown[] | undefined {
  const value = record[name];
  return Array.isArray(value) ? value : undefined;
}

function stringField(record: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = record?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, name: string): number | undefined {
  const value = record[name];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function hostFromPublicAddress(value: string): string {
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return new URL(value).hostname;
  }
  const unbracketed = value.replace(/^\[/, "").replace(/\]$/, "");
  if (net.isIP(unbracketed)) {
    return unbracketed;
  }
  const colonCount = [...unbracketed].filter((char) => char === ":").length;
  return colonCount === 1 ? unbracketed.split(":")[0] : unbracketed;
}

function managerIdFromFlags(flags: Map<string, string | boolean>): string | undefined {
  return (
    stringFlag(flags, "manager-id") ??
    firstCsv(process.env.OPERATOR_MANAGER_IDS ?? "") ??
    firstCsv(process.env.OPERATOR_MANAGER_ID ?? "") ??
    process.env.ACURAST_MANAGER_ID
  );
}

function firstCsv(value: string): string | undefined {
  return value
    .split(",")
    .map((item) => item.trim())
    .find((item) => item.length > 0);
}

function parseArgs(args: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const withoutPrefix = arg.slice(2);
    const [name, inlineValue] = withoutPrefix.split("=", 2);
    if (inlineValue !== undefined) {
      flags.set(name, inlineValue);
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }

  return { flags };
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function numberFlag(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  const value = stringFlag(flags, name);
  if (!value) {
    return fallback;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return Number(value);
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value == null || value === "") {
    return fallback;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return Number(value);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  /(?:^|[/\\])discover\.ts$/.test(process.argv[1])
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[gateway:discover] ${message}`);
    process.exitCode = 1;
  });
}
