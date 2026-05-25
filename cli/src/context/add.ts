import * as p from "@clack/prompts";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { ethers } from "ethers";

import { accountFromUri, contractLayerAddress } from "../../../src/polkadot.js";
import {
  boolFlag,
  formatAssetUnits,
  optionalEnv,
  pruneUndefined,
  readContextStore,
  resolveCliNetworkConfig,
  safeErrorMessage,
  sanitizeContextForOutput,
  stringFlag,
  writeContextStore,
  writeOutput,
  type AssetDisplay,
  type CliNetworkConfig,
  type CliRuntime,
  type SwitchboardContext
} from "../index.js";

const DEFAULT_ACURAST_MAINNET_RPC = "wss://archive.mainnet.acurast.com";
const DEFAULT_ACURAST_CANARY_RPC = "wss://canarynet-ws-1.acurast-h-server-2.papers.tech";
const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];
const ERC20_METADATA_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

const ACU_FLOOR_PLANCK = 500_000_000_000n;
const HUB_NATIVE_FLOOR_PLANCK = 100_000_000_000n;
const HUB_USDC_FLOOR_RAW = 2_000_000n;

interface BalanceLine {
  label: string;
  value: string;
  ok: boolean;
  hint?: string;
}

export async function contextAddCommand(
  flags: Map<string, string | boolean>,
  positionals: string[],
  runtime?: Pick<CliRuntime, "contextStorePath">
): Promise<void> {
  if (boolFlag(flags, "json")) {
    throw new Error("`context add` is interactive. Use `context set` for scripted updates.");
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error("`context add` requires an interactive TTY. Use `context set` for scripted updates.");
  }

  const explicitName = positionals[2] ?? stringFlag(flags, "context");
  const contextStorePath = runtime?.contextStorePath;
  const store = contextStorePath ? await readContextStore(contextStorePath) : await readContextStore();

  p.intro("Switchboard · context add");

  let name = explicitName;
  if (!name) {
    const answer = await p.text({
      message: "Context name",
      placeholder: "mainnet",
      validate: (value) => (!value || value.trim().length === 0 ? "Required" : undefined)
    });
    if (p.isCancel(answer)) {
      p.cancel("Cancelled.");
      process.exit(1);
    }
    name = answer.trim();
  }

  if (store.contexts?.[name]) {
    p.cancel(`Context "${name}" already exists. Use \`switchboard context set ${name} ...\` to update it.`);
    process.exit(1);
  }

  const acurastNetworkAnswer = await p.select({
    message: "Acurast network",
    options: [
      { value: "mainnet", label: "mainnet" },
      { value: "canary", label: "canary" }
    ],
    initialValue: "mainnet"
  });
  cancelIfCancelled(acurastNetworkAnswer);
  const acurastNetwork = acurastNetworkAnswer as string;

  const acurastSeedEnvAnswer = await p.text({
    message: "Acurast deploy seed env var",
    initialValue: "ACURAST_MAINNET_SEED",
    validate: (value) => (!value || value.trim().length === 0 ? "Required" : undefined)
  });
  cancelIfCancelled(acurastSeedEnvAnswer);
  const acurastSeedEnv = (acurastSeedEnvAnswer as string).trim();
  const acurastSeed = optionalEnv(acurastSeedEnv);

  let derivedAcurastAddress: string | undefined;
  if (acurastSeed) {
    derivedAcurastAddress = await deriveSs58Address(acurastSeed).catch((error) => {
      p.log.warn(`Could not derive Acurast address from ${acurastSeedEnv}: ${safeErrorMessage(error)}`);
      return undefined;
    });
    if (derivedAcurastAddress) {
      p.log.info(`Derived Acurast address (ss58 generic): ${derivedAcurastAddress}`);
    }
  } else {
    p.log.warn(`Env var ${acurastSeedEnv} is not set; address derivation skipped.`);
  }

  const acurastAddressEnvAnswer = await p.text({
    message: "Acurast deploy address env var (blank to skip)",
    initialValue: "ACURAST_MAINNET_ADDRESS"
  });
  cancelIfCancelled(acurastAddressEnvAnswer);
  const acurastAddressEnv = nonEmpty(acurastAddressEnvAnswer as string);
  const acurastAddressLiteral =
    (acurastAddressEnv ? optionalEnv(acurastAddressEnv) : undefined) ?? derivedAcurastAddress;

  const signerKindAnswer = await p.select({
    message: "Hub payment signer",
    options: [
      { value: "seed", label: "Polkadot seed (env-backed)" },
      { value: "ledger", label: "Ledger" }
    ],
    initialValue: "seed"
  });
  cancelIfCancelled(signerKindAnswer);
  const signerKind = signerKindAnswer as "seed" | "ledger";

  const partial: SwitchboardContext = {
    acurastNetwork,
    acurastSeedEnv,
    acurastAddressEnv,
    polkadotSigner: signerKind
  };

  let polkadotAddress: string | undefined;
  if (signerKind === "seed") {
    const seedEnvAnswer = await p.text({
      message: "Polkadot seed env var",
      initialValue: "POLKADOT_SEED",
      validate: (value) => (!value || value.trim().length === 0 ? "Required" : undefined)
    });
    cancelIfCancelled(seedEnvAnswer);
    partial.polkadotSeedEnv = (seedEnvAnswer as string).trim();

    const polkadotSeed = optionalEnv(partial.polkadotSeedEnv);
    if (polkadotSeed) {
      polkadotAddress = await deriveSs58Address(polkadotSeed).catch(() => undefined);
      if (polkadotAddress) {
        p.log.info(`Derived Polkadot address (ss58 generic): ${polkadotAddress}`);
      }
    } else {
      p.log.warn(`Env var ${partial.polkadotSeedEnv} is not set; address derivation skipped.`);
    }

    const addrEnvAnswer = await p.text({
      message: "Polkadot address env var (blank to store derived address literally)",
      placeholder: "POLKADOT_ADDRESS"
    });
    cancelIfCancelled(addrEnvAnswer);
    const addrEnv = nonEmpty(addrEnvAnswer as string);
    if (addrEnv) {
      partial.polkadotAddressEnv = addrEnv;
      polkadotAddress = optionalEnv(addrEnv) ?? polkadotAddress;
    } else if (polkadotAddress) {
      partial.polkadotAddress = polkadotAddress;
    }
  } else {
    const ledgerAddrAnswer = await p.text({
      message: "Ledger Polkadot address",
      validate: (value) => (!value || value.trim().length === 0 ? "Required" : undefined)
    });
    cancelIfCancelled(ledgerAddrAnswer);
    polkadotAddress = (ledgerAddrAnswer as string).trim();
    partial.polkadotAddress = polkadotAddress;

    const accountAnswer = await p.text({
      message: "Ledger account index",
      initialValue: "0"
    });
    cancelIfCancelled(accountAnswer);
    partial.ledgerAccount = (accountAnswer as string).trim();

    const indexAnswer = await p.text({
      message: "Ledger address index",
      initialValue: "0"
    });
    cancelIfCancelled(indexAnswer);
    partial.ledgerAddressIndex = (indexAnswer as string).trim();

    const modeAnswer = await p.select({
      message: "Ledger app mode",
      options: [
        { value: "generic", label: "Polkadot Generic (recommended)" },
        { value: "legacy", label: "Legacy chain-specific app" }
      ],
      initialValue: "generic"
    });
    cancelIfCancelled(modeAnswer);
    partial.ledgerMode = modeAnswer as string;

    if (partial.ledgerMode === "generic") {
      const chainIdAnswer = await p.text({
        message: "Ledger metadata chain id (zondax)",
        placeholder: "polkadot"
      });
      cancelIfCancelled(chainIdAnswer);
      partial.ledgerMetadataChainId = nonEmpty(chainIdAnswer as string);
    } else {
      const chainAnswer = await p.text({
        message: "Legacy ledger chain",
        initialValue: "statemint"
      });
      cancelIfCancelled(chainAnswer);
      partial.ledgerChain = nonEmpty(chainAnswer as string);
    }
  }

  const useAnswer = await p.confirm({
    message: "Make this the current context?",
    initialValue: true
  });
  cancelIfCancelled(useAnswer);
  const setCurrent = useAnswer === true;

  pruneUndefined(partial);
  const updatedStore = contextStorePath ? await readContextStore(contextStorePath) : await readContextStore();
  if (updatedStore.contexts?.[name]) {
    p.cancel(`Context "${name}" appeared in another process; aborting.`);
    process.exit(1);
  }
  updatedStore.contexts = { ...(updatedStore.contexts ?? {}), [name]: partial };
  if (setCurrent || !updatedStore.current) {
    updatedStore.current = name;
  }
  if (contextStorePath) {
    await writeContextStore(updatedStore, contextStorePath);
  } else {
    await writeContextStore(updatedStore);
  }
  p.log.success(`Saved context "${name}"${updatedStore.current === name ? " (current)" : ""}.`);

  const skipBalances = boolFlag(flags, "no-balance-check");
  if (!skipBalances) {
    const acurastRpc =
      stringFlag(flags, "acurast-rpc") ??
      optionalEnv("ACURAST_RPC") ??
      (acurastNetwork === "canary" ? DEFAULT_ACURAST_CANARY_RPC : DEFAULT_ACURAST_MAINNET_RPC);
    await runBalanceChecks({ flags, acurastAddress: acurastAddressLiteral, polkadotAddress, acurastRpc });
  } else {
    p.log.info("Balance checks skipped (--no-balance-check).");
  }

  p.outro(
    "Next: run `switchboard preflight --quote`. PROOF-managed DNS credentials are not needed in normal builder contexts."
  );

  writeOutput(
    flags,
    {
      ok: true,
      action: "context-add",
      name,
      current: updatedStore.current,
      context: sanitizeContextForOutput(partial)
    },
    () => {
      // human output already streamed by clack
    }
  );
}

