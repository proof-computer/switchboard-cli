import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ethers } from "ethers";

import { certificateRequestDomain } from "../src/certificate-request.js";
import { INGRESS_REGISTRY_ABI } from "../src/ingress-contract.js";
import {
  hashIngressQuote,
  signIngressQuote,
  type IngressQuote
} from "../src/ingress-quote.js";
import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  recoverRegistrationSigner,
  registrationDomain,
  signRegistration,
  type RegistrationPayload
} from "../src/registration.js";

const REGISTRY = "0x65d6B76BeC50F46D198fFa3598E381a298025Da0";
const CHAIN_ID = 420420419;
const PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000009";
const WALLET = new ethers.Wallet(PRIVATE_KEY);

describe("registry EIP-712 domains", () => {
  it("keeps registry-bound domains aligned with the deployed ProofIngress contract", async () => {
    assert.equal(EIP712_DOMAIN_NAME, "ProofIngress");
    assert.equal(EIP712_DOMAIN_VERSION, "1");
    assert.deepEqual(registrationDomain(CHAIN_ID, REGISTRY), {
      name: "ProofIngress",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: REGISTRY
    });
    assert.deepEqual(certificateRequestDomain(CHAIN_ID, REGISTRY), {
      name: "ProofIngress",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: REGISTRY
    });
  });

  it("signs registration payloads recoverable under the deployed registry domain", async () => {
    const registration = exampleRegistration();
    const signature = await signRegistration(WALLET, CHAIN_ID, REGISTRY, registration);
    assert.equal(recoverRegistrationSigner(CHAIN_ID, REGISTRY, registration, signature), WALLET.address);
  });

  it("signs quote payloads recoverable under the deployed registry domain", () => {
    const quote = exampleQuote();
    const signature = signIngressQuote(quote, { chainId: CHAIN_ID, registryAddress: REGISTRY }, PRIVATE_KEY);
    assert.equal(
      ethers.recoverAddress(expectedRegistryQuoteDigest(quote), signature),
      WALLET.address
    );
    assert.equal(hashIngressQuote(quote, { chainId: CHAIN_ID, registryAddress: REGISTRY }), expectedRegistryQuoteDigest(quote));
  });
});

function exampleRegistration(): RegistrationPayload {
  return {
    sessionId: `0x${"01".repeat(32)}`,
    jobId: `0x${"02".repeat(32)}`,
    jobSigner: WALLET.address,
    operatorId: `0x${"03".repeat(32)}`,
    processorId: `0x${"04".repeat(32)}`,
    endpointHash: `0x${"05".repeat(32)}`,
    nonce: "1",
    deadline: "4102444800"
  };
}

function exampleQuote(): IngressQuote {
  return {
    quoteId: `0x${"10".repeat(32)}`,
    sessionId: `0x${"11".repeat(32)}`,
    developer: "0x0000000000000000000000000000000000001001",
    asset: "0x0000053900000000000000000000000001200000",
    amount: 120000n,
    minAmount: 120000n,
    maxAmount: 120000n,
    paidSeconds: 600n,
    serviceAmount: 100000n,
    setupFee: 10000n,
    validationFeeCap: 10000n,
    jobId: `0x${"12".repeat(32)}`,
    expectedJobSigner: WALLET.address,
    operatorId: `0x${"13".repeat(32)}`,
    processorId: `0x${"14".repeat(32)}`,
    endpointHash: `0x${"15".repeat(32)}`,
    salt: `0x${"16".repeat(32)}`,
    operatorRecipient: "0x0000000000000000000000000000000000002001",
    validatorRecipient: "0x0000000000000000000000000000000000002002",
    proofRecipient: "0x0000000000000000000000000000000000002003",
    maxOperatorBps: 1_000,
    maxValidatorBps: 500,
    maxProofBps: 2_000,
    policyHash: `0x${"17".repeat(32)}`,
    deadline: 4102444800n
  };
}

function expectedRegistryQuoteDigest(quote: IngressQuote): string {
  const iface = new ethers.Interface(INGRESS_REGISTRY_ABI);
  const quoteTuple = {
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
  const contractHash = iface.encodeFunctionData("fundWithAssetQuote", [quoteTuple, "0x"]);
  assert.match(contractHash, /^0x/);

  const domainSeparator = ethers.TypedDataEncoder.hashDomain({
    name: "ProofIngress",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: REGISTRY
  });
  const typehash = ethers.keccak256(ethers.toUtf8Bytes("Quote(bytes32 quoteId,bytes32 routeHash,bytes32 economicsHash,uint256 deadline)"));
  const routeTypehash = ethers.keccak256(ethers.toUtf8Bytes("QuoteRoute(bytes32 sessionId,address developer,address asset,bytes32 jobId,address expectedJobSigner,bytes32 operatorId,bytes32 processorId,bytes32 endpointHash,bytes32 salt)"));
  const economicsTypehash = ethers.keccak256(ethers.toUtf8Bytes("QuoteEconomics(bytes32 paymentHash,bytes32 recipientsHash,bytes32 capsHash,bytes32 policyHash)"));
  const paymentTypehash = ethers.keccak256(ethers.toUtf8Bytes("QuotePayment(uint256 amount,uint256 minAmount,uint256 maxAmount,uint256 paidSeconds,uint256 serviceAmount,uint256 setupFee,uint256 validationFeeCap)"));
  const recipientsTypehash = ethers.keccak256(ethers.toUtf8Bytes("QuoteRecipients(address operatorRecipient,address validatorRecipient,address proofRecipient)"));
  const capsTypehash = ethers.keccak256(ethers.toUtf8Bytes("QuoteCaps(uint16 maxOperatorBps,uint16 maxValidatorBps,uint16 maxProofBps)"));
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const routeHash = ethers.keccak256(
    abi.encode(
      ["bytes32", "bytes32", "address", "address", "bytes32", "address", "bytes32", "bytes32", "bytes32", "bytes32"],
      [routeTypehash, quote.sessionId, quote.developer, quote.asset, quote.jobId, quote.expectedJobSigner, quote.operatorId, quote.processorId, quote.endpointHash, quote.salt]
    )
  );
  const paymentHash = ethers.keccak256(
    abi.encode(
      ["bytes32", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
      [paymentTypehash, quote.amount, quote.minAmount, quote.maxAmount, quote.paidSeconds, quote.serviceAmount, quote.setupFee, quote.validationFeeCap]
    )
  );
  const recipientsHash = ethers.keccak256(
    abi.encode(
      ["bytes32", "address", "address", "address"],
      [recipientsTypehash, quote.operatorRecipient, quote.validatorRecipient, quote.proofRecipient]
    )
  );
  const capsHash = ethers.keccak256(
    abi.encode(
      ["bytes32", "uint16", "uint16", "uint16"],
      [capsTypehash, quote.maxOperatorBps, quote.maxValidatorBps, quote.maxProofBps]
    )
  );
  const economicsHash = ethers.keccak256(
    abi.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
      [economicsTypehash, paymentHash, recipientsHash, capsHash, quote.policyHash]
    )
  );
  const structHash = ethers.keccak256(
    abi.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "uint256"],
      [typehash, quote.quoteId, routeHash, economicsHash, quote.deadline]
    )
  );
  return ethers.keccak256(ethers.concat(["0x1901", domainSeparator, structHash]));
}
