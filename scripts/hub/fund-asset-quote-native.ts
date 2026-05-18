import "dotenv/config";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { u8aToHex } from "@polkadot/util";
import { decodeAddress } from "@polkadot/util-crypto";
import { ethers } from "ethers";

import { getSwitchboardTarget, HUB_USDC, type SwitchboardTargetConfig } from "../../src/chains.js";
import { INGRESS_REGISTRY_ABI } from "../../src/ingress-contract.js";
import { encodeFundWithAssetQuote } from "../../src/ingress-quote.js";
import {
  assertNativeFundingSufficientForFirstApproval,
  enrichNativeFundingError,
  minimumNativeForFirstApproval,
  readNativeFreeBalance,
  readNativeFundingConstants
} from "../../src/native-funding-diagnostics.js";
import { loadOperatorContext } from "../../src/operator-context.js";
import { accountFromUri, contractLayerAddress, isReviveAccountMapped, ledgerAccount, signAndSend } from "../../src/polkadot.js";
import { assertIngressQuoteMatchesRequest } from "../../src/quote-binding.js";

const erc20Abi = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)"
] as const;

export interface QuoteResponse {
  ok: boolean;
  quote: Record<string, unknown>;
  signature: string;
  endpointHostname?: string;
  validationHostname?: string;
  policy?: unknown;
  allocation?: unknown;
}

interface FundingContext {
  ethRpcUrl: string;
  substrateWsUrl: string;
  registryAddress: string;
  relayUrl: string;
  target: SwitchboardTargetConfig;
  operatorId?: string;
}

