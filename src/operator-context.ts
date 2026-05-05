/**
 * Operator-side context loader for non-CLI scripts (scripts/hub/*, scripts/acurast/*).
 *
 * Every script that talks to chain-or-relay infrastructure loads the active
 * Switchboard CLI context here, then derives chain config from `chains.ts`
 * defaults plus the relay's /health response.
 *
 * What this loader guarantees once it returns:
 *   - context.target is set
 *   - chainId reported by relayUrl/health matches getSwitchboardTarget(target).expectedChainId
 *   - operatorId, relayUrl, ethRpcUrl, substrateWsUrl all resolved
 *
 * Anything ambiguous is a thrown error with a remediation hint.
 */
import { readFile } from "node:fs/promises";

import { getSwitchboardTarget, type SwitchboardTargetConfig } from "./chains.js";
import { contextStorePath } from "../cli/src/switchboard-paths.js";

export interface SwitchboardContext {
  manifestUrl?: string;
  manifestSigner?: string;
  target?: string;
  operatorId?: string;
  relayUrl?: string;
  paymentMode?: string;
  acurastNetwork?: string;
  acurastSeedEnv?: string;
  acurastAddressEnv?: string;
  polkadotSigner?: string;
  polkadotAddress?: string;
  polkadotSeedEnv?: string;
  polkadotAddressEnv?: string;
  polkadotSs58Format?: string;
  ledgerMode?: string;
  ledgerTransport?: string;
  ledgerChain?: string;
  ledgerSlip44?: string;
  ledgerAccount?: string;
  ledgerAddressIndex?: string;
  ledgerMetadataChainId?: string;
  ledgerMetadataUrl?: string;
  developerPrivateKeyEnv?: string;
  cloudflareApiTokenEnv?: string;
}

export interface SwitchboardContextStore {
  current?: string;
  contexts?: Record<string, SwitchboardContext>;
}

export interface LoadedOperatorContext {
  contextName: string;
  context: SwitchboardContext;
  target: SwitchboardTargetConfig;
  /** EVM RPC for the configured target. Pulled from chains.ts. */
  ethRpcUrl: string;
  /** Substrate WS for the configured target. */
  substrateWsUrl: string;
  /** Bootstrap relay URL the context points at. */
  relayUrl: string;
  /** Operator owner identity (bytes32 hex). */
  operatorId: string;
  /** Relay /health snapshot, including the live registryAddress + chainId. */
  relayHealth: RelayHealth;
  /** Registry address the relay reports. */
  registryAddress: string;
}

export interface RelayHealth {
  ok: boolean;
  chainId: string;
  registryAddress: string;
  recorderCoordinatorAddress?: string;
  [key: string]: unknown;
}

export interface LoadOperatorContextOptions {
  /** Override active context. Falls back to `SWITCHBOARD_CONTEXT`, then store.current. */
  contextName?: string;
  /** Skip relay /health roundtrip + chainId assertion. Default false. */
  skipRelayCheck?: boolean;
  /** HTTP timeout for /health, ms. Default 10000. */
  healthTimeoutMs?: number;
}

export class OperatorContextError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

