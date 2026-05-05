import { readFile } from "node:fs/promises";
import path from "node:path";

import { Keyring } from "@polkadot/api";
import { cryptoWaitReady, decodeAddress, encodeAddress, mnemonicValidate } from "@polkadot/util-crypto";

import { parseRelayDeploymentSpec } from "../../../src/relay-deployment-spec.js";

export interface RunRelayWhoamiOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  cwd?: string;
}

export interface RelayWhoamiResult {
  network: "mainnet" | "canary";
  seedEnvName: string;
  addressEnvName?: string;
  derivedAddressGeneric: string;
  derivedAddressPolkadot: string;
  configuredAddress?: string;
  matches: boolean | "unset";
}

/**
 * Derive the Acurast deployer address from the configured seed and
 * compare against the address env. Diagnoses the
 * "ACURAST_SEED does not derive ACURAST_ADDRESS …" deploy-time error
 * without needing to read fish files by hand.
 *
 * Resolution order for the seed:
 *   --seed-env <NAME>
 *   spec.acurast.deployerSeedEnv  (when --spec / --relay <id> is passed)
 *   ACURAST_MAINNET_SEED, ACURAST_SEED (canary: ACURAST_CANARY_SEED)
 */
export async function runRelayWhoami(options: RunRelayWhoamiOptions): Promise<RelayWhoamiResult> {
  const io = options.io ?? defaultIo();
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const network = (stringFlag(options.flags, "network") ?? "mainnet") as "mainnet" | "canary";
  if (network !== "mainnet" && network !== "canary") {
    throw new Error(`--network must be mainnet or canary (got ${network})`);
  }
  const seedPrefix = network === "canary" ? "ACURAST_CANARY" : "ACURAST_MAINNET";

  let seedEnvName = stringFlag(options.flags, "seed-env");
  if (!seedEnvName) {
    const relayId = (options.positionals ?? [])[2];
    const specFlag = stringFlag(options.flags, "spec") ?? stringFlag(options.flags, "spec-file");
    const specPath = specFlag ?? (relayId ? path.join(cwd, "relays", `${relayId}.json`) : undefined);
    if (specPath) {
      try {
        const raw = await readFile(specPath, "utf8");
        const spec = parseRelayDeploymentSpec(JSON.parse(raw));
        if (spec.acurast?.deployerSeedEnv) {
          seedEnvName = spec.acurast.deployerSeedEnv;
        }
      } catch {
        // best-effort; fall through to env defaults
      }
    }
  }
  if (!seedEnvName) {
    seedEnvName = env[`${seedPrefix}_SEED`] ? `${seedPrefix}_SEED` : env.ACURAST_SEED ? "ACURAST_SEED" : `${seedPrefix}_SEED`;
  }
  const seed = env[seedEnvName];
  if (!seed) {
    throw new Error(`Seed env ${seedEnvName} is not set in the calling shell`);
  }
  if (!mnemonicValidate(seed)) {
    throw new Error(`${seedEnvName} is not a valid 12/24-word BIP-39 mnemonic`);
  }

  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  const pair = keyring.addFromMnemonic(seed);
  const publicKey = decodeAddress(pair.address);
  const derivedAddressGeneric = encodeAddress(publicKey, 42); // generic Substrate prefix
  const derivedAddressPolkadot = encodeAddress(publicKey, 0); // Polkadot mainnet prefix

  const addressCandidates = [`${seedPrefix}_ADDRESS`, "ACURAST_ADDRESS"];
  let addressEnvName: string | undefined;
  let configuredAddress: string | undefined;
  for (const candidate of addressCandidates) {
    if (env[candidate]) {
      addressEnvName = candidate;
      configuredAddress = env[candidate];
      break;
    }
  }

  let matches: boolean | "unset" = "unset";
  if (configuredAddress) {
    try {
      const expected = decodeAddress(configuredAddress);
      matches = Buffer.from(publicKey).equals(Buffer.from(expected));
    } catch {
      matches = false;
    }
  }

  if (boolFlag(options.flags, "json")) {
    io.log(JSON.stringify({
      network,
      seedEnvName,
      addressEnvName,
      derivedAddressGeneric,
      derivedAddressPolkadot,
      configuredAddress,
      matches
    }, null, 2));
  } else {
    io.log(`network              : ${network}`);
    io.log(`seed env             : ${seedEnvName}`);
    io.log(`derived (generic 42) : ${derivedAddressGeneric}`);
    io.log(`derived (polkadot 0) : ${derivedAddressPolkadot}`);
    if (addressEnvName) {
      io.log(`configured ${addressEnvName.padEnd(8)} : ${configuredAddress}`);
      if (matches === true) {
        io.log("");
        io.log("✓ seed derives the configured address");
      } else {
        io.log("");
        io.log(`✗ seed does NOT derive ${configuredAddress}`);
        io.log("");
        io.log("Fix one of:");
        io.log(`  - Set ${addressEnvName} to ${derivedAddressGeneric} (or the polkadot-prefix form ${derivedAddressPolkadot})`);
        io.log(`  - Use a seed that derives ${configuredAddress} (different account)`);
        io.log(`  - Unset ${addressEnvName} to skip the check (loses verification)`);
      }
    } else {
      io.log(`configured address   : (none — verification skipped at deploy time)`);
    }
  }

  return {
    network,
    seedEnvName,
    addressEnvName,
    derivedAddressGeneric,
    derivedAddressPolkadot,
    configuredAddress,
    matches
  };
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
