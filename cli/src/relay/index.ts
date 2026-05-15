import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ethers } from "ethers";
import { decodeAddress } from "@polkadot/util-crypto";

import {
  RELAY_DEPLOYMENT_SPEC_VERSION,
  isForbiddenAcurastEnvName,
  safeParseRelayDeploymentSpec,
  type RelayDeploymentSpec
} from "../../../src/relay-deployment-spec.js";
import { mkdir, writeFile } from "node:fs/promises";

import { HUB_USDC } from "../../../src/chains.js";
import {
  fundIngressSessionWithLedger,
  type FundIngressSessionInput,
  type FundIngressSessionResult
} from "../../../src/ledger-fund-ingress-session.js";
import { createLogSink, type CreatedLogSink } from "../../../src/log-sink-client.js";
import {
  fundIngressSessionWithSubstrate,
  type FundIngressSessionSubstrateInput,
  type FundIngressSessionSubstrateResult
} from "../../../src/substrate-fund-ingress-session.js";
import {
  runAcurastDeploy,
  type AcurastDeploySources,
  type AcurastRegistrationOverrides
} from "./acurast-target.js";
import { runBootstrapDeploy } from "./bootstrap-target.js";
import {
  rebuildSignedRelayCatalog,
  readRelayCatalogStore,
  upsertRelayCatalogEntry,
  withRelayCatalogState,
  writeRelayCatalogStore,
  type RelayCatalogStore
} from "./catalog.js";
import {
  findActiveAcurastDeployment,
  loadRelayDeploymentHistory,
  recordRelayDeployment,
  type RelayDeploymentHistoryEntry
} from "./history.js";
import { isDeploymentActive, readLatestAcurastDeployState } from "./acurast-deploy-state.js";
import { AcurastDeployEnvConflictError, synthesizeAcurastDeployEnv } from "./deploy-env.js";
import { parseDuration, formatDuration } from "./duration.js";
import {
  type PickProcessorDiscover,
  type PickProcessorDiscoverInput
} from "./pick-processor.js";
import { probeRelay, summarizeRelayStatus } from "./status.js";
import {
  createAcurastApi,
  discoverManagerProcessorsWithApi,
  rpcForAcurastNetwork,
  type ManagerProcessorInventory
} from "../../../src/acurast-manager.js";
import { serviceStateSchema, type ServiceState } from "../../../src/service-catalog.js";
import { SWITCHBOARD_PROJECT_STATE_DIR, relayStateDir } from "../switchboard-paths.js";
import {
  buildSpecSecretIntentPlan,
  formatSecretIntentPlan
} from "./secret-intent.js";

const SS58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{45,50}$/;
const DEPLOY_AUTO_PICK_START_DELAY_MS = 120_000;
const DEPLOY_AUTO_PICK_MAX_AGE_SECONDS = 900;

const RELAY_CATALOG_STATES = [
  "candidate",
  "active",
  "degraded",
  "draining",
  "disabled"
] as const satisfies ReadonlyArray<RelayDeploymentSpec["catalogState"]>;

export interface RelayCommandIo {
  log: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

const DEFAULT_IO: RelayCommandIo = {
  log: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line)
};

