import { z } from "zod";

export const RELAY_DEPLOYMENT_SPEC_VERSION = 1;

// Env names that must never reach an Acurast IPFS-bound build config or
// upload artifact. The wrapper bundle and `__SWITCHBOARD_BUILD_CONFIG__`
// are public on IPFS; any value placed there is exposed.
//
// `prepare-acurast-relay-env.fish` historically lists some of these because
// the home-server bootstrap relay also acts as quote signer / manifest
// signer / catalog signer. A managed CLI deploy of an Acurast-hosted relay
// must keep root-authority keys out of the job entirely.
export const FORBIDDEN_ACURAST_ENV_NAMES = [
  "QUOTE_SIGNER_PRIVATE_KEY",
  "PROOF_MAINNET_QUOTE_SIGNER_PRIVATE_KEY",
  "PROOF_NETWORK_MANIFEST_SIGNING_KEY",
  "PROOF_MAINNET_MANIFEST_SIGNING_KEY",
  "PROOF_SERVICE_CATALOG_SIGNING_KEY",
  "PROOF_QUOTE_ENDPOINT_ID_SECRET",
  "PROOF_MAINNET_QUOTE_ENDPOINT_ID_SECRET"
] as const;

// These are not equivalent to quote/manifest/catalog roots, because provider
// tokens can be scoped and job-owned TLS still protects traffic content. They
// are still high-authority and must be explicit bootstrap-only in managed
// Acurast relay specs.
export const HIGH_AUTHORITY_ACURAST_ENV_NAMES = [
  "ACME_EAB_HMAC_KEY",
  "CLOUDFLARE_API_TOKEN",
  "PROOF_CONTROL_PLANE_TOKEN"
] as const;

const FORBIDDEN_SET = new Set<string>(FORBIDDEN_ACURAST_ENV_NAMES.map((name) => name.toUpperCase()));
const HIGH_AUTHORITY_SET = new Set<string>(HIGH_AUTHORITY_ACURAST_ENV_NAMES.map((name) => name.toUpperCase()));

const envNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Z][A-Z0-9_]*$/, "env name must be SHOUTING_SNAKE_CASE")
  .refine((name) => !FORBIDDEN_SET.has(name.toUpperCase()), {
    message: "env name is on the forbidden Acurast list (root-authority key)"
  });

export const relayCatalogStateSchema = z.enum([
  "candidate",
  "active",
  "degraded",
  "draining",
  "disabled"
]);

export const relayAuthorityProfileSchema = z.enum([
  "durable-relay",
  "bootstrap-control-plane"
]);

export const relayAdmissionModeSchema = z.enum([
  "proof-infra",
  "paid-ingress",
  "none"
]);

const peerRelaySchema = z
  .object({
    relayId: z.string().min(1),
    apiBaseUrl: z.string().url(),
    readTokenEnv: envNameSchema.optional()
  })
  .strict();

const relaySecretsSchema = z
  .object({
    relayerPrivateKeyEnv: envNameSchema,
    validationReadTokenEnv: envNameSchema.optional(),
    controlPlaneTokenEnv: envNameSchema.optional(),
    relayInfraAdmissionTokenEnv: envNameSchema.optional(),
    logCreateTokenEnv: envNameSchema.optional(),
    logEncryptionKeyEnv: envNameSchema.optional()
  })
  .strict();

const acurastTargetSchema = z
  .object({
    deployerSeedEnv: envNameSchema,
    network: z.enum(["mainnet", "canary"]).default("mainnet"),
    deployerAddress: z.string().min(1).optional(),
    projectName: z.string().min(1),
    stageDir: z.string().min(1),
    entrypoint: z.string().min(1).default("src/server.ts"),
    deploymentProfile: z.string().min(1).default("default"),
    executionMs: z.number().int().positive().default(3_600_000),
    maxCostPerExecution: z
      .union([z.number().int().nonnegative(), z.string().regex(/^[0-9]+$/)])
      .transform((value) => (typeof value === "number" ? value.toString() : value)),
    replicas: z.number().int().positive().default(1),
    managerId: z.string().min(1).optional(),
    instantMatchProcessors: z.array(z.string().min(1)).default([]),
    compactEnv: z.boolean().default(true),
    includeEnv: z.array(envNameSchema).default([]),
    encryptedCode: z.boolean().default(true),
    scriptIpfs: z.string().min(1).optional()
  })
  .strict();

const bootstrapTargetSchema = z
  .object({
    composeFile: z.string().min(1).default("docker-compose.control-plane.yaml"),
    composeService: z.string().min(1),
    envFile: z.string().min(1).default(".control-plane/control-plane.env"),
    rebuild: z.boolean().default(true)
  })
  .strict();

