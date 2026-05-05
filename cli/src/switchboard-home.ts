import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseDotenv } from "dotenv";

import { getSwitchboardTarget } from "../../src/chains.js";
import { inferCloudflareZoneName } from "../../src/cloudflare-dns.js";
import { CANONICAL_CONSUMER_INGRESS_DOMAIN_POOL_CSV } from "../../src/domain-pool.js";
import {
  contextStorePath,
  switchboardHome,
  SWITCHBOARD_HOME_ENV
} from "./switchboard-paths.js";

export const SWITCHBOARD_OPS_PROFILE_ENV = "SWITCHBOARD_OPS_PROFILE";
export const SWITCHBOARD_CONTEXT_SECRET_FILE_ENV = "SWITCHBOARD_CONTEXT_SECRET_FILE";
export const SWITCHBOARD_OPS_CONFIG_FILE_ENV = "SWITCHBOARD_OPS_CONFIG_FILE";
export const SWITCHBOARD_OPS_SECRET_FILE_ENV = "SWITCHBOARD_OPS_SECRET_FILE";
export const DEFAULT_SWITCHBOARD_SERVICE_DOMAIN = "switchboard.proof.computer";
export const DEFAULT_BUILDER_INGRESS_DOMAIN_POOL = CANONICAL_CONSUMER_INGRESS_DOMAIN_POOL_CSV;
export const DEFAULT_SWITCHBOARD_OPS_PROFILE = "mainnet";

export interface SwitchboardOpsServiceConfig {
  domain?: string;
  controlHostname?: string;
  gatewayHostname?: string;
  acmeDelegationHostname?: string;
  relayHostnamePattern?: string;
  logBaseUrl?: string;
  secretsBaseUrl?: string;
}

export interface SwitchboardOpsBootstrapConfig {
  host?: string;
  remoteDir?: string;
}

export interface SwitchboardOpsConfig {
  version: 1;
  profile: string;
  target: string;
  manifestUrl?: string;
  manifestSigner?: string;
  controlPlaneUrl?: string;
  chainId?: string;
  hubEthRpcUrl?: string;
  hubSubstrateWsUrl?: string;
  registryAddress?: string;
  recorderCoordinatorAddress?: string;
  defaultAssetAddress?: string;
  quoteSignerAddress?: string;
  quoteSetupFee?: string;
  quoteValidationFeeCap?: string;
  operatorId?: string;
  operatorManagerIds?: string;
  operatorRecipient?: string;
  validatorRecipient?: string;
  treasuryRecipient?: string;
  validationAllowedSigners?: string;
  operatorCapabilityAllowedSigners?: string;
  relayRecorderAddresses?: Record<string, string>;
  acurastNetwork?: "mainnet" | "canary";
  acurastRpc?: string;
  services?: SwitchboardOpsServiceConfig;
  bootstrap?: SwitchboardOpsBootstrapConfig;
}

export interface LoadEnvFileResult {
  path: string;
  loaded: string[];
  skipped: string[];
  missing: boolean;
}

export interface SwitchboardHomePaths {
  home: string;
  contexts: string;
  builderSecretsDir: string;
  builderSecretFile: string;
  opsDir: string;
  opsConfigFile: string;
  opsSecretFile: string;
}

export interface LoadSwitchboardOpsProfileResult {
  profile: string;
  configPath: string;
  secretsPath: string;
  config?: SwitchboardOpsConfig;
  loadedEnv: LoadEnvFileResult;
}

export function normalizeSwitchboardProfileName(value: string | undefined): string {
  const profile = (value ?? DEFAULT_SWITCHBOARD_OPS_PROFILE).trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profile)) {
    throw new Error(`Invalid Switchboard ops profile "${profile}". Use lowercase letters, digits, and hyphens.`);
  }
  return profile;
}

export function switchboardHomePaths(options: {
  contextName?: string;
  opsProfile?: string;
  env?: NodeJS.ProcessEnv;
} = {}): SwitchboardHomePaths {
  const env = options.env ?? process.env;
  const home = switchboardHome(env);
  const opsProfile = normalizeSwitchboardProfileName(options.opsProfile ?? env[SWITCHBOARD_OPS_PROFILE_ENV]);
  const contextName = options.contextName && options.contextName.length > 0 ? options.contextName : "default";
  return {
    home,
    contexts: contextStorePath(env),
    builderSecretsDir: path.join(home, "secrets"),
    builderSecretFile: path.join(home, "secrets", `${contextName}.env`),
    opsDir: path.join(home, "ops", opsProfile),
    opsConfigFile: env[SWITCHBOARD_OPS_CONFIG_FILE_ENV] ?? path.join(home, "ops", opsProfile, "config.json"),
    opsSecretFile: env[SWITCHBOARD_OPS_SECRET_FILE_ENV] ?? path.join(home, "ops", opsProfile, "secrets.env")
  };
}

