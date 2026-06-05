import type { ApiPromise } from "@polkadot/api";
import { ethers } from "ethers";

import { HUB_USDC, HUB_USDT } from "./chains.js";
import {
  assertIngressQuoteMatchesRequest,
  encodeFundWithAssetQuote,
  normalizeIngressQuote,
  rebindIngressQuoteEndpoint,
  signIngressQuote
} from "@proofcomputer/switchboard-sdk/funding";
import { INGRESS_REGISTRY_ABI } from "./ingress-contract.js";
import type { ChainReader } from "./ledger-fund-ingress-session.js";
import {
  assertNativeFundingSufficientForFirstApproval,
  enrichNativeFundingError,
  minimumNativeForFirstApproval,
  readNativeFreeBalance,
  readNativeFundingConstants
} from "./native-funding-diagnostics.js";
import { accountFromUri, contractLayerAddress, isReviveAccountMapped, signAndSend } from "./polkadot.js";

const ERC20_ABI = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)"
] as const;

export interface SubstrateSigningContext {
  /** sr25519 mnemonic, hex seed, or //URI accepted by `Keyring.addFromUri`. */
  seed: string;
  /** ss58 prefix for the derived address. Polkadot=0, generic=42. Defaults to 0. */
  ss58Format?: number;
  /** Substrate WebSocket RPC. */
  substrateWsUrl: string;
  /** EVM JSON-RPC for Hub (used for chain-id check, balance/allowance, session readback). */
  ethRpcUrl: string;
  /** Decimal chain id, e.g. "420420419". */
  chainId: string;
  /** Native token symbol for diagnostics. Defaults to DOT. */
  nativeSymbol?: string;
  /** Native token decimals for diagnostics. Defaults to 10. */
  nativeDecimals?: number;
}

export interface FundIngressSessionSubstrateInput {
  /** Polkadot Hub IngressRegistry contract address. */
  registryAddress: string;
  /** Bootstrap relay URL exposing `/v1/ingress-intents`. */
  relayUrl: string;
  /** Payment asset (e.g. Hub USDC `0x...01200000`). */
  asset: string;
  /** Human-readable payment asset symbol for diagnostics. */
  assetSymbol?: string;
  /** Quote duration in seconds (e.g. "600"). */
  paidSeconds: string;
  /** EVM address that will sign the Acurast job's registration. */
  jobSignerAddress: string;
  /** Substrate sr25519 signing context. */
  signing: SubstrateSigningContext;
  /** When false, prepare extrinsics but do not sign+broadcast (returns a planned shape). */
  yes: boolean;
  /** Optional 0x-32 hex; sent as `jobId` to the quote endpoint. */
  jobId?: string;
  /** Optional 0x-32 hex; sent as `operatorId` to the quote endpoint. */
  operatorId?: string;
  /** Optional 0x-32 hex; sent as `processorId` to the quote endpoint. */
  processorId?: string;
  /** Optional human-readable label echoed in quote logs. */
  sessionLabel?: string;
  /** Optional endpoint hostname sent to the quote endpoint and validated through quote.endpointHash. */
  endpointHostname?: string;
  /** Optional 0x-32 endpoint hash sent to the quote endpoint and validated directly. */
  endpointHash?: string;
  /**
   * Ops-only: when set, request a normal public relay quote, then locally
   * rebind/sign the endpoint fields for a protected service hostname.
   */
  quoteSignerPrivateKey?: string;
  /** Optional 0x-32 hex salt to disambiguate sessions for the same tuple. */
  sessionSalt?: string;
  /** revive.call storage deposit limit (default `1_000_000_000_000`). */
  storageDepositLimit?: bigint;
  /** revive.call weight limit (defaults align with the existing fund script). */
  weightLimit?: { refTime: string; proofSize: string };
  /** Skip the implicit revive.mapAccount step (only do this if you're sure the signer is already mapped). */
  skipMapAccount?: boolean;
  /** Replace the polkadot ApiPromise. Used by tests; if omitted, opened against `signing.substrateWsUrl`. */
  api?: ApiPromise;
  /** Replace the EVM provider. Used by tests. */
  evmProvider?: ethers.JsonRpcProvider;
  /** Replace the fetch implementation (used for the relay quote call). */
  fetchImpl?: typeof fetch;
  /** Replace the on-chain reader for EVM-side queries (chainId, balance, allowance, session). */
  chainReader?: ChainReader;
  /** Replace the substrate signAndSend. Used by tests. */
  signAndSendImpl?: typeof signAndSend;
  /** Replace the keypair derivation. Used by tests. */
  accountFromUriImpl?: typeof accountFromUri;
  /** Replace the chain-side EVM-mapping resolver. Used by tests. */
  contractLayerAddressImpl?: typeof contractLayerAddress;
  /** Replace the chain-side mapping check. Used by tests. */
  isReviveAccountMappedImpl?: typeof isReviveAccountMapped;
  /** Logger for status updates. */
  io?: { log: (line: string) => void; warn: (line: string) => void };
  /** Quote-endpoint request timeout (ms). */
  quoteTimeoutMs?: number;
}

