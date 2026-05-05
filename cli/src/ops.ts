import {
  DEFAULT_BUILDER_INGRESS_DOMAIN_POOL,
  DEFAULT_SWITCHBOARD_OPS_PROFILE,
  DEFAULT_SWITCHBOARD_SERVICE_DOMAIN,
  SWITCHBOARD_OPS_PROFILE_ENV,
  defaultCloudflareZoneNamesForOpsServiceDomain,
  describeSwitchboardHome,
  initSwitchboardOpsProfile,
  loadSwitchboardOpsProfile,
  normalizeSwitchboardProfileName,
  relayRecorderAddressEnvName,
  resolveOpsServiceConfig,
  userFacingSwitchboardHomeHint,
  type SwitchboardOpsConfig
} from "./switchboard-home.js";

export interface OpsSubcommandArgs {
  flags: Map<string, string | boolean>;
  positionals: string[];
  env?: NodeJS.ProcessEnv;
  io?: {
    log: (line: string) => void;
    warn: (line: string) => void;
    error: (line: string) => void;
  };
}

const DEFAULT_IO = {
  log: (line: string) => console.log(line),
  warn: (line: string) => console.warn(line),
  error: (line: string) => console.error(line)
};

export async function runOpsSubcommand(args: OpsSubcommandArgs): Promise<void> {
  const io = args.io ?? DEFAULT_IO;
  const env = args.env ?? process.env;
  const verb = args.positionals[1] ?? "show";
  if (verb === "help") {
    printOpsUsage(io);
    return;
  }

  const profile = profileFromArgs(args.flags, args.positionals, env);

  if (verb === "paths") {
    const paths = describeSwitchboardHome(env, stringFlag(args.flags, "context"), profile);
    io.log(`Switchboard home paths (${profile})`);
    io.log(`  home              : ${paths.home}`);
    io.log(`  contexts          : ${paths.contexts}`);
    io.log(`  builder secrets   : ${paths.builderSecretFile}`);
    io.log(`  ops config        : ${paths.opsConfigFile}`);
    io.log(`  ops secrets       : ${paths.opsSecretFile}`);
    io.log(`  note              : ${userFacingSwitchboardHomeHint()}`);
    return;
  }

  if (verb === "init") {
    const config = configOverridesFromFlags(args.flags, profile);
    const result = await initSwitchboardOpsProfile({
      profile,
      env,
      config,
      overwrite: boolFlag(args.flags, "force") || boolFlag(args.flags, "overwrite")
    });
    io.log(`Switchboard ops profile ${profile}`);
    io.log(`  config  : ${result.configPath}${result.wroteConfig ? " (written)" : " (exists)"}`);
    io.log(`  secrets : ${result.secretsPath}${result.wroteSecrets ? " (written)" : " (exists)"}`);
    io.log(`  target  : ${result.config.target}`);
    io.log(`  control : ${result.config.controlPlaneUrl}`);
    io.log(`  domain  : ${resolveOpsServiceConfig(result.config.services).domain}`);
    return;
  }

  if (verb === "show" || verb === "current") {
    const loaded = await loadSwitchboardOpsProfile({ profile, env });
    const config = loaded.config ?? defaultMissingConfig(profile);
    io.log(`Switchboard ops profile ${profile}`);
    io.log(`  config        : ${loaded.configPath}${loaded.config ? "" : " (missing)"}`);
    io.log(`  secrets       : ${loaded.secretsPath}${loaded.loadedEnv.missing ? " (missing)" : ""}`);
    io.log(`  secrets loaded: ${loaded.loadedEnv.loaded.length}`);
    printOpsConfigSummary(io, config, Boolean(loaded.config));
    return;
  }

  if (verb === "env") {
    const loaded = await loadSwitchboardOpsProfile({ profile, env });
    if (!loaded.config) {
      throw new Error(`Ops config missing at ${loaded.configPath}. Run \`switchboard ops init ${profile}\` first.`);
    }
    printOpsEnv(io, loaded.config);
    return;
  }

  throw new Error(`Unknown ops command: switchboard ops ${verb}`);
}