export async function loadEnvFileIntoProcess(
  filePath: string,
  options: { override?: boolean; env?: NodeJS.ProcessEnv; allowKey?: (key: string) => boolean } = {}
): Promise<LoadEnvFileResult> {
  const env = options.env ?? process.env;
  if (!existsSync(filePath)) {
    return { path: filePath, loaded: [], skipped: [], missing: true };
  }
  const parsed = parseDotenv(await readFile(filePath, "utf8"));
  const loaded: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (options.allowKey && !options.allowKey(key)) {
      skipped.push(key);
      continue;
    }
    if (!options.override && env[key] !== undefined && env[key] !== "") {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    loaded.push(key);
  }
  return { path: filePath, loaded, skipped, missing: false };
}

export async function loadContextSecretFile(
  contextName: string | undefined,
  options: { env?: NodeJS.ProcessEnv; override?: boolean } = {}
): Promise<LoadEnvFileResult | undefined> {
  if (!contextName) return undefined;
  const env = options.env ?? process.env;
  const explicit = env[SWITCHBOARD_CONTEXT_SECRET_FILE_ENV];
  const filePath = explicit ?? switchboardHomePaths({ contextName, env }).builderSecretFile;
  return loadEnvFileIntoProcess(filePath, { env, override: options.override, allowKey: isBuilderContextSecretEnvAllowed });
}

export function isBuilderContextSecretEnvAllowed(name: string): boolean {
  const normalized = name.toUpperCase();
  if (
    normalized === "PROOF_CONTROL_PLANE_TOKEN" ||
    normalized === "SWITCHBOARD_CONTROL_TOKEN" ||
    normalized === "PROOF_VALIDATION_READ_TOKEN" ||
    normalized === "PROOF_LOG_CREATE_TOKEN" ||
    normalized === "PROOF_OPERATOR_CAPABILITY_TOKEN" ||
    normalized === "GATEWAY_AGENT_ROUTE_INTENT_TOKEN" ||
    normalized === "RELAYER_PRIVATE_KEY" ||
    normalized === "PROOF_NETWORK_MANIFEST_SIGNING_KEY" ||
    normalized === "PROOF_SERVICE_CATALOG_SIGNING_KEY" ||
    normalized === "PROOF_QUOTE_ENDPOINT_ID_SECRET" ||
    normalized === "PROOF_MAINNET_QUOTE_SIGNER_PRIVATE_KEY" ||
    normalized.startsWith("ACME_EAB_")
  ) {
    return false;
  }
  return true;
}

export async function readSwitchboardOpsConfig(
  profile: string = DEFAULT_SWITCHBOARD_OPS_PROFILE,
  env: NodeJS.ProcessEnv = process.env
): Promise<SwitchboardOpsConfig | undefined> {
  const normalizedProfile = normalizeSwitchboardProfileName(profile);
  const filePath = switchboardHomePaths({ opsProfile: normalizedProfile, env }).opsConfigFile;
  if (!existsSync(filePath)) return undefined;
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as SwitchboardOpsConfig;
  validateSwitchboardOpsConfig(parsed, filePath);
  if (parsed.profile !== normalizedProfile) {
    throw new Error(`${filePath}: profile must be "${normalizedProfile}"`);
  }
  return parsed;
}

export async function loadSwitchboardOpsProfile(options: {
  profile?: string;
  env?: NodeJS.ProcessEnv;
  overrideConfigEnv?: boolean;
  overrideSecretsEnv?: boolean;
  overrideEnv?: boolean;
} = {}): Promise<LoadSwitchboardOpsProfileResult> {
  const env = options.env ?? process.env;
  const profile = normalizeSwitchboardProfileName(options.profile ?? env[SWITCHBOARD_OPS_PROFILE_ENV]);
  const paths = switchboardHomePaths({ opsProfile: profile, env });
  const config = await readSwitchboardOpsConfig(profile, env);
  if (config) {
    applyOpsConfigToEnv(config, env, { override: options.overrideConfigEnv ?? options.overrideEnv ?? false });
  }
  const loadedEnv = await loadEnvFileIntoProcess(paths.opsSecretFile, {
    env,
    override: options.overrideSecretsEnv ?? options.overrideEnv
  });
  return {
    profile,
    configPath: paths.opsConfigFile,
    secretsPath: paths.opsSecretFile,
    config,
    loadedEnv
  };
}

