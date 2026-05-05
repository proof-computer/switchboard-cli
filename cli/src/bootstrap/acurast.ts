import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseRelayDeploymentSpec, type RelayDeploymentSpec } from "../../../src/relay-deployment-spec.js";
import { readLatestAcurastDeployState } from "../relay/acurast-deploy-state.js";
import { parseDuration } from "../relay/duration.js";
import { runRelayDeploy, type RelayCommandIo } from "../relay/index.js";
import { probeRelay, summarizeRelayStatus, type RelayStatusResult } from "../relay/status.js";
import {
  DEFAULT_SWITCHBOARD_OPS_PROFILE,
  SWITCHBOARD_OPS_PROFILE_ENV,
  normalizeSwitchboardProfileName,
  switchboardHomePaths
} from "../switchboard-home.js";
import { runBootstrapHostSubcommand } from "./host.js";

const DEFAULT_BOOTSTRAP_RELAY_ID = "bootstrap-acurast";
const BOOTSTRAP_STATE_FILE = "bootstrap-acurast.json";
const DEFAULT_BOOTSTRAP_PORT = "3000";
const DEFAULT_BOOTSTRAP_DURATION = "30m";

export interface BootstrapCommandIo extends RelayCommandIo {}

const DEFAULT_IO: BootstrapCommandIo = {
  log: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line)
};

export interface BootstrapAcurastArgs {
  flags: Map<string, string | boolean>;
  positionals: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  io?: BootstrapCommandIo;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  relayDeploy?: typeof runRelayDeploy;
}

interface BootstrapAcurastState {
  version: 1;
  kind: "acurast-direct";
  profile: string;
  relayId: string;
  endpointUrl?: string;
  deploymentId?: string;
  origin?: string;
  ipfsHash?: string;
  scriptHash?: string;
  managerId?: string;
  processor?: string;
  stageDir?: string;
  status: "planned" | "active" | "teardown-requested";
  startedAt?: string;
  expiresAt?: string;
  updatedAt: string;
  tornDownAt?: string;
}

export async function runBootstrapSubcommand(args: BootstrapAcurastArgs): Promise<void> {
  const transport = args.positionals[1];
  if (!transport || transport === "help") {
    printBootstrapUsage(args.io ?? DEFAULT_IO);
    return;
  }
  if (transport === "host") {
    await runBootstrapHostSubcommand(args);
    return;
  }
  if (transport !== "acurast") {
    throw new Error("Use `switchboard bootstrap acurast ...` or `switchboard bootstrap host ...`.");
  }
  await runBootstrapAcurastSubcommand(args);
}

export async function runBootstrapAcurastSubcommand(args: BootstrapAcurastArgs): Promise<void> {
  const io = args.io ?? DEFAULT_IO;
  const verb = args.positionals[2] ?? "status";

  if (verb === "help") {
    printBootstrapAcurastUsage(io);
    return;
  }
  if (verb === "plan") {
    await runPlan(args);
    return;
  }
  if (verb === "deploy") {
    await runDeploy(args);
    return;
  }
  if (verb === "use") {
    await runUse(args);
    return;
  }
  if (verb === "endpoint") {
    await runEndpoint(args);
    return;
  }
  if (verb === "status") {
    await runStatus(args);
    return;
  }
  if (verb === "teardown") {
    await runTeardown(args);
    return;
  }
  if (verb === "publish-catalog") {
    await runPublish(args, "service-catalogs");
    return;
  }
  if (verb === "publish-manifest") {
    await runPublish(args, "network-manifest");
    return;
  }

  throw new Error(`Unknown bootstrap acurast command: ${verb}`);
}

function printBootstrapUsage(io: BootstrapCommandIo): void {
  io.log(`switchboard bootstrap

Bootstrap Switchboard relay/control-plane infrastructure.

Commands:
  bootstrap acurast <cmd>   Manage a short-lived direct Acurast bootstrap relay.
  bootstrap host <cmd>      Manage the SSH/Docker bootstrap host.
`);
}

