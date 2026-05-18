import type { ApiPromise } from "@polkadot/api";
import type { Contract } from "ethers";
import { ethers } from "ethers";

import { NATIVE_ASSET_ADDRESS } from "./chains.js";
import { endpointHash, idBytes32 } from "./registration.js";
import type { ReviveNativeValueQuote } from "./revive.js";

const NATIVE_DOT_CONTRACT_PAYMENT_UNSUPPORTED =
  "Native DOT contract payment is not supported by the v1 paid registry; fund with an accepted ERC20 stablecoin quote instead.";

export interface NativeDotPaymentRequest {
  source: "contract-payment-amount" | "lease-seconds";
  requestedContractValue: bigint;
  nativePricePerSecond?: bigint;
  leaseSeconds?: bigint;
}

export interface NativeDotPaymentIntentInput {
  chainId: bigint | number | string;
  registryAddress: string;
  developerAddress: string;
  sessionLabel?: string;
  sessionId?: string;
  jobId?: string;
  expectedJobSigner: string;
  operatorId?: string;
  processorId?: string;
  endpointHostname?: string;
  salt?: string;
}

export interface NativeDotPaymentIntent {
  sessionLabel: string;
  endpointHostname: string;
  fundParams: {
    sessionId: string;
    jobId: string;
    expectedJobSigner: string;
    operatorId: string;
    processorId: string;
    endpointHash: string;
    salt: string;
  };
}

export interface NativeDotPaymentQuote {
  request: NativeDotPaymentRequest;
  revive: ReviveNativeValueQuote;
}

export interface ReviveCallWeightLimit {
  refTime: string;
  proofSize: string;
}

export interface NativeDotFundCallInput {
  api: ApiPromise;
  registryAddress: string;
  intent: NativeDotPaymentIntent;
  nativeCallValue: bigint;
  weightLimit: ReviveCallWeightLimit;
  storageDepositLimit: bigint;
}

export function buildNativeDotPaymentIntent(input: NativeDotPaymentIntentInput): NativeDotPaymentIntent {
  const sessionLabel = input.sessionLabel ?? `ingress-${Date.now()}`;
  const endpointHostname = input.endpointHostname ?? `${toDnsLabel(sessionLabel)}.ingress.test`;
  const expectedJobSigner = ethers.getAddress(input.expectedJobSigner);
  const jobId = input.jobId ?? idBytes32(`${sessionLabel}:job`);
  const operatorId = input.operatorId ?? idBytes32("proof-operator-local");
  const processorId = input.processorId ?? idBytes32("processor-local-1");
  const endpointHashValue = endpointHash(endpointHostname);
  const salt = input.salt ?? idBytes32(`${sessionLabel}:session`);
  const sessionId = deriveIngressSessionId({
    chainId: input.chainId,
    registryAddress: input.registryAddress,
    developerAddress: input.developerAddress,
    assetAddress: NATIVE_ASSET_ADDRESS,
    jobId,
    expectedJobSigner,
    operatorId,
    processorId,
    endpointHash: endpointHashValue,
    salt
  });
  if (input.sessionId && ethers.hexlify(input.sessionId).toLowerCase() !== sessionId.toLowerCase()) {
    throw new Error(`SESSION_ID ${input.sessionId} does not match derived session ID ${sessionId}`);
  }

  return {
    sessionLabel,
    endpointHostname,
    fundParams: {
      sessionId,
      jobId,
      expectedJobSigner,
      operatorId,
      processorId,
      endpointHash: endpointHashValue,
      salt
    }
  };
}

export function deriveIngressSessionId(input: {
  chainId: bigint | number | string;
  registryAddress: string;
  developerAddress: string;
  assetAddress: string;
  jobId: string;
  expectedJobSigner: string;
  operatorId: string;
  processorId: string;
  endpointHash: string;
  salt: string;
}): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "address", "address", "bytes32", "address", "bytes32", "bytes32", "bytes32", "bytes32"],
      [
        idBytes32("PROOF_INGRESS_SESSION_V1"),
        input.chainId,
        ethers.getAddress(input.registryAddress),
        ethers.getAddress(input.developerAddress),
        ethers.getAddress(input.assetAddress),
        ethers.hexlify(input.jobId),
        ethers.getAddress(input.expectedJobSigner),
        ethers.hexlify(input.operatorId),
        ethers.hexlify(input.processorId),
        ethers.hexlify(input.endpointHash),
        ethers.hexlify(input.salt)
      ]
    )
  );
}

export async function resolveNativeDotPaymentRequest(
  registry: Contract,
  input: {
    contractPaymentAmount?: bigint;
    leaseSeconds?: bigint;
    defaultLeaseSeconds?: bigint;
  }
): Promise<NativeDotPaymentRequest> {
  void registry;
  void input;
  return unsupportedNativeDotPayment();
}

export async function quoteNativeDotPayment(
  api: ApiPromise,
  registry: Contract,
  input: {
    contractPaymentAmount?: bigint;
    leaseSeconds?: bigint;
    defaultLeaseSeconds?: bigint;
  }
): Promise<NativeDotPaymentQuote> {
  void api;
  void registry;
  void input;
  return unsupportedNativeDotPayment();
}

export function encodeFundWithDot(intent: NativeDotPaymentIntent): string {
  void intent;
  return unsupportedNativeDotPayment();
}

export function buildNativeDotFundCall(input: NativeDotFundCallInput): any {
  void input;
  return unsupportedNativeDotPayment();
}

export function toDnsLabel(value: string): string {
  const label = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

  return label.length > 0 ? label : "session";
}

function unsupportedNativeDotPayment(): never {
  throw new Error(NATIVE_DOT_CONTRACT_PAYMENT_UNSUPPORTED);
}