const relayProcessConfigSchema = z
  .object({
    authorityProfile: relayAuthorityProfileSchema.default("durable-relay"),
    settlementRelayId: z.string().min(1).optional(),
    authorityLeaseOwnerId: z.string().min(1).optional(),
    admissionMode: relayAdmissionModeSchema.optional(),
    autoRegister: z.boolean().default(false),
    bootstrapRelayUrl: z.string().url().optional(),
    certificateMode: z.enum(["job-acme", "self-signed", "external"]).default("job-acme"),
    /**
     * Provision an encrypted log sink on `bootstrapRelayUrl` per deploy
     * and ship `SWITCHBOARD_LOG_URL` / `SWITCHBOARD_LOG_TOKEN` /
     * `SWITCHBOARD_LOG_ENCRYPTION_KEY` into the job. Read state is
     * persisted to `.switchboard/relays/<id>.log-sink.json` so
     * `switchboard relay logs <id>` works without flags.
     */
    enableLogs: z.boolean().default(false),
    /** Env name holding the bearer used to call POST /v1/log-sinks on the bootstrap relay. */
    logCreateTokenEnv: envNameSchema.default("PROOF_LOG_CREATE_TOKEN"),
    enableValidationReports: z.boolean().default(true),
    enableControlPlane: z.boolean().default(false),
    enablePeerBackfill: z.boolean().default(true),
    enableMonitoring: z.boolean().default(true),
    enableRateLimits: z.boolean().default(true),
    validationReportStoreKind: z.enum(["json", "sqlite"]).default("sqlite"),
    sqliteDriver: z.enum(["node:sqlite", "better-sqlite3"]).default("node:sqlite"),
    sqliteFile: z.string().min(1).default("tmp/validation-reports/proof-relay.sqlite"),
    publicMetrics: z.boolean().default(false),
    quotesEnabled: z.boolean().default(false)
  })
  .strict()
  .transform((value) => ({
    ...value,
    admissionMode: value.admissionMode ?? (value.autoRegister ? "paid-ingress" : "none")
  }));

const verificationConfigSchema = z
  .object({
    pollIntervalMs: z.number().int().positive().default(5_000),
    pollTimeoutMs: z.number().int().positive().default(120_000),
    /**
     * Extra readiness window for Acurast self-ingress deploys
     * (`relay.autoRegister=true` + `target=acurast`). Acurast's
     * `startAt.msFromNow` defers the relay's first execution by 5 min
     * by default, then register-ingress + hub-watcher + gateway-agent
     * + ACME issuance add another 2-3 min. The bootstrap path doesn't
     * need this. Default: 300_000ms (5 min) on top of `pollTimeoutMs`.
     */
    acurastReadyGraceMs: z.number().int().nonnegative().default(300_000),
    requirePeerBackfillReachable: z.boolean().default(true)
  })
  .strict();

const dnsHostnameSchema = z
  .string()
  .min(1)
  .regex(/^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/, "must be a lowercase FQDN");

const relayDnsConfigSchema = z
  .object({
    provider: z.literal("cloudflare"),
    cnameTarget: dnsHostnameSchema,
    ttl: z.number().int().positive().default(60),
    comment: z.string().min(1).optional()
  })
  .strict();

export const relayDeploymentSpecSchema = z
  .object({
    version: z.literal(RELAY_DEPLOYMENT_SPEC_VERSION),
    relayId: z.string().min(1),
    target: z.enum(["acurast", "bootstrap"]),
    catalogState: relayCatalogStateSchema.default("candidate"),
    apiBaseUrl: z.string().url(),
    validationReportUrl: z.string().url().optional(),
    controlPlaneUrl: z.string().url().optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    peers: z.array(peerRelaySchema).default([]),
    secrets: relaySecretsSchema,
    relay: relayProcessConfigSchema.default(() => relayProcessConfigSchema.parse({})),
    verification: verificationConfigSchema.default(() => verificationConfigSchema.parse({})),
    dns: relayDnsConfigSchema.optional(),
    acurast: acurastTargetSchema.optional(),
    bootstrap: bootstrapTargetSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.target === "acurast" && !value.acurast) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "acurast section is required when target=acurast",
        path: ["acurast"]
      });
    }
    if (value.target === "bootstrap" && !value.bootstrap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bootstrap section is required when target=bootstrap",
        path: ["bootstrap"]
      });
    }
    if (value.target === "acurast" && value.relay.autoRegister && !value.relay.bootstrapRelayUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "relay.bootstrapRelayUrl is required when target=acurast and relay.autoRegister=true",
        path: ["relay", "bootstrapRelayUrl"]
      });
    }
    if (value.target === "acurast" && value.relay.admissionMode === "proof-infra") {
      if (value.relay.autoRegister) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "relay.autoRegister must be false when relay.admissionMode=proof-infra",
          path: ["relay", "autoRegister"]
        });
      }
      if (!value.relay.bootstrapRelayUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "relay.bootstrapRelayUrl is required when target=acurast and relay.admissionMode=proof-infra",
          path: ["relay", "bootstrapRelayUrl"]
        });
      }
      if (!value.secrets.relayInfraAdmissionTokenEnv) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "secrets.relayInfraAdmissionTokenEnv is required when relay.admissionMode=proof-infra",
          path: ["secrets", "relayInfraAdmissionTokenEnv"]
        });
      }
    }
    if (value.target === "acurast" && value.relay.enableLogs && !value.relay.bootstrapRelayUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "relay.bootstrapRelayUrl is required when target=acurast and relay.enableLogs=true",
        path: ["relay", "bootstrapRelayUrl"]
      });
    }
    if (value.target === "acurast" && value.relay.authorityProfile === "durable-relay") {
      if (value.relay.quotesEnabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "durable Acurast relays must be quote-rootless; use authorityProfile=bootstrap-control-plane only for explicit temporary bootstrap authority",
          path: ["relay", "quotesEnabled"]
        });
      }
      for (const [name, path] of collectShippedEnvRefs(value)) {
        if (isQuoteAuthorityAcurastEnvName(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `durable Acurast relays must not ship quote-related env ${name}`,
            path
          });
        }
        if (isHighAuthorityAcurastEnvName(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `high-authority bootstrap env ${name} requires relay.authorityProfile=bootstrap-control-plane`,
            path
          });
        }
      }
    }
  });