function printBootstrapAcurastUsage(io: BootstrapCommandIo): void {
  io.log(`switchboard bootstrap acurast

Commands:
  bootstrap acurast plan [relay-id] [--spec-file <path>] [--duration 30m]
      Print the temporary Acurast bootstrap deploy plan.
  bootstrap acurast deploy [relay-id] [--spec-file <path>] --yes
      Delegate to relay deploy and persist local bootstrap state.
  bootstrap acurast use --url <https-url>
      Record the temporary bootstrap endpoint under the ops profile.
  bootstrap acurast endpoint [--json]
      Print the active temporary bootstrap endpoint from local state/spec.
  bootstrap acurast status [--url <url>] [--json]
      Probe /health, /v1/relay-status, and /v1/service-catalogs/relay.
  bootstrap acurast publish-catalog --catalog-file <signed-json>
      PUT a signed catalog bundle to the temporary bootstrap relay.
  bootstrap acurast publish-manifest --manifest-file <signed-json>
      PUT a signed network manifest to the temporary bootstrap relay.
  bootstrap acurast teardown --yes
      Mark the temporary bootstrap as torn down locally.

Flags:
  --profile <name>              Ops profile, default ${DEFAULT_SWITCHBOARD_OPS_PROFILE}.
  --relay-id <id>               Default ${DEFAULT_BOOTSTRAP_RELAY_ID}.
  --url <url>                   Temporary bootstrap endpoint URL.
  --allow-insecure-bootstrap    Allow non-local http:// endpoints.
`);
}

async function runPlan(args: BootstrapAcurastArgs): Promise<void> {
  const io = args.io ?? DEFAULT_IO;
  validateBootstrapPort(args.flags);
  const relayId = relayIdFromArgs(args);
  const profile = profileFromArgs(args);
  const stateFile = statePath(args, profile);
  io.log("bootstrap acurast plan");
  io.log(`  profile    : ${profile}`);
  io.log(`  relay id   : ${relayId}`);
  io.log(`  state file : ${stateFile}`);
  io.log(`  transport  : direct Acurast IPv6 / explicit-port bootstrap`);
  io.log(`  default port/duration: ${DEFAULT_BOOTSTRAP_PORT} / ${DEFAULT_BOOTSTRAP_DURATION}`);
  io.log("");

  const relayFlags = relayDeployFlags(args.flags, {
    dryRun: true,
    noCatalogDefault: true
  });
  await (args.relayDeploy ?? runRelayDeploy)({
    flags: relayFlags,
    positionals: ["relay", "deploy", relayId],
    io,
    skipReadinessPoll: true,
    skipPeerCheck: true
  });
}

async function runDeploy(args: BootstrapAcurastArgs): Promise<void> {
  const io = args.io ?? DEFAULT_IO;
  validateBootstrapPort(args.flags);
  const relayId = relayIdFromArgs(args);
  const profile = profileFromArgs(args);
  const spec = await readRelaySpec(args, relayId);
  if (spec.target !== "acurast") {
    throw new Error(`bootstrap acurast deploy requires target=acurast; ${relayId} has target=${spec.target}`);
  }

  const relayFlags = relayDeployFlags(args.flags, {
    dryRun: false,
    noCatalogDefault: true
  });
  await (args.relayDeploy ?? runRelayDeploy)({
    flags: relayFlags,
    positionals: ["relay", "deploy", relayId],
    io
  });

  const latest = spec.acurast?.stageDir
    ? await readLatestAcurastDeployState(resolveStageDir(args, spec)).catch(() => undefined)
    : undefined;
  const endpointUrl = normalizeUrl(
    stringFlag(args.flags, "url") ??
      stringFlag(args.flags, "api-base-url") ??
      spec.apiBaseUrl
  );
  assertBootstrapUrlSafe(endpointUrl, args.flags, true);
  const now = (args.now ?? (() => new Date()))();
  const state: BootstrapAcurastState = {
    ...(await loadState(args, profile).catch(() => undefined)),
    version: 1,
    kind: "acurast-direct",
    profile,
    relayId,
    endpointUrl,
    deploymentId: latest?.deploymentId,
    origin: latest?.origin,
    ipfsHash: latest?.ipfsHash,
    managerId: spec.acurast?.managerId,
    processor: spec.acurast?.instantMatchProcessors[0],
    stageDir: spec.acurast?.stageDir,
    status: "active",
    startedAt: now.toISOString(),
    expiresAt: expiresAtFromSpec(args, spec, now),
    updatedAt: now.toISOString()
  };
  await writeState(args, profile, state);
  printStateSummary(io, state, statePath(args, profile));
}