export interface FundIngressSessionSubstrateResult {
  /** 0x-32 hex sessionId returned by the relay quote — what `--session-id` should be set to. */
  sessionId: string;
  /** 0x-32 hex jobId from the quote. */
  jobId: string;
  /** Quote-side endpoint hostname (echoed for logging). */
  endpointHostname?: string;
  /** True when the registry already shows a funded session for this quote. */
  alreadyFunded: boolean;
  /** Developer's substrate ss58 address (the signer). */
  developerSs58: string;
  /** Developer's revive-mapped EVM address (where USDC must sit and where the on-chain Hub session shows ownership). */
  developerEvm: string;
  /** Quote amount as a decimal string. */
  amount: string;
  /** Quote asset address (lowercase). */
  asset: string;
  /** Per-tx outcome when broadcast (yes=true). Empty when alreadyFunded or yes=false. */
  txs: Array<{ action: "mapAccount" | "approve" | "fundWithAssetQuote"; txHash: string; status?: string }>;
}

interface QuoteResponse {
  ok: boolean;
  quote: Record<string, unknown>;
  signature: string;
  endpointHostname?: string;
  policy?: unknown;
}

const DEFAULT_WEIGHT_LIMIT = { refTime: "10000000000", proofSize: "2000000" };
const DEFAULT_STORAGE_DEPOSIT_LIMIT = 1_000_000_000_000n;