export function applyOpsConfigToEnv(
  config: SwitchboardOpsConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: { override?: boolean } = {}
): void {
  const put = (key: string, value: string | undefined): void => {
    if (!value || value.length === 0) return;
    if (!options.override && env[key] !== undefined) return;
    env[key] = value;
  };

  put("SWITCHBOARD_OPS_PROFILE", config.profile);
  put("SWITCHBOARD_TARGET", config.target);
  put("PROOF_NETWORK_MANIFEST_URL", config.manifestUrl);
  put("PROOF_NETWORK_MANIFEST_SIGNER", config.manifestSigner);
  put("PROOF_CONTROL_PLANE_URL", config.controlPlaneUrl);
  put("RELAY_URL", config.controlPlaneUrl);
  put("CHAIN_ID", config.chainId);
  put("HUB_CHAIN_ID", config.chainId);
  put("HUB_ETH_RPC_URL", config.hubEthRpcUrl);
  put("POLKADOT_HUB_RPC_URL", config.hubEthRpcUrl);
  put("HUB_SUBSTRATE_WS_URL", config.hubSubstrateWsUrl);
  put("INGRESS_REGISTRY_ADDRESS", config.registryAddress);
  put("PROOF_EXPLORER_REGISTRY_ADDRESS", config.registryAddress);
  put("PROOF_RECORDER_COORDINATOR_ADDRESS", config.recorderCoordinatorAddress);
  put("RECORDER_COORDINATOR_ADDRESS", config.recorderCoordinatorAddress);
  put("PROOF_QUOTE_DEFAULT_ASSET", config.defaultAssetAddress);
  put("PAYMENT_ASSET_ADDRESS", config.defaultAssetAddress);
  put("ACCEPTED_ASSET_ADDRESSES", config.defaultAssetAddress);
  put("QUOTE_SIGNER_ADDRESS", config.quoteSignerAddress);
  put("PROOF_QUOTE_SETUP_FEE", config.quoteSetupFee);
  put("PROOF_QUOTE_VALIDATION_FEE_CAP", config.quoteValidationFeeCap);
  put("OPERATOR_ID", config.operatorId);
  put("PROOF_OPERATOR_ID", config.operatorId);
  put("OPERATOR_MANAGER_IDS", config.operatorManagerIds);
  put("PROOF_MAINNET_OPERATOR_RECIPIENT", config.operatorRecipient);
  put("PROOF_MAINNET_VALIDATOR_RECIPIENT", config.validatorRecipient);
  put("PROOF_MAINNET_TREASURY_RECIPIENT", config.treasuryRecipient);
  put("PROOF_VALIDATION_ALLOWED_SIGNERS", config.validationAllowedSigners);
  put("PROOF_OPERATOR_CAPABILITY_ALLOWED_SIGNERS", config.operatorCapabilityAllowedSigners);
  put("ACURAST_NETWORK", config.acurastNetwork);
  put("ACURAST_RPC", config.acurastRpc);
  put("ACURAST_RPC_NODE", config.acurastRpc);
  put("PROOF_EXPLORER_ACURAST_RPC_URL", config.acurastRpc);
  for (const [relayId, address] of Object.entries(config.relayRecorderAddresses ?? {})) {
    put(relayRecorderAddressEnvName(relayId), address);
  }

  const services = resolveOpsServiceConfig(config.services);
  put("SWITCHBOARD_SERVICE_DOMAIN", services.domain);
  put("SWITCHBOARD_CONTROL_HOSTNAME", services.controlHostname);
  put("SWITCHBOARD_GATEWAY_HOSTNAME", services.gatewayHostname);
  put("SWITCHBOARD_ACME_DELEGATION_HOSTNAME", services.acmeDelegationHostname);
  put("SWITCHBOARD_RELAY_HOSTNAME_PATTERN", services.relayHostnamePattern);
  put("CLOUDFLARE_ZONE_NAMES", defaultCloudflareZoneNamesForOpsServiceDomain(services.domain));
  put("SWITCHBOARD_DOMAIN_POOL", DEFAULT_BUILDER_INGRESS_DOMAIN_POOL);
  put("PROOF_CUSTOMER_HOSTNAME_ACME_DNS01_DELEGATION_SUFFIX", services.acmeDelegationHostname);
  put("PROOF_LOG_BASE_URL", services.logBaseUrl);
  put("PROOF_SECRETS_BASE_URL", services.secretsBaseUrl);

  put("SWITCHBOARD_BOOTSTRAP_HOST", config.bootstrap?.host);
  put("SWITCHBOARD_BOOTSTRAP_REMOTE_DIR", config.bootstrap?.remoteDir);
}

