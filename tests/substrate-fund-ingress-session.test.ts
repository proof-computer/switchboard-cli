import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { ethers } from "ethers";

import {
  fundIngressSessionWithSubstrate,
  type FundIngressSessionSubstrateInput
} from "../src/substrate-fund-ingress-session.js";
import { encodeFundWithAssetQuote, type IngressQuote } from "../src/ingress-quote.js";
import type { ChainReader } from "../src/ledger-fund-ingress-session.js";

const ASSET = "0x0000053900000000000000000000000001200000";
const REGISTRY = "0x65d6B76BeC50F46D198fFa3598E381a298025Da0";
const JOB_SIGNER = "0x4389bddE214740DAaD4255019b787E8c51f6dCcf";
const SS58 = "136jcDxAEzdU1o25a9555GSwEzVYdEuPi6hxma1bFibU7SHw";
const EVM_MAPPED = "0x1938dac993153be94b613bc22f2e0bf5b2156f8f";
const SIGNING = {
  seed: "fish method water vague travel wealth amused river curtain stadium digital wedding",
  ss58Format: 0,
  substrateWsUrl: "wss://example/substrate",
  ethRpcUrl: "https://example/eth",
  chainId: "420420419"
} as const;

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function quoteResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    signature: "0xdeadbeef",
    endpointHostname: "relay-d.switchboard.proof.computer",
    quote: {
      quoteId: `0x${"01".repeat(32)}`,
      sessionId: `0x${"02".repeat(32)}`,
      developer: EVM_MAPPED,
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
    funding: { assetCalldata: "0xabcdef" },
    ...overrides
  };
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

interface ChainReaderState {
  chainId?: bigint;
  balance?: bigint;
  allowance?: bigint;
  existingDeveloper?: string;
}

function makeChainReader(state: ChainReaderState = {}): ChainReader {
  return {
    async getChainId() {
      return state.chainId ?? 420420419n;
    },
    async getAssetBalance() {
      return state.balance ?? 1_000_000n;
    },
    async getAssetAllowance() {
      return state.allowance ?? 0n;
    },
    async getRegistrySessionDeveloper() {
      return state.existingDeveloper ?? ethers.ZeroAddress;
    }
  };
}

interface FakeApi {
  tx: {
    revive: {
      mapAccount: () => unknown;
      call: (...args: unknown[]) => unknown;
    };
  };
  consts: {
    balances: {
      existentialDeposit: unknown;
    };
    assets: {
      approvalDeposit: unknown;
    };
  };
  query: {
    system: {
      account: () => Promise<unknown>;
    };
  };
  isReady: Promise<void>;
  disconnect: () => Promise<void>;
}

interface FakeApiOptions {
  nativeFree?: bigint;
  existentialDeposit?: bigint;
  approvalDeposit?: bigint;
  mapFee?: bigint;
  approveFee?: bigint;
  fundFee?: bigint;
}

function makeFakeApi(options: FakeApiOptions = {}): FakeApi {
  const nativeFree = options.nativeFree ?? 1_000_000_000n;
  const existentialDeposit = options.existentialDeposit ?? 100_000_000n;
  const approvalDeposit = options.approvalDeposit ?? 100_000_000n;
  const tx = (label: string, args: unknown[] = []) => ({
    __label: label,
    args,
    paymentInfo: async () => ({
      partialFee: txFee(label, args, options).toString()
    })
  });
  return {
    tx: {
      revive: {
        mapAccount: () => tx("revive.mapAccount"),
        call: (...args: unknown[]) => tx("revive.call", args)
      }
    },
    consts: {
      balances: {
        existentialDeposit: existentialDeposit.toString()
      },
      assets: {
        approvalDeposit: approvalDeposit.toString()
      }
    },
    query: {
      system: {
        account: async () => ({
          data: {
            free: nativeFree.toString()
          }
        })
      }
    },
    isReady: Promise.resolve(),
    disconnect: async () => undefined
  };
}