async function runBalanceChecks(options: {
  flags: Map<string, string | boolean>;
  acurastAddress?: string;
  polkadotAddress?: string;
  acurastRpc: string;
}): Promise<void> {
  const lines: BalanceLine[] = [];
  const spinner = p.spinner();
  spinner.start("Checking balances against the signed manifest");

  let manifestConfig: CliNetworkConfig | undefined;
  try {
    manifestConfig = await resolveCliNetworkConfig(options.flags);
  } catch (error) {
    spinner.stop("Manifest unavailable");
    p.log.warn(`Could not resolve signed manifest: ${safeErrorMessage(error)}`);
    return;
  }

  if (options.acurastAddress) {
    const result = await readSubstrateFreeBalance(options.acurastRpc, options.acurastAddress).catch((error) => ({
      error: safeErrorMessage(error)
    }));
    if ("error" in result) {
      lines.push({ label: `Acurast ACU (${options.acurastAddress})`, value: `error: ${result.error}`, ok: false });
    } else {
      lines.push({
        label: `Acurast ACU (${options.acurastAddress})`,
        value: formatPlanck(result.free, 12, "ACU"),
        ok: result.free >= ACU_FLOOR_PLANCK,
        hint: result.free >= ACU_FLOOR_PLANCK ? undefined : "below recommended deploy floor (~0.5 ACU)"
      });
    }
  } else {
    lines.push({ label: "Acurast ACU", value: "skipped (no address)", ok: false });
  }

  if (options.polkadotAddress && manifestConfig.substrateWsUrl) {
    const native = await readSubstrateFreeBalance(manifestConfig.substrateWsUrl, options.polkadotAddress).catch(
      (error) => ({ error: safeErrorMessage(error) })
    );
    if ("error" in native) {
      lines.push({ label: `Hub native (${options.polkadotAddress})`, value: `error: ${native.error}`, ok: false });
    } else {
      lines.push({
        label: `Hub native (${options.polkadotAddress})`,
        value: formatPlanck(native.free, 10, ""),
        ok: native.free >= HUB_NATIVE_FLOOR_PLANCK,
        hint: native.free >= HUB_NATIVE_FLOOR_PLANCK ? undefined : "needs gas for approve + fundWithAssetQuote"
      });
    }
  }

  if (options.polkadotAddress && manifestConfig.ethRpcUrl && manifestConfig.defaultAssetAddress && manifestConfig.substrateWsUrl) {
    const usdc = await readHubAssetBalance(
      manifestConfig.substrateWsUrl,
      manifestConfig.ethRpcUrl,
      manifestConfig.defaultAssetAddress,
      options.polkadotAddress,
      manifestConfig
    ).catch((error) => ({ error: safeErrorMessage(error) }));
    if ("error" in usdc) {
      lines.push({ label: `Hub asset (${manifestConfig.defaultAssetAddress})`, value: `error: ${usdc.error}`, ok: false });
    } else {
      lines.push({
        label: `Hub ${usdc.asset.symbol ?? "asset"} (${usdc.contractLayerAddress})`,
        value: formatAssetUnits(usdc.balance, usdc.asset) ?? usdc.balance.toString(),
        ok: usdc.balance >= HUB_USDC_FLOOR_RAW,
        hint: usdc.balance >= HUB_USDC_FLOOR_RAW ? undefined : "below typical hello-world quote (~2 USDC)"
      });
    }
  } else if (options.polkadotAddress) {
    lines.push({ label: "Hub asset", value: "skipped (manifest missing fields)", ok: false });
  }

  spinner.stop("Balance check complete");
  for (const line of lines) {
    const status = line.ok ? "✓" : "✗";
    p.log.message(`${status} ${line.label}: ${line.value}${line.hint ? ` — ${line.hint}` : ""}`);
  }
}

