import {
  discoverServices,
  resolveRelayInventoryMembers
} from "../../../src/service-discovery.js";
import { readRelayCatalogStore } from "./catalog.js";
import { probeRelay, type RelayStatusResult } from "./status.js";
import { checkPeerReachability } from "./readiness.js";
import {
  type RelayCatalogInputEntry
} from "../../../src/service-catalog.js";

export interface RunRelayVerifyOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  fetchImpl?: typeof fetch;
  cwd?: string;
}

export interface RelayVerifyResult {
  relayId: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  ok: boolean;
}

/**
 * Comprehensive pre-flight against a deployed relay. Beyond the three
 * HTTP probes of `relay status`, this also checks:
 *
 *   - The catalog member's apiBaseUrl matches the local spec.
 *   - The live signed catalog contains the relay (publish reached
 *     bootstrap).
 *   - All declared peers are reachable via /health.
 *   - The relay's reported relayId matches the spec.
 *
 * Use as a final gate before promotion.
 */
export async function runRelayVerify(options: RunRelayVerifyOptions): Promise<RelayVerifyResult> {
  const io = options.io ?? defaultIo();
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  // positionals shape: ["relay", "verify", "<id>"]
  const relayId = (options.positionals ?? [])[2];
  if (!relayId || !/^[a-z0-9-]+$/.test(relayId)) {
    throw new Error("Usage: switchboard relay verify <relay-id>");
  }

  const checks: RelayVerifyResult["checks"] = [];
  const addCheck = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    io.log(`${ok ? "ok    " : "FAIL  "}  ${name.padEnd(28)}  ${detail}`);
  };

  const store = await readRelayCatalogStore(cwd);
  const entry = store.entries.find((e) => e.relayId === relayId);
  if (!entry) {
    addCheck("local-catalog-entry", false, `not found in ${store.filePath}`);
    return { relayId, checks, ok: false };
  }
  addCheck("local-catalog-entry", true, `${entry.apiBaseUrl} state=${entry.state ?? "(unset)"}`);

  // Live discovery
  const manifestUrl = stringFlag(options.flags, "manifest-url") ?? env.PROOF_NETWORK_MANIFEST_URL;
  if (!manifestUrl) {
    addCheck("live-catalog-publish", false, "PROOF_NETWORK_MANIFEST_URL or --manifest-url required");
  } else {
    try {
      const expectedSigner = stringFlag(options.flags, "manifest-signer") ?? env.PROOF_NETWORK_MANIFEST_SIGNER;
      const discovery = await discoverServices({
        manifestUrlCandidates: [manifestUrl],
        expectedManifestSigner: expectedSigner,
        allowUnpinnedManifestSigner: !expectedSigner,
        fetchImpl: options.fetchImpl
      });
      const liveMembers = resolveRelayInventoryMembers(discovery);
      const liveMember = liveMembers.find((m) => m.relayId === relayId);
      if (!liveMember) {
        addCheck(
          "live-catalog-publish",
          false,
          `${relayId} not present in published catalog at ${manifestUrl} — bootstrap host hasn't reloaded?`
        );
      } else if (liveMember.apiBaseUrl !== entry.apiBaseUrl) {
        addCheck(
          "live-catalog-publish",
          false,
          `live apiBaseUrl=${liveMember.apiBaseUrl} differs from local=${entry.apiBaseUrl}`
        );
      } else {
        addCheck("live-catalog-publish", true, `live signer=${discovery.catalogs.relays?.signer?.slice(0, 16)}…`);
      }
    } catch (error) {
      addCheck("live-catalog-publish", false, (error as Error).message);
    }
  }

  // Three-endpoint probes
  const probe = await probeRelay(entry as RelayCatalogInputEntry, {
    fetchImpl: options.fetchImpl,
    timeoutMs: 8_000
  });
  addCheck("/health", probe.health.ok, probeDetail(probe, "health"));
  addCheck("/v1/relay-status", probe.relayStatus.ok, probeDetail(probe, "relayStatus"));
  addCheck("/v1/service-catalogs/relay", probe.relayCatalog.ok, probeDetail(probe, "relayCatalog"));

  // relayId reported by the running process
  const reportedRelayId = probe.relayStatus.body?.relayId;
  if (reportedRelayId) {
    if (reportedRelayId === relayId) {
      addCheck("reported-relay-id", true, `service reports relayId=${reportedRelayId}`);
    } else {
      addCheck("reported-relay-id", false, `service reports relayId=${reportedRelayId}, expected ${relayId}`);
    }
  }

  // Peer reachability (using the catalog members minus self as peers)
  const peers = store.entries
    .filter((e) => e.relayId !== relayId)
    .filter((e) => e.state === "active" || e.state === undefined || e.state === "candidate")
    .map((e) => ({ relayId: e.relayId, apiBaseUrl: e.apiBaseUrl }));
  if (peers.length > 0) {
    const peerResult = await checkPeerReachability({
      peers,
      required: false,
      pollIntervalMs: 5_000,
      pollTimeoutMs: 5_000,
      fetchImpl: options.fetchImpl
    });
    addCheck(
      "peer-reachability",
      peerResult.unreachable.length === 0,
      `reachable=[${peerResult.reachable.join(", ")}]${peerResult.unreachable.length > 0 ? ` unreachable=[${peerResult.unreachable.map((p) => `${p.relayId}:${p.reason}`).join(", ")}]` : ""}`
    );
  }

  const ok = checks.every((check) => check.ok);
  io.log("");
  io.log(ok ? `relay ${relayId}: all checks passed` : `relay ${relayId}: FAILED (${checks.filter((c) => !c.ok).length} check(s))`);
  return { relayId, checks, ok };
}

function probeDetail(probe: RelayStatusResult, key: "health" | "relayStatus" | "relayCatalog"): string {
  const outcome = probe[key];
  if (outcome.ok) {
    return `${outcome.httpStatus ?? "?"} in ${outcome.durationMs}ms`;
  }
  if (outcome.httpStatus) return `http=${outcome.httpStatus}`;
  return `error=${outcome.error ?? "unknown"}`;
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