export function printOpsUsage(io = DEFAULT_IO): void {
  io.log(`switchboard ops

Manage local Switchboard operator/PROOF ops config under ~/.switchboard.

Commands:
  ops init [profile] [--domain switchboard.proof.computer]
      Create ~/.switchboard/ops/<profile>/config.json and secrets.env.
  ops show [profile]
      Load and summarize the ops profile. Secret values are never printed.
  ops paths [profile] [--context <name>]
      Print context, builder-secret, ops-config, and ops-secret paths.
  ops env [profile]
      Print non-secret env values derived from the ops config.

Flags:
  --profile <name>       Default ${DEFAULT_SWITCHBOARD_OPS_PROFILE}; also ${SWITCHBOARD_OPS_PROFILE_ENV}
  --domain <name>        Default ${DEFAULT_SWITCHBOARD_SERVICE_DOMAIN}
  --bootstrap-host <h>   Optional SSH target for bootstrap host commands
  --target <name>        Default polkadot-hub
  --force                Overwrite existing files during init
`);
}

function profileFromArgs(flags: Map<string, string | boolean>, positionals: string[], env: NodeJS.ProcessEnv): string {
  const raw =
    stringFlag(flags, "profile") ??
    positionals[2] ??
    env[SWITCHBOARD_OPS_PROFILE_ENV] ??
    DEFAULT_SWITCHBOARD_OPS_PROFILE;
  return normalizeSwitchboardProfileName(raw);
}

function configOverridesFromFlags(flags: Map<string, string | boolean>, profile: string): Partial<SwitchboardOpsConfig> {
  const domain = stringFlag(flags, "domain") ?? DEFAULT_SWITCHBOARD_SERVICE_DOMAIN;
  const controlHostname = stringFlag(flags, "control-hostname");
  const gatewayHostname = stringFlag(flags, "gateway-hostname");
  const acmeDelegationHostname = stringFlag(flags, "acme-hostname") ?? stringFlag(flags, "acme-delegation-hostname");
  const relayHostnamePattern = stringFlag(flags, "relay-hostname-pattern");
  const target = stringFlag(flags, "target");
  const bootstrapHost = stringFlag(flags, "bootstrap-host");
  const bootstrapRemoteDir = stringFlag(flags, "bootstrap-remote-dir");
  const overrides: Partial<SwitchboardOpsConfig> = {
    profile,
    ...(target ? { target } : {}),
    services: {
      domain,
      ...(controlHostname ? { controlHostname } : {}),
      ...(gatewayHostname ? { gatewayHostname } : {}),
      ...(acmeDelegationHostname ? { acmeDelegationHostname } : {}),
      ...(relayHostnamePattern ? { relayHostnamePattern } : {})
    },
    bootstrap: {
      ...(bootstrapHost ? { host: bootstrapHost } : {}),
      ...(bootstrapRemoteDir ? { remoteDir: bootstrapRemoteDir } : {})
    }
  };
  return overrides;
}