async function readSubstrateFreeBalance(wsUrl: string, address: string): Promise<{ free: bigint }> {
  const provider = new WsProvider(wsUrl);
  const api = await ApiPromise.create({ provider, throwOnConnect: true });
  try {
    const account = await api.query.system.account(address);
    return { free: BigInt((account as any).data.free.toString()) };
  } finally {
    await api.disconnect();
  }
}

async function readHubAssetBalance(
  substrateWsUrl: string,
  ethRpcUrl: string,
  assetAddress: string,
  polkadotAddress: string,
  manifestConfig: CliNetworkConfig
): Promise<{ balance: bigint; asset: AssetDisplay; contractLayerAddress: string }> {
  const provider = new WsProvider(substrateWsUrl);
  const api = await ApiPromise.create({ provider, throwOnConnect: true });
  let mappedAddress: string;
  try {
    mappedAddress = await contractLayerAddress(api, polkadotAddress);
  } finally {
    await api.disconnect();
  }
  const ethProvider = new ethers.JsonRpcProvider(ethRpcUrl);
  const asset = await resolveAssetDisplay(ethProvider, manifestConfig, assetAddress);
  const token = new ethers.Contract(assetAddress, ERC20_BALANCE_ABI, ethProvider) as any;
  const balance = (await token.balanceOf(mappedAddress)) as bigint;
  return { balance, asset, contractLayerAddress: mappedAddress };
}