export async function fundIngressSessionWithSubstrate(
  input: FundIngressSessionSubstrateInput
): Promise<FundIngressSessionSubstrateResult> {
  const io = input.io ?? { log: () => undefined, warn: () => undefined };
  const fetchImpl = input.fetchImpl ?? fetch;
  const accountFromUriFn = input.accountFromUriImpl ?? accountFromUri;
  const contractLayerAddressFn = input.contractLayerAddressImpl ?? contractLayerAddress;
  const isReviveAccountMappedFn = input.isReviveAccountMappedImpl ?? isReviveAccountMapped;
  const signAndSendFn = input.signAndSendImpl ?? signAndSend;
  const weightLimit = input.weightLimit ?? DEFAULT_WEIGHT_LIMIT;
  const storageDepositLimit = input.storageDepositLimit ?? DEFAULT_STORAGE_DEPOSIT_LIMIT;
  const chainReader = input.chainReader ?? defaultChainReaderForRpc(input.evmProvider, input.signing.ethRpcUrl);

  // Verify chain id before opening the substrate api so misconfig fails cheap.
  const chainId = await chainReader.getChainId();
  if (chainId.toString() !== input.signing.chainId) {
    throw new Error(
      `Hub RPC connected to chain id ${chainId.toString()}, but expected ${input.signing.chainId}`
    );
  }

  let api = input.api;
  let createdApi = false;
  if (!api) {
    const { ApiPromise: Api, WsProvider } = await import("@polkadot/api");
    api = await Api.create({
      provider: new WsProvider(input.signing.substrateWsUrl),
      noInitWarn: true
    });
    await api.isReady;
    createdApi = true;
  }

  try {
    const ss58Format = input.signing.ss58Format ?? 0;
    const developer = await accountFromUriFn(input.signing.seed, ss58Format);
    const developerEvm = ethers.getAddress(await contractLayerAddressFn(api, developer.address));
    const asset = ethers.getAddress(input.asset);
    const registryAddress = ethers.getAddress(input.registryAddress);
    const jobSignerAddress = ethers.getAddress(input.jobSignerAddress);
    const nativeSymbol = input.signing.nativeSymbol ?? "DOT";
    const nativeDecimals = input.signing.nativeDecimals ?? 10;
    const assetSymbol = input.assetSymbol ?? knownHubAssetSymbol(asset);
    const localEndpointBinding = Boolean(input.quoteSignerPrivateKey && (input.endpointHostname || input.endpointHash));

    const txs: FundIngressSessionSubstrateResult["txs"] = [];

    // 1. Map the developer's substrate account to its revive EVM address if not yet mapped.
    if (!input.skipMapAccount && !(await isReviveAccountMappedFn(api, developerEvm))) {
      const mapTx = api.tx.revive.mapAccount();
      const [nativeFree, paymentInfo] = await Promise.all([
        readNativeFreeBalance(api, developer.address).catch(() => undefined),
        mapTx.paymentInfo ? mapTx.paymentInfo(developer.address).catch(() => undefined) : Promise.resolve(undefined)
      ]);
      io.log(`[substrate-fund] mapping ${developer.address} → ${developerEvm}`);
      if (input.yes) {
        let mapResult;
        try {
          mapResult = await signAndSendFn(api, mapTx, developer);
        } catch (error) {
          throw enrichNativeFundingError(error, {
            action: "mapAccount",
            polkadotAddress: developer.address,
            contractLayerAddress: developerEvm,
            nativeFree,
            estimatedFee: paymentInfo?.partialFee !== undefined ? BigInt(paymentInfo.partialFee.toString()) : undefined,
            nativeSymbol,
            nativeDecimals
          });
        }
        txs.push({ action: "mapAccount", txHash: mapResult.txHash, status: mapResult.status });
      }
    }

    // 2. Request the signed quote from the relay.
    const quoteResponse = await requestQuote(
      fetchImpl,
      input.relayUrl,
      {
        developer: developerEvm,
        asset,
        paidSeconds: input.paidSeconds,
        sessionLabel: input.sessionLabel,
        jobId: input.jobId,
        expectedJobSigner: jobSignerAddress,
        operatorId: input.operatorId,
        processorId: input.processorId,
        endpointHostname: localEndpointBinding ? undefined : input.endpointHostname,
        endpointHash: localEndpointBinding ? undefined : input.endpointHash,
        salt: input.sessionSalt
      },
      input.quoteTimeoutMs ?? 15_000
    );
    let quote = normalizeIngressQuote(quoteResponse.quote);
    let quoteSignature = quoteResponse.signature;
    const endpointHostname = localEndpointBinding
      ? input.endpointHostname ?? quoteResponse.endpointHostname
      : quoteResponse.endpointHostname;
    if (localEndpointBinding) {
      quote = rebindIngressQuoteEndpoint({
        quote,
        chainId: input.signing.chainId,
        registryAddress,
        endpointHostname: input.endpointHostname,
        endpointHash: input.endpointHash,
        sessionLabel: input.sessionLabel,
        policy: quoteResponse.policy
      });
      quoteSignature = signIngressQuote(
        quote,
        { chainId: input.signing.chainId, registryAddress },
        input.quoteSignerPrivateKey!
      );
    }

    assertIngressQuoteMatchesRequest(quote, {
      developer: developerEvm,
      asset,
      paidSeconds: input.paidSeconds,
      expectedJobSigner: jobSignerAddress,
      jobId: input.jobId,
      operatorId: input.operatorId,
      processorId: input.processorId,
      endpointHash: input.endpointHash,
      endpointHostname: input.endpointHostname,
      salt: input.sessionSalt
    });

    // 3. Read EVM-side balance/allowance/existing-session via shared ChainReader.
    const [assetBalance, currentAllowance, existingDeveloper] = await Promise.all([
      chainReader.getAssetBalance(asset, developerEvm),
      chainReader.getAssetAllowance(asset, developerEvm, registryAddress),
      chainReader.getRegistrySessionDeveloper(registryAddress, quote.sessionId)
    ]);

    if (existingDeveloper !== ethers.ZeroAddress) {
      io.log(
        `[substrate-fund] Hub session ${quote.sessionId} already funded by ${existingDeveloper}; skipping broadcast.`
      );
      return {
        sessionId: quote.sessionId,
        jobId: quote.jobId,
        endpointHostname,
        alreadyFunded: true,
        developerSs58: developer.address,
        developerEvm,
        amount: quote.amount.toString(),
        asset: asset.toLowerCase(),
        txs
      };
    }

    if (assetBalance < quote.amount) {
      throw new Error(
        `Mapped developer asset balance ${assetBalance.toString()} is below quote amount ${quote.amount.toString()}`
      );
    }

    // 4. Build approve + fundWithAssetQuote calldata wrapped in revive.call.
    const fundingCalldata = encodeFundWithAssetQuote(quote, quoteSignature);
    const approveCalldata = new ethers.Interface(ERC20_ABI).encodeFunctionData("approve", [registryAddress, quote.amount]);

    const approveTx =
      currentAllowance >= quote.amount
        ? undefined
        : api.tx.revive.call(asset, "0", weightLimit, storageDepositLimit.toString(), approveCalldata);
    const fundTx = api.tx.revive.call(registryAddress, "0", weightLimit, storageDepositLimit.toString(), fundingCalldata);
    const nativeConstants = readNativeFundingConstants(api);
    const [nativeBefore, approveFee, fundFee] = await Promise.all([
      readNativeFreeBalance(api, developer.address).catch(() => undefined),
      approveTx ? approveTx.paymentInfo(developer.address) : Promise.resolve(undefined),
      fundTx.paymentInfo(developer.address)
    ]);
    const approveFeeAmount = approveFee?.partialFee !== undefined ? BigInt(approveFee.partialFee.toString()) : undefined;
    const fundFeeAmount = fundFee.partialFee !== undefined ? BigInt(fundFee.partialFee.toString()) : undefined;
    const approveMinimum = approveTx
      ? minimumNativeForFirstApproval({
          action: "approve",
          polkadotAddress: developer.address,
          nativeFree: nativeBefore,
          estimatedFee: approveFeeAmount,
          ...nativeConstants
        })
      : undefined;

    if (!input.yes) {
      // Dry-run: don't broadcast, just signal the planned actions via `txs` shape.
      if (approveTx) txs.push({ action: "approve", txHash: "(dry-run)" });
      txs.push({ action: "fundWithAssetQuote", txHash: "(dry-run)" });
      return {
        sessionId: quote.sessionId,
        jobId: quote.jobId,
        endpointHostname,
        alreadyFunded: false,
        developerSs58: developer.address,
        developerEvm,
        amount: quote.amount.toString(),
        asset: asset.toLowerCase(),
        txs
      };
    }

    // 5. Broadcast.
    if (approveTx) {
      assertNativeFundingSufficientForFirstApproval({
        action: "approve",
        polkadotAddress: developer.address,
        contractLayerAddress: developerEvm,
        nativeFree: nativeBefore,
        estimatedFee: approveFeeAmount,
        minimumRequired: approveMinimum,
        assetSymbol,
        nativeSymbol,
        nativeDecimals,
        ...nativeConstants
      });
    }

    if (approveTx) {
      io.log(`[substrate-fund] approve ${quote.amount.toString()} of ${asset} → ${registryAddress}`);
      let approveResult;
      try {
        approveResult = await signAndSendFn(api, approveTx, developer);
      } catch (error) {
        throw enrichNativeFundingError(error, {
          action: "approve",
          polkadotAddress: developer.address,
          contractLayerAddress: developerEvm,
          nativeFree: nativeBefore,
          estimatedFee: approveFeeAmount,
          minimumRequired: approveMinimum,
          assetSymbol,
          nativeSymbol,
          nativeDecimals,
          ...nativeConstants
        });
      }
      txs.push({ action: "approve", txHash: approveResult.txHash, status: approveResult.status });
    } else {
      io.log("[substrate-fund] allowance already covers quote amount; skipping approve");
    }

    io.log(`[substrate-fund] fundWithAssetQuote session=${quote.sessionId}`);
    const nativeBeforeFund = await readNativeFreeBalance(api, developer.address).catch(() => nativeBefore);
    let fundResult;
    try {
      fundResult = await signAndSendFn(api, fundTx, developer);
    } catch (error) {
      throw enrichNativeFundingError(error, {
        action: "fundWithAssetQuote",
        polkadotAddress: developer.address,
        contractLayerAddress: developerEvm,
        nativeFree: nativeBeforeFund,
        estimatedFee: fundFeeAmount,
        nativeSymbol,
        nativeDecimals,
        ...nativeConstants
      });
    }
    txs.push({ action: "fundWithAssetQuote", txHash: fundResult.txHash, status: fundResult.status });

    return {
      sessionId: quote.sessionId,
      jobId: quote.jobId,
      endpointHostname,
      alreadyFunded: false,
      developerSs58: developer.address,
      developerEvm,
      amount: quote.amount.toString(),
      asset: asset.toLowerCase(),
      txs
    };
  } finally {
    if (createdApi && api) {
      await api.disconnect().catch(() => undefined);
    }
  }
}

