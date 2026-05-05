import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  discoverServices,
  resolveRelayInventoryMembers,
  type RelayDiscoveryMember
} from "../../../src/service-discovery.js";

export interface RunRelayBackfillSpecsOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  fetchImpl?: typeof fetch;
  cwd?: string;
}

export interface RelayBackfillSpecsResult {
  written: string[];
  skipped: string[];
  target: "bootstrap" | "acurast";
}

/**
 * Author RelayDeploymentSpec files for relays that exist in the live
 * signed catalog but don't yet have a spec on disk. Default --target is
 * bootstrap because the existing relay-a/b/c are docker-compose-based;
 * pass --target acurast to backfill Acurast-managed relays instead.
 *
 * Existing files are preserved unless --force is passed; this command
 * is meant to be run once to migrate the legacy fish-helper-driven
 * relay set into typed specs.
 */
export async function runRelayBackfillSpecs(
  options: RunRelayBackfillSpecsOptions
): Promise<RelayBackfillSpecsResult> {
  const io = options.io ?? defaultIo();
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const target = (stringFlag(options.flags, "target") ?? "bootstrap") as "bootstrap" | "acurast";
  if (target !== "bootstrap" && target !== "acurast") {
    throw new Error(`--target must be bootstrap or acurast (got ${target})`);
  }
  const force = boolFlag(options.flags, "force");

  const manifestUrl = stringFlag(options.flags, "manifest-url") ?? env.PROOF_NETWORK_MANIFEST_URL;
  if (!manifestUrl) {
    throw new Error("relay backfill-specs requires --manifest-url <url> or PROOF_NETWORK_MANIFEST_URL");
  }
  const expectedSigner = stringFlag(options.flags, "manifest-signer") ?? env.PROOF_NETWORK_MANIFEST_SIGNER;

  const discovery = await discoverServices({
    manifestUrlCandidates: [manifestUrl],
    expectedManifestSigner: expectedSigner,
    allowUnpinnedManifestSigner: !expectedSigner,
    fetchImpl: options.fetchImpl
  });
  const members = resolveRelayInventoryMembers(discovery);
  io.log(`Resolved ${members.length} relay member(s) from live catalog`);

  const written: string[] = [];
  const skipped: string[] = [];

  for (const member of members) {
    const filePath = path.join(cwd, "relays", `${member.relayId}.json`);
    const exists = await fileExists(filePath);
    if (exists && !force) {
      skipped.push(filePath);
      continue;
    }
    const spec = buildSpec(member, target);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
    written.push(filePath);
    io.log(`Wrote ${filePath}`);
  }

  if (skipped.length > 0) {
    io.log(`Skipped ${skipped.length} existing spec(s); pass --force to overwrite.`);
  }

  return { written, skipped, target };
}

function buildSpec(member: RelayDiscoveryMember, target: "bootstrap" | "acurast"): Record<string, unknown> {
  const apiBaseUrl = member.apiBaseUrl ?? "";
  const relayerKeyEnv = mainnetRelayerKeyEnv(member.relayId);
  const catalogState = member.state ?? (member.active === false ? "disabled" : "active");

  if (target === "bootstrap") {
    return {
      version: 1,
      relayId: member.relayId,
      target: "bootstrap",
      catalogState,
      apiBaseUrl,
      ...(member.validationReportUrl ? { validationReportUrl: member.validationReportUrl } : {}),
      peers: [],
      secrets: {
        relayerPrivateKeyEnv: relayerKeyEnv
      },
      bootstrap: {
        composeService: member.relayId,
        composeFile: "docker-compose.control-plane.yaml",
        envFile: ".control-plane/control-plane.env",
        rebuild: true
      }
    };
  }

  return {
    version: 1,
    relayId: member.relayId,
    target: "acurast",
    catalogState,
    apiBaseUrl,
    ...(member.validationReportUrl ? { validationReportUrl: member.validationReportUrl } : {}),
    peers: [],
    secrets: {
      relayerPrivateKeyEnv: relayerKeyEnv
    },
    relay: {
      enablePeerBackfill: false,
      enableValidationReports: true
    },
    acurast: {
      deployerSeedEnv: "PROOF_ACURAST_MAINNET_DEPLOYER_SEED",
      network: "mainnet",
      projectName: `switchboard-mainnet-${member.relayId}`,
      stageDir: `dist/acurast/switchboard-mainnet-${member.relayId}`,
      maxCostPerExecution: 40000000000,
      instantMatchProcessors: [],
      includeEnv: []
    }
  };
}

function mainnetRelayerKeyEnv(relayId: string): string {
  // Mainnet bootstrap convention: PROOF_MAINNET_RELAY_<X>_RECORDER_PRIVATE_KEY
  // Acurast canary convention from relay-d direction note:
  //   PROOF_<ID>_RELAYER_PRIVATE_KEY
  // Backfill defaults to the mainnet recorder convention; operators can
  // edit the spec to switch.
  const upper = relayId.toUpperCase().replace(/-/g, "_");
  if (upper.startsWith("RELAY_")) {
    return `PROOF_MAINNET_${upper}_RECORDER_PRIVATE_KEY`;
  }
  return `PROOF_${upper}_RECORDER_PRIVATE_KEY`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
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
