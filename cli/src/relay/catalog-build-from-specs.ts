import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { runCatalogBuild } from "../catalog/index.js";
import { readRelayCatalogStore } from "./catalog.js";
import {
  type RelayCatalogInputEntry,
  type ServiceState
} from "../../../src/service-catalog.js";
import { safeParseRelayDeploymentSpec } from "../../../src/relay-deployment-spec.js";

export interface RunRelayCatalogBuildOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  cwd?: string;
}

export interface RelayCatalogBuildResult {
  specsDir: string;
  entries: RelayCatalogInputEntry[];
  outputFile?: string;
  signer: string;
}

/**
 * Build the signed catalog bundle from the relays/<id>.json spec files +
 * the persisted state in relays/catalog.json. The state file is the source
 * of truth for catalogState; the spec files are the source of truth for
 * apiBaseUrl, validationReportUrl, controlPlaneUrl.
 */
export async function runRelayCatalogBuild(options: RunRelayCatalogBuildOptions): Promise<RelayCatalogBuildResult> {
  const io = options.io ?? defaultIo();
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const specsDir = stringFlag(options.flags, "specs-dir") ?? path.join(cwd, "relays");
  const specs = await loadSpecs(specsDir);
  if (specs.length === 0) {
    throw new Error(
      `relay catalog build found no spec files in ${specsDir}. Run \`switchboard relay sync\` to bootstrap, or scaffold a spec.`
    );
  }
  io.log(`Found ${specs.length} relay spec(s) in ${specsDir}`);

  const stateById = await loadStateMap(cwd);

  const entries: RelayCatalogInputEntry[] = specs.map((spec) => {
    const recordedState = stateById.get(spec.relayId);
    const state: ServiceState = recordedState ?? spec.catalogState;
    return {
      relayId: spec.relayId,
      apiBaseUrl: spec.apiBaseUrl,
      ...(spec.validationReportUrl ? { validationReportUrl: spec.validationReportUrl } : {}),
      ...(spec.controlPlaneUrl ? { controlPlaneUrl: spec.controlPlaneUrl } : {}),
      state
    };
  });

  // Hand off to the existing catalog build pipeline by injecting the
  // derived relay JSON via the env channel runCatalogBuild already
  // honors. control-api inputs still come from env / --spec.
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    PROOF_NETWORK_MANIFEST_RELAYS_JSON: JSON.stringify(entries)
  };
  const result = await runCatalogBuild({
    flags: passThroughFlags(options.flags),
    env: childEnv,
    io
  });

  return {
    specsDir,
    entries,
    outputFile: stringFlag(options.flags, "output") ?? env.PROOF_SERVICE_CATALOGS_OUTPUT_FILE,
    signer: result.signer
  };
}

interface SpecSummary {
  relayId: string;
  apiBaseUrl: string;
  validationReportUrl?: string;
  controlPlaneUrl?: string;
  catalogState: ServiceState;
  target: string;
}

async function loadSpecs(specsDir: string): Promise<SpecSummary[]> {
  let names: string[];
  try {
    names = await readdir(specsDir);
  } catch {
    return [];
  }
  const specs: SpecSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (name === "catalog.json") continue;
    const filePath = path.join(specsDir, name);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = safeParseRelayDeploymentSpec(parsed);
    if (!result.ok) {
      // Skip stub specs (from `relay sync`) — they are intentionally not
      // a complete RelayDeploymentSpec until reviewed/edited.
      const obj = parsed as Record<string, unknown>;
      if (obj && typeof obj.relayId === "string" && typeof obj.apiBaseUrl === "string") {
        specs.push({
          relayId: obj.relayId,
          apiBaseUrl: obj.apiBaseUrl,
          validationReportUrl: typeof obj.validationReportUrl === "string" ? obj.validationReportUrl : undefined,
          controlPlaneUrl: typeof obj.controlPlaneUrl === "string" ? obj.controlPlaneUrl : undefined,
          catalogState: (typeof obj.catalogState === "string" ? obj.catalogState : "active") as ServiceState,
          target: typeof obj.target === "string" ? obj.target : "unknown"
        });
      }
      continue;
    }
    specs.push({
      relayId: result.spec.relayId,
      apiBaseUrl: result.spec.apiBaseUrl,
      validationReportUrl: result.spec.validationReportUrl,
      controlPlaneUrl: result.spec.controlPlaneUrl,
      catalogState: result.spec.catalogState,
      target: result.spec.target
    });
  }
  return specs.sort((a, b) => a.relayId.localeCompare(b.relayId));
}

async function loadStateMap(cwd: string): Promise<Map<string, ServiceState>> {
  const map = new Map<string, ServiceState>();
  const store = await readRelayCatalogStore(cwd).catch(() => null);
  if (!store) return map;
  for (const entry of store.entries) {
    const state = entry.state ?? (entry.active === false ? "disabled" : "active");
    map.set(entry.relayId, state);
  }
  return map;
}

function passThroughFlags(flags: Map<string, string | boolean>): Map<string, string | boolean> {
  const next = new Map<string, string | boolean>();
  for (const key of ["output", "output-file", "stdout", "signing-key", "signing-scheme"]) {
    const value = flags.get(key);
    if (value !== undefined) next.set(key, value);
  }
  return next;
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function defaultIo() {
  return {
    log: (line: string) => console.log(line),
    warn: (line: string) => console.warn(line),
    error: (line: string) => console.error(line)
  };
}
