import { randomBytes } from "node:crypto";
import { ethers } from "ethers";

import { INGRESS_REGISTRY_ABI } from "./ingress-contract.js";
import { deriveIngressSessionId, toDnsLabel } from "./native-dot-payment.js";
import { EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION, endpointHash, idBytes32 } from "./registration.js";

export const MAX_INGRESS_QUOTE_PAID_SECONDS = 28n * 24n * 60n * 60n;

export interface IngressQuote {
  quoteId: string;
  sessionId: string;
  developer: string;
  asset: string;
  amount: bigint;
  minAmount: bigint;
  maxAmount: bigint;
  paidSeconds: bigint;
  serviceAmount: bigint;
  setupFee: bigint;
  validationFeeCap: bigint;
  jobId: string;
  expectedJobSigner: string;
  operatorId: string;
  processorId: string;
  endpointHash: string;
  salt: string;
  operatorRecipient: string;
  validatorRecipient: string;
  proofRecipient: string;
  maxOperatorBps: number;
  maxValidatorBps: number;
  maxProofBps: number;
  policyHash: string;
  deadline: bigint;
}

export interface IngressQuoteBuildInput {
  chainId: bigint | number | string;
  registryAddress: string;
  developer: string;
  asset: string;
  amount?: bigint;
  serviceAmount?: bigint;
  setupFee?: bigint;
  validationFeeCap?: bigint;
  minAmount?: bigint;
  maxAmount?: bigint;
  paidSeconds: bigint;
  expectedJobSigner: string;
  operatorRecipient: string;
  validatorRecipient: string;
  proofRecipient: string;
  maxOperatorBps?: number;
  maxValidatorBps?: number;
  maxProofBps?: number;
  policyHash: string;
  deadline: bigint | number | string;
  quoteId?: string;
  sessionLabel?: string;
  jobId?: string;
  operatorId?: string;
  processorId?: string;
  endpointHostname?: string;
  endpointHash?: string;
  salt?: string;
}

export interface IngressQuoteDomain {
  chainId: bigint | number | string;
  registryAddress: string;
}

const QUOTE_TYPEHASH = ethers.id("Quote(bytes32 quoteId,bytes32 routeHash,bytes32 economicsHash,uint256 deadline)");
const QUOTE_ROUTE_TYPEHASH = ethers.id(
  "QuoteRoute(bytes32 sessionId,address developer,address asset,bytes32 jobId,address expectedJobSigner,bytes32 operatorId,bytes32 processorId,bytes32 endpointHash,bytes32 salt)"
);
const QUOTE_ECONOMICS_TYPEHASH = ethers.id(
  "QuoteEconomics(bytes32 paymentHash,bytes32 recipientsHash,bytes32 capsHash,bytes32 policyHash)"
);
const QUOTE_PAYMENT_TYPEHASH = ethers.id(
  "QuotePayment(uint256 amount,uint256 minAmount,uint256 maxAmount,uint256 paidSeconds,uint256 serviceAmount,uint256 setupFee,uint256 validationFeeCap)"
);
const QUOTE_RECIPIENTS_TYPEHASH = ethers.id(
  "QuoteRecipients(address operatorRecipient,address validatorRecipient,address proofRecipient)"
);
const QUOTE_CAPS_TYPEHASH = ethers.id(
  "QuoteCaps(uint16 maxOperatorBps,uint16 maxValidatorBps,uint16 maxProofBps)"
);

export function buildIngressQuote(input: IngressQuoteBuildInput): IngressQuote {
  const setupFee = input.setupFee ?? 0n;
  const validationFeeCap = input.validationFeeCap ?? 0n;
  const serviceAmount = input.serviceAmount ?? input.amount;
  if (serviceAmount === undefined) {
    throw new Error("quote serviceAmount must be provided");
  }
  if (setupFee < 0n || validationFeeCap < 0n) {
    throw new Error("quote fees cannot be negative");
  }
  const amount = input.amount ?? serviceAmount + setupFee + validationFeeCap;
  if (amount <= 0n || serviceAmount <= 0n || amount !== serviceAmount + setupFee + validationFeeCap) {
    throw new Error("quote amount must equal serviceAmount plus fee caps");
  }
  if (input.paidSeconds <= 0n) {
    throw new Error("quote paidSeconds must be positive");
  }
  if (input.paidSeconds > MAX_INGRESS_QUOTE_PAID_SECONDS) {
    throw new Error("quote paidSeconds exceeds the 28 day Acurast job maximum");
  }

  const sessionLabel = input.sessionLabel ?? `ingress-${Date.now()}`;
  const asset = ethers.getAddress(input.asset);
  if (asset === ethers.ZeroAddress) {
    throw new Error("quote asset must be a non-native ERC20 address");
  }
  const expectedJobSigner = ethers.getAddress(input.expectedJobSigner);
  const developer = ethers.getAddress(input.developer);
  const endpointHostname = input.endpointHostname ?? `${toDnsLabel(sessionLabel)}.ingress.test`;
  const endpointHashValue = input.endpointHash ? ethers.hexlify(input.endpointHash) : endpointHash(endpointHostname);
  const jobId = input.jobId ?? idBytes32(`${sessionLabel}:job`);
  const operatorId = input.operatorId ?? idBytes32("proof-operator-local");
  const processorId = input.processorId ?? idBytes32("processor-local-1");
  const salt = input.salt ?? idBytes32(`${sessionLabel}:session`);
  const sessionId = deriveIngressSessionId({
    chainId: input.chainId,
    registryAddress: input.registryAddress,
    developerAddress: developer,
    assetAddress: asset,
    jobId,
    expectedJobSigner,
    operatorId,
    processorId,
    endpointHash: endpointHashValue,
    salt
  });

  return {
    quoteId: input.quoteId ?? ethers.hexlify(randomBytes(32)),
    sessionId,
    developer,
    asset,
    amount,
    minAmount: input.minAmount ?? amount,
    maxAmount: input.maxAmount ?? amount,
    paidSeconds: input.paidSeconds,
    serviceAmount,
    setupFee,
    validationFeeCap,
    jobId,
    expectedJobSigner,
    operatorId,
    processorId,
    endpointHash: endpointHashValue,
    salt,
    operatorRecipient: ethers.getAddress(input.operatorRecipient),
    validatorRecipient: ethers.getAddress(input.validatorRecipient),
    proofRecipient: ethers.getAddress(input.proofRecipient),
    maxOperatorBps: input.maxOperatorBps ?? 8_000,
    maxValidatorBps: input.maxValidatorBps ?? 500,
    maxProofBps: input.maxProofBps ?? 2_000,
    policyHash: ethers.hexlify(input.policyHash),
    deadline: BigInt(input.deadline)
  };
}

