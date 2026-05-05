import type { RelayDeploymentSpec } from "../../../src/relay-deployment-spec.js";

/**
 * Build the env for direct Acurast helper calls (inspect,
 * status, etc). The harness reads ACURAST_MAINNET_SEED /
 * ACURAST_SEED — which most operators don't have in their shell because
 * they source PROOF_ACURAST_MAINNET_DEPLOYER_SEED instead. This helper
 * bridges the two so wrapped lifecycle commands work uniformly without
 * relying on stale shell state.
 *
 * Also sets ACURAST_NETWORK / PROJECT_NAME / STAGE_DIR from the spec
 * so a passing-through deploy or inspect doesn't pick up some other
 * project's stage dir if that's set in env.
 */
export function buildAcurastCliEnv(spec: RelayDeploymentSpec, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (spec.target !== "acurast" || !spec.acurast) {
    throw new Error("buildAcurastCliEnv requires spec.target=acurast");
  }
  const acurast = spec.acurast;
  const seed = baseEnv[acurast.deployerSeedEnv];
  if (!seed) {
    throw new Error(
      `Deployer seed env ${acurast.deployerSeedEnv} is not set in the calling shell — source your secrets file first`
    );
  }
  const network = acurast.network;
  const seedName = network === "canary" ? "ACURAST_CANARY_SEED" : "ACURAST_MAINNET_SEED";
  const addressName = network === "canary" ? "ACURAST_CANARY_ADDRESS" : "ACURAST_MAINNET_ADDRESS";

  return {
    ...baseEnv,
    [seedName]: seed,
    ...(acurast.deployerAddress ? { [addressName]: acurast.deployerAddress } : {}),
    ACURAST_NETWORK: network,
    ACURAST_PROJECT_NAME: acurast.projectName,
    ACURAST_STAGE_DIR: acurast.stageDir
  };
}
