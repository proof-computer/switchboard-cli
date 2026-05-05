import { spawn } from "node:child_process";

import { ethers } from "ethers";

import { encodeFundWithAssetQuote, type IngressQuote } from "./ingress-quote.js";
import { INGRESS_REGISTRY_ABI } from "./ingress-contract.js";
import { assertIngressQuoteMatchesRequest } from "./quote-binding.js";

const ERC20_ABI = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)"
] as const;

export interface LedgerSigningContext {
  /** RPC url to which `cast send --ledger` connects. */
  rpcUrl: string;
  /** Decimal chain id, e.g. "420420419". */
  chainId: string;
  /** EVM address shown on the Ledger device. */
  ledgerAddress: string;
  /** Optional BIP-44 derivation path override. */
  derivationPath?: string;
  /** Hub mainnet developer funding requires legacy mode (no EIP-1559). */
  legacy?: boolean;
  /** Confirmations to wait for. */
  confirmations?: string;
}

export interface FundIngressSessionInput {
  /** Polkadot Hub IngressRegistry contract address. */
  registryAddress: string;
  /** Bootstrap relay URL that exposes `/v1/ingress-intents`. */
  relayUrl: string;
  /** Payment asset (e.g. Hub USDC). */
  asset: string;
  /** Quote duration in seconds (e.g. "600"). */
  paidSeconds: string;
  /** EVM address that will sign the Acurast job's registration. */
  jobSignerAddress: string;
  /** Ledger signer context. */
  ledger: LedgerSigningContext;
  /** When false, prepare commands but do not broadcast. */
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
  /** Optional 0x-32 hex salt to disambiguate sessions for the same tuple. */
  sessionSalt?: string;
  /** Replace the JSON-RPC provider. Used by tests. */
  provider?: ethers.JsonRpcProvider;
  /**
   * Replace the on-chain reader. When provided, used in place of the
   * built-in `ethers.Contract` calls against `provider`. Tests should
   * inject this rather than try to mock JsonRpcProvider end-to-end.
   */
  chainReader?: ChainReader;
  /** Replace fetch (for the `/v1/ingress-intents` quote call). Used by tests. */
  fetchImpl?: typeof fetch;
  /** Replace the cast-send subprocess runner. Used by tests. */
  runCommand?: (command: string, args: string[]) => Promise<void>;
  /** Logger for status updates. */
  io?: { log: (line: string) => void; warn: (line: string) => void };
  /** Quote-endpoint request timeout (ms). */
  quoteTimeoutMs?: number;
}

export interface ChainReader {
  /** Chain id reported by `eth_chainId`. */
  getChainId(): Promise<bigint>;
  /** ERC-20 `balanceOf(owner)`. */
  getAssetBalance(asset: string, owner: string): Promise<bigint>;
  /** ERC-20 `allowance(owner, spender)`. */
  getAssetAllowance(asset: string, owner: string, spender: string): Promise<bigint>;
  /** Registry `getSession(sessionId)` — only `developer` is consulted. */
  getRegistrySessionDeveloper(registry: string, sessionId: string): Promise<string>;
}

export interface FundIngressSessionResult {
  /** 0x-32 hex sessionId returned by the relay quote — what `--session-id` will be set to. */
  sessionId: string;
  /** 0x-32 hex jobId from the quote. */
  jobId: string;
  /** Quote-side endpoint hostname (echoed for logging). */
  endpointHostname?: string;
  /** True when the registry already shows a funded session for this quote. */
  alreadyFunded: boolean;
  /** ledger developer address (echoed). */
  developer: string;
  /** Quote amount as a decimal string. */
  amount: string;
  /** Quote asset address (lowercase). */
  asset: string;
  /** When yes=false, the planned `cast send` invocations that would have run. */
  plannedCommands?: PlannedCastCommand[];
}

export interface PlannedCastCommand {
  action: "approve" | "fundWithAssetQuote";
  command: "cast";
  args: string[];
}

interface QuoteResponse {
  ok: boolean;
  quote: Record<string, unknown>;
  signature: string;
  endpointHostname?: string;
}

