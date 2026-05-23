import {
  FORBIDDEN_ACURAST_ENV_NAMES,
  HIGH_AUTHORITY_ACURAST_ENV_NAMES,
  isForbiddenAcurastEnvName,
  isHighAuthorityAcurastEnvName,
  isQuoteAuthorityAcurastEnvName,
  type RelayDeploymentSpec
} from "../../../src/relay-deployment-spec.js";
import type { AcurastDeployContext } from "./acurast-target.js";
import { SWITCHBOARD_CODE_KEY_ENV } from "./encrypted-code.js";

export type SecretIntentCategory =
  | "publicBuildConfig"
  | "encryptedRuntimeEnv"
  | "localOnly"
  | "bootstrapAuthority"
  | "forbidden";

export interface SecretIntentItem {
  name: string;
  category: SecretIntentCategory;
  source: string;
  shipped: boolean;
  present?: boolean;
  note?: string;
}

export interface SecretIntentPlan {
  relayId: string;
  target: RelayDeploymentSpec["target"];
  authorityProfile: RelayDeploymentSpec["relay"]["authorityProfile"];
  quotesEnabled: boolean;
  items: SecretIntentItem[];
  forbiddenRootNames: string[];
  highAuthorityBootstrapNames: string[];
}

export function buildSpecSecretIntentPlan(
  spec: RelayDeploymentSpec,
  env: NodeJS.ProcessEnv = process.env
): SecretIntentPlan {
  const items: SecretIntentItem[] = [];
  for (const name of expectedBuildConfigNames(spec, env)) {
    items.push(classifiedItem(name, "publicBuildConfig", "__SWITCHBOARD_BUILD_CONFIG__", true, undefined));
  }

  addRuntimeEnvRef(items, "RELAYER_PRIVATE_KEY", spec.secrets.relayerPrivateKeyEnv, env, "secrets.relayerPrivateKeyEnv");
  addOptionalRuntimeEnvRef(items, "PROOF_VALIDATION_READ_TOKEN", spec.secrets.validationReadTokenEnv, env, "secrets.validationReadTokenEnv");
  if (spec.secrets.controlPlaneTokenEnv) {
    if (spec.relay.enableControlPlane) {
      addOptionalRuntimeEnvRef(items, "PROOF_CONTROL_PLANE_TOKEN", spec.secrets.controlPlaneTokenEnv, env, "secrets.controlPlaneTokenEnv");
    } else {
      items.push(classifiedItem(
        "PROOF_CONTROL_PLANE_TOKEN",
        "localOnly",
        "secrets.controlPlaneTokenEnv",
        false,
        envPresent(env, spec.secrets.controlPlaneTokenEnv),
        `<- ${spec.secrets.controlPlaneTokenEnv}; relay.enableControlPlane=false`
      ));
    }
  }
  addOptionalRuntimeEnvRef(items, "PROOF_LOG_CREATE_TOKEN", spec.secrets.logCreateTokenEnv, env, "secrets.logCreateTokenEnv");
  addOptionalRuntimeEnvRef(
    items,
    "SWITCHBOARD_LOG_ENCRYPTION_KEY",
    spec.secrets.logEncryptionKeyEnv,
    env,
    "secrets.logEncryptionKeyEnv"
  );

  for (const peer of spec.peers) {
    if (peer.readTokenEnv) {
      addRuntimeEnvRef(items, "PROOF_RELAY_PEERS_JSON", peer.readTokenEnv, env, `peers.${peer.relayId}.readTokenEnv`);
    }
  }

  if (spec.relay.autoRegister) {
    items.push({
      name: "JOB_SIGNER_PRIVATE_KEY",
      category: "encryptedRuntimeEnv",
      source: "generated per deploy",
      shipped: true,
      note: "generated after funding unless --session-id supplies an existing session"
    });
  }

  if (spec.acurast?.encryptedCode !== false) {
    items.push({
      name: SWITCHBOARD_CODE_KEY_ENV,
      category: "encryptedRuntimeEnv",
      source: "generated per deploy",
      shipped: true,
      note: "decrypts the IPFS-public relay bootstrap bundle at runtime"
    });
  }

  for (const name of spec.acurast?.includeEnv ?? []) {
    items.push(classifiedItem(name, categoryForShippedName(name, "encryptedRuntimeEnv"), "acurast.includeEnv", true, envPresent(env, name)));
  }

  if (spec.acurast?.deployerSeedEnv) {
    items.push({
      name: spec.acurast.deployerSeedEnv,
      category: "localOnly",
      source: "acurast.deployerSeedEnv",
      shipped: false,
      present: envPresent(env, spec.acurast.deployerSeedEnv),
      note: "used locally to submit Acurast extrinsics"
    });
  }

  return makePlan(spec, items);
}

