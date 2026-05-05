import "dotenv/config";
import { ethers } from "ethers";

import { INGRESS_REGISTRY_ABI } from "../../src/ingress-contract.js";
import { getSwitchboardTarget } from "../../src/chains.js";

async function main() {
  const target = getSwitchboardTarget(process.env.SWITCHBOARD_TARGET ?? "revive-local");
  const rpcUrl = process.env.HUB_ETH_RPC_URL ?? process.env.ETH_RPC_URL ?? target.defaultEthRpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const registry = new ethers.Contract(requiredEnv("INGRESS_REGISTRY_ADDRESS"), INGRESS_REGISTRY_ABI, provider);
  const sessionId = requiredEnv("SESSION_ID");
  const session = await registry.getSession(sessionId);

  console.log(
    JSON.stringify(
      {
        target: target.name,
        rpcUrl,
        registryAddress: await registry.getAddress(),
        sessionId,
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
        registered: session.registered,
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
      },
      null,
      2
    )
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

await main();