async function runUse(args: BootstrapAcurastArgs): Promise<void> {
  const io = args.io ?? DEFAULT_IO;
  const profile = profileFromArgs(args);
  const relayId = relayIdFromArgs(args);
  const rawUrl = stringFlag(args.flags, "url") ?? args.positionals[3];
  if (!rawUrl) {
    throw new Error("Usage: switchboard bootstrap acurast use --url <https-url>");
  }
  const endpointUrl = normalizeUrl(rawUrl);
  assertBootstrapUrlSafe(endpointUrl, args.flags, true);
  const now = (args.now ?? (() => new Date()))();
  const previous = await loadState(args, profile).catch(() => undefined);
  const state: BootstrapAcurastState = {
    ...previous,
    version: 1,
    kind: "acurast-direct",
    profile,
    relayId: previous?.relayId ?? relayId,
    endpointUrl,
    status: "active",
    updatedAt: now.toISOString()
  };
  await writeState(args, profile, state);
  printStateSummary(io, state, statePath(args, profile));
  io.log("");
  io.log("fish:");
  io.log(`  set -gx SWITCHBOARD_BOOTSTRAP_URL ${shellQuote(endpointUrl)}`);
  io.log(`  set -gx PROOF_CONTROL_PLANE_URL ${shellQuote(endpointUrl)}`);
}

async function runEndpoint(args: BootstrapAcurastArgs): Promise<void> {
  const io = args.io ?? DEFAULT_IO;
  const profile = profileFromArgs(args);
  const endpointUrl = await resolveEndpointUrl(args, profile, { allowSpec: true });
  if (boolFlag(args.flags, "json")) {
    io.log(JSON.stringify({ ok: true, url: endpointUrl }, null, 2));
  } else {
    io.log(endpointUrl);
  }
}

async function runStatus(args: BootstrapAcurastArgs): Promise<void> {
  const io = args.io ?? DEFAULT_IO;
  const profile = profileFromArgs(args);
  const state = await loadState(args, profile).catch(() => undefined);
  const relayId = state?.relayId ?? relayIdFromArgs(args);
  const endpointUrl = await resolveEndpointUrl(args, profile, { allowSpec: true });
  const timeoutMs = integerFlag(args.flags, "timeout-ms", 5_000);
  const result = await probeRelay(
    { relayId, apiBaseUrl: endpointUrl, state: state?.status === "teardown-requested" ? "disabled" : "candidate" },
    { timeoutMs, fetchImpl: args.fetchImpl }
  );

  if (boolFlag(args.flags, "json")) {
    io.log(JSON.stringify({ ok: probeOk(result), state, probe: result }, null, 2));
    return;
  }

  io.log("bootstrap acurast status");
  if (state) {
    io.log(`  profile    : ${state.profile}`);
    io.log(`  relay id   : ${state.relayId}`);
    io.log(`  state      : ${state.status}`);
    if (state.deploymentId) io.log(`  deployment : ${state.deploymentId}`);
    if (state.expiresAt) io.log(`  expires    : ${state.expiresAt}`);
  } else {
    io.log(`  profile    : ${profile}`);
    io.log("  state      : (no local bootstrap state)");
  }
  io.log("");
  for (const line of summarizeRelayStatus(result)) io.log(line);
}