export function resolveOpsServiceConfig(
  input: SwitchboardOpsServiceConfig | undefined = {}
): Required<SwitchboardOpsServiceConfig> {
  const domain = normalizeHostname(input.domain ?? DEFAULT_SWITCHBOARD_SERVICE_DOMAIN);
  return {
    domain,
    controlHostname: normalizeHostname(input.controlHostname ?? `control.${domain}`),
    gatewayHostname: normalizeHostname(input.gatewayHostname ?? `gateway.${domain}`),
    acmeDelegationHostname: normalizeHostname(input.acmeDelegationHostname ?? `acme.${domain}`),
    relayHostnamePattern: input.relayHostnamePattern ?? `\${relayId}.${domain}`,
    logBaseUrl: input.logBaseUrl ?? `https://logging.${domain}`,
    secretsBaseUrl: input.secretsBaseUrl ?? `https://secrets.${domain}`
  };
}

export function defaultCloudflareZoneNamesForOpsServiceDomain(serviceDomain: string): string {
  const serviceZoneName = inferCloudflareZoneName(serviceDomain);
  return [...new Set([serviceZoneName, DEFAULT_BUILDER_INGRESS_DOMAIN_POOL])].join(",");
}

export function relayHostnameFromPattern(relayId: string, pattern?: string): string {
  const services = resolveOpsServiceConfig({ relayHostnamePattern: pattern });
  return normalizeHostname(services.relayHostnamePattern.replace(/\$\{relayId\}/g, relayId));
}

export function defaultSwitchboardOpsConfig(profile = DEFAULT_SWITCHBOARD_OPS_PROFILE): SwitchboardOpsConfig {
  const target = getSwitchboardTarget("polkadot-hub");
  const services = resolveOpsServiceConfig();
  return {
    version: 1,
    profile,
    target: target.name,
    manifestUrl: `https://${services.controlHostname}/v1/network-manifest`,
    controlPlaneUrl: `https://${services.controlHostname}`,
    chainId: target.expectedChainId?.toString(),
    hubEthRpcUrl: target.defaultEthRpcUrl,
    hubSubstrateWsUrl: target.defaultSubstrateWsUrl,
    defaultAssetAddress: target.assets[0]?.contractAddress,
    acurastNetwork: "mainnet",
    services: {
      domain: services.domain,
      controlHostname: services.controlHostname,
      gatewayHostname: services.gatewayHostname,
      acmeDelegationHostname: services.acmeDelegationHostname,
      relayHostnamePattern: services.relayHostnamePattern,
      logBaseUrl: services.logBaseUrl,
      secretsBaseUrl: services.secretsBaseUrl
    }
  };
}