const DEFAULT_DEPLOYMENT_INTENT_QUOTE_TIMEOUT_MS = 60_000;
const DEPLOYMENT_INTENT_QUOTE_RESUME_POLL_MS = 2_000;

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const fundingCtx = await loadFundingContext(flags);
  const ethRpcUrl = fundingCtx.ethRpcUrl;
  const substrateWsUrl = fundingCtx.substrateWsUrl;
  const registryAddress = ethers.getAddress(fundingCtx.registryAddress);
  const relayUrl = stringFlag(flags, "relay-url") ?? fundingCtx.relayUrl;
  const target = fundingCtx.target;
  const asset = ethers.getAddress(
    stringFlag(flags, "asset") ??
      process.env.PAYMENT_ASSET_ADDRESS ??
      process.env.PROOF_QUOTE_DEFAULT_ASSET ??
      HUB_USDC.contractAddress
  );
  const assetSymbol = target.assets.find((candidate) => ethers.getAddress(candidate.contractAddress) === asset)?.symbol ?? "the payment asset";
  const paidSeconds = stringFlag(flags, "paid-seconds") ?? process.env.PAID_SECONDS ?? process.env.QUOTE_PAID_SECONDS ?? "600";
  const quoteTimeoutMs = integerFlag(
    flags,
    "quote-timeout-ms",
    "SWITCHBOARD_DEPLOYMENT_INTENT_QUOTE_TIMEOUT_MS",
    DEFAULT_DEPLOYMENT_INTENT_QUOTE_TIMEOUT_MS
  );
  const deploymentIntentId = stringFlag(flags, "deployment-intent-id") ?? process.env.SWITCHBOARD_INTENT_ID;
  const deploymentIntentGroupId = stringFlag(flags, "deployment-intent-group-id") ?? process.env.SWITCHBOARD_INTENT_GROUP_ID;
  const groupMemberIntentId = stringFlag(flags, "group-member-intent-id") ?? deploymentIntentId;
  const quoteResponseFile = stringFlag(flags, "quote-response-file");
  const jobSignerAddress = resolveJobSignerAddress(flags);
  const confirmations = Number(stringFlag(flags, "confirmations") ?? process.env.CONFIRMATIONS ?? "1");
  const storageDepositLimit = BigInt(stringFlag(flags, "storage-deposit-limit") ?? process.env.NATIVE_STORAGE_DEPOSIT_LIMIT ?? "1000000000000");
  const weightLimit = {
    refTime: BigInt(stringFlag(flags, "ref-time") ?? process.env.NATIVE_REVIVE_REF_TIME ?? "10000000000").toString(),
    proofSize: BigInt(stringFlag(flags, "proof-size") ?? process.env.NATIVE_REVIVE_PROOF_SIZE ?? "2000000").toString()
  };

  const api = await ApiPromise.create({
    provider: new WsProvider(substrateWsUrl),
    noInitWarn: true
  });
  await api.isReady;
  let developer: any;

  try {
    const provider = new ethers.JsonRpcProvider(ethRpcUrl);
    const network = await provider.getNetwork();
    if (target.expectedChainId && network.chainId !== target.expectedChainId) {
      throw new Error(`Connected to chain ID ${network.chainId.toString()}, but ${target.name} expects ${target.expectedChainId.toString()}`);
    }

    const ss58Format = Number(stringFlag(flags, "ss58-format") ?? process.env.POLKADOT_SS58_FORMAT ?? String(api.registry.chainSS58 ?? 0));
    developer = await polkadotPaymentSigner(api, flags, ss58Format);
    const developerContractAddress = await contractLayerAddress(api, developer.address);

    if (!boolFlag(flags, "no-map-account") && !(await isReviveAccountMapped(api, developerContractAddress))) {
      const mapTx = api.tx.revive.mapAccount();
      const [nativeFree, paymentInfo] = await Promise.all([
        readNativeFreeBalance(api, developer.address).catch(() => undefined),
        mapTx.paymentInfo(developer.address)
      ]);
      step(`mapping ${developer.address} to contract-layer ${developerContractAddress}`);
      step(`estimated map_account fee ${paymentInfo.partialFee.toString()}`);
      if (!boolFlag(flags, "dry-run")) {
        try {
          await signAndSend(api, mapTx, developer);
        } catch (error) {
          throw enrichNativeFundingError(error, {
            action: "mapAccount",
            polkadotAddress: developer.address,
            contractLayerAddress: developerContractAddress,
            nativeFree,
            estimatedFee: BigInt(paymentInfo.partialFee.toString()),
            nativeSymbol: target.nativeSymbol,
            nativeDecimals: target.nativeDecimals
          });
        }
      }
    }

    const sessionLabel = stringFlag(flags, "session-label") ?? process.env.SESSION_LABEL;
    const requestedJobId = stringFlag(flags, "job-id") ?? process.env.JOB_ID;
    const requestedOperatorId = stringFlag(flags, "operator-id") ?? fundingCtx.operatorId;
    const requestedProcessorId = stringFlag(flags, "processor-id") ?? process.env.PROCESSOR_ID;
    const requestedEndpointHostname = stringFlag(flags, "endpoint-hostname") ?? process.env.ENDPOINT_HOSTNAME;
    const requestedEndpointHash = stringFlag(flags, "endpoint-hash") ?? process.env.ENDPOINT_HASH;
    const requestedSalt = stringFlag(flags, "session-salt") ?? process.env.SESSION_SALT;
    const requestedMaxAmount = stringFlag(flags, "max-amount") ?? process.env.SWITCHBOARD_QUOTE_MAX_AMOUNT ?? process.env.MAX_AMOUNT;
    const quoteCapAmount =
      stringFlag(flags, "quote-cap-amount") ??
      process.env.SWITCHBOARD_QUOTE_CAP_AMOUNT ??
      process.env.SWITCHBOARD_DEPLOY_EXPECTED_QUOTE_AMOUNT;
    if (requestedMaxAmount && quoteCapAmount) {
      throw new Error("Use either --max-amount for exact quote binding or --quote-cap-amount for preview-cap funding, not both");
    }
    const quoteRequest = compactObject({
      developer: developerContractAddress,
      asset,
      paidSeconds,
      sessionLabel,
      maxAmount: requestedMaxAmount
    });
    const quoteBindingRequest = compactObject({
      developer: developerContractAddress,
      asset,
      paidSeconds,
      sessionLabel,
      maxAmount: requestedMaxAmount,
      jobId: requestedJobId,
      expectedJobSigner: jobSignerAddress,
      operatorId: requestedOperatorId,
      processorId: requestedProcessorId,
      endpointHostname: requestedEndpointHostname,
      endpointHash: requestedEndpointHash,
      salt: requestedSalt
    });
    const quoteResponse = quoteResponseFile
      ? await readQuoteResponseFile(quoteResponseFile)
      : deploymentIntentId
        ? deploymentIntentGroupId
          ? await requestDeploymentIntentGroupMemberQuoteOrResume(
              relayUrl,
              deploymentIntentGroupId,
              groupMemberIntentId ?? deploymentIntentId,
              quoteRequest,
              stringFlag(flags, "intent-token") ?? stringFlag(flags, "cli-token") ?? process.env.SWITCHBOARD_INTENT_CLI_TOKEN,
              quoteTimeoutMs,
              quoteBindingRequest
            )
          : await requestDeploymentIntentQuoteOrResume(
              relayUrl,
              deploymentIntentId,
              quoteRequest,
              stringFlag(flags, "intent-token") ?? stringFlag(flags, "cli-token") ?? process.env.SWITCHBOARD_INTENT_CLI_TOKEN,
              quoteTimeoutMs,
              quoteBindingRequest
            )
        : await requestQuote(relayUrl, quoteBindingRequest, quoteTimeoutMs);
    const quote = normalizeQuote(quoteResponse.quote);
    const signature = quoteResponse.signature;
    assertIngressQuoteMatchesRequest(quote, {
      developer: developerContractAddress,
      asset,
      paidSeconds,
      maxAmount: requestedMaxAmount,
      expectedJobSigner: jobSignerAddress,
      jobId: requestedJobId,
      operatorId: requestedOperatorId,
      processorId: requestedProcessorId,
      endpointHash: requestedEndpointHash,
      endpointHostname: requestedEndpointHostname,
      salt: requestedSalt
    });
    assertQuoteWithinCap(quote, quoteCapAmount);

    const token = new ethers.Contract(asset, erc20Abi, provider);
    const registry = new ethers.Contract(registryAddress, INGRESS_REGISTRY_ABI, provider);
    const [assetBalance, currentAllowance] = await Promise.all([
      token.balanceOf(developerContractAddress) as Promise<bigint>,
      token.allowance(developerContractAddress, registryAddress) as Promise<bigint>
    ]);
    if (assetBalance < quote.amount) {
      throw new Error(`Mapped developer asset balance ${assetBalance.toString()} is below quote amount ${quote.amount.toString()}`);
    }

    const fundingCalldata = encodeFundWithAssetQuote(quote, signature);
    const approveCalldata = new ethers.Interface(erc20Abi).encodeFunctionData("approve", [registryAddress, quote.amount]);

    const approveTx =
      currentAllowance >= quote.amount
        ? undefined
        : api.tx.revive.call(asset, "0", weightLimit, storageDepositLimit.toString(), approveCalldata);
    const fundTx = api.tx.revive.call(registryAddress, "0", weightLimit, storageDepositLimit.toString(), fundingCalldata);
    const nativeConstants = readNativeFundingConstants(api);
    const [nativeBefore, approveFee, fundFee] = await Promise.all([
      readNativeFreeBalance(api, developer.address),
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

    const dryRun = boolFlag(flags, "dry-run") || !boolFlag(flags, "yes");
    const baseOutput = {
      ok: true,
      dryRun,
      target: target.name,
      chainId: network.chainId.toString(),
      ethRpcUrl,
      substrateWsUrl,
      relayUrl,
      registryAddress,
      polkadotSigner: developer.signerType ?? "seed",
      account: {
        polkadotAddress: developer.address,
        contractLayerAddress: developerContractAddress
      },
      quote: {
        ...quote,
        amount: quote.amount.toString(),
        minAmount: quote.minAmount.toString(),
        maxAmount: quote.maxAmount.toString(),
        paidSeconds: quote.paidSeconds.toString(),
        serviceAmount: quote.serviceAmount.toString(),
        setupFee: quote.setupFee.toString(),
        validationFeeCap: quote.validationFeeCap.toString(),
        deadline: quote.deadline.toString()
      },
      signature,
      balancesBefore: {
        nativeFree: nativeBefore.toString(),
        asset: assetBalance.toString(),
        allowance: currentAllowance.toString(),
        nativeExistentialDeposit: nativeConstants.existentialDeposit?.toString(),
        assetApprovalDeposit: nativeConstants.approvalDeposit?.toString()
      },
      estimatedFees: {
        approve: approveFee?.partialFee.toString(),
        fund: fundFee.partialFee.toString(),
        firstApprovalMinimum: approveMinimum?.toString()
      },
      intentRequest: quoteBindingRequest,
      quoteCapAmount,
      endpointHostname: quoteResponse.endpointHostname,
      validationHostname: quoteResponse.validationHostname ?? stringField(objectField(quoteResponse, "intent"), "validationHostname"),
      policy: quoteResponse.policy,
      allocation: quoteResponse.allocation
    };

    if (dryRun) {
      console.log(JSON.stringify(baseOutput, null, 2));
      return;
    }

    const txs: Array<{ action: string; txHash: string; blockHash?: string; status: string }> = [];
    if (approveTx) {
      assertNativeFundingSufficientForFirstApproval({
        action: "approve",
        polkadotAddress: developer.address,
        contractLayerAddress: developerContractAddress,
        nativeFree: nativeBefore,
        estimatedFee: approveFeeAmount,
        minimumRequired: approveMinimum,
        assetSymbol,
        nativeSymbol: target.nativeSymbol,
        nativeDecimals: target.nativeDecimals,
        ...nativeConstants
      });
      step(`approving ${quote.amount.toString()} units of ${asset} for registry ${registryAddress}`);
      let approveResult;
      try {
        approveResult = await signAndSend(api, approveTx, developer);
      } catch (error) {
        throw enrichNativeFundingError(error, {
          action: "approve",
          polkadotAddress: developer.address,
          contractLayerAddress: developerContractAddress,
          nativeFree: nativeBefore,
          estimatedFee: approveFeeAmount,
          minimumRequired: approveMinimum,
          assetSymbol,
          nativeSymbol: target.nativeSymbol,
          nativeDecimals: target.nativeDecimals,
          ...nativeConstants
        });
      }
      txs.push({ action: "approve", txHash: approveResult.txHash, blockHash: approveResult.blockHash, status: approveResult.status });
    } else {
      step("asset allowance already covers quote amount");
    }

    step(`funding session ${quote.sessionId}`);
    const nativeBeforeFund = await readNativeFreeBalance(api, developer.address).catch(() => nativeBefore);
    let fundResult;
    try {
      fundResult = await signAndSend(api, fundTx, developer);
    } catch (error) {
      throw enrichNativeFundingError(error, {
        action: "fundWithAssetQuote",
        polkadotAddress: developer.address,
        contractLayerAddress: developerContractAddress,
        nativeFree: nativeBeforeFund,
        estimatedFee: fundFeeAmount,
        nativeSymbol: target.nativeSymbol,
        nativeDecimals: target.nativeDecimals,
        ...nativeConstants
      });
    }
    txs.push({ action: "fundWithAssetQuote", txHash: fundResult.txHash, blockHash: fundResult.blockHash, status: fundResult.status });

    if (confirmations > 0) {
      // Substrate inclusion is already observed above; this keeps the output shape
      // aligned with EVM scripts that expose a confirmation knob.
      void confirmations;
    }

    const [assetAfter, allowanceAfter, session] = await Promise.all([
      token.balanceOf(developerContractAddress) as Promise<bigint>,
      token.allowance(developerContractAddress, registryAddress) as Promise<bigint>,
      waitForFundedSession(registry, quote)
    ]);

    console.log(
      JSON.stringify(
        {
          ...baseOutput,
          dryRun: false,
          txs,
          balancesAfter: {
            asset: assetAfter.toString(),
            allowance: allowanceAfter.toString()
          },
          session: sessionOutput(session)
        },
        null,
        2
      )
    );
  } finally {
    await developer?.disconnect?.().catch(() => undefined);
    await api.disconnect();
  }
}

async function loadFundingContext(flags: Map<string, string | boolean>): Promise<FundingContext> {
  const targetNameOverride = stringFlag(flags, "target") ?? process.env.SWITCHBOARD_TARGET;
  const ethRpcUrlOverride = stringFlag(flags, "eth-rpc-url") ?? process.env.HUB_ETH_RPC_URL ?? process.env.ETH_RPC_URL;
  const substrateWsUrlOverride =
    stringFlag(flags, "substrate-ws-url") ?? process.env.HUB_SUBSTRATE_WS_URL ?? process.env.SUBSTRATE_WS_URL;
  const registryAddressOverride = stringFlag(flags, "registry") ?? process.env.INGRESS_REGISTRY_ADDRESS;
  const relayUrlOverride =
    stringFlag(flags, "relay-url") ??
    process.env.SWITCHBOARD_DEPLOY_RELAY_URL ??
    process.env.RELAY_URL ??
    process.env.PROOF_CONTROL_PLANE_URL;
  const operatorIdOverride = stringFlag(flags, "operator-id") ?? process.env.OPERATOR_ID ?? process.env.SWITCHBOARD_OPERATOR_ID;
  try {
    const operatorCtx = await loadOperatorContext({
      contextName: stringFlag(flags, "context")
    });
    return {
      ethRpcUrl: ethRpcUrlOverride ?? operatorCtx.ethRpcUrl,
      substrateWsUrl: substrateWsUrlOverride ?? operatorCtx.substrateWsUrl,
      registryAddress: registryAddressOverride ?? operatorCtx.registryAddress,
      relayUrl: relayUrlOverride ?? operatorCtx.relayUrl,
      target: targetNameOverride ? getSwitchboardTarget(targetNameOverride) : operatorCtx.target,
      operatorId: operatorIdOverride ?? operatorCtx.operatorId
    };
  } catch (error) {
    if (targetNameOverride && ethRpcUrlOverride && substrateWsUrlOverride && registryAddressOverride && relayUrlOverride) {
      return {
        ethRpcUrl: ethRpcUrlOverride,
        substrateWsUrl: substrateWsUrlOverride,
        registryAddress: registryAddressOverride,
        relayUrl: relayUrlOverride,
        target: getSwitchboardTarget(targetNameOverride),
        operatorId: operatorIdOverride
      };
    }
    throw error;
  }
}

async function polkadotPaymentSigner(api: ApiPromise, flags: Map<string, string | boolean>, ss58Format: number): Promise<any> {
  const signerKind = stringFlag(flags, "polkadot-signer") ?? process.env.PROOF_POLKADOT_SIGNER ?? (boolFlag(flags, "ledger") ? "ledger" : "seed");
  const configuredAddress = stringFlag(flags, "polkadot-address") ?? process.env.POLKADOT_ADDRESS;
  if (signerKind === "ledger") {
    const mode = ledgerMode(flags);
    const metadataChainId = stringFlag(flags, "ledger-metadata-chain-id") ?? process.env.PROOF_LEDGER_METADATA_CHAIN_ID;
    if (mode === "generic" && !metadataChainId) {
      throw new Error("Generic Ledger signing requires --ledger-metadata-chain-id or PROOF_LEDGER_METADATA_CHAIN_ID");
    }
    return ledgerAccount({
      api,
      address: configuredAddress,
      ss58Format,
      mode,
      transport: ledgerTransport(flags),
      chain: stringFlag(flags, "ledger-chain") ?? process.env.PROOF_LEDGER_CHAIN,
      slip44: optionalIntegerFlag(flags, "ledger-slip44", "PROOF_LEDGER_SLIP44"),
      accountIndex: integerFlag(flags, "ledger-account", "PROOF_LEDGER_ACCOUNT", 0),
      addressOffset: integerFlag(flags, "ledger-address-index", "PROOF_LEDGER_ADDRESS_INDEX", 0),
      confirmAddress: boolFlag(flags, "ledger-confirm-address"),
      metadataChainId,
      metadataUrl: stringFlag(flags, "ledger-metadata-url") ?? process.env.PROOF_LEDGER_METADATA_URL
    });
  }
  if (signerKind !== "seed") {
    throw new Error(`Unsupported Polkadot signer "${signerKind}". Expected seed or ledger.`);
  }

  const developer = await accountFromUri(requiredEnv("POLKADOT_SEED"), ss58Format);
  if (configuredAddress && !samePolkadotAddress(configuredAddress, developer.address)) {
    throw new Error(`POLKADOT_SEED resolves to ${developer.address}, not POLKADOT_ADDRESS ${configuredAddress}`);
  }
  return developer;
}

function samePolkadotAddress(left: string, right: string): boolean {
  return u8aToHex(decodeAddress(left)) === u8aToHex(decodeAddress(right));
}

function ledgerMode(flags: Map<string, string | boolean>): "generic" | "legacy" {
  const value = stringFlag(flags, "ledger-mode") ?? process.env.PROOF_LEDGER_MODE ?? "generic";
  if (value === "generic" || value === "legacy") {
    return value;
  }
  throw new Error(`Unsupported Ledger mode "${value}". Expected generic or legacy.`);
}

function ledgerTransport(flags: Map<string, string | boolean>): "hid" | "webusb" {
  const value = stringFlag(flags, "ledger-transport") ?? process.env.PROOF_LEDGER_TRANSPORT ?? "hid";
  if (value === "hid" || value === "webusb") {
    return value;
  }
  throw new Error(`Unsupported Ledger transport "${value}". Expected hid or webusb.`);
}

function optionalIntegerFlag(flags: Map<string, string | boolean>, flagName: string, envName: string): number | undefined {
  const value = stringFlag(flags, flagName) ?? process.env[envName];
  return value ? parseIntegerFlagValue(flagName, value) : undefined;
}

function integerFlag(flags: Map<string, string | boolean>, flagName: string, envName: string, fallback: number): number {
  return optionalIntegerFlag(flags, flagName, envName) ?? fallback;
}

function parseIntegerFlagValue(flagName: string, value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${flagName} must be a non-negative integer`);
  }

  return Number(value);
}

async function waitForFundedSession(registry: ethers.Contract, quote: ReturnType<typeof normalizeQuote>) {
  const timeoutMs = Number(process.env.NATIVE_FUNDING_READBACK_TIMEOUT_MS ?? "60000");
  const pollMs = Number(process.env.NATIVE_FUNDING_READBACK_POLL_MS ?? "3000");
  const deadline = Date.now() + timeoutMs;
  let lastSession: any;

  while (Date.now() <= deadline) {
    lastSession = await registry.getSession(quote.sessionId);
    if (
      ethers.getAddress(lastSession.developer) === ethers.getAddress(quote.developer) &&
      ethers.getAddress(lastSession.asset) === ethers.getAddress(quote.asset) &&
      lastSession.amountPaid >= quote.amount &&
      lastSession.jobId === quote.jobId &&
      ethers.getAddress(lastSession.expectedJobSigner) === ethers.getAddress(quote.expectedJobSigner)
    ) {
      return lastSession;
    }
    await sleep(pollMs);
  }

  throw new Error(
    `funding readback failed for session ${quote.sessionId}: expected amountPaid>=${quote.amount.toString()}, last amountPaid=${lastSession?.amountPaid?.toString?.() ?? "unknown"}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestQuote(
  relayUrl: string,
  body: Record<string, unknown>,
  timeoutMs = DEFAULT_DEPLOYMENT_INTENT_QUOTE_TIMEOUT_MS
): Promise<QuoteResponse> {
  const response = await fetch(new URL("/v1/ingress-intents", relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok || !json.ok) {
    throw new Error(`Quote request failed with ${response.status}: ${JSON.stringify(json)}`);
  }
  return json as QuoteResponse;
}

async function requestDeploymentIntentQuote(
  relayUrl: string,
  intentId: string,
  body: Record<string, unknown>,
  cliToken: string | undefined,
  timeoutMs = DEFAULT_DEPLOYMENT_INTENT_QUOTE_TIMEOUT_MS
): Promise<QuoteResponse> {
  if (!cliToken) {
    throw new Error("Missing deployment intent CLI token. Pass --intent-token/--cli-token or SWITCHBOARD_INTENT_CLI_TOKEN.");
  }
  const response = await fetch(new URL(`/v1/deployment-intents/${encodeURIComponent(intentId)}/quote`, relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cliToken}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok || !json.ok) {
    throw new Error(`Deployment intent quote request failed with ${response.status}: ${JSON.stringify(json)}`);
  }
  return json as QuoteResponse;
}

async function requestDeploymentIntentGroupMemberQuote(
  relayUrl: string,
  groupId: string,
  intentId: string,
  body: Record<string, unknown>,
  cliToken: string | undefined,
  timeoutMs = DEFAULT_DEPLOYMENT_INTENT_QUOTE_TIMEOUT_MS
): Promise<QuoteResponse> {
  if (!cliToken) {
    throw new Error("Missing deployment intent group CLI token. Pass --intent-token/--cli-token or SWITCHBOARD_INTENT_CLI_TOKEN.");
  }
  const response = await fetch(
    new URL(`/v1/deployment-intent-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(intentId)}/quote`, relayUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cliToken}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    }
  );
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok || !json.ok) {
    throw new Error(`Deployment intent group member quote request failed with ${response.status}: ${JSON.stringify(json)}`);
  }
  return json as QuoteResponse;
}

export async function requestDeploymentIntentQuoteOrResume(
  relayUrl: string,
  intentId: string,
  body: Record<string, unknown>,
  cliToken: string | undefined,
  timeoutMs = DEFAULT_DEPLOYMENT_INTENT_QUOTE_TIMEOUT_MS,
  quoteBindingRequest: Record<string, unknown> = body
): Promise<QuoteResponse> {
  try {
    return await requestDeploymentIntentQuote(relayUrl, intentId, body, cliToken, timeoutMs);
  } catch (error) {
    if (!isTimeoutError(error)) {
      throw error;
    }
    const resumeDeadline = Date.now() + (timeoutMs >= 1_000 ? Math.min(timeoutMs, 30_000) : 0);
    let status = await requestDeploymentIntentStatus(relayUrl, intentId, cliToken, timeoutMs);
    while (true) {
      const resumed = quoteResponseFromDeploymentIntentStatus(status, quoteBindingRequest);
      if (resumed) {
        step(`quote request timed out after ${timeoutMs}ms; resuming from deployment intent ${intentId} quote`);
        return resumed;
      }
      const remainingMs = resumeDeadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await sleep(Math.min(DEPLOYMENT_INTENT_QUOTE_RESUME_POLL_MS, remainingMs));
      status = await requestDeploymentIntentStatus(relayUrl, intentId, cliToken, timeoutMs);
    }
    throw new Error(
      `Deployment intent quote request timed out after ${timeoutMs}ms and no reusable quote was available for ${intentId}: ${describeDeploymentIntentStatus(status)}`
    );
  }
}

export async function requestDeploymentIntentGroupMemberQuoteOrResume(
  relayUrl: string,
  groupId: string,
  intentId: string,
  body: Record<string, unknown>,
  cliToken: string | undefined,
  timeoutMs = DEFAULT_DEPLOYMENT_INTENT_QUOTE_TIMEOUT_MS,
  quoteBindingRequest: Record<string, unknown> = body
): Promise<QuoteResponse> {
  try {
    return await requestDeploymentIntentGroupMemberQuote(relayUrl, groupId, intentId, body, cliToken, timeoutMs);
  } catch (error) {
    if (!isTimeoutError(error)) {
      throw error;
    }
    const resumeDeadline = Date.now() + (timeoutMs >= 1_000 ? Math.min(timeoutMs, 30_000) : 0);
    let status = await requestDeploymentIntentStatus(relayUrl, intentId, cliToken, timeoutMs);
    while (true) {
      const resumed = quoteResponseFromDeploymentIntentStatus(status, quoteBindingRequest);
      if (resumed) {
        step(`group member quote request timed out after ${timeoutMs}ms; resuming from deployment intent ${intentId} quote`);
        return resumed;
      }
      const remainingMs = resumeDeadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await sleep(Math.min(DEPLOYMENT_INTENT_QUOTE_RESUME_POLL_MS, remainingMs));
      status = await requestDeploymentIntentStatus(relayUrl, intentId, cliToken, timeoutMs);
    }
    throw new Error(
      `Deployment intent group member quote request timed out after ${timeoutMs}ms and no reusable quote was available for ${intentId}: ${describeDeploymentIntentStatus(status)}`
    );
  }
}

async function requestDeploymentIntentStatus(
  relayUrl: string,
  intentId: string,
  cliToken: string | undefined,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  if (!cliToken) {
    throw new Error("Missing deployment intent CLI token. Pass --intent-token/--cli-token or SWITCHBOARD_INTENT_CLI_TOKEN.");
  }
  const response = await fetch(new URL(`/v1/deployment-intents/${encodeURIComponent(intentId)}`, relayUrl), {
    method: "GET",
    headers: {
      authorization: `Bearer ${cliToken}`
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok || !json.ok) {
    throw new Error(`Deployment intent status request failed with ${response.status}: ${JSON.stringify(json)}`);
  }
  return json as Record<string, unknown>;
}

export function quoteResponseFromDeploymentIntentStatus(
  status: Record<string, unknown>,
  request: Record<string, unknown>,
  nowSeconds = Math.floor(Date.now() / 1000)
): QuoteResponse | undefined {
  const intent = objectField(status, "intent");
  const envelope = objectField(intent, "quote");
  const quote = objectField(envelope, "quote");
  const signature = stringField(envelope, "signature");
  if (!intent || !envelope || !quote || !signature) {
    return undefined;
  }

  const normalized = normalizeQuote(quote);
  try {
    assertIngressQuoteMatchesRequest(normalized, {
      developer: requiredString(request.developer, "request.developer"),
      asset: requiredString(request.asset, "request.asset"),
      paidSeconds: stringField(request, "paidSeconds") ?? stringField(request, "durationSeconds") ?? "",
      maxAmount: stringField(request, "maxAmount"),
      expectedJobSigner: requiredString(request.expectedJobSigner, "request.expectedJobSigner"),
      jobId: stringField(request, "jobId"),
      operatorId: stringField(request, "operatorId"),
      processorId: stringField(request, "processorId"),
      endpointHash: stringField(request, "endpointHash"),
      endpointHostname: stringField(request, "endpointHostname"),
      salt: stringField(request, "salt")
    });
  } catch {
    return undefined;
  }
  if (normalized.deadline <= BigInt(nowSeconds)) {
    return undefined;
  }

  return {
    ok: true,
    quote,
    signature,
    endpointHostname: stringField(intent, "endpointHostname"),
    validationHostname: stringField(intent, "validationHostname"),
    policy: envelope.policy,
    allocation: intent.allocation
  };
}

export function assertQuoteWithinCap(quote: ReturnType<typeof normalizeQuote>, capAmount: string | undefined): void {
  if (!capAmount) {
    return;
  }
  if (!/^[0-9]+$/.test(capAmount)) {
    throw new Error("quote cap amount must be a non-negative integer string");
  }
  const cap = BigInt(capAmount);
  if (quote.amount > cap) {
    throw new Error(`Current quote amount ${quote.amount.toString()} exceeds preview cap ${cap.toString()}`);
  }
}

async function readQuoteResponseFile(file: string): Promise<QuoteResponse> {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || !("quote" in parsed) || !("signature" in parsed)) {
    throw new Error(`Quote response file ${file} must contain quote and signature`);
  }
  return parsed as QuoteResponse;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

function describeDeploymentIntentStatus(status: Record<string, unknown>): string {
  const intent = objectField(status, "intent");
  if (!intent) {
    return "intent status missing";
  }
  const dns = objectField(intent, "dns");
  const events = Array.isArray(intent.events) ? intent.events : [];
  const latest = events.at(-1);
  const latestDetails = objectField(latest, "details");
  return [
    `status=${stringField(intent, "status") ?? "unknown"}`,
    `dns=${stringField(dns, "status") ?? "missing"}`,
    `dnsError=${stringField(dns, "lastError") ?? "none"}`,
    `latestEvent=${stringField(latest, "type") ?? "none"}`,
    `latestReason=${stringField(latestDetails, "lastError") ?? stringField(latestDetails, "reason") ?? "none"}`
  ].join(" ");
}

function objectField(input: unknown, name: string): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringField(input: unknown, name: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeQuote(input: Record<string, unknown>) {
  return {
    quoteId: bytes32(input.quoteId, "quote.quoteId"),
    sessionId: bytes32(input.sessionId, "quote.sessionId"),
    developer: ethers.getAddress(requiredString(input.developer, "quote.developer")),
    asset: ethers.getAddress(requiredString(input.asset, "quote.asset")),
    amount: bigintField(input.amount, "quote.amount"),
    minAmount: bigintField(input.minAmount, "quote.minAmount"),
    maxAmount: bigintField(input.maxAmount, "quote.maxAmount"),
    paidSeconds: bigintField(input.paidSeconds, "quote.paidSeconds"),
    serviceAmount: bigintField(input.serviceAmount, "quote.serviceAmount"),
    setupFee: bigintField(input.setupFee, "quote.setupFee"),
    validationFeeCap: bigintField(input.validationFeeCap, "quote.validationFeeCap"),
    jobId: bytes32(input.jobId, "quote.jobId"),
    expectedJobSigner: ethers.getAddress(requiredString(input.expectedJobSigner, "quote.expectedJobSigner")),
    operatorId: bytes32(input.operatorId, "quote.operatorId"),
    processorId: bytes32(input.processorId, "quote.processorId"),
    endpointHash: bytes32(input.endpointHash, "quote.endpointHash"),
    salt: bytes32(input.salt, "quote.salt"),
    operatorRecipient: ethers.getAddress(requiredString(input.operatorRecipient, "quote.operatorRecipient")),
    validatorRecipient: ethers.getAddress(requiredString(input.validatorRecipient, "quote.validatorRecipient")),
    proofRecipient: ethers.getAddress(requiredString(input.proofRecipient, "quote.proofRecipient")),
    maxOperatorBps: numberField(input.maxOperatorBps, "quote.maxOperatorBps"),
    maxValidatorBps: numberField(input.maxValidatorBps, "quote.maxValidatorBps"),
    maxProofBps: numberField(input.maxProofBps, "quote.maxProofBps"),
    policyHash: bytes32(input.policyHash, "quote.policyHash"),
    deadline: bigintField(input.deadline, "quote.deadline")
  };
}

function sessionOutput(session: any) {
  return {
    developer: session.developer,
    asset: session.asset,
    amountPaid: session.amountPaid.toString(),
    serviceAmount: session.serviceAmount?.toString(),
    setupFee: session.setupFee?.toString(),
    validationFeeCap: session.validationFeeCap?.toString(),
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
    registered: Boolean(session.registered),
    nextNonce: session.nextNonce.toString(),
    status: session.status?.toString()
  };
}

function resolveJobSignerAddress(flags: Map<string, string | boolean>): string {
  const explicit = stringFlag(flags, "job-signer-address") ?? stringFlag(flags, "job-signer") ?? process.env.JOB_SIGNER_ADDRESS;
  if (explicit) {
    return ethers.getAddress(explicit);
  }
  const privateKey = process.env.JOB_SIGNER_PRIVATE_KEY ?? process.env.EVM_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("Missing JOB_SIGNER_ADDRESS or JOB_SIGNER_PRIVATE_KEY");
  }
  return new ethers.Wallet(privateKey).address;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}

function bytes32(value: unknown, name: string): string {
  const hex = ethers.hexlify(requiredString(value, name));
  if (ethers.dataLength(hex) !== 32) {
    throw new Error(`${name} must be bytes32`);
  }
  return hex;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function bigintField(value: unknown, name: string): bigint {
  const text = typeof value === "bigint" ? value.toString() : requiredString(value, name);
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`${name} must be a non-negative integer string`);
  }
  return BigInt(text);
}

function numberField(value: unknown, name: string): number {
  if (typeof value === "number") {
    return value;
  }
  const text = requiredString(value, name);
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(text);
}

function parseFlags(args: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }
  return flags;
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true || flags.get(name) === "true";
}

function step(message: string) {
  console.error(`[hub:fund-native-asset-quote] ${message}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