function defaultChainReaderForRpc(provider: ethers.JsonRpcProvider | undefined, rpcUrl: string): ChainReader {
  const rpc = provider ?? new ethers.JsonRpcProvider(rpcUrl);
  return {
    async getChainId() {
      return (await rpc.getNetwork()).chainId;
    },
    async getAssetBalance(asset, owner) {
      const token = new ethers.Contract(asset, ERC20_ABI, rpc);
      return (await token.balanceOf(owner)) as bigint;
    },
    async getAssetAllowance(asset, owner, spender) {
      const token = new ethers.Contract(asset, ERC20_ABI, rpc);
      return (await token.allowance(owner, spender)) as bigint;
    },
    async getRegistrySessionDeveloper(registry, sessionId) {
      const contract = new ethers.Contract(registry, INGRESS_REGISTRY_ABI, rpc);
      const session = await contract.getSession(sessionId);
      return session.developer as string;
    }
  };
}

function knownHubAssetSymbol(asset: string): string {
  if (ethers.getAddress(asset) === ethers.getAddress(HUB_USDC.contractAddress)) return HUB_USDC.symbol;
  if (ethers.getAddress(asset) === ethers.getAddress(HUB_USDT.contractAddress)) return HUB_USDT.symbol;
  return "the payment asset";
}

async function requestQuote(
  fetchImpl: typeof fetch,
  relayUrl: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<QuoteResponse> {
  const compactBody = Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined && value !== "")
  );
  const response = await fetchImpl(new URL("/v1/ingress-intents", relayUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(compactBody),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  const json = text ? (JSON.parse(text) as QuoteResponse) : ({} as QuoteResponse);
  if (!response.ok || !json.ok) {
    throw new Error(
      `Quote request to ${relayUrl}/v1/ingress-intents failed (${response.status}): ${text.slice(0, 500)}`
    );
  }
  return json;
}