export async function initSwitchboardOpsProfile(options: {
  profile?: string;
  env?: NodeJS.ProcessEnv;
  config?: Partial<SwitchboardOpsConfig>;
  overwrite?: boolean;
} = {}): Promise<{ configPath: string; secretsPath: string; config: SwitchboardOpsConfig; wroteConfig: boolean; wroteSecrets: boolean }> {
  const env = options.env ?? process.env;
  const profile = normalizeSwitchboardProfileName(options.profile ?? env[SWITCHBOARD_OPS_PROFILE_ENV]);
  const paths = switchboardHomePaths({ opsProfile: profile, env });
  const base = defaultSwitchboardOpsConfig(profile);
  const config = { ...mergeOpsConfig(base, options.config ?? {}), profile };
  validateSwitchboardOpsConfig(config, paths.opsConfigFile);
  await mkdir(paths.opsDir, { recursive: true });

  let wroteConfig = false;
  if (options.overwrite || !existsSync(paths.opsConfigFile)) {
    await writeFile(paths.opsConfigFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    wroteConfig = true;
  }

  let wroteSecrets = false;
  if (options.overwrite || !existsSync(paths.opsSecretFile)) {
    await writeFile(paths.opsSecretFile, defaultOpsSecretsTemplate(), { mode: 0o600 });
    wroteSecrets = true;
  }

  return { configPath: paths.opsConfigFile, secretsPath: paths.opsSecretFile, config, wroteConfig, wroteSecrets };
}

function mergeOpsConfig(base: SwitchboardOpsConfig, overrides: Partial<SwitchboardOpsConfig>): SwitchboardOpsConfig {
  return {
    ...base,
    ...overrides,
    services: {
      ...(base.services ?? {}),
      ...(overrides.services ?? {})
    },
    bootstrap: {
      ...(base.bootstrap ?? {}),
      ...(overrides.bootstrap ?? {})
    }
  };
}

function validateSwitchboardOpsConfig(config: SwitchboardOpsConfig, filePath: string): void {
  if (config.version !== 1) {
    throw new Error(`${filePath}: expected version=1`);
  }
  normalizeSwitchboardProfileName(config.profile);
  getSwitchboardTarget(config.target);
  if (config.chainId && !/^[0-9]+$/.test(config.chainId)) {
    throw new Error(`${filePath}: chainId must be decimal`);
  }
  if (config.controlPlaneUrl) new URL(config.controlPlaneUrl);
  if (config.manifestUrl) new URL(config.manifestUrl);
  if (config.hubEthRpcUrl) new URL(config.hubEthRpcUrl);
  if (config.hubSubstrateWsUrl) new URL(config.hubSubstrateWsUrl);
  for (const [key, value] of [
    ["quoteSetupFee", config.quoteSetupFee],
    ["quoteValidationFeeCap", config.quoteValidationFeeCap]
  ]) {
    if (value && !/^[0-9]+$/.test(value)) {
      throw new Error(`${filePath}: ${key} must be decimal`);
    }
  }
  if (config.relayRecorderAddresses) {
    for (const [relayId, address] of Object.entries(config.relayRecorderAddresses)) {
      if (!relayId.trim() || !address.trim()) {
        throw new Error(`${filePath}: relayRecorderAddresses entries must have non-empty relay IDs and addresses`);
      }
    }
  }
  resolveOpsServiceConfig(config.services);
}

export function relayRecorderAddressEnvName(relayId: string): string {
  const token = relayId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!token) {
    throw new Error("relay recorder ID is required");
  }
  const normalized = token.startsWith("RELAY_") ? token : `RELAY_${token}`;
  return `PROOF_${normalized}_RECORDER_ADDRESS`;
}

function normalizeHostname(value: string): string {
  const hostname = value.trim().replace(/\.$/, "").toLowerCase();
  if (!/^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/.test(hostname)) {
    throw new Error(`Invalid hostname "${value}"`);
  }
  return hostname;
}

function defaultOpsSecretsTemplate(): string {
  return [
    "# Switchboard ops secrets. chmod 0600. Do not commit.",
    "# Fill only the values needed by the command you are running.",
    "",
    "PROOF_MAINNET_QUOTE_SIGNER_PRIVATE_KEY=",
    "PROOF_MAINNET_QUOTE_ENDPOINT_ID_SECRET=",
    "PROOF_MAINNET_MANIFEST_SIGNING_KEY=",
    "PROOF_SERVICE_CATALOG_SIGNING_KEY=",
    "PROOF_CONTROL_PLANE_TOKEN=",
    "PROOF_VALIDATION_READ_TOKEN=",
    "PROOF_LOG_CREATE_TOKEN=",
    "CLOUDFLARE_API_TOKEN=",
    "ACME_EMAIL=",
    "PROOF_ACURAST_MAINNET_DEPLOYER_SEED=",
    "PROOF_MAINNET_RELAY_A_RECORDER_PRIVATE_KEY=",
    "PROOF_MAINNET_RELAY_B_RECORDER_PRIVATE_KEY=",
    "PROOF_MAINNET_RELAY_C_RECORDER_PRIVATE_KEY=",
    "PROOF_MAINNET_RELAY_D_RECORDER_PRIVATE_KEY=",
    "PROOF_MAINNET_OPERATOR_REPORT_SEED=",
    ""
  ].join("\n");
}

export function describeSwitchboardHome(env: NodeJS.ProcessEnv = process.env, contextName?: string, opsProfile?: string): SwitchboardHomePaths {
  return switchboardHomePaths({ contextName, opsProfile, env });
}

export function userFacingSwitchboardHomeHint(): string {
  return `${SWITCHBOARD_HOME_ENV} overrides ~/.switchboard; ops profile defaults to ${DEFAULT_SWITCHBOARD_OPS_PROFILE}.`;
}