export async function runRelayDeploy(args: {
  flags: Map<string, string | boolean>;
  positionals: string[];
  io?: RelayCommandIo;
  /** Test seam: replace live processor discovery used by auto-pick. */
  discoverProcessor?: PickProcessorDiscover;
  /** Test seam: replace Acurast helper spawning inside runAcurastDeploy. */
  spawnPnpm?: (args: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<number>;
  /** Test seam: replace node spawning inside runAcurastDeploy. */
  spawnNode?: (args: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<number>;
  /** Test seam: skip the post-deploy readiness poll. */
  skipReadinessPoll?: boolean;
  /** Test seam: skip the peer-backfill reachability check. */
  skipPeerCheck?: boolean;
  /** Test seam: replace fetch in readiness/peer probes. */
  fetchImpl?: typeof fetch;
  /** Test seam: replace the Ledger funding helper. */
  fundHubSession?: typeof fundIngressSessionWithLedger;
  /** Test seam: replace the substrate funding helper. */
  fundHubSessionSubstrate?: typeof fundIngressSessionWithSubstrate;
  /** Test seam: replace the log-sink creation helper. */
  createLogSink?: typeof createLogSink;
  /** Test seam: replace the random-bytes generator (used for ephemeral job-signer key). */
  randomBytes?: (size: number) => Buffer;
}): Promise<void> {
  const io = args.io ?? DEFAULT_IO;
  const relayId = relayIdFromArgs(args);
  const spec = await loadRelayDeploymentSpec({ flags: args.flags, relayId });

  // The CLI also accepts a chain-level --target (polkadot-hub, etc.) from
  // project context defaults; only treat values in the relay-target set as
  // meant for this command.
  const targetOverride = stringFlag(args.flags, "target");
  if (targetOverride && (targetOverride === "acurast" || targetOverride === "bootstrap") && targetOverride !== spec.target) {
    throw new Error(
      `Spec for ${spec.relayId} has target=${spec.target}, but --target=${targetOverride} was passed`
    );
  }

  const stateOverride = stringFlag(args.flags, "state");
  if (stateOverride && !RELAY_CATALOG_STATES.includes(stateOverride as RelayDeploymentSpec["catalogState"])) {
    throw new Error(`--state must be candidate|active|degraded|draining|disabled (got ${stateOverride})`);
  }
  const effectiveState = (stateOverride as RelayDeploymentSpec["catalogState"] | undefined) ?? spec.catalogState;

  const durationOverride = stringFlag(args.flags, "duration");
  if (durationOverride && spec.target === "acurast" && spec.acurast) {
    const overrideMs = parseDuration(durationOverride);
    spec.acurast.executionMs = overrideMs;
    io.log(
      `--duration override: spec.acurast.executionMs = ${overrideMs}ms (${formatDuration(overrideMs)})`
    );
  } else if (durationOverride && spec.target !== "acurast") {
    throw new Error("--duration is only meaningful for --target acurast");
  }

  const managerIdOverride = stringFlag(args.flags, "manager-id");
  if (managerIdOverride) {
    if (spec.target !== "acurast" || !spec.acurast) {
      throw new Error("--manager-id is only meaningful for --target acurast");
    }
    spec.acurast.managerId = managerIdOverride;
    io.log(`--manager-id override: spec.acurast.managerId = ${managerIdOverride}`);
  }

  const apiBaseUrlOverride = stringFlag(args.flags, "api-base-url");
  if (apiBaseUrlOverride) {
    spec.apiBaseUrl = normalizeUrlOverride(apiBaseUrlOverride, "--api-base-url");
    io.log(`--api-base-url override: spec.apiBaseUrl = ${spec.apiBaseUrl}`);
  }

  const bootstrapRelayUrlOverride = stringFlag(args.flags, "bootstrap-url");
  if (bootstrapRelayUrlOverride) {
    spec.relay.bootstrapRelayUrl = normalizeUrlOverride(bootstrapRelayUrlOverride, "--bootstrap-url");
    io.log(`--bootstrap-url override: spec.relay.bootstrapRelayUrl = ${spec.relay.bootstrapRelayUrl}`);
  }

  // Keep --dry-run output aligned with the live run when operators pass a
  // one-off deployer override.
  maybeApplyDeployerSeedOverride(spec, args.flags, io);

  const dryRun = boolFlag(args.flags, "dry-run");
  if (dryRun) {
    printDeployDryRun(spec, effectiveState, io, args.flags);
    return;
  }

  const skipCatalog = boolFlag(args.flags, "no-catalog");
  const forceRedeploy = boolFlag(args.flags, "force-redeploy");
  const startedAt = Date.now();
  let outcome: "success" | "failed" = "failed";
  let notes: string | undefined;
  let acurastState: Awaited<ReturnType<typeof readLatestAcurastDeployState>>;

  try {
    if (spec.target === "acurast") {
      const yes = boolFlag(args.flags, "yes") || process.env.ACURAST_ASSUME_YES === "true";
      if (!yes) {
        throw new Error("Refusing to deploy to Acurast without --yes (or ACURAST_ASSUME_YES=true)");
      }

      const existing = await maybeFindActiveDeployment(spec.relayId);
      if (existing && !forceRedeploy) {
        const a = existing.acurast!;
        const endsIn = a.endTime !== undefined ? Math.max(0, a.endTime - Date.now()) : 0;
        io.log("");
        io.log(`Found active Acurast deployment for ${spec.relayId}:`);
        io.log(`  deploymentId : ${a.deploymentId}`);
        if (a.ipfsHash) io.log(`  ipfs         : ${a.ipfsHash}`);
        if (a.endTime !== undefined) {
          io.log(`  ends         : ${new Date(a.endTime).toISOString()} (in ${(endsIn / 60_000).toFixed(0)}m)`);
        }
        io.log("");
        io.log("Skipping deploy. Pass --force-redeploy to submit a fresh job anyway.");
        outcome = "success";
        notes = `skipped: active deployment ${a.deploymentId} still running`;
        return;
      }
      if (existing && forceRedeploy) {
        io.warn(
          `--force-redeploy: ignoring active deployment ${existing.acurast!.deploymentId}; submitting a new Acurast job.`
        );
      }

      const acurastEnv = await synthesizeAcurastDeployEnvFromFlags(args.flags, io, args.fetchImpl);
      await resolveAcurastDeployProcessor({ spec, flags: args.flags, io, discover: args.discoverProcessor });
      const registration = collectRegistrationOverrides(args.flags);
      const ephemeralRng = args.randomBytes ?? randomBytes;
      const fundResult = await maybeFundHubSession({
        spec,
        flags: args.flags,
        io,
        baseEnv: acurastEnv,
        registration,
        rng: ephemeralRng,
        fundLedger: args.fundHubSession ?? fundIngressSessionWithLedger,
        fundSubstrate: args.fundHubSessionSubstrate ?? fundIngressSessionWithSubstrate
      });
      const sources: AcurastDeploySources = {
        env: acurastEnv,
        registration
      };
      if (fundResult?.jobSignerPrivateKey) {
        sources.jobSignerPrivateKey = fundResult.jobSignerPrivateKey;
      }
      const sinkResult = await maybeProvisionLogSink({
        spec,
        flags: args.flags,
        io,
        baseEnv: acurastEnv,
        rng: ephemeralRng,
        create: args.createLogSink ?? createLogSink
      });
      if (sinkResult) {
        sources.logSink = {
          writeUrl: sinkResult.writeUrl,
          writeToken: sinkResult.writeToken,
          encryptionKey: sinkResult.encryptionKey
        };
      }
      await runAcurastDeploy(spec, {
        yes: true,
        io,
        sources,
        spawnPnpm: args.spawnPnpm,
        spawnNode: args.spawnNode,
        skipReadinessPoll: args.skipReadinessPoll ?? boolFlag(args.flags, "skip-readiness-poll"),
        skipPeerCheck: args.skipPeerCheck ?? boolFlag(args.flags, "skip-peer-check"),
        fetchImpl: args.fetchImpl
      });
      acurastState = await readLatestAcurastDeployState(spec.acurast!.stageDir).catch(() => undefined);
      if (!skipCatalog) {
        await refreshCatalogForDeploy({ spec, effectiveState, flags: args.flags, io });
      } else {
        io.log("");
        io.log("Skipped catalog refresh (--no-catalog). Run `switchboard relay catalog set-state` after evidence checks.");
        notes = "skipped catalog refresh (--no-catalog)";
      }
      outcome = "success";
      return;
    }

    if (spec.target === "bootstrap") {
      const yes = boolFlag(args.flags, "yes") || process.env.PROOF_RELAY_DEPLOY_ASSUME_YES === "true";
      if (!yes) {
        throw new Error("Refusing to run bootstrap deploy without --yes");
      }
      await runBootstrapDeploy(spec, { yes: true, io });
      if (!skipCatalog) {
        await refreshCatalogForDeploy({ spec, effectiveState, flags: args.flags, io });
      } else {
        io.log("");
        io.log("Skipped catalog refresh (--no-catalog).");
        notes = "skipped catalog refresh (--no-catalog)";
      }
      outcome = "success";
      return;
    }
  } catch (error) {
    notes = (error as Error).message;
    throw error;
  } finally {
    if (!acurastState && spec.target === "acurast" && spec.acurast) {
      acurastState = await readLatestAcurastDeployState(spec.acurast.stageDir).catch(() => undefined);
    }
    const acurast = acurastState && acurastState.deploymentId
      ? {
          deploymentId: acurastState.deploymentId,
          origin: acurastState.origin,
          ipfsHash: acurastState.ipfsHash,
          startTime: acurastState.startTime,
          endTime: acurastState.endTime,
          duration: acurastState.duration,
          status: acurastState.status
        }
      : undefined;
    await recordRelayDeployment({
      timestamp: new Date().toISOString(),
      relayId: spec.relayId,
      target: spec.target,
      apiBaseUrl: spec.apiBaseUrl,
      catalogState: effectiveState,
      outcome,
      durationMs: Date.now() - startedAt,
      ...(notes ? { notes } : {}),
      ...(acurast ? { acurast } : {})
    }).catch(() => undefined);
  }
}

async function maybeFindActiveDeployment(relayId: string): Promise<RelayDeploymentHistoryEntry | undefined> {
  const history = await loadRelayDeploymentHistory(relayId).catch(() => undefined);
  if (!history) return undefined;
  const entry = findActiveAcurastDeployment(history);
  if (!entry) return undefined;
  if (!isDeploymentActive(entry.acurast as Awaited<ReturnType<typeof readLatestAcurastDeployState>>, Date.now())) {
    return undefined;
  }
  return entry;
}

async function synthesizeAcurastDeployEnvFromFlags(
  flags: Map<string, string | boolean>,
  io: RelayCommandIo,
  fetchImpl?: typeof fetch
): Promise<NodeJS.ProcessEnv> {
  // Hardcoded mainnet defaults match `cli/src/index.ts` constants. We
  // copy them here to avoid an upward import; if these change, update
  // both places.
  const PROOF_NETWORK_MANIFEST_URL = "https://control.switchboard.proof.computer/v1/network-manifest";
  const PROOF_NETWORK_MANIFEST_SIGNER = "5EpwnRzamXpqWo3jW9h4ecSJHL9LBjR6jTMW5Wzw6p9nMTh7";
  const PROOF_MAINNET_RECORDER_COORDINATOR_ADDRESS = "0xd4dFB4AD9A4a2AfF56CCBe479F661b84947287A5";

  const manifestUrl = stringFlag(flags, "manifest-url") ?? process.env.PROOF_NETWORK_MANIFEST_URL ?? PROOF_NETWORK_MANIFEST_URL;
  const manifestSigner = stringFlag(flags, "manifest-signer") ?? process.env.PROOF_NETWORK_MANIFEST_SIGNER ?? PROOF_NETWORK_MANIFEST_SIGNER;
  try {
    return await synthesizeAcurastDeployEnv({
      baseEnv: process.env,
      manifestUrl,
      manifestSigner,
      fallbackRecorderCoordinatorAddress: PROOF_MAINNET_RECORDER_COORDINATOR_ADDRESS,
      fetchImpl
    });
  } catch (error) {
    // Env/manifest disagreement is a hard failure — bypass the soft
    // "manifest unreachable" fallback so the operator sees the diagnostic.
    if (error instanceof AcurastDeployEnvConflictError) {
      throw error;
    }
    io.warn(
      `Could not resolve manifest at ${manifestUrl} (${(error as Error).message}); falling back to env-only deploy config`
    );
    return process.env;
  }
}

async function resolveAcurastDeployProcessor(args: {
  spec: RelayDeploymentSpec;
  flags: Map<string, string | boolean>;
  io: RelayCommandIo;
  discover?: PickProcessorDiscover;
}): Promise<void> {
  const { spec, flags, io } = args;
  if (spec.target !== "acurast" || !spec.acurast) {
    return;
  }

  const explicitPin = stringFlag(flags, "pin-processor");
  if (explicitPin !== undefined) {
    if (!SS58_ADDRESS_RE.test(explicitPin)) {
      throw new Error(`--pin-processor must be a substrate ss58 address (got ${JSON.stringify(explicitPin)})`);
    }
    spec.acurast.instantMatchProcessors = [explicitPin];
    io.log(`Using --pin-processor override: ${explicitPin}`);
    return;
  }

  if (boolFlag(flags, "no-auto-pick")) {
    if (spec.acurast.instantMatchProcessors.length === 0) {
      io.warn(
        "--no-auto-pick: spec.acurast.instantMatchProcessors is empty; the deploy will rely on Acurast market matching."
      );
    } else {
      io.log(
        `--no-auto-pick: using spec.acurast.instantMatchProcessors verbatim (${spec.acurast.instantMatchProcessors.length} address(es))`
      );
    }
    return;
  }

  const managerId = spec.acurast.managerId;
  if (!managerId) {
    throw new Error(
      `relay ${spec.relayId}: auto-pick requires acurast.managerId in the spec. Add it (treat as region/AZ pin), or pass --no-auto-pick to use the spec's instantMatchProcessors verbatim, or --pin-processor <addr> for a one-off override.`
    );
  }

  const network = spec.acurast.network;
  const rpcUrl = stringFlag(flags, "rpc") ?? rpcForAcurastNetwork(network);
  const startDelayMs = numberFlag(flags, "auto-pick-start-delay-ms", DEPLOY_AUTO_PICK_START_DELAY_MS);
  const durationMs = spec.acurast.executionMs;
  const maxAgeSeconds = numberFlag(flags, "auto-pick-max-age-seconds", DEPLOY_AUTO_PICK_MAX_AGE_SECONDS);
  const excludeSet = new Set(
    (stringFlag(flags, "auto-pick-exclude") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  );

  io.log("");
  io.log(
    `Auto-picking instant-match processor under manager ${managerId} (${network}, window=${formatDuration(durationMs)} starting in ${formatDuration(startDelayMs)})`
  );

  const discover = args.discover ?? defaultDeployDiscover;
  const inventory = await discover({
    network,
    managerId,
    rpcUrl,
    startDelayMs,
    durationMs,
    maxAgeSeconds
  });

  const candidates = inventory.processors.filter(
    (processor) =>
      processor.heartbeatAgeSeconds !== null &&
      processor.heartbeatAgeSeconds <= maxAgeSeconds &&
      processor.availability !== undefined &&
      processor.availability.conflicts === 0 &&
      !excludeSet.has(processor.processor)
  );
  if (candidates.length === 0) {
    const window = inventory.availabilityWindow;
    throw new Error(
      `auto-pick: no schedule-clear processor under manager ${managerId} for window ${window?.proposedStartIso} → ${window?.proposedEndIso}. ` +
        `Wait, retry, or run \`switchboard relay pick-processor ${spec.relayId} --include-conflicting\` to inspect why.`
    );
  }

  const picked = candidates[0];
  spec.acurast.instantMatchProcessors = [picked.processor];
  io.log(
    `  picked ${picked.processor} (heartbeat=${picked.heartbeatAgeSeconds}s, ${candidates.length - 1} other available)`
  );
}

async function defaultDeployDiscover(input: PickProcessorDiscoverInput): Promise<ManagerProcessorInventory> {
  const api = await createAcurastApi({ network: input.network, rpcUrl: input.rpcUrl });
  try {
    return await discoverManagerProcessorsWithApi(api, {
      network: input.network,
      managerId: input.managerId,
      rpcUrl: input.rpcUrl,
      maxAgeSeconds: input.maxAgeSeconds,
      checkAvailability: true,
      startDelayMs: input.startDelayMs,
      durationMs: input.durationMs
    });
  } finally {
    await api.disconnect();
  }
}

async function refreshCatalogForDeploy(args: {
  spec: RelayDeploymentSpec;
  effectiveState: RelayDeploymentSpec["catalogState"];
  flags: Map<string, string | boolean>;
  io: RelayCommandIo;
}): Promise<void> {
  const { spec, effectiveState, io } = args;
  const cwd = process.cwd();
  const catalogFileFlag = stringFlag(args.flags, "catalog-file");
  let store: RelayCatalogStore;
  try {
    store = await readRelayCatalogStore(cwd, catalogFileFlag);
  } catch (error) {
    io.warn(
      `Could not read relay catalog file (${(error as Error).message}). Skipping catalog refresh; run \`switchboard relay catalog set-state\` manually.`
    );
    return;
  }
  const nextEntries = upsertRelayCatalogEntry(store.entries, {
    relayId: spec.relayId,
    apiBaseUrl: spec.apiBaseUrl,
    validationReportUrl: spec.validationReportUrl,
    controlPlaneUrl: spec.controlPlaneUrl,
    state: effectiveState
  });
  const updated: RelayCatalogStore = { ...store, entries: nextEntries };
  await writeRelayCatalogStore(updated);
  io.log("");
  io.log(`Updated ${updated.filePath}: ${spec.relayId} -> state=${effectiveState}`);
  await rebuildSignedRelayCatalog(updated, { cwd, io });
}

export async function runRelayCatalogSetState(args: {
  flags: Map<string, string | boolean>;
  positionals: string[];
  io?: RelayCommandIo;
}): Promise<void> {
  const io = args.io ?? DEFAULT_IO;
  // positionals shape: ["relay", "catalog", "set-state", "<id>", "<state>"]
  const relayId = args.positionals[3];
  const stateInput = args.positionals[4];
  if (!relayId || !stateInput) {
    throw new Error("Usage: switchboard relay catalog set-state <relay-id> <state>");
  }
  if (!/^[a-z0-9-]+$/.test(relayId)) {
    throw new Error(`Invalid relay id ${JSON.stringify(relayId)}: must match /^[a-z0-9-]+$/`);
  }
  const stateResult = serviceStateSchema.safeParse(stateInput);
  if (!stateResult.success) {
    throw new Error(`Invalid catalog state ${JSON.stringify(stateInput)}: must be candidate|active|degraded|draining|disabled`);
  }
  const state: ServiceState = stateResult.data;

  const cwd = process.cwd();
  const catalogFileFlag = stringFlag(args.flags, "catalog-file");
  const store = await readRelayCatalogStore(cwd, catalogFileFlag);
  const next = withRelayCatalogState(store.entries, relayId, state);
  const updated = { ...store, entries: next };
  await writeRelayCatalogStore(updated);
  io.log(`Updated ${updated.filePath}: ${relayId} -> state=${state}`);

  if (boolFlag(args.flags, "no-rebuild")) {
    io.log(`Skipped catalog signing because --no-rebuild was passed.`);
    return;
  }
  await rebuildSignedRelayCatalog(updated, { cwd, io });
}

export async function runRelayStatus(args: {
  flags: Map<string, string | boolean>;
  positionals: string[];
  io?: RelayCommandIo;
}): Promise<void> {
  const io = args.io ?? DEFAULT_IO;
  const cwd = process.cwd();
  const catalogFileFlag = stringFlag(args.flags, "catalog-file");
  const store = await readRelayCatalogStore(cwd, catalogFileFlag);
  // positionals shape: ["relay", "status", "<id>?"]
  const explicitRelayId = args.positionals[2];

  let entries = store.entries;
  if (explicitRelayId) {
    if (!/^[a-z0-9-]+$/.test(explicitRelayId)) {
      throw new Error(`Invalid relay id ${JSON.stringify(explicitRelayId)}: must match /^[a-z0-9-]+$/`);
    }
    entries = entries.filter((entry) => entry.relayId === explicitRelayId);
    if (entries.length === 0) {
      throw new Error(`relay ${explicitRelayId} not found in ${store.filePath}`);
    }
  }

  const timeoutMs = numberFlag(args.flags, "timeout-ms", 5_000);
  io.log(`Probing ${entries.length} relay${entries.length === 1 ? "" : "s"} from ${store.filePath}`);
  io.log("");

  let anyFail = false;
  for (const entry of entries) {
    const result = await probeRelay(entry, { timeoutMs });
    if (!result.health.ok || !result.relayStatus.ok || !result.relayCatalog.ok) anyFail = true;
    for (const line of summarizeRelayStatus(result)) io.log(line);
    io.log("");
  }
  if (anyFail) {
    process.exitCode = 1;
  }
}

interface SpecLoaderArgs {
  flags: Map<string, string | boolean>;
  relayId: string;
}

async function loadRelayDeploymentSpec(args: SpecLoaderArgs): Promise<RelayDeploymentSpec> {
  const explicitFile = stringFlag(args.flags, "spec-file") ?? stringFlag(args.flags, "spec");
  const candidates = explicitFile
    ? [explicitFile]
    : defaultSpecCandidates(args.relayId);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const raw = await readFile(resolved, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (raw === undefined) continue;
    const parsed = JSON.parse(raw) as unknown;
    const result = safeParseRelayDeploymentSpec(parsed);
    if (!result.ok) {
      const detail = result.error.errors.map((issue) => `  - ${issue.path || "(root)"}: ${issue.message}`).join("\n");
      throw new Error(`Invalid relay deployment spec at ${resolved}:\n${detail}`);
    }
    if (result.spec.relayId !== args.relayId) {
      throw new Error(
        `Spec at ${resolved} declares relayId=${result.spec.relayId}, but command was invoked for ${args.relayId}`
      );
    }
    if (result.spec.version !== RELAY_DEPLOYMENT_SPEC_VERSION) {
      throw new Error(
        `Spec at ${resolved} version=${result.spec.version} does not match expected ${RELAY_DEPLOYMENT_SPEC_VERSION}`
      );
    }
    return result.spec;
  }

  const tried = candidates.map((candidate) => `  - ${candidate}`).join("\n");
  throw new Error(
    `Could not find a relay deployment spec for ${args.relayId}. Looked at:\n${tried}\nPass --spec-file <path> to override.`
  );
}

function defaultSpecCandidates(relayId: string): string[] {
  return [
    `relays/${relayId}.json`,
    `${SWITCHBOARD_PROJECT_STATE_DIR}/relays/${relayId}.json`,
    `.switchboard/relays/${relayId}.json`,
    `docs/relays/${relayId}.json`
  ];
}

function relayIdFromArgs(args: { positionals: string[]; flags: Map<string, string | boolean> }): string {
  // positionals shape: ["relay", "deploy", "<id>", ...] or ["relay", "status", "<id>", ...]
  const positional = args.positionals[2];
  const flag = stringFlag(args.flags, "relay-id") ?? stringFlag(args.flags, "id");
  const value = positional ?? flag;
  if (!value) {
    throw new Error("Missing relay id. Pass it as a positional argument: switchboard relay deploy <id>");
  }
  if (!/^[a-z0-9-]+$/.test(value)) {
    throw new Error(`Invalid relay id ${JSON.stringify(value)}: must match /^[a-z0-9-]+$/`);
  }
  return value;
}

function printDeployDryRun(
  spec: RelayDeploymentSpec,
  effectiveState: RelayDeploymentSpec["catalogState"],
  io: RelayCommandIo,
  flags: Map<string, string | boolean> = new Map()
): void {
  const announce = (line: string) => io.log(line);

  announce(`relay deploy --dry-run`);
  announce(`  relay id        : ${spec.relayId}`);
  announce(`  target          : ${spec.target}`);
  announce(`  api base url    : ${spec.apiBaseUrl}`);
  announce(`  catalog state   : ${effectiveState}${effectiveState === spec.catalogState ? "" : " (overridden by --state)"}`);
  if (spec.validationReportUrl) announce(`  validation url  : ${spec.validationReportUrl}`);
  if (spec.controlPlaneUrl) announce(`  control plane   : ${spec.controlPlaneUrl}`);
  announce("");

  for (const line of formatSecretIntentPlan(buildSpecSecretIntentPlan(spec))) {
    announce(line);
  }
  announce("");

  announce(`secrets (env name references):`);
  announce(`  RELAYER_PRIVATE_KEY        <- ${spec.secrets.relayerPrivateKeyEnv} ${envPresence(spec.secrets.relayerPrivateKeyEnv)}`);
  if (spec.secrets.validationReadTokenEnv) {
    announce(`  PROOF_VALIDATION_READ_TOKEN <- ${spec.secrets.validationReadTokenEnv} ${envPresence(spec.secrets.validationReadTokenEnv)}`);
  }
  if (spec.secrets.controlPlaneTokenEnv) {
    announce(`  PROOF_CONTROL_PLANE_TOKEN  <- ${spec.secrets.controlPlaneTokenEnv} ${envPresence(spec.secrets.controlPlaneTokenEnv)}`);
  }
  if (spec.secrets.relayInfraAdmissionTokenEnv) {
    announce(`  SB_RELAY_INFRA_ADMISSION_TOKEN <- ${spec.secrets.relayInfraAdmissionTokenEnv} ${envPresence(spec.secrets.relayInfraAdmissionTokenEnv)}`);
  }
  if (spec.secrets.logCreateTokenEnv) {
    announce(`  PROOF_LOG_CREATE_TOKEN     <- ${spec.secrets.logCreateTokenEnv} ${envPresence(spec.secrets.logCreateTokenEnv)}`);
  }
  if (spec.secrets.logEncryptionKeyEnv) {
    announce(`  SWITCHBOARD_LOG_ENCRYPTION_KEY <- ${spec.secrets.logEncryptionKeyEnv} ${envPresence(spec.secrets.logEncryptionKeyEnv)}`);
  }
  announce("");

  if (spec.peers.length > 0) {
    announce(`peer relays (${spec.peers.length}):`);
    for (const peer of spec.peers) {
      const tokenSuffix = peer.readTokenEnv ? ` (read token <- ${peer.readTokenEnv} ${envPresence(peer.readTokenEnv)})` : "";
      announce(`  - ${peer.relayId} @ ${peer.apiBaseUrl}${tokenSuffix}`);
    }
    announce("");
  }

  if (spec.target === "acurast" && spec.acurast) {
    announce(`acurast plan:`);
    announce(`  network              : ${spec.acurast.network}`);
    announce(`  project name         : ${spec.acurast.projectName}`);
    announce(`  stage dir            : ${spec.acurast.stageDir}`);
    announce(`  entrypoint           : ${spec.acurast.entrypoint}`);
    announce(`  deployer seed env    : ${spec.acurast.deployerSeedEnv} ${envPresence(spec.acurast.deployerSeedEnv)}`);
    announce(`  execution ms         : ${spec.acurast.executionMs}`);
    announce(`  max cost / execution : ${spec.acurast.maxCostPerExecution}`);
    announce(`  replicas             : ${spec.acurast.replicas}`);
    announce(`  encrypted code       : ${spec.acurast.encryptedCode === false ? "disabled" : "enabled (AES-256-GCM bootstrap)"}`);
    announce(`  admission mode       : ${spec.relay.admissionMode}`);
    if (spec.acurast.scriptIpfs) {
      announce(`  script ipfs (pinned) : ${spec.acurast.scriptIpfs}`);
    }
    if (spec.acurast.managerId) {
      announce(`  manager id           : ${spec.acurast.managerId} (auto-pick from this manager unless --no-auto-pick or --pin-processor)`);
    } else {
      announce(`  manager id           : (unset — deploy will require --no-auto-pick or --pin-processor <addr>)`);
    }
    if (spec.acurast.instantMatchProcessors.length > 0) {
      announce(`  instant-match cache (${spec.acurast.instantMatchProcessors.length}):`);
      for (const processor of spec.acurast.instantMatchProcessors) {
        announce(`    - ${processor}`);
      }
    }
    const includeEnv = spec.acurast.includeEnv;
    announce(`  include env (${includeEnv.length}):`);
    for (const name of includeEnv) {
      const presence = envPresence(name);
      const flag = isForbiddenAcurastEnvName(name) ? " FORBIDDEN" : "";
      announce(`    - ${name} ${presence}${flag}`);
    }
    announce("");
    announce(`actions (would run, not executed in --dry-run):`);
    announce(`  - validate IPFS-bound bundle has no forbidden env names`);
    announce(`  - run scripts/mainnet/scan-acurast-artifact-secrets.mjs against the staged artifact`);
    if (spec.acurast.managerId) {
      announce(`  - auto-pick a schedule-clear processor under manager ${spec.acurast.managerId}`);
    }
    if (spec.relay.admissionMode === "proof-infra") {
      announce(
        `  - submit signed PROOF-only relay infra admission to ${spec.relay.bootstrapRelayUrl ?? "<bootstrapRelayUrl>"} (no Hub funding or deployment intent)`
      );
    }
    if (spec.relay.autoRegister && spec.relay.admissionMode === "paid-ingress") {
      const fundingMode = boolFlag(flags, "no-fund") ? "skip" : resolveFundingMode(flags);
      const fundingSeedEnv =
        stringFlag(flags, "funding-seed-env") ??
        (fundingMode === "substrate" ? spec.acurast.deployerSeedEnv : undefined);
      const fundingDetail =
        fundingMode === "ledger"
          ? "via Ledger"
          : fundingMode === "substrate"
            ? `via substrate sr25519${fundingSeedEnv ? ` (${fundingSeedEnv})` : ""}`
            : "out-of-band";
      announce(
        `  - generate ephemeral job-signer keypair and fund a Hub ingress session ${fundingDetail} (skipped if --session-id passed)`
      );
    }
    if (spec.relay.enableLogs) {
      announce(
        `  - provision encrypted log sink on ${spec.relay.bootstrapRelayUrl ?? "<bootstrapRelayUrl>"} and persist read state under ${SWITCHBOARD_PROJECT_STATE_DIR}/relays/${spec.relayId}.log-sink.json (skipped with --no-logs)`
      );
    }
    announce(`  - prepare the Acurast project bundle`);
    if (spec.acurast.encryptedCode !== false) {
      announce(`  - replace dist/bundle.cjs with encrypted-code bootstrap after plaintext scan`);
    }
    announce(`  - deploy the Acurast project directly with --yes`);
    announce(`  - poll ${spec.apiBaseUrl}/health, /v1/relay-status, /v1/service-catalogs/relay`);
    announce(
      `  - verify peer-backfill reachability from ${spec.peers.length} bootstrap relay${spec.peers.length === 1 ? "" : "s"}`
    );
  } else if (spec.target === "bootstrap" && spec.bootstrap) {
    announce(`bootstrap plan:`);
    announce(`  compose file    : ${spec.bootstrap.composeFile}`);
    announce(`  compose service : ${spec.bootstrap.composeService}`);
    announce(`  env file        : ${spec.bootstrap.envFile}`);
    announce(`  rebuild image   : ${spec.bootstrap.rebuild ? "yes" : "no"}`);
    announce("");
    announce(`actions (would run, not executed in --dry-run):`);
    const rebuildFlags = spec.bootstrap.rebuild ? "--build --force-recreate" : "--no-build --force-recreate";
    announce(
      `  - docker compose --env-file ${spec.bootstrap.envFile} -f ${spec.bootstrap.composeFile} up -d --no-deps ${rebuildFlags} ${spec.bootstrap.composeService}`
    );
    announce(
      `  - docker compose --env-file ${spec.bootstrap.envFile} -f ${spec.bootstrap.composeFile} ps ${spec.bootstrap.composeService}`
    );
    announce(`  - poll ${spec.apiBaseUrl}/health and /v1/relay-status`);
  }
}

function envPresence(name: string): string {
  return process.env[name] && process.env[name]!.length > 0 ? "(present)" : "(MISSING)";
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeUrlOverride(value: string, flagName: string): string {
  try {
    return new URL(value).toString().replace(/\/+$/, "");
  } catch (error) {
    throw new Error(`${flagName} must be a valid URL (${(error as Error).message})`);
  }
}

function numberFlag(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  const value = stringFlag(flags, name);
  if (!value) return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return Number(value);
}

/**
 * Apply `--deployer-seed-env <NAME>` to the spec's `acurast.deployerSeedEnv`
 * in place. Production deploys should leave this alone (defaults to
 * `PROOF_ACURAST_MAINNET_DEPLOYER_SEED`). For tight-loop testing on mainnet,
 * the operator can override at deploy time without editing the spec file —
 * useful when a low-value funded key (e.g. `.envrc:ACURAST_MAINNET_SEED`)
 * is acceptable for the smoke run. Logs a yellow advisory line so the
 * non-default deployer is visible in the deploy output.
 */
function maybeApplyDeployerSeedOverride(
  spec: RelayDeploymentSpec,
  flags: Map<string, string | boolean>,
  io: RelayCommandIo
): void {
  const override = stringFlag(flags, "deployer-seed-env");
  if (!override) return;
  if (spec.target !== "acurast" || !spec.acurast) return;
  const original = spec.acurast.deployerSeedEnv;
  if (override === original) return;
  spec.acurast.deployerSeedEnv = override;
  io.warn("");
  io.warn(`!! deployer override: signing Acurast extrinsics with ${override} (default ${original})`);
  io.warn(`   this is a non-production deployer key; recorder authority is unchanged`);
  io.warn(`   (relay's chain identity is its RELAYER_PRIVATE_KEY, not the deployer)`);
}

function collectRegistrationOverrides(flags: Map<string, string | boolean>): AcurastRegistrationOverrides {
  const overrides: AcurastRegistrationOverrides = {};
  const sessionId = stringFlag(flags, "session-id");
  if (sessionId !== undefined) overrides.sessionId = sessionId;
  const jobId = stringFlag(flags, "job-id");
  if (jobId !== undefined) overrides.jobId = jobId;
  const operatorId = stringFlag(flags, "operator-id");
  if (operatorId !== undefined) overrides.operatorId = operatorId;
  const nonce = stringFlag(flags, "nonce");
  if (nonce !== undefined) overrides.nonce = nonce;
  const deadline = stringFlag(flags, "deadline");
  if (deadline !== undefined) overrides.deadline = deadline;
  return overrides;
}

type FundingMode = "ledger" | "substrate" | "skip";

function resolveFundingMode(flags: Map<string, string | boolean>): FundingMode {
  const raw = stringFlag(flags, "funding-mode") ?? "ledger";
  if (raw === "ledger" || raw === "substrate" || raw === "skip") return raw;
  throw new Error(`--funding-mode must be one of: ledger | substrate | skip (got ${raw})`);
}

interface MaybeFundHubSessionInput {
  spec: RelayDeploymentSpec;
  flags: Map<string, string | boolean>;
  io: RelayCommandIo;
  baseEnv: NodeJS.ProcessEnv;
  /** Mutated in place: `sessionId` and `jobId` are filled when funding succeeds. */
  registration: AcurastRegistrationOverrides;
  rng: (size: number) => Buffer;
  fundLedger: typeof fundIngressSessionWithLedger;
  fundSubstrate: typeof fundIngressSessionWithSubstrate;
}

interface MaybeFundHubSessionResult {
  /** 0x-prefixed 32-byte hex of the ephemeral job signer (passed into the relay's encrypted runtime env). */
  jobSignerPrivateKey: string;
  /** Funding mode that ran. */
  mode: FundingMode;
  /** Ledger funding response (when mode=ledger). */
  ledger?: FundIngressSessionResult;
  /** Substrate funding response (when mode=substrate). */
  substrate?: FundIngressSessionSubstrateResult;
}

/**
 * Fund a Polkadot Hub ingress session for an Acurast-hosted relay before the
 * Acurast deploy submits.
 *
 * No-ops (returns undefined) when:
 *   - spec.relay.autoRegister is false
 *   - --session-id is already supplied (operator funded out-of-band)
 *   - --no-fund is passed (caller is responsible for funding)
 *
 * Otherwise, generates a fresh secp256k1 job signer, funds the session via
 * `fundIngressSessionWithLedger`, mutates `registration` to carry the resulting
 * sessionId/jobId, and returns the ephemeral private key for the caller to
 * thread into the relay's encrypted runtime env.
 */
async function maybeFundHubSession(
  input: MaybeFundHubSessionInput
): Promise<MaybeFundHubSessionResult | undefined> {
  const { spec, flags, io, baseEnv, registration, rng, fundLedger, fundSubstrate } = input;
  if (spec.target !== "acurast" || !spec.relay.autoRegister) return undefined;
  if (spec.relay.admissionMode === "proof-infra") {
    io.log("");
    io.log("Skipping inline Hub funding: relay.admissionMode=proof-infra uses protected relay infra admission.");
    return undefined;
  }
  if (registration.sessionId) {
    io.log("");
    io.log(`Skipping inline Hub funding: --session-id ${registration.sessionId} already provided.`);
    return undefined;
  }
  // Resolve mode (default ledger). --no-fund is a back-compat alias for --funding-mode=skip.
  const mode: FundingMode = boolFlag(flags, "no-fund") ? "skip" : resolveFundingMode(flags);
  if (mode === "skip") {
    throw new Error(
      "relay deploy: --funding-mode=skip (or --no-fund) was passed but no --session-id was provided. Either fund out-of-band and pass --session-id, or pick a funding mode."
    );
  }

  if (!spec.relay.bootstrapRelayUrl) {
    throw new Error(
      "relay.bootstrapRelayUrl is required to fund a Hub session inline (the bootstrap relay serves /v1/ingress-intents)"
    );
  }
  const registryAddress = baseEnv.INGRESS_REGISTRY_ADDRESS;
  if (!registryAddress) {
    throw new Error(
      "relay deploy: inline Hub funding requires INGRESS_REGISTRY_ADDRESS in the selected ops profile or env"
    );
  }
  const chainId = baseEnv.CHAIN_ID;
  if (!chainId) {
    throw new Error("relay deploy: inline Hub funding requires CHAIN_ID in env");
  }
  const ethRpcUrl =
    stringFlag(flags, "ledger-rpc-url") ?? baseEnv.LEDGER_RPC_URL ?? baseEnv.HUB_ETH_RPC_URL;
  if (!ethRpcUrl) {
    throw new Error(
      "relay deploy: inline Hub funding requires HUB_ETH_RPC_URL or LEDGER_RPC_URL in env (or --ledger-rpc-url)"
    );
  }
  const asset =
    stringFlag(flags, "asset") ?? baseEnv.PAYMENT_ASSET_ADDRESS ?? baseEnv.PROOF_QUOTE_DEFAULT_ASSET ?? HUB_USDC.contractAddress;
  const paidSeconds = stringFlag(flags, "paid-seconds") ?? baseEnv.PAID_SECONDS ?? "600";
  const quoteTimeoutMs = numberFlag(flags, "quote-timeout-ms", 15_000);
  const sessionLabel = stringFlag(flags, "session-label") ?? baseEnv.SESSION_LABEL ?? `switchboard-${spec.relayId}`;
  const sessionSalt = stringFlag(flags, "session-salt") ?? baseEnv.SESSION_SALT;
  const endpointHostname = endpointHostnameFromSpec(spec);
  const quoteSignerPrivateKey = baseEnv.QUOTE_SIGNER_PRIVATE_KEY ?? baseEnv.PROOF_MAINNET_QUOTE_SIGNER_PRIVATE_KEY;
  if (!quoteSignerPrivateKey) {
    throw new Error(
      "relay deploy: canonical relay endpoint funding requires QUOTE_SIGNER_PRIVATE_KEY or PROOF_MAINNET_QUOTE_SIGNER_PRIVATE_KEY so the SDK can locally rebind and sign the quote endpoint"
    );
  }

  // Ephemeral job signer for this deploy. v1: deployer holds the key, ships
  // it into the relay job's encrypted runtime env. v2: derive via Acurast TEE
  // secp256k1 with a deployer-precommit.
  const jobSignerPrivateKey = `0x${rng(32).toString("hex")}`;
  const jobSignerWallet = new ethers.Wallet(jobSignerPrivateKey);
  const jobSignerAddress = jobSignerWallet.address;

  if (mode === "ledger") {
    const ledgerAddress = stringFlag(flags, "ledger-address") ?? baseEnv.LEDGER_ADDRESS ?? baseEnv.DEPLOYER_ADDRESS;
    if (!ledgerAddress) {
      throw new Error(
        "relay deploy: --funding-mode=ledger requires LEDGER_ADDRESS in env or --ledger-address (the EVM developer/payer address shown on the Ledger device)"
      );
    }
    io.log("");
    io.log(`Funding Hub ingress session for ${spec.relayId} via Ledger (${ledgerAddress}):`);
    io.log(`  bootstrap relay   : ${spec.relay.bootstrapRelayUrl}`);
    io.log(`  ephemeral signer  : ${jobSignerAddress}`);
    io.log(`  asset             : ${asset}`);
    io.log(`  paid seconds      : ${paidSeconds}`);

    const ledgerYes = boolFlag(flags, "ledger-yes") || baseEnv.LEDGER_ASSUME_YES === "true";
    const fundInput: FundIngressSessionInput = {
      registryAddress,
      relayUrl: spec.relay.bootstrapRelayUrl,
      asset,
      paidSeconds,
      jobSignerAddress,
      ledger: {
        rpcUrl: ethRpcUrl,
        chainId,
        ledgerAddress,
        derivationPath: stringFlag(flags, "ledger-derivation-path") ?? baseEnv.LEDGER_DERIVATION_PATH,
        legacy: baseEnv.LEDGER_LEGACY === "true",
        confirmations: baseEnv.CONFIRMATIONS ?? "1"
      },
      yes: ledgerYes,
      operatorId: registration.operatorId ?? baseEnv.PROOF_OPERATOR_ID ?? baseEnv.OPERATOR_ID,
      processorId: derivedProcessorIdFromSpec(spec),
      sessionLabel,
      endpointHostname,
      quoteSignerPrivateKey,
      sessionSalt,
      quoteTimeoutMs,
      io
    };

    const ledger = await fundLedger(fundInput);
    io.log(
      `  hub session       : ${ledger.sessionId} (${ledger.alreadyFunded ? "already funded" : "newly funded"})`
    );
    registration.sessionId = ledger.sessionId;
    registration.jobId = ledger.jobId;
    return { jobSignerPrivateKey, mode, ledger };
  }

  // mode === "substrate"
  const seedEnvName =
    stringFlag(flags, "funding-seed-env") ??
    (spec.target === "acurast" && spec.acurast ? spec.acurast.deployerSeedEnv : undefined);
  if (!seedEnvName) {
    throw new Error("relay deploy: --funding-mode=substrate requires --funding-seed-env (or spec.acurast.deployerSeedEnv)");
  }
  const seed = baseEnv[seedEnvName];
  if (!seed) {
    throw new Error(
      `relay deploy: --funding-mode=substrate requires ${seedEnvName} to be set (the substrate sr25519 mnemonic that funds the Hub session via revive.call)`
    );
  }
  const substrateWsUrl = baseEnv.HUB_SUBSTRATE_WS_URL ?? baseEnv.SUBSTRATE_WS_URL;
  if (!substrateWsUrl) {
    throw new Error(
      "relay deploy: --funding-mode=substrate requires HUB_SUBSTRATE_WS_URL in the selected ops profile or env"
    );
  }
  const ss58FormatRaw = baseEnv.POLKADOT_SS58_FORMAT ?? "0";
  const ss58Format = Number(ss58FormatRaw);
  if (!Number.isInteger(ss58Format) || ss58Format < 0) {
    throw new Error(`relay deploy: POLKADOT_SS58_FORMAT must be a non-negative integer (got ${ss58FormatRaw})`);
  }

  io.log("");
  io.log(`Funding Hub ingress session for ${spec.relayId} via substrate sr25519 (${seedEnvName}):`);
  io.log(`  bootstrap relay   : ${spec.relay.bootstrapRelayUrl}`);
  io.log(`  ephemeral signer  : ${jobSignerAddress}`);
  io.log(`  asset             : ${asset}`);
  io.log(`  paid seconds      : ${paidSeconds}`);

  const substrateInput: FundIngressSessionSubstrateInput = {
    registryAddress,
    relayUrl: spec.relay.bootstrapRelayUrl,
    asset,
    paidSeconds,
    jobSignerAddress,
    signing: {
      seed,
      ss58Format,
      substrateWsUrl,
      ethRpcUrl,
      chainId
    },
    yes: true,
    operatorId: registration.operatorId ?? baseEnv.PROOF_OPERATOR_ID ?? baseEnv.OPERATOR_ID,
    processorId: derivedProcessorIdFromSpec(spec),
    sessionLabel,
    endpointHostname,
    quoteSignerPrivateKey,
    sessionSalt,
    quoteTimeoutMs,
    io
  };
  const substrate = await fundSubstrate(substrateInput);
  io.log(
    `  hub session       : ${substrate.sessionId} (${substrate.alreadyFunded ? "already funded" : "newly funded"})`
  );
  io.log(`  developer         : ${substrate.developerSs58} → ${substrate.developerEvm}`);
  registration.sessionId = substrate.sessionId;
  registration.jobId = substrate.jobId;
  return { jobSignerPrivateKey, mode, substrate };
}

interface MaybeProvisionLogSinkInput {
  spec: RelayDeploymentSpec;
  flags: Map<string, string | boolean>;
  io: RelayCommandIo;
  baseEnv: NodeJS.ProcessEnv;
  rng: (size: number) => Buffer;
  create: typeof createLogSink;
}

/**
 * Provision a fresh encrypted log sink on the bootstrap relay before deploy
 * and persist the read state locally so `switchboard relay logs <id>`
 * works without flags.
 */
async function maybeProvisionLogSink(input: MaybeProvisionLogSinkInput): Promise<CreatedLogSink | undefined> {
  const { spec, flags, io, baseEnv, rng, create } = input;
  if (spec.target !== "acurast" || !spec.relay.enableLogs) return undefined;
  if (boolFlag(flags, "no-logs")) {
    io.log("");
    io.log("Skipping inline log-sink provisioning: --no-logs passed.");
    return undefined;
  }
  if (!spec.relay.bootstrapRelayUrl) {
    throw new Error(
      "relay.bootstrapRelayUrl is required to provision a log sink (the sink is hosted on the bootstrap relay)"
    );
  }
  const tokenEnvName = spec.relay.logCreateTokenEnv;
  const createToken = baseEnv[tokenEnvName];
  if (!createToken) {
    throw new Error(
      `relay deploy: relay.enableLogs=true but ${tokenEnvName} is not set in env (the bearer for POST /v1/log-sinks on ${spec.relay.bootstrapRelayUrl})`
    );
  }

  io.log("");
  io.log(`Provisioning encrypted log sink on ${spec.relay.bootstrapRelayUrl}...`);
  const sink = await create({
    relayUrl: spec.relay.bootstrapRelayUrl,
    createToken,
    randomBytes: rng
  });
  io.log(`  sinkId    : ${sink.sinkId}`);
  io.log(`  writeUrl  : ${sink.writeUrl}`);
  io.log(`  readUrl   : ${sink.readUrl}`);

  // Persist the read-side state so `switchboard relay logs <id>` works
  // without flags. The encryption key is operator-only and never reaches
  // the relay or the on-chain registry; the read token is paired with the
  // readUrl to fetch back ciphertext, which we decrypt locally.
  const stateDir = relayStateDir(process.cwd());
  const statePath = path.join(stateDir, `${spec.relayId}.log-sink.json`);
  await mkdir(stateDir, { recursive: true });
  const readState = {
    relayId: spec.relayId,
    sinkId: sink.sinkId,
    writeUrl: sink.writeUrl,
    readUrl: sink.readUrl,
    readToken: sink.readToken,
    encryptionKey: sink.encryptionKey,
    createdAt: new Date().toISOString()
  };
  await writeFile(statePath, `${JSON.stringify(readState, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  io.log(`  saved     : ${statePath}`);

  return sink;
}

function derivedProcessorIdFromSpec(spec: RelayDeploymentSpec): string | undefined {
  if (spec.target !== "acurast" || !spec.acurast) return undefined;
  const ss58 = spec.acurast.instantMatchProcessors[0];
  if (!ss58) return undefined;
  return `0x${Buffer.from(decodeAddress(ss58)).toString("hex")}`.toLowerCase();
}

function endpointHostnameFromSpec(spec: RelayDeploymentSpec): string {
  return new URL(spec.apiBaseUrl).hostname;
}
