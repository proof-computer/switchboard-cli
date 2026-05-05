import {
  discoverServices,
  resolveRelayInventoryMembers,
  type RelayDiscoveryMember
} from "../../../src/service-discovery.js";
import { readRelayCatalogStore } from "./catalog.js";

export interface RunRelayDiffOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  fetchImpl?: typeof fetch;
  cwd?: string;
}

export interface RelayDiffEntry {
  relayId: string;
  change: "add" | "remove" | "state-change" | "url-change" | "unchanged";
  liveState?: string;
  localState?: string;
  liveApiBaseUrl?: string;
  localApiBaseUrl?: string;
}

export interface RelayDiffResult {
  manifestUrl: string;
  liveSigner?: string;
  liveSequence?: number;
  liveIssuedAt?: string;
  entries: RelayDiffEntry[];
}

export async function runRelayDiff(options: RunRelayDiffOptions): Promise<RelayDiffResult> {
  const io = options.io ?? defaultIo();
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const manifestUrl = stringFlag(options.flags, "manifest-url") ?? env.PROOF_NETWORK_MANIFEST_URL;
  if (!manifestUrl) {
    throw new Error("relay diff requires --manifest-url <url> or PROOF_NETWORK_MANIFEST_URL");
  }
  const expectedSigner = stringFlag(options.flags, "manifest-signer") ?? env.PROOF_NETWORK_MANIFEST_SIGNER;

  const discovery = await discoverServices({
    manifestUrlCandidates: [manifestUrl],
    expectedManifestSigner: expectedSigner,
    allowUnpinnedManifestSigner: !expectedSigner,
    fetchImpl: options.fetchImpl
  });
  const live = resolveRelayInventoryMembers(discovery);
  const liveById = new Map<string, RelayDiscoveryMember>(live.map((m) => [m.relayId, m]));

  const store = await readRelayCatalogStore(cwd).catch(() => null);
  const localById = new Map<string, { relayId: string; apiBaseUrl: string; state: string }>();
  if (store) {
    for (const entry of store.entries) {
      localById.set(entry.relayId, {
        relayId: entry.relayId,
        apiBaseUrl: entry.apiBaseUrl,
        state: entry.state ?? (entry.active === false ? "disabled" : "active")
      });
    }
  }

  const ids = new Set([...liveById.keys(), ...localById.keys()]);
  const entries: RelayDiffEntry[] = [];
  for (const id of [...ids].sort()) {
    const liveMember = liveById.get(id);
    const localEntry = localById.get(id);
    const liveState = liveMember ? (liveMember.state ?? (liveMember.active === false ? "disabled" : "active")) : undefined;

    if (liveMember && !localEntry) {
      entries.push({
        relayId: id,
        change: "remove",
        liveState,
        liveApiBaseUrl: liveMember.apiBaseUrl
      });
      continue;
    }
    if (!liveMember && localEntry) {
      entries.push({
        relayId: id,
        change: "add",
        localState: localEntry.state,
        localApiBaseUrl: localEntry.apiBaseUrl
      });
      continue;
    }
    if (!liveMember || !localEntry) continue;

    const stateChanged = liveState !== localEntry.state;
    const urlChanged = liveMember.apiBaseUrl !== localEntry.apiBaseUrl;
    if (stateChanged || urlChanged) {
      entries.push({
        relayId: id,
        change: stateChanged ? "state-change" : "url-change",
        liveState,
        localState: localEntry.state,
        liveApiBaseUrl: liveMember.apiBaseUrl,
        localApiBaseUrl: localEntry.apiBaseUrl
      });
      continue;
    }
    entries.push({
      relayId: id,
      change: "unchanged",
      liveState,
      localState: localEntry.state,
      liveApiBaseUrl: liveMember.apiBaseUrl,
      localApiBaseUrl: localEntry.apiBaseUrl
    });
  }

  const result: RelayDiffResult = {
    manifestUrl: discovery.manifestUrl,
    liveSigner: discovery.catalogs.relays?.signer,
    liveSequence: discovery.catalogs.relays?.catalog.sequence,
    liveIssuedAt: discovery.catalogs.relays?.catalog.issuedAt,
    entries
  };

  if (boolFlag(options.flags, "json")) {
    io.log(JSON.stringify(result, null, 2));
  } else {
    printHumanReadable(result, io);
  }
  return result;
}

function printHumanReadable(result: RelayDiffResult, io: { log: (l: string) => void }): void {
  io.log(`live: ${result.manifestUrl}`);
  if (result.liveSequence !== undefined) {
    io.log(`  sequence=${result.liveSequence} issuedAt=${result.liveIssuedAt} signer=${result.liveSigner?.slice(0, 16)}…`);
  }
  io.log("");
  const grouped: Record<string, RelayDiffEntry[]> = { add: [], remove: [], "state-change": [], "url-change": [], unchanged: [] };
  for (const entry of result.entries) grouped[entry.change].push(entry);

  if (grouped.add.length === 0 && grouped.remove.length === 0 && grouped["state-change"].length === 0 && grouped["url-change"].length === 0) {
    io.log("Local matches live — no changes pending.");
    return;
  }

  for (const entry of grouped.add) {
    io.log(`+ ${entry.relayId}  (would add: state=${entry.localState} url=${entry.localApiBaseUrl})`);
  }
  for (const entry of grouped.remove) {
    io.log(`- ${entry.relayId}  (would remove: live state=${entry.liveState} url=${entry.liveApiBaseUrl})`);
  }
  for (const entry of grouped["state-change"]) {
    io.log(`~ ${entry.relayId}  (state: ${entry.liveState} -> ${entry.localState})`);
  }
  for (const entry of grouped["url-change"]) {
    io.log(`~ ${entry.relayId}  (url: ${entry.liveApiBaseUrl} -> ${entry.localApiBaseUrl})`);
  }
  if (grouped.unchanged.length > 0) {
    io.log("");
    io.log(`unchanged: ${grouped.unchanged.map((e) => e.relayId).join(", ")}`);
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