export async function loadOperatorContext(options: LoadOperatorContextOptions = {}): Promise<LoadedOperatorContext> {
  const store = await readContextStoreForOperatorScripts();
  const name = options.contextName ?? process.env.SWITCHBOARD_CONTEXT ?? store.current;
  if (!name) {
    throw new OperatorContextError(
      "No active switchboard context.",
      "Create one with `switchboard context add <name> --target polkadot-hub --acurast-network mainnet ...` and select it via `switchboard context use <name>`. " +
        "Or set SWITCHBOARD_CONTEXT for a one-shot."
    );
  }
  const context = store.contexts?.[name];
  if (!context) {
    throw new OperatorContextError(
      `Unknown switchboard context "${name}".`,
      "Run `switchboard context list` to see what's defined."
    );
  }

  if (!context.target) {
    throw new OperatorContextError(
      `Context "${name}" is missing required field: target`,
      "Set with `switchboard context set " + name + " --target polkadot-hub` (or polkadot-hub-testnet)."
    );
  }
  let target: SwitchboardTargetConfig;
  try {
    target = getSwitchboardTarget(context.target);
  } catch (error) {
    throw new OperatorContextError(
      `Context "${name}" references unknown target "${context.target}": ${(error as Error).message}`,
      "Valid targets: polkadot-hub, polkadot-hub-testnet."
    );
  }
  if (!context.relayUrl) {
    throw new OperatorContextError(
      `Context "${name}" is missing required field: relayUrl`,
      "Set with `switchboard context set " + name + " --relay-url https://relay-a.switchboard.proof.computer`."
    );
  }
  if (!context.operatorId) {
    throw new OperatorContextError(
      `Context "${name}" is missing required field: operatorId`,
      "Set with `switchboard context set " + name + " --operator-id 0x...`."
    );
  }

  const ethRpcUrl = target.defaultEthRpcUrl;
  const substrateWsUrl = target.defaultSubstrateWsUrl;
  if (!ethRpcUrl) throw new OperatorContextError(`chains.ts target "${context.target}" has no defaultEthRpcUrl`);
  if (!substrateWsUrl) throw new OperatorContextError(`chains.ts target "${context.target}" has no defaultSubstrateWsUrl`);

  const expectedChainId = target.expectedChainId;
  if (expectedChainId === undefined || expectedChainId === null) {
    throw new OperatorContextError(`chains.ts target "${context.target}" has no expectedChainId`);
  }
  const relayHealth = options.skipRelayCheck
    ? ({ ok: false, chainId: expectedChainId.toString(), registryAddress: "" } as RelayHealth)
    : await fetchRelayHealth(context.relayUrl, options.healthTimeoutMs ?? 10_000);

  if (!options.skipRelayCheck) {
    const expected = expectedChainId.toString();
    if (relayHealth.chainId !== expected) {
      throw new OperatorContextError(
        `Relay ${context.relayUrl} reports chainId=${relayHealth.chainId} but context "${name}" target=${context.target} expects ${expected}.`,
        "Either change the context's target/relayUrl, or pick a different context with --context. " +
          "This prevents accidentally using a relay pointed at a different Hub network."
      );
    }
    if (!relayHealth.registryAddress) {
      throw new OperatorContextError(
        `Relay ${context.relayUrl} /health returned no registryAddress.`,
        "Either the relay is misconfigured or the manifest endpoint changed shape."
      );
    }
  }

  return {
    contextName: name,
    context,
    target,
    ethRpcUrl,
    substrateWsUrl,
    relayUrl: context.relayUrl,
    operatorId: context.operatorId,
    relayHealth,
    registryAddress: relayHealth.registryAddress
  };
}

async function readContextStoreForOperatorScripts(): Promise<SwitchboardContextStore> {
  const filePath = contextStorePath();
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const store = parsed as SwitchboardContextStore;
    return {
      current: typeof store.current === "string" ? store.current : undefined,
      contexts: store.contexts && typeof store.contexts === "object" && !Array.isArray(store.contexts) ? store.contexts : {}
    };
  } catch {
    return {};
  }
}

async function fetchRelayHealth(relayUrl: string, timeoutMs: number): Promise<RelayHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL("/health", relayUrl), { signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      throw new OperatorContextError(`Relay ${relayUrl}/health failed (${response.status}): ${body.slice(0, 200)}`);
    }
    const parsed = JSON.parse(body) as RelayHealth;
    if (!parsed.chainId) {
      throw new OperatorContextError(`Relay ${relayUrl}/health missing chainId field`);
    }
    return parsed;
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new OperatorContextError(`Relay ${relayUrl}/health timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the env-var-pointer fields on the context. Returns undefined for
 * unconfigured pointers; throws if the pointer is configured but the env is empty.
 */
export function resolvePointerEnv(envName: string | undefined, label: string): string | undefined {
  if (!envName) return undefined;
  const value = process.env[envName];
  if (!value) {
    throw new OperatorContextError(
      `Context references ${label} via env "${envName}" but that env is unset.`,
      `Set ${envName} or update the context to point at a different env.`
    );
  }
  return value;
}
