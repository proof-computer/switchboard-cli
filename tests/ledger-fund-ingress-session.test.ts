import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { ethers } from "ethers";

import {
  fundIngressSessionWithLedger,
  type ChainReader,
  type FundIngressSessionInput
} from "../src/ledger-fund-ingress-session.js";
import { encodeFundWithAssetQuote, type IngressQuote } from "../src/ingress-quote.js";

const ledger = {
  rpcUrl: "https://services.polkadothub-rpc.com/mainnet",
  chainId: "420420419",
  ledgerAddress: "0xaE6980ad5D0210585FF381A48Cba5c0be5C02C96",
  derivationPath: "m/44'/60'/1'/0/0",
  legacy: true,
  confirmations: "1"
} as const;

const ASSET = "0x0000053900000000000000000000000001200000";
const REGISTRY = "0x65d6B76BeC50F46D198fFa3598E381a298025Da0";
const JOB_SIGNER = "0x4389bddE214740DAaD4255019b787E8c51f6dCcf";

function quoteResponse(overrides: Record<string, unknown> = {}): unknown {
  const base = {
    ok: true,
    signature: "0xdeadbeef",
    endpointHostname: "relay-d.switchboard.proof.computer",
    quote: {
      quoteId: `0x${"01".repeat(32)}`,
      sessionId: `0x${"02".repeat(32)}`,
      developer: ledger.ledgerAddress,
      asset: ASSET,
      amount: "1000000",
      minAmount: "500000",
      maxAmount: "5000000",
      paidSeconds: "600",
      serviceAmount: "100",
      setupFee: "10",
      validationFeeCap: "5",
      jobId: `0x${"03".repeat(32)}`,
      expectedJobSigner: JOB_SIGNER,
      operatorId: `0x${"04".repeat(32)}`,
      processorId: `0x${"05".repeat(32)}`,
      endpointHash: `0x${"06".repeat(32)}`,
      salt: `0x${"07".repeat(32)}`,
      operatorRecipient: "0x0000000000000000000000000000000000001111",
      validatorRecipient: "0x0000000000000000000000000000000000002222",
      proofRecipient: "0x0000000000000000000000000000000000003333",
      maxOperatorBps: 1000,
      maxValidatorBps: 200,
      maxProofBps: 50,
      policyHash: `0x${"08".repeat(32)}`,
      deadline: "1800000000"
    },
    funding: { assetCalldata: "0xabcdef" }
  };
  return { ...base, ...overrides };
}

function quoteRecordToIngressQuote(input: Record<string, unknown>): IngressQuote {
  return {
    quoteId: input.quoteId as string,
    sessionId: input.sessionId as string,
    developer: ethers.getAddress(input.developer as string),
    asset: ethers.getAddress(input.asset as string),
    amount: BigInt(input.amount as string),
    minAmount: BigInt(input.minAmount as string),
    maxAmount: BigInt(input.maxAmount as string),
    paidSeconds: BigInt(input.paidSeconds as string),
    serviceAmount: BigInt(input.serviceAmount as string),
    setupFee: BigInt(input.setupFee as string),
    validationFeeCap: BigInt(input.validationFeeCap as string),
    jobId: input.jobId as string,
    expectedJobSigner: ethers.getAddress(input.expectedJobSigner as string),
    operatorId: input.operatorId as string,
    processorId: input.processorId as string,
    endpointHash: input.endpointHash as string,
    salt: input.salt as string,
    operatorRecipient: ethers.getAddress(input.operatorRecipient as string),
    validatorRecipient: ethers.getAddress(input.validatorRecipient as string),
    proofRecipient: ethers.getAddress(input.proofRecipient as string),
    maxOperatorBps: Number(input.maxOperatorBps),
    maxValidatorBps: Number(input.maxValidatorBps),
    maxProofBps: Number(input.maxProofBps),
    policyHash: input.policyHash as string,
    deadline: BigInt(input.deadline as string)
  };
}

function expectedFundingCalldata(response: unknown = quoteResponse()): string {
  const typed = response as { quote: Record<string, unknown>; signature: string };
  return encodeFundWithAssetQuote(quoteRecordToIngressQuote(typed.quote), typed.signature);
}

