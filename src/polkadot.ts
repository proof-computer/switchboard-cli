import type { ApiPromise } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { Keyring } from "@polkadot/keyring";
import { ethers } from "ethers";

export interface LedgerPolkadotOptions {
  api: ApiPromise;
  address?: string;
  ss58Format?: number;
  mode?: "generic" | "legacy";
  transport?: "hid" | "webusb";
  chain?: string;
  slip44?: number;
  accountIndex?: number;
  addressOffset?: number;
  confirmAddress?: boolean;
  metadataChainId?: string;
  metadataUrl?: string;
}

export interface PolkadotExternalSigner {
  address: string;
  signerType: "ledger";
  signAndSendAccount: string;
  signAndSendOptions: Record<string, unknown>;
  publicKey?: string;
  disconnect(): Promise<void>;
}

export async function accountFromUri(uri: string, ss58Format?: number) {
  await cryptoWaitReady();
  const keyring = new Keyring({
    type: "sr25519",
    ss58Format
  });

  return keyring.addFromUri(uri);
}

export async function ledgerAccount(options: LedgerPolkadotOptions): Promise<PolkadotExternalSigner> {
  const module = await import("./ledger/polkadot-ledger.js");
  return module.ledgerAccount(options);
}

export async function signAndSend(api: ApiPromise, tx: any, signer: any, timeoutMs = 120_000): Promise<{
  txHash: string;
  blockHash?: string;
  status: string;
  events: Array<{ section: string; method: string }>;
}> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      reject(new Error(`Transaction was not included within ${timeoutMs}ms`));
    }, timeoutMs);

    const settle = <T>(fn: (value: T) => void, value: T) => {
      clearTimeout(timeout);
      unsubscribe?.();
      fn(value);
    };

    const callback = (result: any) => {
      if (result.dispatchError) {
        const message = dispatchErrorMessage(api, result.dispatchError);
        settle(reject, new Error(message));
        return;
      }

      if (result.status.isInBlock || result.status.isFinalized) {
        settle(resolve, {
          txHash: tx.hash.toHex(),
          blockHash: result.status.isFinalized
            ? result.status.asFinalized.toHex()
            : result.status.asInBlock.toHex(),
          status: result.status.type,
          events: result.events.map(({ event }: any) => ({
            section: event.section,
            method: event.method
          }))
        });
      }
    };

    const signAndSendPromise = isPolkadotExternalSigner(signer)
      ? tx.signAndSend(signer.signAndSendAccount, signer.signAndSendOptions, callback)
      : tx.signAndSend(signer, callback);

    signAndSendPromise
      .then((unsub: () => void) => {
        unsubscribe = unsub;
      })
      .catch((error: unknown) => settle(reject, error));
  });
}

export function dispatchErrorMessage(api: ApiPromise, error: any): string {
  if (error.isModule) {
    const decoded = api.registry.findMetaError(error.asModule);
    return `${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`;
  }

  return error.toString();
}

export async function contractLayerAddress(api: ApiPromise, accountAddress: string): Promise<string> {
  const address = await api.call.reviveApi.address(accountAddress);
  return ethers.getAddress(address.toString());
}

export async function isReviveAccountMapped(api: ApiPromise, contractLayerAddress: string): Promise<boolean> {
  const original = await api.query.revive.originalAccount(contractLayerAddress);
  return (original as any).isSome === true;
}

export function signingPayloadBytes(api: ApiPromise, payload: any): Uint8Array {
  return api.registry
    .createTypeUnsafe("ExtrinsicPayload", [payload, { version: payload.version }])
    .toU8a({ method: true });
}

function isPolkadotExternalSigner(value: any): value is PolkadotExternalSigner {
  return Boolean(value?.signAndSendAccount && value?.signAndSendOptions);
}