export function buildAcurastSecretIntentPlan(
  spec: RelayDeploymentSpec,
  context: AcurastDeployContext,
  env: NodeJS.ProcessEnv = process.env
): SecretIntentPlan {
  const items: SecretIntentItem[] = [];
  for (const name of Object.keys(context.buildConfig).sort()) {
    items.push(classifiedItem(name, categoryForShippedName(name, "publicBuildConfig"), "__SWITCHBOARD_BUILD_CONFIG__", true, true));
  }

  for (const name of context.includeEnv.slice().sort()) {
    const source = Object.prototype.hasOwnProperty.call(context.runtimeEnv, name)
      ? "generated runtimeEnv"
      : "acurast.includeEnv";
    const present = Object.prototype.hasOwnProperty.call(context.runtimeEnv, name)
      ? true
      : envPresent(env, name);
    items.push(classifiedItem(name, categoryForShippedName(name, "encryptedRuntimeEnv"), source, true, present));
  }

  if (spec.acurast?.deployerSeedEnv) {
    items.push({
      name: spec.acurast.deployerSeedEnv,
      category: "localOnly",
      source: "acurast.deployerSeedEnv",
      shipped: false,
      present: envPresent(env, spec.acurast.deployerSeedEnv),
      note: "used locally to submit Acurast extrinsics"
    });
  }

  return makePlan(spec, items);
}

export function assertSecretIntentAllowed(plan: SecretIntentPlan): void {
  const forbiddenShipped = uniqueNames(
    plan.items.filter((item) => item.shipped && item.category === "forbidden").map((item) => item.name)
  );
  if (forbiddenShipped.length > 0) {
    throw new Error(
      `Refusing to deploy with forbidden root-authority env in the Acurast payload: ${forbiddenShipped.join(", ")}`
    );
  }

  if (plan.target === "acurast" && plan.authorityProfile === "durable-relay") {
    if (plan.quotesEnabled) {
      throw new Error(
        "Refusing to deploy durable Acurast relay with quotes enabled; quote signing must stay local or move to a dedicated quote service"
      );
    }

    const quoteRelated = uniqueNames(
      plan.items
        .filter((item) => item.shipped && item.name.toUpperCase() !== "PROOF_QUOTES_ENABLED" && isQuoteAuthorityAcurastEnvName(item.name))
        .map((item) => item.name)
    );
    if (quoteRelated.length > 0) {
      throw new Error(
        `Refusing to deploy durable Acurast relay with quote-related env in the payload: ${quoteRelated.join(", ")}`
      );
    }

    const highAuthority = uniqueNames(
      plan.items.filter((item) => item.shipped && item.category === "bootstrapAuthority").map((item) => item.name)
    );
    if (highAuthority.length > 0) {
      throw new Error(
        `Refusing to deploy durable Acurast relay with bootstrap authority env: ${highAuthority.join(", ")}`
      );
    }
  }
}

export function formatSecretIntentPlan(plan: SecretIntentPlan): string[] {
  const lines = [
    "secret intent plan:",
    `  authority profile : ${plan.authorityProfile}`,
    `  quotes enabled    : ${plan.quotesEnabled ? "yes" : "no"}`
  ];

  appendGroup(lines, "public build config (IPFS-public)", plan.items, "publicBuildConfig");
  appendGroup(lines, "encrypted runtime env", plan.items, "encryptedRuntimeEnv");
  appendGroup(lines, "local only", plan.items, "localOnly");
  appendGroup(lines, "bootstrap authority", plan.items, "bootstrapAuthority");
  appendGroup(lines, "forbidden in managed Acurast payload", plan.items, "forbidden");
  lines.push(`  forbidden roots  : ${plan.forbiddenRootNames.join(", ")}`);
  lines.push(`  bootstrap roots  : ${plan.highAuthorityBootstrapNames.join(", ")}`);
  return lines;
}

function makePlan(spec: RelayDeploymentSpec, items: SecretIntentItem[]): SecretIntentPlan {
  return {
    relayId: spec.relayId,
    target: spec.target,
    authorityProfile: spec.relay.authorityProfile,
    quotesEnabled: spec.relay.quotesEnabled,
    items: dedupeItems(items),
    forbiddenRootNames: [...FORBIDDEN_ACURAST_ENV_NAMES],
    highAuthorityBootstrapNames: [...HIGH_AUTHORITY_ACURAST_ENV_NAMES]
  };
}

