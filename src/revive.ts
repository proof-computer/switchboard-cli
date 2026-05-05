import type { ApiPromise } from "@polkadot/api";

export interface ReviveBalanceWithDust {
  contractValue: bigint;
  nativeBalanceWithValue: bigint;
  dust: bigint;
}

export interface ReviveNativeValueQuote {
  requestedContractValue: bigint;
  nativeCallValue: bigint;
  contractValuePerNativeUnit: bigint;
  submittedContractValue: bigint;
  excessContractValue: bigint;
  dust: bigint;
  nativeBalanceBase: bigint;
  nativeBalanceWithRequestedValue: bigint;
}

export async function quoteReviveNativeCallValue(
  api: ApiPromise,
  requestedContractValue: bigint
): Promise<ReviveNativeValueQuote> {
  if (requestedContractValue < 0n) {
    throw new Error("requestedContractValue must not be negative");
  }

  const nativeBalanceBase = (await readNewBalanceWithDust(api, 0n)).nativeBalanceWithValue;
  const requested = await readNewBalanceWithDust(api, requestedContractValue);
  const contractValuePerNativeUnit = await deriveContractValuePerNativeUnit(api, nativeBalanceBase);
  const nativeWholeUnits = requested.nativeBalanceWithValue - nativeBalanceBase;
  const nativeCallValue = requestedContractValue === 0n ? 0n : nativeWholeUnits + (requested.dust > 0n ? 1n : 0n);
  const submittedContractValue = nativeCallValue * contractValuePerNativeUnit;

  return {
    requestedContractValue,
    nativeCallValue,
    contractValuePerNativeUnit,
    submittedContractValue,
    excessContractValue: submittedContractValue - requestedContractValue,
    dust: requested.dust,
    nativeBalanceBase,
    nativeBalanceWithRequestedValue: requested.nativeBalanceWithValue
  };
}

async function deriveContractValuePerNativeUnit(api: ApiPromise, nativeBalanceBase: bigint): Promise<bigint> {
  let high = 1n;
  while ((await readNewBalanceWithDust(api, high)).nativeBalanceWithValue <= nativeBalanceBase) {
    high *= 2n;
  }

  let low = 0n;
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if ((await readNewBalanceWithDust(api, mid)).nativeBalanceWithValue > nativeBalanceBase) {
      high = mid;
    } else {
      low = mid;
    }
  }

  return high;
}

async function readNewBalanceWithDust(api: ApiPromise, contractValue: bigint): Promise<ReviveBalanceWithDust> {
  const result = (await api.call.reviveApi.newBalanceWithDust(contractValue.toString())) as any;
  if (result.isErr) {
    throw new Error(`reviveApi.newBalanceWithDust failed: ${result.asErr.toString()}`);
  }

  const [nativeBalanceWithValue, dust] = result.asOk;
  return {
    contractValue,
    nativeBalanceWithValue: BigInt(nativeBalanceWithValue.toString()),
    dust: BigInt(dust.toString())
  };
}
