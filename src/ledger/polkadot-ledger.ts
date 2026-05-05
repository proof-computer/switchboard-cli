import type { LedgerPolkadotOptions, PolkadotExternalSigner } from "../polkadot.js";
import { signingPayloadBytes } from "../polkadot.js";

export async function ledgerAccount(options: LedgerPolkadotOptions): Promise<PolkadotExternalSigner> {
  const mode = options.mode ?? "generic";
  const transport = options.transport ?? "hid";
  const chain = options.chain ?? (mode === "legacy" ? "statemint" : "polkadot");
  const accountIndex = options.accountIndex ?? 0;
  const addressOffset = options.addressOffset ?? 0;
  const ss58Format = options.ss58Format ?? 42;
  const transportInstance = await createLedgerTransport(transport);
  const ledgerSubstrate = await importLedgerSubstrate();
  let requestId = 0;

  if (mode === "legacy") {
    const ledger = ledgerSubstrate.newSubstrateApp(transportInstance as any, legacyLedgerChainName(chain));
    const account = LEDGER_DEFAULT_ACCOUNT + accountIndex;
    const addressIndex = LEDGER_DEFAULT_INDEX + addressOffset;
    const ledgerAddress = await ledger.getAddress(account, LEDGER_DEFAULT_CHANGE, addressIndex, options.confirmAddress ?? false);
    const address = ledgerAddress.address;
    assertLedgerAddress(options.address, address);

    return {
      address,
      signerType: "ledger",
      signAndSendAccount: address,
      signAndSendOptions: {
        signer: {
          signPayload: async (payload: any) => {
            assertLedgerAddress(address, payload.address);
            const signature = await ledger.sign(
              account,
              LEDGER_DEFAULT_CHANGE,
              addressIndex,
              Buffer.from(signingPayloadBytes(options.api, payload))
            );
            return { id: ++requestId, signature: hexPrefix(signature.signature.toString("hex")) };
          }
        }
      },
      publicKey: hexPrefix(ledgerAddress.pubKey.toString()),
      disconnect: () => transportInstance.close()
    };
  }

  const ledger = new ledgerSubstrate.PolkadotGenericApp(
    transportInstance as any,
    options.metadataChainId,
    options.metadataUrl ?? "https://api.zondax.ch/polkadot/transaction/metadata"
  );
  const ledgerPath = ledgerBip44Path(options.slip44 ?? 354, accountIndex, addressOffset);
  const ledgerAddress = await ledger.getAddressEd25519(ledgerPath, ss58Format, options.confirmAddress ?? false);
  const address = ledgerAddress.address;
  assertLedgerAddress(options.address, address);

  return {
    address,
    signerType: "ledger",
    signAndSendAccount: address,
    signAndSendOptions: {
      signer: {
        signPayload: async (payload: any) => {
          assertLedgerAddress(address, payload.address);
          const signature = await ledger.signEd25519(ledgerPath, Buffer.from(signingPayloadBytes(options.api, payload)));
          return { id: ++requestId, signature: hexPrefix(signature.signature.toString("hex")) };
        }
      }
    },
    publicKey: hexPrefix(ledgerAddress.pubKey),
    disconnect: () => transportInstance.close()
  };
}

async function importLedgerSubstrate(): Promise<typeof import("@zondax/ledger-substrate")> {
  try {
    return await import("@zondax/ledger-substrate");
  } catch (error) {
    throw ledgerInstallError("@zondax/ledger-substrate", error);
  }
}

async function createLedgerTransport(transport: "hid" | "webusb"): Promise<any> {
  if (transport !== "hid") {
    throw new Error("Node CLI Ledger support currently requires --ledger-transport hid");
  }
  let module: any;
  try {
    module = await import("@ledgerhq/hw-transport-node-hid-singleton");
  } catch (error) {
    throw ledgerInstallError("@ledgerhq/hw-transport-node-hid-singleton", error);
  }
  const transportClass = (module.default as any)?.default ?? module.default;
  if (!transportClass?.create) {
    throw new Error("Ledger HID transport did not expose a create() method");
  }
  return transportClass.create();
}

function ledgerInstallError(packageName: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!isModuleNotFound(error)) {
    return new Error(`Failed to load Ledger dependency ${packageName}: ${message}`);
  }
  return new Error(
    [
      "Ledger-backed Polkadot signing is not part of the core switchboard-cli install.",
      `Missing Ledger dependency: ${packageName}.`,
      "Install the Ledger extension dependencies on the machine that needs Ledger signing, not on ordinary operator boxes."
    ].join(" ")
  );
}

function isModuleNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND";
}

function assertLedgerAddress(expected: string | undefined, actual: string): void {
  if (expected && expected !== actual) {
    throw new Error(`Ledger address ${actual} does not match configured Polkadot address ${expected}`);
  }
}

function ledgerBip44Path(slip44: number, accountIndex: number, addressOffset: number): string {
  return `m/44'/${slip44}'/${accountIndex}'/0'/${addressOffset}'`;
}

function legacyLedgerChainName(chain: string): string {
  const names: Record<string, string> = {
    polkadot: "Polkadot",
    statemint: "Statemint",
    statemine: "Statemine",
    kusama: "Kusama"
  };
  return names[chain] ?? chain;
}

function hexPrefix(value: string): string {
  return value.startsWith("0x") ? value : `0x${value}`;
}

const LEDGER_DEFAULT_ACCOUNT = 0x80000000;
const LEDGER_DEFAULT_CHANGE = 0x80000000;
const LEDGER_DEFAULT_INDEX = 0x80000000;