async function resolveAssetDisplay(
  provider: ethers.Provider,
  manifestConfig: CliNetworkConfig,
  assetAddress: string
): Promise<AssetDisplay> {
  const manifestAsset = manifestConfig.manifest?.supportedAssets?.find(
    (item) => item.address.toLowerCase() === assetAddress.toLowerCase()
  );
  const display: AssetDisplay = {
    address: ethers.getAddress(assetAddress),
    symbol: manifestAsset?.symbol,
    decimals: manifestAsset?.decimals
  };
  if (display.symbol && display.decimals !== undefined) {
    return display;
  }
  const token = new ethers.Contract(assetAddress, ERC20_METADATA_ABI, provider) as any;
  const [symbol, decimals] = await Promise.all([
    display.symbol ? Promise.resolve(display.symbol) : token.symbol().catch(() => undefined),
    display.decimals !== undefined ? Promise.resolve(display.decimals) : token.decimals().catch(() => undefined)
  ]);
  return {
    ...display,
    symbol: typeof symbol === "string" ? symbol : display.symbol,
    decimals: decimals === undefined ? display.decimals : Number(decimals)
  };
}

async function deriveSs58Address(seed: string): Promise<string> {
  const account = await accountFromUri(seed);
  return account.address;
}

function formatPlanck(amount: bigint, decimals: number, symbol: string): string {
  const formatted = ethers.formatUnits(amount, decimals);
  return symbol ? `${formatted} ${symbol}` : formatted;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cancelIfCancelled<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(1);
  }
}