async function runTeardown(args: BootstrapAcurastArgs): Promise<void> {
  const io = args.io ?? DEFAULT_IO;
  const profile = profileFromArgs(args);
  const yes = boolFlag(args.flags, "yes") || (args.env ?? process.env).SWITCHBOARD_BOOTSTRAP_ASSUME_YES === "true";
  if (!yes) {
    throw new Error("Refusing to mark bootstrap teardown without --yes");
  }
  const previous = await loadState(args, profile).catch(() => undefined);
  if (!previous) {
    throw new Error(`No bootstrap acurast state found at ${statePath(args, profile)}`);
  }
  const now = (args.now ?? (() => new Date()))();
  const state: BootstrapAcurastState = {
    ...previous,
    status: "teardown-requested",
    tornDownAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  await writeState(args, profile, state);
  printStateSummary(io, state, statePath(args, profile));
  io.warn("Acurast stop/remove is not wired yet; this command records local teardown state. Let the short schedule expire or stop the job with Acurast tooling if needed.");
}

async function runPublish(args: BootstrapAcurastArgs, kind: "service-catalogs" | "network-manifest"): Promise<void> {
  const io = args.io ?? DEFAULT_IO;
  const profile = profileFromArgs(args);
  const endpointUrl = await resolveEndpointUrl(args, profile, { allowSpec: true });
  assertBootstrapUrlSafe(endpointUrl, args.flags, true);

  const fileFlag = kind === "service-catalogs" ? "catalog-file" : "manifest-file";
  const filePath = stringFlag(args.flags, fileFlag);
  if (!filePath) {
    throw new Error(`Usage: switchboard bootstrap acurast publish-${kind === "service-catalogs" ? "catalog" : "manifest"} --${fileFlag} <signed-json>`);
  }
  const tokenEnv = stringFlag(args.flags, "token-env") ?? "PROOF_CONTROL_PLANE_TOKEN";
  const token = (args.env ?? process.env)[tokenEnv];
  if (!token) {
    throw new Error(
      `${tokenEnv} is not set; pass --token-env <NAME> or add it to ` +
        `${switchboardHomePaths({ opsProfile: profile, env: args.env ?? process.env }).opsSecretFile}`
    );
  }
  const body = await readFile(path.resolve(args.cwd ?? process.cwd(), filePath), "utf8");
  JSON.parse(body);
  const pathSuffix = kind === "service-catalogs" ? "/v1/admin/service-catalogs" : "/v1/admin/network-manifest";
  const url = new URL(pathSuffix, `${endpointUrl}/`).toString();
  const response = await (args.fetchImpl ?? fetch)(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`publish ${kind} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  if (boolFlag(args.flags, "json")) {
    io.log(JSON.stringify({ ok: true, url, status: response.status, response: parseJsonMaybe(text) }, null, 2));
  } else {
    io.log(`Published ${kind} to ${url} (HTTP ${response.status})`);
  }
}

function relayDeployFlags(flags: Map<string, string | boolean>, options: { dryRun: boolean; noCatalogDefault: boolean }): Map<string, string | boolean> {
  const next = new Map(flags);
  next.set("target", "acurast");
  if (options.dryRun) next.set("dry-run", true);
  if (options.noCatalogDefault && !boolFlag(flags, "catalog")) {
    next.set("no-catalog", true);
  }
  const endpointUrl = stringFlag(flags, "url");
  if (endpointUrl && !stringFlag(next, "api-base-url")) {
    next.set("api-base-url", endpointUrl);
  }
  if (!stringFlag(next, "duration")) {
    next.set("duration", DEFAULT_BOOTSTRAP_DURATION);
  }
  return next;
}

function validateBootstrapPort(flags: Map<string, string | boolean>): void {
  const port = stringFlag(flags, "port");
  if (port && port !== DEFAULT_BOOTSTRAP_PORT) {
    throw new Error(`bootstrap acurast currently supports only --port ${DEFAULT_BOOTSTRAP_PORT}; got ${port}`);
  }
}

function relayIdFromArgs(args: BootstrapAcurastArgs): string {
  const relayId = stringFlag(args.flags, "relay-id") ?? args.positionals[3] ?? DEFAULT_BOOTSTRAP_RELAY_ID;
  if (!/^[a-z0-9-]+$/.test(relayId)) {
    throw new Error(`Invalid bootstrap relay id ${JSON.stringify(relayId)}; expected /^[a-z0-9-]+$/`);
  }
  return relayId;
}

function profileFromArgs(args: BootstrapAcurastArgs): string {
  const env = args.env ?? process.env;
  return normalizeSwitchboardProfileName(
    stringFlag(args.flags, "ops-profile") ??
      stringFlag(args.flags, "profile") ??
      env[SWITCHBOARD_OPS_PROFILE_ENV] ??
      DEFAULT_SWITCHBOARD_OPS_PROFILE
  );
}

function statePath(args: BootstrapAcurastArgs, profile: string): string {
  const explicit = stringFlag(args.flags, "state-file");
  if (explicit) return path.resolve(args.cwd ?? process.cwd(), explicit);
  return path.join(switchboardHomePaths({ opsProfile: profile, env: args.env ?? process.env }).opsDir, BOOTSTRAP_STATE_FILE);
}

async function loadState(args: BootstrapAcurastArgs, profile: string): Promise<BootstrapAcurastState | undefined> {
  const filePath = statePath(args, profile);
  const raw = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as BootstrapAcurastState;
  if (parsed.version !== 1 || parsed.kind !== "acurast-direct") {
    throw new Error(`${filePath}: invalid bootstrap acurast state`);
  }
  return parsed;
}

async function writeState(args: BootstrapAcurastArgs, profile: string, state: BootstrapAcurastState): Promise<void> {
  const filePath = statePath(args, profile);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function readRelaySpec(args: BootstrapAcurastArgs, relayId: string): Promise<RelayDeploymentSpec> {
  const cwd = args.cwd ?? process.cwd();
  const specPath = stringFlag(args.flags, "spec-file") ?? stringFlag(args.flags, "spec") ?? path.join(cwd, "relays", `${relayId}.json`);
  const raw = await readFile(specPath, "utf8").catch(() => {
    throw new Error(`Spec ${specPath} not found. Create it or pass --spec-file <path>.`);
  });
  const spec = parseRelayDeploymentSpec(JSON.parse(raw));
  if (spec.relayId !== relayId) {
    throw new Error(`Spec at ${specPath} declares relayId=${spec.relayId}, but command was invoked for ${relayId}`);
  }
  return spec;
}

async function resolveEndpointUrl(
  args: BootstrapAcurastArgs,
  profile: string,
  options: { allowSpec: boolean }
): Promise<string> {
  const explicit =
    stringFlag(args.flags, "url") ??
    stringFlag(args.flags, "api-base-url") ??
    stringFlag(args.flags, "endpoint");
  if (explicit) return normalizeUrl(explicit);
  const state = await loadState(args, profile).catch(() => undefined);
  if (state?.endpointUrl) return normalizeUrl(state.endpointUrl);
  if (options.allowSpec) {
    const relayId = relayIdFromArgs(args);
    const spec = await readRelaySpec(args, relayId).catch(() => undefined);
    if (spec?.apiBaseUrl) return normalizeUrl(spec.apiBaseUrl);
  }
  throw new Error("No bootstrap endpoint found. Pass --url <url> or run `switchboard bootstrap acurast use --url <url>`.");
}

function resolveStageDir(args: BootstrapAcurastArgs, spec: RelayDeploymentSpec): string {
  const cwd = args.cwd ?? process.cwd();
  const stageDir = spec.acurast?.stageDir ?? "";
  return path.isAbsolute(stageDir) ? stageDir : path.resolve(cwd, stageDir);
}

function expiresAtFromSpec(args: BootstrapAcurastArgs, spec: RelayDeploymentSpec, now: Date): string | undefined {
  const rawDuration = stringFlag(args.flags, "duration");
  const durationMs = rawDuration
    ? parseDuration(rawDuration)
    : spec.acurast?.executionMs;
  return durationMs ? new Date(now.getTime() + durationMs).toISOString() : undefined;
}

function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  return url.toString().replace(/\/+$/, "");
}

function assertBootstrapUrlSafe(rawUrl: string, flags: Map<string, string | boolean>, carriesSecrets: boolean): void {
  if (!carriesSecrets) return;
  const url = new URL(rawUrl);
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLocalHostname(url.hostname)) return;
  if (boolFlag(flags, "allow-insecure-bootstrap")) return;
  throw new Error(
    `Refusing to use insecure bootstrap URL ${rawUrl} for token-bearing operations; pass --allow-insecure-bootstrap only for controlled smoke tests`
  );
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function printStateSummary(io: BootstrapCommandIo, state: BootstrapAcurastState, filePath: string): void {
  io.log("bootstrap acurast state");
  io.log(`  state file : ${filePath}`);
  io.log(`  profile    : ${state.profile}`);
  io.log(`  relay id   : ${state.relayId}`);
  io.log(`  status     : ${state.status}`);
  if (state.endpointUrl) io.log(`  endpoint   : ${state.endpointUrl}`);
  if (state.deploymentId) io.log(`  deployment : ${state.deploymentId}`);
  if (state.expiresAt) io.log(`  expires    : ${state.expiresAt}`);
}

function probeOk(result: RelayStatusResult): boolean {
  return result.health.ok && result.relayStatus.ok && result.relayCatalog.ok;
}

function parseJsonMaybe(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerFlag(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  const value = stringFlag(flags, name);
  if (!value) return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`--${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}