function txFee(label: string, args: unknown[], options: FakeApiOptions): bigint {
  if (label === "revive.mapAccount") return options.mapFee ?? 10_000_000n;
  return args[0] === ASSET ? options.approveFee ?? 10_000_000n : options.fundFee ?? 10_000_000n;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function baseInput(overrides: Partial<FundIngressSessionSubstrateInput> = {}): FundIngressSessionSubstrateInput {
  return {
    registryAddress: REGISTRY,
    relayUrl: "https://relay-a.switchboard.proof.computer",
    asset: ASSET,
    paidSeconds: "600",
    jobSignerAddress: JOB_SIGNER,
    signing: { ...SIGNING },
    yes: true,
    fetchImpl: async () => jsonResponse(quoteResponse()),
    chainReader: makeChainReader(),
    api: makeFakeApi() as unknown as Parameters<typeof fundIngressSessionWithSubstrate>[0]["api"],
    accountFromUriImpl: (async (_uri: string, _ss58: number) => ({ address: SS58 })) as never,
    contractLayerAddressImpl: (async () => EVM_MAPPED) as never,
    isReviveAccountMappedImpl: (async () => true) as never,
    signAndSendImpl: (async (_api: unknown, tx: unknown) => ({
      txHash: `0xtx-${(tx as { __label: string }).__label}`,
      blockHash: "0xblock",
      status: "InBlock"
    })) as never,
    ...overrides
  };
}

describe("fundIngressSessionWithSubstrate", () => {
  it("approves and funds when no allowance and no existing session", async () => {
    const recordedSends: string[] = [];
    const recordedReviveCalls: unknown[][] = [];
    const result = await fundIngressSessionWithSubstrate(
      baseInput({
        signAndSendImpl: (async (_api: unknown, tx: unknown) => {
          const plannedTx = tx as { __label: string; args?: unknown[] };
          const label = plannedTx.__label;
          recordedSends.push(label);
          if (plannedTx.args) recordedReviveCalls.push(plannedTx.args);
          return { txHash: `0xtx-${label}`, blockHash: "0xblock", status: "InBlock" };
        }) as never
      })
    );
    assert.equal(result.alreadyFunded, false);
    assert.equal(result.sessionId, `0x${"02".repeat(32)}`);
    assert.equal(result.developerSs58, SS58);
    assert.equal(result.developerEvm, ethers.getAddress(EVM_MAPPED));
    // mapAccount skipped (already mapped), so we expect only revive.call sends
    assert.deepEqual(recordedSends, ["revive.call", "revive.call"]);
    assert.equal(result.txs.length, 2);
    assert.equal(result.txs[0].action, "approve");
    assert.equal(result.txs[1].action, "fundWithAssetQuote");
    assert.equal(recordedReviveCalls.length, 2);
    assert.equal(recordedReviveCalls[1][4], expectedFundingCalldata());
    assert.notEqual(recordedReviveCalls[1][4], "0xabcdef");
  });

  it("skips approve when allowance already covers the quote", async () => {
    const recordedActions: string[] = [];
    const recordedReviveCalls: unknown[][] = [];
    await fundIngressSessionWithSubstrate(
      baseInput({
        chainReader: makeChainReader({ allowance: 9_999_999n }),
        signAndSendImpl: (async (_api: unknown, tx: unknown) => {
          const plannedTx = tx as { __label: string; args?: unknown[] };
          recordedActions.push(plannedTx.__label);
          if (plannedTx.args) recordedReviveCalls.push(plannedTx.args);
          return { txHash: "0x", blockHash: "0xb", status: "InBlock" };
        }) as never
      })
    );
    assert.equal(recordedActions.length, 1); // only fund
    assert.equal(recordedReviveCalls.length, 1);
    assert.equal(recordedReviveCalls[0][4], expectedFundingCalldata());
    assert.notEqual(recordedReviveCalls[0][4], "0xabcdef");
  });

  it("calls revive.mapAccount when not yet mapped", async () => {
    const labels: string[] = [];
    await fundIngressSessionWithSubstrate(
      baseInput({
        isReviveAccountMappedImpl: (async () => false) as never,
        signAndSendImpl: (async (_api: unknown, tx: unknown) => {
          labels.push((tx as { __label: string }).__label);
          return { txHash: "0x", blockHash: "0xb", status: "InBlock" };
        }) as never
      })
    );
    // mapAccount, then approve, then fundWithAssetQuote
    assert.equal(labels[0], "revive.mapAccount");
    assert.equal(labels.length, 3);
  });

  it("returns alreadyFunded without broadcasting when registry shows existing developer", async () => {
    let sendCalls = 0;
    const result = await fundIngressSessionWithSubstrate(
      baseInput({
        chainReader: makeChainReader({ existingDeveloper: EVM_MAPPED }),
        signAndSendImpl: (async () => {
          sendCalls += 1;
          return { txHash: "0x", blockHash: "0xb", status: "InBlock" };
        }) as never
      })
    );
    assert.equal(result.alreadyFunded, true);
    assert.equal(sendCalls, 0);
    assert.equal(result.txs.length, 0);
  });

  it("dry-runs (yes=false) without broadcasting", async () => {
    let sendCalls = 0;
    const result = await fundIngressSessionWithSubstrate(
      baseInput({
        yes: false,
        signAndSendImpl: (async () => {
          sendCalls += 1;
          return { txHash: "0x", blockHash: "0xb", status: "InBlock" };
        }) as never
      })
    );
    assert.equal(sendCalls, 0);
    assert.ok(result.txs.every((tx) => tx.txHash === "(dry-run)"));
    assert.deepEqual(result.txs.map((t) => t.action), ["approve", "fundWithAssetQuote"]);
  });

  it("rejects when developer balance is below quote amount", async () => {
    await assert.rejects(
      () =>
        fundIngressSessionWithSubstrate(
          baseInput({ chainReader: makeChainReader({ balance: 0n }) })
        ),
      /asset balance .* is below quote amount/
    );
  });

  it("rejects before first-time approval when the Polkadot funder lacks native DOT", async () => {
    let sendCalls = 0;
    await assert.rejects(
      () =>
        fundIngressSessionWithSubstrate(
          baseInput({
            api: makeFakeApi({
              nativeFree: 249n,
              existentialDeposit: 100n,
              approvalDeposit: 50n,
              approveFee: 100n
            }) as unknown as Parameters<typeof fundIngressSessionWithSubstrate>[0]["api"],
            signAndSendImpl: (async () => {
              sendCalls += 1;
              return { txHash: "0x", blockHash: "0xb", status: "InBlock" };
            }) as never
          })
        ),
      (error: unknown) => {
        assert.match(String((error as Error).message), /Not enough native DOT on Polkadot funder account/);
        assert.match(String((error as Error).message), new RegExp(SS58));
        assert.match(String((error as Error).message), new RegExp(ethers.getAddress(EVM_MAPPED)));
        assert.match(String((error as Error).message), /approve USDC for Hub funding/);
        assert.match(String((error as Error).message), /Known minimum required before this action: 0\.000000025 DOT/);
        return true;
      }
    );
    assert.equal(sendCalls, 0);
  });

  it("rewrites ConsumerRemaining during approval into a native DOT top-up error", async () => {
    await assert.rejects(
      () =>
        fundIngressSessionWithSubstrate(
          baseInput({
            api: makeFakeApi({ nativeFree: 1_000_000_000n }) as unknown as Parameters<typeof fundIngressSessionWithSubstrate>[0]["api"],
            signAndSendImpl: (async (_api: unknown, tx: unknown) => {
              const plannedTx = tx as { args?: unknown[] };
              if (plannedTx.args?.[0] === ASSET) {
                throw new Error("ConsumerRemaining");
              }
              return { txHash: "0x", blockHash: "0xb", status: "InBlock" };
            }) as never
          })
        ),
      /Not enough native DOT .*approve USDC.*Raw chain error: ConsumerRemaining/s
    );
  });

  it("rewrites ConsumerRemaining during fundWithAssetQuote with fund-call context", async () => {
    await assert.rejects(
      () =>
        fundIngressSessionWithSubstrate(
          baseInput({
            chainReader: makeChainReader({ allowance: 9_999_999n }),
            api: makeFakeApi({ nativeFree: 1_000_000_000n }) as unknown as Parameters<typeof fundIngressSessionWithSubstrate>[0]["api"],
            signAndSendImpl: (async () => {
              throw new Error("ConsumerRemaining");
            }) as never
          })
        ),
      /Not enough native DOT .*fund the Hub session.*Raw chain error: ConsumerRemaining/s
    );
  });

  it("rejects when chain id mismatches signing context", async () => {
    await assert.rejects(
      () =>
        fundIngressSessionWithSubstrate(
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
        fundIngressSessionWithSubstrate(
          baseInput({ fetchImpl: async () => jsonResponse(skewed) })
        ),
      /Quote expectedJobSigner .* does not match requested job signer/
    );
  });

  it("rejects when quote route fields differ from requested fields", async () => {
    const skewed = quoteResponse() as { quote: Record<string, unknown> };
    skewed.quote.processorId = `0x${"09".repeat(32)}`;
    await assert.rejects(
      () =>
        fundIngressSessionWithSubstrate(
          baseInput({
            operatorId: `0x${"04".repeat(32)}`,
            processorId: `0x${"05".repeat(32)}`,
            sessionSalt: `0x${"07".repeat(32)}`,
            fetchImpl: async () => jsonResponse(skewed)
          })
        ),
      /Quote processorId .* does not match requested processorId/
    );
  });

  it("rejects when quote.paidSeconds differs from requested paidSeconds", async () => {
    const skewed = quoteResponse() as { quote: Record<string, unknown> };
    skewed.quote.paidSeconds = "601";
    await assert.rejects(
      () =>
        fundIngressSessionWithSubstrate(
          baseInput({ fetchImpl: async () => jsonResponse(skewed) })
        ),
      /Quote paidSeconds .* does not match requested paidSeconds/
    );
  });

  it("rejects when quote.developer doesn't match the revive-mapped developer", async () => {
    const skewed = quoteResponse() as { quote: Record<string, unknown> };
    skewed.quote.developer = "0x0000000000000000000000000000000000000999";
    await assert.rejects(
      () =>
        fundIngressSessionWithSubstrate(
          baseInput({ fetchImpl: async () => jsonResponse(skewed) })
        ),
      /Quote developer .* does not match requested developer/
    );
  });
});