function printOpsConfigSummary(
  io: { log: (line: string) => void },
  config: SwitchboardOpsConfig,
  exists: boolean
): void {
  const services = resolveOpsServiceConfig(config.services);
  io.log(`  state         : ${exists ? "configured" : "not initialized"}`);
  io.log(`  target        : ${config.target}`);
  io.log(`  chainId       : ${config.chainId ?? "(unset)"}`);
  io.log(`  ethRpc        : ${config.hubEthRpcUrl ?? "(unset)"}`);
  io.log(`  registry      : ${config.registryAddress ?? "(unset)"}`);
  io.log(`  control       : ${config.controlPlaneUrl ?? `https://${services.controlHostname}`}`);
  io.log(`  domain        : ${services.domain}`);
  io.log(`  relay pattern : ${services.relayHostnamePattern}`);
  io.log(`  gateway cname : ${services.gatewayHostname}`);
  io.log(`  acme suffix   : ${services.acmeDelegationHostname}`);
  io.log(`  bootstrap     : ${config.bootstrap?.host ?? "(unset)"}`);
}

function printOpsEnv(io: { log: (line: string) => void }, config: SwitchboardOpsConfig): void {
  const services = resolveOpsServiceConfig(config.services);
  const lines: Record<string, string | undefined> = {
    SWITCHBOARD_OPS_PROFILE: config.profile,
    SWITCHBOARD_SERVICE_DOMAIN: services.domain,
    SWITCHBOARD_CONTROL_HOSTNAME: services.controlHostname,
    SWITCHBOARD_GATEWAY_HOSTNAME: services.gatewayHostname,
    SWITCHBOARD_ACME_DELEGATION_HOSTNAME: services.acmeDelegationHostname,
    SWITCHBOARD_RELAY_HOSTNAME_PATTERN: services.relayHostnamePattern,
    CLOUDFLARE_ZONE_NAMES: defaultCloudflareZoneNamesForOpsServiceDomain(services.domain),
    SWITCHBOARD_DOMAIN_POOL: DEFAULT_BUILDER_INGRESS_DOMAIN_POOL,
    SWITCHBOARD_TARGET: config.target,
    PROOF_NETWORK_MANIFEST_URL: config.manifestUrl,
    PROOF_NETWORK_MANIFEST_SIGNER: config.manifestSigner,
    PROOF_CONTROL_PLANE_URL: config.controlPlaneUrl,
    RELAY_URL: config.controlPlaneUrl,
    CHAIN_ID: config.chainId,
    HUB_ETH_RPC_URL: config.hubEthRpcUrl,
    HUB_SUBSTRATE_WS_URL: config.hubSubstrateWsUrl,
    INGRESS_REGISTRY_ADDRESS: config.registryAddress,
    PROOF_EXPLORER_REGISTRY_ADDRESS: config.registryAddress,
    PROOF_RECORDER_COORDINATOR_ADDRESS: config.recorderCoordinatorAddress,
    QUOTE_SIGNER_ADDRESS: config.quoteSignerAddress,
    PROOF_QUOTE_SETUP_FEE: config.quoteSetupFee,
    PROOF_QUOTE_VALIDATION_FEE_CAP: config.quoteValidationFeeCap,
    PROOF_MAINNET_OPERATOR_RECIPIENT: config.operatorRecipient,
    PROOF_MAINNET_VALIDATOR_RECIPIENT: config.validatorRecipient,
    PROOF_MAINNET_TREASURY_RECIPIENT: config.treasuryRecipient,
    PROOF_VALIDATION_ALLOWED_SIGNERS: config.validationAllowedSigners,
    PROOF_OPERATOR_CAPABILITY_ALLOWED_SIGNERS: config.operatorCapabilityAllowedSigners,
    OPERATOR_ID: config.operatorId,
    OPERATOR_MANAGER_IDS: config.operatorManagerIds,
    ACURAST_NETWORK: config.acurastNetwork,
    ACURAST_RPC: config.acurastRpc,
    ACURAST_RPC_NODE: config.acurastRpc,
    PROOF_EXPLORER_ACURAST_RPC_URL: config.acurastRpc,
    PROOF_CUSTOMER_HOSTNAME_ACME_DNS01_DELEGATION_SUFFIX: services.acmeDelegationHostname
  };
  for (const [relayId, address] of Object.entries(config.relayRecorderAddresses ?? {})) {
    lines[relayRecorderAddressEnvName(relayId)] = address;
  }
  for (const [key, value] of Object.entries(lines)) {
    if (value && value.length > 0) {
      io.log(`${key}=${value}`);
    }
  }
}

function defaultMissingConfig(profile: string): SwitchboardOpsConfig {
  return {
    version: 1,
    profile,
    target: "polkadot-hub",
    services: {
      domain: DEFAULT_SWITCHBOARD_SERVICE_DOMAIN
    }
  };
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
