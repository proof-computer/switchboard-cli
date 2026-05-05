import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  discoverServices,
  resolveRelayInventoryMembers,
  type RelayDiscoveryMember
} from "../../../src/service-discovery.js";
import {
  type RelayCatalogInputEntry,
  type ServiceState
} from "../../../src/service-catalog.js";
import { writeRelayCatalogStore, type RelayCatalogStore } from "./catalog.js";

export interface RelayCommandIo {
  log: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

export interface RunRelaySyncOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: RelayCommandIo;
  fetchImpl?: typeof fetch;
  cwd?: string;
}

export interface RelaySyncResult {
  manifestUrl: string;
  members: RelayDiscoveryMember[];
  catalogFilePath: string;
  newSpecs: string[];
  existingSpecs: string[];
  dryRun: boolean;
}

export async function runRelaySync(options: RunRelaySyncOptions): Promise<RelaySyncResult> {
  const io = options.io ?? defaultIo();
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const manifestUrl = stringFlag(options.flags, "manifest-url") ?? env.PROOF_NETWORK_MANIFEST_URL;
  if (!manifestUrl) {
    throw new Error("relay sync requires --manifest-url <url> or PROOF_NETWORK_MANIFEST_URL");
  }
  const expectedSigner = stringFlag(options.flags, "manifest-signer") ?? env.PROOF_NETWORK_MANIFEST_SIGNER;
  if (!expectedSigner && !boolFlag(options.flags, "allow-unpinned-signer")) {
    throw new Error(
      "relay sync requires --manifest-signer <signer> or --allow-unpinned-signer"
    );
  }
  const dryRun = boolFlag(options.flags, "dry-run");

  io.log(`Fetching live catalog from ${manifestUrl}`);
  const discovery = await discoverServices({
    manifestUrlCandidates: [manifestUrl],
    expectedManifestSigner: expectedSigner,
    allowUnpinnedManifestSigner: !expectedSigner,
    fetchImpl: options.fetchImpl
  });
  const members = resolveRelayInventoryMembers(discovery);
  io.log(`Resolved ${members.length} relay member(s) from live catalog`);

  const entries: RelayCatalogInputEntry[] = members.map((member) => ({
    relayId: member.relayId,
    apiBaseUrl: member.apiBaseUrl ?? "",
    ...(member.validationReportUrl ? { validationReportUrl: member.validationReportUrl } : {}),
    ...(member.controlPlaneUrl ? { controlPlaneUrl: member.controlPlaneUrl } : {}),
    state: deriveStateFromMember(member),
    ...(member.weight !== undefined ? { weight: member.weight } : {})
  }));

  const catalogFile = path.join(cwd, "relays", "catalog.json");
  const catalogStore: RelayCatalogStore = { filePath: catalogFile, entries };

  const newSpecs: string[] = [];
  const existingSpecs: string[] = [];
  for (const member of members) {
    const specPath = path.join(cwd, "relays", `${member.relayId}.json`);
    const exists = await fileExists(specPath);
    if (exists) {
      existingSpecs.push(specPath);
    } else {
      newSpecs.push(specPath);
    }
  }

  if (dryRun) {
    io.log("");
    io.log("Dry run — no files written.");
    io.log(`  would write : ${catalogFile} (${entries.length} entries)`);
    for (const file of newSpecs) {
      io.log(`  would write : ${file} (new stub)`);
    }
    for (const file of existingSpecs) {
      io.log(`  would skip  : ${file} (already exists)`);
    }
    return { manifestUrl, members, catalogFilePath: catalogFile, newSpecs, existingSpecs, dryRun };
  }

  await writeRelayCatalogStore(catalogStore);
  io.log(`Wrote ${catalogFile}`);

  for (const specPath of newSpecs) {
    const member = members.find((m) => path.basename(specPath, ".json") === m.relayId)!;
    const stub = stubSpec(member);
    await mkdir(path.dirname(specPath), { recursive: true });
    await writeFile(specPath, `${JSON.stringify(stub, null, 2)}\n`, "utf8");
    io.log(`Wrote ${specPath} (new stub — review before deploy)`);
  }
  if (existingSpecs.length > 0) {
    io.log(`Skipped ${existingSpecs.length} existing spec(s); preserved local edits.`);
  }

  return { manifestUrl, members, catalogFilePath: catalogFile, newSpecs, existingSpecs, dryRun };
}

function deriveStateFromMember(member: RelayDiscoveryMember): ServiceState {
  if (member.state) return member.state;
  if (member.active === false) return "disabled";
  return "active";
}

function stubSpec(member: RelayDiscoveryMember): Record<string, unknown> {
  const apiBaseUrl = member.apiBaseUrl ?? "";
  // Match the existing operator-side convention from
  // scripts/mainnet/prepare-acurast-relay-env.fish:
  //   PROOF_MAINNET_RELAY_<X>_RECORDER_PRIVATE_KEY
  const upper = member.relayId.toUpperCase().replace(/-/g, "_");
  return {
    version: 1,
    relayId: member.relayId,
    target: "bootstrap",
    catalogState: deriveStateFromMember(member),
    apiBaseUrl,
    peers: [],
    secrets: {
      relayerPrivateKeyEnv: `PROOF_MAINNET_${upper}_RECORDER_PRIVATE_KEY`
    },
    bootstrap: {
      composeService: member.relayId
    },
    _stub: "Generated by `switchboard relay sync`. Review and edit before using as a deploy spec."
  };
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

function defaultIo(): RelayCommandIo {
  return {
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
    error: (line) => console.error(line)
  };
}
