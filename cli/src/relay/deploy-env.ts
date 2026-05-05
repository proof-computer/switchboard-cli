import { discoverServices } from "../../../src/service-discovery.js";

/**
 * Thrown when env-provided values disagree with the live network manifest.
 * Distinct from manifest-unreachable / signature errors so callers can
 * fail-fast rather than fall through to "env-only" deploy config.
 */
export class AcurastDeployEnvConflictError extends Error {
  readonly conflicts: ReadonlyArray<string>;
  constructor(message: string, conflicts: string[]) {
    super(message);
    this.name = "AcurastDeployEnvConflictError";
    this.conflicts = conflicts;
  }
}

/**
 * Build the env block fed into `runAcurastDeploy`'s `sources.env`. The
 * managed-CLI principle: the signed network manifest is the canonical
 * source of truth for chain config (CHAIN_ID, HUB_ETH_RPC_URL,
 * INGRESS_REGISTRY_ADDRESS). The CLI loads operator secrets from the selected
 * `~/.switchboard/ops/<profile>/secrets.env`; public chain config is
 * auto-resolved from the manifest, so operators do not need to source
 * `docs/mainnet-public-env.fish`.
 *
 * Operator-provided env always wins. Manifest fills gaps. The
 * `PROOF_RECORDER_COORDINATOR_ADDRESS` mainnet default is hardcoded
 * as a final fallback because the manifest schema doesn't currently
 * include it.
 */
export interface SynthesizeAcurastDeployEnvOptions {
  /** Existing env (typically process.env). */
  baseEnv: NodeJS.ProcessEnv;
  /** Network manifest URL (e.g. https://control.switchboard.proof.computer/v1/network-manifest). */
  manifestUrl: string;
  /** Pinned signer for the manifest. Pass undefined with allowUnpinned to skip. */
  manifestSigner?: string;
  /** Hardcoded recorder-coordinator fallback for when env doesn't have one. */
  fallbackRecorderCoordinatorAddress?: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Skip the manifest fetch entirely (for tests / break-glass). */
  skipManifest?: boolean;
}

export async function synthesizeAcurastDeployEnv(
  options: SynthesizeAcurastDeployEnvOptions
): Promise<NodeJS.ProcessEnv> {
  const next: NodeJS.ProcessEnv = { ...options.baseEnv };

  if (!options.skipManifest) {
    const discovery = await discoverServices({
      manifestUrlCandidates: [options.manifestUrl],
      expectedManifestSigner: options.manifestSigner,
      allowUnpinnedManifestSigner: !options.manifestSigner,
      fetchImpl: options.fetchImpl
    });
    const manifest = discovery.manifest;
    const manifestChainId = manifest.chain?.chainId !== undefined ? String(manifest.chain.chainId) : undefined;
    const manifestRpcUrl = manifest.rpc?.eth?.[0];
    const manifestRegistryAddress = manifest.registries.active[0]?.address;

    // Detect conflicts between env-provided values and the signed manifest.
    // The classic shape: a stale `.envrc` from a testnet workflow leaks
    // testnet addresses into a mainnet deploy session, mostly silently.
    // Refuse the deploy with a precise diff so the operator either fixes
    // the env or unsets it to let the manifest win.
    const conflicts: string[] = [];
    if (manifestChainId && next.CHAIN_ID && next.CHAIN_ID !== manifestChainId) {
      conflicts.push(`CHAIN_ID=${next.CHAIN_ID} (env) vs ${manifestChainId} (manifest)`);
    }
    if (manifestRpcUrl && next.HUB_ETH_RPC_URL && next.HUB_ETH_RPC_URL !== manifestRpcUrl) {
      conflicts.push(`HUB_ETH_RPC_URL=${next.HUB_ETH_RPC_URL} (env) vs ${manifestRpcUrl} (manifest)`);
    }
    if (
      manifestRegistryAddress &&
      next.INGRESS_REGISTRY_ADDRESS &&
      next.INGRESS_REGISTRY_ADDRESS.toLowerCase() !== manifestRegistryAddress.toLowerCase()
    ) {
      conflicts.push(
        `INGRESS_REGISTRY_ADDRESS=${next.INGRESS_REGISTRY_ADDRESS} (env) vs ${manifestRegistryAddress} (manifest)`
      );
    }
    if (conflicts.length > 0) {
      throw new AcurastDeployEnvConflictError(
        `Refusing to deploy with env values that disagree with ${options.manifestUrl}:\n` +
          conflicts.map((line) => `  - ${line}`).join("\n") +
          "\nFix the conflicting env (likely leaked from .envrc / a previous testnet session), or " +
          "unset CHAIN_ID / HUB_ETH_RPC_URL / INGRESS_REGISTRY_ADDRESS to let the manifest win.",
        conflicts
      );
    }

    if (!next.CHAIN_ID && manifestChainId) {
      next.CHAIN_ID = manifestChainId;
    }
    if (!next.HUB_ETH_RPC_URL && manifestRpcUrl) {
      next.HUB_ETH_RPC_URL = manifestRpcUrl;
    }
    if (!next.INGRESS_REGISTRY_ADDRESS && manifestRegistryAddress) {
      next.INGRESS_REGISTRY_ADDRESS = manifestRegistryAddress;
    }
  }

  if (!next.PROOF_RECORDER_COORDINATOR_ADDRESS && options.fallbackRecorderCoordinatorAddress) {
    next.PROOF_RECORDER_COORDINATOR_ADDRESS = options.fallbackRecorderCoordinatorAddress;
  }

  return next;
}
