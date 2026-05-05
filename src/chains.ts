export const NATIVE_ASSET_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface PaymentAssetConfig {
  symbol: string;
  kind: "native" | "trust-backed-asset";
  decimals: number;
  contractAddress: string;
  assetId?: number;
}

export interface SwitchboardTargetConfig {
  name: string;
  label: string;
  defaultEthRpcUrl: string;
  defaultSubstrateWsUrl?: string;
  expectedChainId?: bigint;
  nativeSymbol: string;
  nativeDecimals: number;
  requiresExplicitPaymentAmount: boolean;
  assets: PaymentAssetConfig[];
}

export const HUB_USDC: PaymentAssetConfig = {
  symbol: "USDC",
  kind: "trust-backed-asset",
  assetId: 1337,
  decimals: 6,
  contractAddress: "0x0000053900000000000000000000000001200000"
};

export const HUB_USDT: PaymentAssetConfig = {
  symbol: "USDt",
  kind: "trust-backed-asset",
  assetId: 1984,
  decimals: 6,
  contractAddress: "0x000007C000000000000000000000000001200000"
};

export const HUB_DOT: PaymentAssetConfig = {
  symbol: "DOT",
  kind: "native",
  decimals: 10,
  contractAddress: NATIVE_ASSET_ADDRESS
};

export const SWITCHBOARD_TARGETS: Record<string, SwitchboardTargetConfig> = {
  "revive-local": {
    name: "revive-local",
    label: "Local revive dev node",
    defaultEthRpcUrl: "http://127.0.0.1:8545",
    defaultSubstrateWsUrl: "ws://127.0.0.1:9944",
    nativeSymbol: "DOT",
    nativeDecimals: 10,
    requiresExplicitPaymentAmount: false,
    assets: [HUB_USDC, HUB_USDT]
  },
  "polkadot-hub-testnet": {
    name: "polkadot-hub-testnet",
    label: "Polkadot Hub TestNet",
    defaultEthRpcUrl: "https://services.polkadothub-rpc.com/testnet",
    defaultSubstrateWsUrl: "wss://asset-hub-paseo-rpc.n.dwellir.com",
    expectedChainId: 420420417n,
    nativeSymbol: "PAS",
    nativeDecimals: 10,
    requiresExplicitPaymentAmount: true,
    assets: [HUB_USDC, HUB_USDT]
  },
  "polkadot-hub": {
    name: "polkadot-hub",
    label: "Polkadot Hub",
    defaultEthRpcUrl: "https://services.polkadothub-rpc.com/mainnet",
    defaultSubstrateWsUrl: "wss://polkadot-asset-hub-rpc.polkadot.io",
    expectedChainId: 420420419n,
    nativeSymbol: "DOT",
    nativeDecimals: 10,
    requiresExplicitPaymentAmount: true,
    assets: [HUB_USDC, HUB_USDT]
  }
};

export function getSwitchboardTarget(name: string): SwitchboardTargetConfig {
  const target = SWITCHBOARD_TARGETS[name];
  if (!target) {
    throw new Error(`Unknown SWITCHBOARD_TARGET "${name}". Supported targets: ${Object.keys(SWITCHBOARD_TARGETS).join(", ")}`);
  }

  return target;
}