export type RelayDeploymentSpec = z.output<typeof relayDeploymentSpecSchema>;
export type RelayCatalogState = z.output<typeof relayCatalogStateSchema>;
export type RelayDeploymentTarget = RelayDeploymentSpec["target"];
export type RelayAuthorityProfile = RelayDeploymentSpec["relay"]["authorityProfile"];
export type RelayAdmissionMode = NonNullable<RelayDeploymentSpec["relay"]["admissionMode"]>;

export interface RelayDeploymentSpecParseError {
  errors: Array<{ path: string; message: string }>;
}

export function parseRelayDeploymentSpec(input: unknown): RelayDeploymentSpec {
  return relayDeploymentSpecSchema.parse(input);
}

export function safeParseRelayDeploymentSpec(
  input: unknown
): { ok: true; spec: RelayDeploymentSpec } | { ok: false; error: RelayDeploymentSpecParseError } {
  const result = relayDeploymentSpecSchema.safeParse(input);
  if (result.success) {
    return { ok: true, spec: result.data };
  }
  return {
    ok: false,
    error: {
      errors: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message
      }))
    }
  };
}

export function assertNoForbiddenAcurastEnv(envNames: Iterable<string>): void {
  const offenders: string[] = [];
  for (const name of envNames) {
    if (FORBIDDEN_SET.has(name.toUpperCase())) {
      offenders.push(name);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Refusing to expose forbidden env names to Acurast: ${offenders.join(", ")}`
    );
  }
}

export function isForbiddenAcurastEnvName(name: string): boolean {
  return FORBIDDEN_SET.has(name.toUpperCase());
}

export function isHighAuthorityAcurastEnvName(name: string): boolean {
  return HIGH_AUTHORITY_SET.has(name.toUpperCase());
}

export function isQuoteAuthorityAcurastEnvName(name: string): boolean {
  const normalized = name.toUpperCase();
  return (
    normalized === "PROOF_QUOTES_ENABLED" ||
    normalized === "QUOTE_SIGNER_PRIVATE_KEY" ||
    normalized === "PROOF_MAINNET_QUOTE_SIGNER_PRIVATE_KEY" ||
    normalized === "PROOF_QUOTE_ENDPOINT_ID_SECRET" ||
    normalized === "PROOF_MAINNET_QUOTE_ENDPOINT_ID_SECRET" ||
    normalized.startsWith("PROOF_QUOTE_") ||
    normalized.startsWith("QUOTE_")
  );
}

function collectShippedEnvRefs(value: z.output<typeof relayDeploymentSpecSchema>): Array<[string, Array<string | number>]> {
  const refs: Array<[string, Array<string | number>]> = [];
  refs.push([value.secrets.relayerPrivateKeyEnv, ["secrets", "relayerPrivateKeyEnv"]]);
  if (value.secrets.validationReadTokenEnv) refs.push([value.secrets.validationReadTokenEnv, ["secrets", "validationReadTokenEnv"]]);
  if (value.relay.enableControlPlane && value.secrets.controlPlaneTokenEnv) {
    refs.push([value.secrets.controlPlaneTokenEnv, ["secrets", "controlPlaneTokenEnv"]]);
  }
  if (value.secrets.relayInfraAdmissionTokenEnv) refs.push([value.secrets.relayInfraAdmissionTokenEnv, ["secrets", "relayInfraAdmissionTokenEnv"]]);
  if (value.secrets.logCreateTokenEnv) refs.push([value.secrets.logCreateTokenEnv, ["secrets", "logCreateTokenEnv"]]);
  if (value.secrets.logEncryptionKeyEnv) refs.push([value.secrets.logEncryptionKeyEnv, ["secrets", "logEncryptionKeyEnv"]]);
  value.peers.forEach((peer, index) => {
    if (peer.readTokenEnv) refs.push([peer.readTokenEnv, ["peers", index, "readTokenEnv"]]);
  });
  value.acurast?.includeEnv.forEach((name, index) => {
    refs.push([name, ["acurast", "includeEnv", index]]);
  });
  return refs;
}
