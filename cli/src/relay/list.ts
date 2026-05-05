import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  discoverServices,
  resolveRelayInventoryMembers
} from "../../../src/service-discovery.js";
import { readRelayCatalogStore } from "./catalog.js";

export interface RunRelayListOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  fetchImpl?: typeof fetch;
  cwd?: string;
}

export interface RelayListEntry {
  relayId: string;
  apiBaseUrl?: string;
  state?: string;
  target?: string;
  signer?: string;
  sequence?: number;
  issuedAt?: string;
  expiresAt?: string;
  source: "local" | "live";
}

export async function runRelayList(options: RunRelayListOptions): Promise<RelayListEntry[]> {
  const io = options.io ?? defaultIo();
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const source = (stringFlag(options.flags, "source") ?? "local") as "local" | "live";
  if (source !== "local" && source !== "live") {
    throw new Error(`--source must be local or live (got ${source})`);
  }

  const entries = source === "live"
    ? await listLive(options, env)
    : await listLocal(cwd);

  if (boolFlag(options.flags, "json")) {
    io.log(JSON.stringify(entries, null, 2));
  } else {
    printTable(entries, source, io);
  }
  return entries;
}

async function listLive(options: RunRelayListOptions, env: NodeJS.ProcessEnv): Promise<RelayListEntry[]> {
  const manifestUrl = stringFlag(options.flags, "manifest-url") ?? env.PROOF_NETWORK_MANIFEST_URL;
  if (!manifestUrl) {
    throw new Error("relay list --source live requires --manifest-url <url> or PROOF_NETWORK_MANIFEST_URL");
  }
  const expectedSigner = stringFlag(options.flags, "manifest-signer") ?? env.PROOF_NETWORK_MANIFEST_SIGNER;
  const discovery = await discoverServices({
    manifestUrlCandidates: [manifestUrl],
    expectedManifestSigner: expectedSigner,
    allowUnpinnedManifestSigner: !expectedSigner,
    fetchImpl: options.fetchImpl
  });
  const relayCatalog = discovery.catalogs.relays;
  const members = resolveRelayInventoryMembers(discovery);
  return members.map((member) => ({
    relayId: member.relayId,
    apiBaseUrl: member.apiBaseUrl,
    state: member.state ?? (member.active === false ? "disabled" : "active"),
    signer: relayCatalog?.signer,
    sequence: relayCatalog?.catalog.sequence,
    issuedAt: relayCatalog?.catalog.issuedAt,
    expiresAt: relayCatalog?.catalog.expiresAt,
    source: "live"
  }));
}

async function listLocal(cwd: string): Promise<RelayListEntry[]> {
  const store = await readRelayCatalogStore(cwd).catch(() => null);
  const stateById = new Map<string, string>();
  if (store) {
    for (const entry of store.entries) {
      stateById.set(entry.relayId, entry.state ?? (entry.active === false ? "disabled" : "active"));
    }
  }

  const specs = await readSpecFiles(path.join(cwd, "relays"));
  const merged = new Map<string, RelayListEntry>();

  if (store) {
    for (const entry of store.entries) {
      merged.set(entry.relayId, {
        relayId: entry.relayId,
        apiBaseUrl: entry.apiBaseUrl,
        state: entry.state ?? (entry.active === false ? "disabled" : "active"),
        source: "local"
      });
    }
  }
  for (const spec of specs) {
    const existing = merged.get(spec.relayId);
    merged.set(spec.relayId, {
      relayId: spec.relayId,
      apiBaseUrl: spec.apiBaseUrl ?? existing?.apiBaseUrl,
      target: spec.target,
      state: existing?.state ?? stateById.get(spec.relayId) ?? spec.catalogState,
      source: "local"
    });
  }
  return [...merged.values()].sort((a, b) => a.relayId.localeCompare(b.relayId));
}

interface SpecSummary {
  relayId: string;
  apiBaseUrl?: string;
  target?: string;
  catalogState?: string;
}

async function readSpecFiles(dir: string): Promise<SpecSummary[]> {
  let names: string[];
  try {
    const fs = await import("node:fs/promises");
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const specs: SpecSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (name === "catalog.json") continue;
    try {
      const raw = await readFile(path.join(dir, name), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.relayId !== "string") continue;
      specs.push({
        relayId: parsed.relayId,
        apiBaseUrl: typeof parsed.apiBaseUrl === "string" ? parsed.apiBaseUrl : undefined,
        target: typeof parsed.target === "string" ? parsed.target : undefined,
        catalogState: typeof parsed.catalogState === "string" ? parsed.catalogState : undefined
      });
    } catch {
      // skip malformed files
    }
  }
  return specs;
}

function printTable(entries: RelayListEntry[], source: "local" | "live", io: { log: (l: string) => void }): void {
  if (entries.length === 0) {
    io.log(`(no relays found in ${source} source)`);
    return;
  }
  io.log(`source: ${source}`);
  for (const entry of entries) {
    const target = entry.target ? ` target=${entry.target}` : "";
    const seq = entry.sequence !== undefined ? ` sequence=${entry.sequence}` : "";
    const sig = entry.signer ? ` signer=${entry.signer.slice(0, 16)}…` : "";
    io.log(`  ${entry.relayId.padEnd(12)} state=${(entry.state ?? "?").padEnd(10)} ${entry.apiBaseUrl ?? "(no url)"}${target}${seq}${sig}`);
  }
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function defaultIo() {
  return {
    log: (line: string) => console.log(line),
    warn: (line: string) => console.warn(line),
    error: (line: string) => console.error(line)
  };
}
