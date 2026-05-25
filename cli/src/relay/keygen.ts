import { ethers } from "ethers";

export interface RunRelayKeygenOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  createWallet?: () => RelayKeygenWallet;
}

export interface RelayKeygenResult {
  relayId: string;
  address: string;
  privateKey: string;
  envName: string;
  fishLine: string;
}

export interface RelayKeygenWallet {
  address: string;
  privateKey: string;
}

/**
 * Generate a fresh secp256k1 keypair for a relay's relayer/recorder
 * identity. The private key is printed to stderr by default so it stays
 * out of redirected stdout pipelines; the address is printed to stdout
 * for capture into a spec or context.
 *
 * Pass `--unsafe-stdout` to print the private key to stdout (e.g. when
 * piping into `op item create` or `pass insert -m`).
 */
export async function runRelayKeygen(options: RunRelayKeygenOptions): Promise<RelayKeygenResult> {
  const io = options.io ?? defaultIo();
  // positionals shape: ["relay", "keygen", "<id>"]
  const relayId = (options.positionals ?? [])[2];
  if (!relayId || !/^[a-z0-9-]+$/.test(relayId)) {
    throw new Error("Usage: switchboard relay keygen <relay-id>  (id must match /^[a-z0-9-]+$/)");
  }

  const wallet = (options.createWallet ?? (() => ethers.Wallet.createRandom()))();
  const envName = stringFlag(options.flags, "env-name") ?? defaultEnvName(relayId);
  const fishLine = `set -gx ${envName} ${wallet.privateKey}`;

  io.log(`relay  : ${relayId}`);
  io.log(`address: ${wallet.address}`);
  io.log(`env    : ${envName}`);
  io.log("");

  if (boolFlag(options.flags, "unsafe-stdout")) {
    io.log(`private key (stdout): ${wallet.privateKey}`);
  } else {
    io.log("To capture the private key, re-run with --unsafe-stdout (pipes the private key to stdout)");
    io.log("or paste the line below from stderr into your secrets file:");
    io.error(fishLine);
  }

  return {
    relayId,
    address: wallet.address,
    privateKey: wallet.privateKey,
    envName,
    fishLine
  };
}

function defaultEnvName(relayId: string): string {
  // Match the existing operator-side convention from
  // scripts/mainnet/prepare-acurast-relay-env.fish:
  //   PROOF_MAINNET_RELAY_<X>_RECORDER_PRIVATE_KEY
  const upper = relayId.toUpperCase().replace(/-/g, "_");
  if (upper.startsWith("RELAY_")) {
    return `PROOF_MAINNET_${upper}_RECORDER_PRIVATE_KEY`;
  }
  return `PROOF_MAINNET_${upper}_RECORDER_PRIVATE_KEY`;
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
