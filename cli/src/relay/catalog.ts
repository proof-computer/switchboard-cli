import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  relayCatalogInputArraySchema,
  type RelayCatalogInputEntry,
  type ServiceState
} from "../../../src/service-catalog.js";
import { runCatalogBuild, type RunCatalogBuildOptions } from "../catalog/index.js";

export const DEFAULT_RELAY_CATALOG_FILES = [
  "relays/catalog.json",
  ".switchboard/relays.json",
  ".switchboard/relays.json"
] as const;

export interface RelayCatalogStore {
  filePath: string;
  entries: RelayCatalogInputEntry[];
}

export async function readRelayCatalogStore(
  cwd: string,
  override?: string
): Promise<RelayCatalogStore> {
  const candidates = override ? [override] : DEFAULT_RELAY_CATALOG_FILES.map((c) => path.join(cwd, c));
  const errors: Array<{ candidate: string; message: string }> = [];
  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    const raw = await readFile(resolved, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      errors.push({ candidate: resolved, message: error.message });
      return undefined;
    });
    if (raw === undefined) continue;
    const parsed = JSON.parse(raw) as unknown;
    const entries = relayCatalogInputArraySchema.parse(parsed);
    return { filePath: resolved, entries };
  }
  const tried = candidates.map((c) => `  - ${c}`).join("\n");
  const errSuffix = errors.length > 0 ? `\nErrors:\n${errors.map((e) => `  - ${e.candidate}: ${e.message}`).join("\n")}` : "";
  throw new Error(
    `Could not read a relay catalog file. Tried:\n${tried}${errSuffix}\nPass --catalog-file <path> to override.`
  );
}

export function withRelayCatalogState(
  entries: RelayCatalogInputEntry[],
  relayId: string,
  state: ServiceState
): RelayCatalogInputEntry[] {
  let found = false;
  const next = entries.map((entry) => {
    if (entry.relayId !== relayId) return entry;
    found = true;
    const { active: _legacyActive, ...rest } = entry;
    return { ...rest, state };
  });
  if (!found) {
    throw new Error(
      `relay ${relayId} is not present in the catalog file. Add the entry first (relayId, apiBaseUrl) before set-state.`
    );
  }
  return next;
}

export interface UpsertRelayCatalogEntryInput {
  relayId: string;
  apiBaseUrl: string;
  validationReportUrl?: string;
  controlPlaneUrl?: string;
  state: ServiceState;
}

export function upsertRelayCatalogEntry(
  entries: RelayCatalogInputEntry[],
  input: UpsertRelayCatalogEntryInput
): RelayCatalogInputEntry[] {
  const existing = entries.find((entry) => entry.relayId === input.relayId);
  if (existing) {
    return entries.map((entry) => {
      if (entry.relayId !== input.relayId) return entry;
      const { active: _legacyActive, ...rest } = entry;
      return {
        ...rest,
        apiBaseUrl: input.apiBaseUrl,
        ...(input.validationReportUrl ? { validationReportUrl: input.validationReportUrl } : {}),
        ...(input.controlPlaneUrl ? { controlPlaneUrl: input.controlPlaneUrl } : {}),
        state: input.state
      };
    });
  }
  return [
    ...entries,
    {
      relayId: input.relayId,
      apiBaseUrl: input.apiBaseUrl,
      ...(input.validationReportUrl ? { validationReportUrl: input.validationReportUrl } : {}),
      ...(input.controlPlaneUrl ? { controlPlaneUrl: input.controlPlaneUrl } : {}),
      state: input.state
    }
  ];
}

export async function writeRelayCatalogStore(store: RelayCatalogStore): Promise<void> {
  await mkdir(path.dirname(store.filePath), { recursive: true });
  await writeFile(store.filePath, `${JSON.stringify(store.entries, null, 2)}\n`, "utf8");
}

export interface RebuildSignedCatalogOptions {
  cwd?: string;
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  /** Override env passed into the in-process catalog build. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Replace the build runner. Used by tests. */
  build?: (options: RunCatalogBuildOptions) => Promise<unknown>;
}

export async function rebuildSignedRelayCatalog(
  store: RelayCatalogStore,
  options: RebuildSignedCatalogOptions = {}
): Promise<void> {
  const io = options.io ?? {
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
    error: (line) => console.error(line)
  };

  const baseEnv = options.env ?? process.env;
  const signingKey =
    baseEnv.PROOF_SERVICE_CATALOG_SIGNING_KEY ?? baseEnv.PROOF_MAINNET_MANIFEST_SIGNING_KEY;
  if (!signingKey) {
    throw new Error(
      "PROOF_SERVICE_CATALOG_SIGNING_KEY (or PROOF_MAINNET_MANIFEST_SIGNING_KEY) must be set in the calling shell to sign the catalog"
    );
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    PROOF_SERVICE_CATALOG_SIGNING_KEY: signingKey,
    PROOF_NETWORK_MANIFEST_RELAYS_JSON: JSON.stringify(store.entries)
  };

  io.log("Rebuilding signed service catalogs in-process");
  const build = options.build ?? runCatalogBuild;
  await build({
    flags: new Map<string, string | boolean>(),
    env: childEnv,
    io
  });
}