function addRuntimeEnvRef(
  items: SecretIntentItem[],
  runtimeName: string,
  envName: string,
  env: NodeJS.ProcessEnv,
  source: string
): void {
  const category = categoryForShippedName(envName, categoryForShippedName(runtimeName, "encryptedRuntimeEnv"));
  items.push(classifiedItem(runtimeName, category, source, true, envPresent(env, envName), `<- ${envName}`));
}

function addOptionalRuntimeEnvRef(
  items: SecretIntentItem[],
  runtimeName: string,
  envName: string | undefined,
  env: NodeJS.ProcessEnv,
  source: string
): void {
  if (!envName) return;
  addRuntimeEnvRef(items, runtimeName, envName, env, source);
}

function classifiedItem(
  name: string,
  category: SecretIntentCategory,
  source: string,
  shipped: boolean,
  present: boolean | undefined,
  note?: string
): SecretIntentItem {
  return {
    name,
    category,
    source,
    shipped,
    present,
    note
  };
}

function categoryForShippedName(name: string, fallback: SecretIntentCategory): SecretIntentCategory {
  if (isForbiddenAcurastEnvName(name)) return "forbidden";
  if (isHighAuthorityAcurastEnvName(name)) return "bootstrapAuthority";
  return fallback;
}

function expectedBuildConfigNames(spec: RelayDeploymentSpec, env: NodeJS.ProcessEnv): string[] {
  const names = [
    "SWITCHBOARD_HOST",
    "PORT",
    "SWITCHBOARD_AUTO_REGISTER",
    "HUB_ETH_RPC_URL",
    "INGRESS_REGISTRY_ADDRESS",
    "CHAIN_ID",
    "PROOF_RELAY_ID",
    "PROOF_SETTLEMENT_RELAY_ID",
    "PROOF_AUTHORITY_LEASE_OWNER_ID",
    "PROOF_QUOTES_ENABLED",
    "PROOF_VALIDATION_REPORTS_ENABLED",
    "PROOF_VALIDATION_REPORT_STORE_KIND",
    "PROOF_RELAY_SQLITE_FILE",
    "PROOF_SQLITE_DRIVER",
    "PROOF_RELAY_PEER_BACKFILL_ENABLED",
    "PROOF_RELAY_PEER_BACKFILL_AUTOSTART",
    "PROOF_CONTROL_PLANE_ENABLED",
    "PROOF_RELAY_MONITORING_ENABLED",
    "PROOF_RELAY_RATE_LIMITS_ENABLED",
    "PROOF_RELAY_METRICS_PUBLIC"
  ];
  if (spec.relay.autoRegister) {
    names.push(
      "RELAY_URL",
      "ENDPOINT_HOSTNAME",
      "OPERATOR_ID",
      "PROCESSOR_ID",
      "SESSION_ID",
      "JOB_ID",
      "NONCE",
      "DEADLINE",
      "SWITCHBOARD_CERTIFICATE_MODE"
    );
    if (spec.relay.certificateMode === "job-acme") {
      names.push("SWITCHBOARD_CERTIFICATE_HOSTNAMES");
    }
  }
  if (spec.relay.enableLogs) {
    names.push("SWITCHBOARD_LOG_URL", "SWITCHBOARD_LOG_CONTEXT");
  }
  if (env.SWITCHBOARD_RELAY_STARTUP_DIAGNOSTICS === "true") {
    names.push("SWITCHBOARD_RELAY_STARTUP_DIAGNOSTICS");
  }
  if (env.SWITCHBOARD_LOG_LEVEL || env.LOG_LEVEL) {
    names.push("SWITCHBOARD_LOG_LEVEL");
  }
  return names;
}

function appendGroup(
  lines: string[],
  label: string,
  items: SecretIntentItem[],
  category: SecretIntentCategory
): void {
  const group = items.filter((item) => item.category === category);
  if (group.length === 0) {
    lines.push(`  ${label}: none`);
    return;
  }
  lines.push(`  ${label}:`);
  for (const item of group) {
    const presence = item.present === undefined ? "" : item.present ? " [set]" : " [missing]";
    const note = item.note ? ` (${item.note})` : "";
    lines.push(`    - ${item.name}${presence} -- ${item.source}${note}`);
  }
}

function dedupeItems(items: SecretIntentItem[]): SecretIntentItem[] {
  const seen = new Set<string>();
  const result: SecretIntentItem[] = [];
  for (const item of items) {
    const key = `${item.category}\0${item.name}\0${item.source}\0${item.note ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function uniqueNames(names: string[]): string[] {
  return Array.from(new Set(names)).sort();
}

function envPresent(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.length > 0;
}
