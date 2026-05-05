import type { ApiPromise } from "@polkadot/api";

export type NativeFundingAction = "mapAccount" | "approve" | "fundWithAssetQuote";

export interface NativeFundingConstants {
  existentialDeposit?: bigint;
  approvalDeposit?: bigint;
}

export interface NativeFundingDiagnosticContext extends NativeFundingConstants {
  action: NativeFundingAction;
  polkadotAddress: string;
  contractLayerAddress?: string;
  nativeFree?: bigint;
  estimatedFee?: bigint;
  minimumRequired?: bigint;
  nativeSymbol?: string;
  nativeDecimals?: number;
  assetSymbol?: string;
  rawError?: unknown;
}

const NATIVE_FUNDING_ERROR_PATTERNS = [
  "ConsumerRemaining",
  "FundsUnavailable",
  "InsufficientBalance",
  "LiquidityRestrictions",
  "KeepAlive",
  "ExistentialDeposit",
  "BalanceLow"
];

export async function readNativeFreeBalance(api: ApiPromise, address: string): Promise<bigint> {
  const account = await api.query.system.account(address);
  return BigInt((account as any).data.free.toString());
}

export function readNativeFundingConstants(api: ApiPromise): NativeFundingConstants {
  return {
    existentialDeposit: optionalBigInt((api.consts as any).balances?.existentialDeposit),
    approvalDeposit:
      optionalBigInt((api.consts as any).assets?.approvalDeposit) ??
      optionalBigInt((api.consts as any).foreignAssets?.approvalDeposit)
  };
}

export function minimumNativeForFirstApproval(input: NativeFundingDiagnosticContext): bigint | undefined {
  if (input.estimatedFee === undefined) return undefined;
  return input.estimatedFee + (input.existentialDeposit ?? 0n) + (input.approvalDeposit ?? 0n);
}

export function assertNativeFundingSufficientForFirstApproval(input: NativeFundingDiagnosticContext): void {
  if (input.nativeFree === undefined) return;
  const minimumRequired = input.minimumRequired ?? minimumNativeForFirstApproval(input);
  if (minimumRequired === undefined || input.nativeFree >= minimumRequired) return;

  throw new Error(nativeFundingTopUpMessage({ ...input, minimumRequired }));
}

export function enrichNativeFundingError(error: unknown, input: NativeFundingDiagnosticContext): Error {
  const rawError = errorMessage(error);
  const likelyNativeFunding = isLikelyNativeFundingError(error);
  const message = likelyNativeFunding
    ? nativeFundingTopUpMessage({ ...input, rawError })
    : nativeFundingContextMessage({ ...input, rawError });

  return new Error(message);
}

export function isLikelyNativeFundingError(error: unknown): boolean {
  const message = errorMessage(error);
  return NATIVE_FUNDING_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

export function nativeFundingTopUpMessage(input: NativeFundingDiagnosticContext): string {
  const symbol = input.nativeSymbol ?? "DOT";
  const headline = `Not enough native ${symbol} on Polkadot funder account ${input.polkadotAddress} to ${actionLabel(input)}.`;
  return [
    headline,
    topUpLine(input),
    ...nativeFundingDetailLines(input),
    rawErrorLine(input.rawError)
  ].filter(Boolean).join("\n");
}

function nativeFundingContextMessage(input: NativeFundingDiagnosticContext): string {
  return [
    `Hub funding ${input.action} failed for Polkadot funder account ${input.polkadotAddress}.`,
    topUpLine(input),
    ...nativeFundingDetailLines(input),
    rawErrorLine(input.rawError)
  ].filter(Boolean).join("\n");
}

function topUpLine(input: NativeFundingDiagnosticContext): string {
  const symbol = input.nativeSymbol ?? "DOT";
  const mapped = input.contractLayerAddress ? ` The mapped Revive/EVM address is ${input.contractLayerAddress}.` : "";
  return `Top up ${input.polkadotAddress} with native ${symbol}. This account pays Asset Hub revive.call fees and storage deposits; the USDC payment asset can still live on the mapped Revive address.${mapped}`;
}

function nativeFundingDetailLines(input: NativeFundingDiagnosticContext): string[] {
  const lines: string[] = [];
  const unit = nativeUnit(input);
  if (input.nativeFree !== undefined) {
    lines.push(`Native free balance: ${formatNativeAmount(input.nativeFree, unit)}.`);
  }
  if (input.minimumRequired !== undefined) {
    lines.push(`Known minimum required before this action: ${formatNativeAmount(input.minimumRequired, unit)}.`);
  }
  if (input.estimatedFee !== undefined) {
    lines.push(`Estimated ${input.action} transaction fee: ${formatNativeAmount(input.estimatedFee, unit)}.`);
  }
  if (input.approvalDeposit !== undefined && input.action === "approve") {
    lines.push(`Asset approval deposit: ${formatNativeAmount(input.approvalDeposit, unit)}.`);
  }
  if (input.existentialDeposit !== undefined) {
    lines.push(`Native existential deposit: ${formatNativeAmount(input.existentialDeposit, unit)}.`);
  }
  return lines;
}

function actionLabel(input: NativeFundingDiagnosticContext): string {
  const asset = input.assetSymbol ?? "the payment asset";
  if (input.action === "mapAccount") return "map the account for Revive";
  if (input.action === "approve") return `approve ${asset} for Hub funding`;
  return "fund the Hub session";
}

function rawErrorLine(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  return `Raw chain error: ${errorMessage(error)}`;
}

function nativeUnit(input: NativeFundingDiagnosticContext): { symbol: string; decimals: number } {
  return {
    symbol: input.nativeSymbol ?? "DOT",
    decimals: input.nativeDecimals ?? 10
  };
}

function formatNativeAmount(amount: bigint, unit: { symbol: string; decimals: number }): string {
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const base = 10n ** BigInt(unit.decimals);
  const whole = absolute / base;
  const fraction = absolute % base;
  const fractionText = fraction.toString().padStart(unit.decimals, "0").replace(/0+$/, "");
  const decimal = fractionText ? `${whole.toString()}.${fractionText}` : whole.toString();
  return `${negative ? "-" : ""}${decimal} ${unit.symbol} (${amount.toString()} base units)`;
}

function optionalBigInt(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return BigInt((value as any).toString());
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