export function ingressQuoteToContractTuple(quote: IngressQuote) {
  return {
    quoteId: quote.quoteId,
    sessionId: quote.sessionId,
    developer: quote.developer,
    asset: quote.asset,
    amount: quote.amount,
    minAmount: quote.minAmount,
    maxAmount: quote.maxAmount,
    paidSeconds: quote.paidSeconds,
    serviceAmount: quote.serviceAmount,
    setupFee: quote.setupFee,
    validationFeeCap: quote.validationFeeCap,
    jobId: quote.jobId,
    expectedJobSigner: quote.expectedJobSigner,
    operatorId: quote.operatorId,
    processorId: quote.processorId,
    endpointHash: quote.endpointHash,
    salt: quote.salt,
    operatorRecipient: quote.operatorRecipient,
    validatorRecipient: quote.validatorRecipient,
    proofRecipient: quote.proofRecipient,
    maxOperatorBps: quote.maxOperatorBps,
    maxValidatorBps: quote.maxValidatorBps,
    maxProofBps: quote.maxProofBps,
    policyHash: quote.policyHash,
    deadline: quote.deadline
  };
}

export function hashIngressQuote(quote: IngressQuote, domain: IngressQuoteDomain): string {
  const domainSeparator = ethers.TypedDataEncoder.hashDomain({
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId: domain.chainId,
    verifyingContract: ethers.getAddress(domain.registryAddress)
  });
  const routeHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "address", "address", "bytes32", "address", "bytes32", "bytes32", "bytes32", "bytes32"],
      [
        QUOTE_ROUTE_TYPEHASH,
        quote.sessionId,
        quote.developer,
        quote.asset,
        quote.jobId,
        quote.expectedJobSigner,
        quote.operatorId,
        quote.processorId,
        quote.endpointHash,
        quote.salt
      ]
    )
  );
  const paymentHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
      [
        QUOTE_PAYMENT_TYPEHASH,
        quote.amount,
        quote.minAmount,
        quote.maxAmount,
        quote.paidSeconds,
        quote.serviceAmount,
        quote.setupFee,
        quote.validationFeeCap
      ]
    )
  );
  const recipientsHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "address", "address"],
      [QUOTE_RECIPIENTS_TYPEHASH, quote.operatorRecipient, quote.validatorRecipient, quote.proofRecipient]
    )
  );
  const capsHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint16", "uint16", "uint16"],
      [QUOTE_CAPS_TYPEHASH, quote.maxOperatorBps, quote.maxValidatorBps, quote.maxProofBps]
    )
  );
  const economicsHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
      [QUOTE_ECONOMICS_TYPEHASH, paymentHash, recipientsHash, capsHash, quote.policyHash]
    )
  );
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "uint256"],
      [QUOTE_TYPEHASH, quote.quoteId, routeHash, economicsHash, quote.deadline]
    )
  );

  return ethers.keccak256(ethers.concat(["0x1901", domainSeparator, structHash]));
}

export function signIngressQuote(
  quote: IngressQuote,
  domain: IngressQuoteDomain,
  quoteSignerPrivateKey: string
): string {
  const wallet = new ethers.Wallet(quoteSignerPrivateKey);
  return wallet.signingKey.sign(hashIngressQuote(quote, domain)).serialized;
}

export function recoverIngressQuoteSigner(quote: IngressQuote, domain: IngressQuoteDomain, signature: string): string {
  return ethers.recoverAddress(hashIngressQuote(quote, domain), signature);
}

export function policyHashFromJson(value: unknown): string {
  return ethers.keccak256(ethers.toUtf8Bytes(stableJson(value)));
}

export function encodeFundWithAssetQuote(quote: IngressQuote, signature: string): string {
  const contractInterface = new ethers.Interface(INGRESS_REGISTRY_ABI);
  return contractInterface.encodeFunctionData("fundWithAssetQuote", [ingressQuoteToContractTuple(quote), signature]);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}
