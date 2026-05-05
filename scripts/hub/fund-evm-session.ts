import "dotenv/config";
import { ethers } from "ethers";

import { getSwitchboardTarget, NATIVE_ASSET_ADDRESS } from "../../src/chains.js";
import { INGRESS_REGISTRY_NATIVE_PAYMENT_ABI } from "../../src/ingress-contract.js";
import { buildNativeDotPaymentIntent } from "../../src/native-dot-payment.js";

async function main() {
  const target = getSwitchboardTarget(process.env.SWITCHBOARD_TARGET ?? "polkadot-hub-testnet");
  const rpcUrl = process.env.HUB_ETH_RPC_URL ?? process.env.ETH_RPC_URL ?? target.defaultEthRpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (target.expectedChainId && network.chainId !== target.expectedChainId) {
    throw new Error(`Connected to chain ID ${network.chainId.toString()}, but ${target.name} expects ${target.expectedChainId.toString()}`);
  }

  const registryAddress = ethers.getAddress(requiredEnv("INGRESS_REGISTRY_ADDRESS"));
  const developer = new ethers.Wallet(requiredEnv("DEVELOPER_PRIVATE_KEY", process.env.EVM_PRIVATE_KEY), provider);
  const jobSignerAddress = ethers.getAddress(requiredEnv("JOB_SIGNER_ADDRESS"));
  const confirmations = Number(process.env.CONFIRMATIONS ?? "1");
  const intent = buildNativeDotPaymentIntent({
    chainId: network.chainId,
    registryAddress,
    developerAddress: developer.address,
    sessionLabel: process.env.SESSION_LABEL,
    sessionId: process.env.SESSION_ID,
    jobId: process.env.JOB_ID,
    expectedJobSigner: jobSignerAddress,
    operatorId: process.env.OPERATOR_ID,
    processorId: process.env.PROCESSOR_ID,
    endpointHostname: process.env.ENDPOINT_HOSTNAME,
    salt: process.env.SESSION_SALT
  });

  const registry = new ethers.Contract(registryAddress, INGRESS_REGISTRY_NATIVE_PAYMENT_ABI, developer);
  const payment = await resolvePaymentAmount(registry);
  const existing = await registry.getSession(intent.fundParams.sessionId);
  if (existing.developer !== ethers.ZeroAddress) {
    assertExistingSessionMatches(existing, intent);
    console.log(
      JSON.stringify(
        {
          ok: true,
          action: "fund-evm-session",
          alreadyFunded: true,
          target: target.name,
          chainId: network.chainId.toString(),
          registryAddress,
          developerAddress: developer.address,
          intent,
          session: sessionOutput(existing)
        },
        null,
        2
      )
    );
    return;
  }

  const tx = await registry.fundWithDot(intent.fundParams, { value: payment.amount });
  const receipt = await tx.wait(confirmations);
  const session = await registry.getSession(intent.fundParams.sessionId);
  if (session.developer.toLowerCase() !== developer.address.toLowerCase()) {
    throw new Error(`Session developer ${session.developer} did not match ${developer.address}`);
  }
  if (session.asset.toLowerCase() !== NATIVE_ASSET_ADDRESS.toLowerCase()) {
    throw new Error(`Session asset ${session.asset} did not match native asset`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        action: "fund-evm-session",
        alreadyFunded: false,
        target: target.name,
        chainId: network.chainId.toString(),
        rpcUrl,
        registryAddress,
        developerAddress: developer.address,
        paymentAmount: payment.amount.toString(),
        leaseSeconds: payment.leaseSeconds?.toString(),
        nativePricePerSecond: payment.nativePricePerSecond?.toString(),
        intent,
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber,
        session: sessionOutput(session)
      },
      null,
      2
    )
  );
}

async function resolvePaymentAmount(registry: ethers.Contract): Promise<{
  amount: bigint;
  leaseSeconds?: bigint;
  nativePricePerSecond?: bigint;
}> {
  const explicit = optionalEnv("NATIVE_PAYMENT_AMOUNT");
  if (explicit) {
    return {
      amount: parseBaseUnit("NATIVE_PAYMENT_AMOUNT", explicit)
    };
  }

  const leaseSeconds = parseBaseUnit("LEASE_SECONDS", optionalEnv("LEASE_SECONDS") ?? "60");
  const nativePricePerSecond = BigInt((await registry.nativePricePerSecond()).toString());
  return {
    amount: nativePricePerSecond * leaseSeconds,
    leaseSeconds,
    nativePricePerSecond
  };
}

function assertExistingSessionMatches(session: any, intent: ReturnType<typeof buildNativeDotPaymentIntent>) {
  const mismatches = [
    ["jobId", session.jobId, intent.fundParams.jobId],
    ["expectedJobSigner", session.expectedJobSigner, intent.fundParams.expectedJobSigner],
    ["operatorId", session.operatorId, intent.fundParams.operatorId],
    ["processorId", session.processorId, intent.fundParams.processorId],
    ["endpointHash", session.endpointHash, intent.fundParams.endpointHash],
    ["salt", session.salt, intent.fundParams.salt]
  ].filter(([, actual, expected]) => String(actual).toLowerCase() !== String(expected).toLowerCase());

  if (mismatches.length > 0) {
    throw new Error(`Existing session does not match requested intent: ${JSON.stringify(mismatches)}`);
  }
}

function sessionOutput(session: any) {
  return {
    developer: session.developer,
    asset: session.asset,
    amountPaid: session.amountPaid.toString(),
    serviceAmount: session.serviceAmount?.toString(),
    setupFee: session.setupFee?.toString(),
    validationFeeCap: session.validationFeeCap?.toString(),
    pricePerSecond: session.pricePerSecond?.toString(),
    paidSeconds: session.paidSeconds?.toString(),
    expiresAt: session.expiresAt.toString(),
    quoteId: session.quoteId,
    policyHash: session.policyHash,
    jobId: session.jobId,
    expectedJobSigner: session.expectedJobSigner,
    operatorId: session.operatorId,
    processorId: session.processorId,
    endpointHash: session.endpointHash,
    salt: session.salt,
    operatorRecipient: session.operatorRecipient,
    validatorRecipient: session.validatorRecipient,
    proofRecipient: session.proofRecipient,
    maxOperatorBps: session.maxOperatorBps?.toString(),
    maxValidatorBps: session.maxValidatorBps?.toString(),
    maxProofBps: session.maxProofBps?.toString(),
    registered: Boolean(session.registered),
    nextNonce: session.nextNonce.toString(),
    activatedAt: session.activatedAt?.toString(),
    activationDeadline: session.activationDeadline?.toString(),
    fulfilledUntil: session.fulfilledUntil?.toString(),
    amountReleased: session.amountReleased?.toString(),
    amountAccounted: session.amountAccounted?.toString(),
    setupFeeReleased: session.setupFeeReleased?.toString(),
    validationFeeReleased: session.validationFeeReleased?.toString(),
    amountRefunded: session.amountRefunded?.toString(),
    status: session.status?.toString()
  };
}

function requiredEnv(name: string, fallback?: string): string {
  const value = optionalEnv(name) ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function parseBaseUnit(name: string, value: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return BigInt(value);
}

await main();