const DEFAULT_RUN_COMMAND: NonNullable<FundIngressSessionInput["runCommand"]> = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${signal ?? code}`));
    });
  });

export async function fundIngressSessionWithLedger(
  input: FundIngressSessionInput
): Promise<FundIngressSessionResult> {
  const io = input.io ?? { log: () => undefined, warn: () => undefined };
  const fetchImpl = input.fetchImpl ?? fetch;
  const runCommand = input.runCommand ?? DEFAULT_RUN_COMMAND;
  const chainReader = input.chainReader ?? defaultChainReader(input.provider, input.ledger.rpcUrl);

  const chainId = await chainReader.getChainId();
  if (chainId.toString() !== input.ledger.chainId) {
    throw new Error(
      `Ledger funding RPC connected to chain id ${chainId.toString()}, but expected ${input.ledger.chainId}`
    );
  }

  const developer = ethers.getAddress(input.ledger.ledgerAddress);
  const asset = ethers.getAddress(input.asset);
  const registryAddress = ethers.getAddress(input.registryAddress);
  const jobSignerAddress = ethers.getAddress(input.jobSignerAddress);

  const quoteResponse = await requestQuote(
    fetchImpl,
    input.relayUrl,
    {
      developer,
      asset,
      paidSeconds: input.paidSeconds,
      sessionLabel: input.sessionLabel,
      jobId: input.jobId,
      expectedJobSigner: jobSignerAddress,
      operatorId: input.operatorId,
      processorId: input.processorId,
      endpointHostname: input.endpointHostname,
      endpointHash: input.endpointHash,
      salt: input.sessionSalt
    },
    input.quoteTimeoutMs ?? 15_000
  );
  const quote = normalizeQuote(quoteResponse.quote);

  assertIngressQuoteMatchesRequest(quote, {
    developer,
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

  const [assetBalance, currentAllowance, existingDeveloper] = await Promise.all([
    chainReader.getAssetBalance(asset, developer),
    chainReader.getAssetAllowance(asset, developer, registryAddress),
    chainReader.getRegistrySessionDeveloper(registryAddress, quote.sessionId)
  ]);

  if (existingDeveloper !== ethers.ZeroAddress) {
    io.log(
      `Hub session ${quote.sessionId} already funded by ${existingDeveloper}; skipping ledger broadcast.`
    );
    return {
      sessionId: quote.sessionId,
      jobId: quote.jobId,
      endpointHostname: quoteResponse.endpointHostname,
      alreadyFunded: true,
      developer,
      amount: quote.amount.toString(),
      asset: asset.toLowerCase()
    };
  }

  if (assetBalance < quote.amount) {
    throw new Error(
      `Ledger developer asset balance ${assetBalance.toString()} is below quote amount ${quote.amount.toString()}`
    );
  }

  const commands: PlannedCastCommand[] = [];
  if (currentAllowance < quote.amount) {
    commands.push({
      action: "approve",
      command: "cast",
      args: [
        "send",
        ...baseLedgerArgs(input.ledger),
        asset,
        "approve(address,uint256)",
        registryAddress,
        quote.amount.toString()
      ]
    });
  }
  const fundingCalldata = encodeFundWithAssetQuote(quote, quoteResponse.signature);
  commands.push({
    action: "fundWithAssetQuote",
    command: "cast",
    args: ["send", ...baseLedgerArgs(input.ledger), registryAddress, ethers.hexlify(fundingCalldata)]
  });

  if (!input.yes) {
    return {
      sessionId: quote.sessionId,
      jobId: quote.jobId,
      endpointHostname: quoteResponse.endpointHostname,
      alreadyFunded: false,
      developer,
      amount: quote.amount.toString(),
      asset: asset.toLowerCase(),
      plannedCommands: commands
    };
  }

  for (const command of commands) {
    io.log(`[ledger:${command.action}] ${command.command} ${command.args.join(" ")}`);
    await runCommand(command.command, command.args);
  }

  return {
    sessionId: quote.sessionId,
    jobId: quote.jobId,
    endpointHostname: quoteResponse.endpointHostname,
    alreadyFunded: false,
    developer,
    amount: quote.amount.toString(),
    asset: asset.toLowerCase()
  };
}

function defaultChainReader(provider: ethers.JsonRpcProvider | undefined, rpcUrl: string): ChainReader {
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

function baseLedgerArgs(ctx: LedgerSigningContext): string[] {
  const args = [
    "--ledger",
    "--rpc-url",
    ctx.rpcUrl,
    "--chain",
    ctx.chainId,
    "--confirmations",
    ctx.confirmations ?? "1",
    "--from",
    ethers.getAddress(ctx.ledgerAddress)
  ];
  if (ctx.legacy) args.push("--legacy");
  if (ctx.derivationPath) args.push("--mnemonic-derivation-path", ctx.derivationPath);
  return args;
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
    throw new Error(`Quote request to ${relayUrl}/v1/ingress-intents failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return json;
}

function normalizeQuote(input: Record<string, unknown>): IngressQuote {
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

function bytes32(value: unknown, name: string): string {
  const stringValue = requiredString(value, name);
  const hexValue = ethers.hexlify(stringValue);
  if (ethers.dataLength(hexValue) !== 32) {
    throw new Error(`${name} must be bytes32`);
  }
  return hexValue;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function bigintField(value: unknown, name: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  throw new Error(`${name} must be a non-negative integer string`);
}

function numberField(value: unknown, name: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  throw new Error(`${name} must be a non-negative integer`);
}