function lastArg(args: string[]): string {
  return args[args.length - 1] ?? "";
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

interface ChainReaderState {
  chainId?: bigint;
  balance?: bigint;
  allowance?: bigint;
  existingDeveloper?: string;
}

function makeChainReader(state: ChainReaderState = {}): ChainReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getChainId() {
      calls.push("getChainId");
      return state.chainId ?? 420420419n;
    },
    async getAssetBalance(asset, owner) {
      calls.push(`balance:${asset.toLowerCase()}:${owner.toLowerCase()}`);
      return state.balance ?? 1_000_000n;
    },
    async getAssetAllowance(asset, owner, spender) {
      calls.push(`allowance:${asset.toLowerCase()}:${owner.toLowerCase()}:${spender.toLowerCase()}`);
      return state.allowance ?? 0n;
    },
    async getRegistrySessionDeveloper(registry, sessionId) {
      calls.push(`session:${registry.toLowerCase()}:${sessionId}`);
      return state.existingDeveloper ?? ethers.ZeroAddress;
    }
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function baseInput(
  overrides: Partial<FundIngressSessionInput> = {}
): FundIngressSessionInput {
  return {
    registryAddress: REGISTRY,
    relayUrl: "https://relay-a.switchboard.proof.computer",
    asset: ASSET,
    paidSeconds: "600",
    jobSignerAddress: JOB_SIGNER,
    ledger: { ...ledger },
    yes: true,
    fetchImpl: async () => jsonResponse(quoteResponse()),
    runCommand: async () => undefined,
    chainReader: makeChainReader(),
    ...overrides
  };
}

describe("fundIngressSessionWithLedger", () => {
  it("approves and broadcasts fundWithAssetQuote when no allowance and no existing session", async () => {
    const recordedCommands: Array<{ action: string; args: string[] }> = [];
    const result = await fundIngressSessionWithLedger(
      baseInput({
        runCommand: async (command, args) => {
          recordedCommands.push({ action: args[0] === "send" ? args[args.length - 2] ?? args[args.length - 1] : "?", args });
        }
      })
    );
    assert.equal(result.alreadyFunded, false);
    assert.equal(result.sessionId, `0x${"02".repeat(32)}`);
    assert.equal(result.jobId, `0x${"03".repeat(32)}`);
    assert.equal(result.endpointHostname, "relay-d.switchboard.proof.computer");
    assert.equal(recordedCommands.length, 2);
    // First command is the approve; second is the fundWithAssetQuote calldata send.
    assert.match(recordedCommands[0].args.join(" "), /approve\(address,uint256\)/);
    assert.equal(lastArg(recordedCommands[1].args), expectedFundingCalldata());
    assert.notEqual(lastArg(recordedCommands[1].args), "0xabcdef");
  });

  it("skips approve when allowance already covers the quote amount", async () => {
    const recordedCommands: Array<{ args: string[] }> = [];
    await fundIngressSessionWithLedger(
      baseInput({
        chainReader: makeChainReader({ allowance: 10_000_000n }),
        runCommand: async (_command, args) => {
          recordedCommands.push({ args });
        }
      })
    );
    assert.equal(recordedCommands.length, 1);
    assert.equal(lastArg(recordedCommands[0].args), expectedFundingCalldata());
    assert.notEqual(lastArg(recordedCommands[0].args), "0xabcdef");
    // No approve.
    assert.ok(!recordedCommands.some((c) => c.args.join(" ").includes("approve(address,uint256)")));
  });

  it("returns alreadyFunded without broadcasting when the registry already has a session", async () => {
    const recordedCommands: unknown[] = [];
    const result = await fundIngressSessionWithLedger(
      baseInput({
        chainReader: makeChainReader({ existingDeveloper: ledger.ledgerAddress }),
        runCommand: async (...calls) => {
          recordedCommands.push(calls);
        }
      })
    );
    assert.equal(result.alreadyFunded, true);
    assert.equal(recordedCommands.length, 0);
    assert.equal(result.sessionId, `0x${"02".repeat(32)}`);
  });

  it("returns plannedCommands without broadcasting when yes=false", async () => {
    let runCalls = 0;
    const result = await fundIngressSessionWithLedger(
      baseInput({
        yes: false,
        runCommand: async () => {
          runCalls += 1;
        }
      })
    );
    assert.equal(runCalls, 0);
    assert.equal(result.alreadyFunded, false);
    assert.ok(result.plannedCommands && result.plannedCommands.length === 2);
    assert.equal(result.plannedCommands![0].action, "approve");
    assert.equal(result.plannedCommands![1].action, "fundWithAssetQuote");
  });

  it("rejects when the developer balance is below the quote amount", async () => {
    await assert.rejects(
      () =>
        fundIngressSessionWithLedger(
          baseInput({ chainReader: makeChainReader({ balance: 0n }) })
        ),
      /asset balance .* is below quote amount/
    );
  });

  it("rejects when the RPC returns a different chainId", async () => {
    await assert.rejects(
      () =>
        fundIngressSessionWithLedger(
          baseInput({ chainReader: makeChainReader({ chainId: 1n }) })
        ),
      /connected to chain id 1, but expected 420420419/
    );
  });

  it("rejects when quote.expectedJobSigner differs from requested job signer", async () => {
    const skewed = quoteResponse() as { quote: Record<string, unknown> };
    skewed.quote.expectedJobSigner = "0x0000000000000000000000000000000000000999";
    await assert.rejects(
      () =>
        fundIngressSessionWithLedger(
          baseInput({ fetchImpl: async () => jsonResponse(skewed) })
        ),
      /Quote expectedJobSigner .* does not match requested job signer/
    );
  });

  it("rejects when quote route fields differ from requested fields", async () => {
    const skewed = quoteResponse() as { quote: Record<string, unknown> };
    skewed.quote.operatorId = `0x${"09".repeat(32)}`;
    await assert.rejects(
      () =>
        fundIngressSessionWithLedger(
          baseInput({
            operatorId: `0x${"04".repeat(32)}`,
            processorId: `0x${"05".repeat(32)}`,
            sessionSalt: `0x${"07".repeat(32)}`,
            fetchImpl: async () => jsonResponse(skewed)
          })
        ),
      /Quote operatorId .* does not match requested operatorId/
    );
  });

  it("rejects when quote.paidSeconds differs from requested paidSeconds", async () => {
    const skewed = quoteResponse() as { quote: Record<string, unknown> };
    skewed.quote.paidSeconds = "601";
    await assert.rejects(
      () =>
        fundIngressSessionWithLedger(
          baseInput({ fetchImpl: async () => jsonResponse(skewed) })
        ),
      /Quote paidSeconds .* does not match requested paidSeconds/
    );
  });

  it("rejects when quote.developer differs from ledger address", async () => {
    const skewed = quoteResponse() as { quote: Record<string, unknown> };
    skewed.quote.developer = "0x0000000000000000000000000000000000000999";
    await assert.rejects(
      () =>
        fundIngressSessionWithLedger(
          baseInput({ fetchImpl: async () => jsonResponse(skewed) })
        ),
      /Quote developer .* does not match requested developer/
    );
  });
});
