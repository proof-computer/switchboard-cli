#!/usr/bin/env node
import "dotenv/config";

import { readFile } from "node:fs/promises";

import { validateSwitchboardRoute } from "../../src/route-validation-report.js";
import { discoverServices, resolveValidationReportSubmitUrls } from "../../src/service-discovery.js";

const DEFAULT_NETWORK_MANIFEST_URL = "https://control.switchboard.proof.computer/v1/network-manifest";
const DEFAULT_NETWORK_MANIFEST_SIGNER = "5EpwnRzamXpqWo3jW9h4ecSJHL9LBjR6jTMW5Wzw6p9nMTh7";

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const reportPath = stringFlag(flags, "report") ?? process.env.SWITCHBOARD_DEPLOY_REPORT;
  const deploymentReport = reportPath ? (JSON.parse(await readFile(reportPath, "utf8")) as Record<string, any>) : undefined;
  const sessionId = requiredValue(
    stringFlag(flags, "session-id") ?? stringRecordField(deploymentReport?.session, "sessionId") ?? process.env.VALIDATION_SESSION_ID,
    "--session-id, VALIDATION_SESSION_ID, or --report"
  );
  const hostname = requiredValue(
    stringFlag(flags, "hostname") ?? stringRecordField(deploymentReport?.session, "hostname") ?? process.env.VALIDATION_HOSTNAME,
    "--hostname, VALIDATION_HOSTNAME, or --report"
  );
  const reportSubmitUrls = await validationReportSubmitUrls(flags, deploymentReport);
  const signing = validatorSigningConfig(flags);
  const validationReport = await validateSwitchboardRoute({
    sessionId,
    hostname,
    deploymentId: stringFlag(flags, "deployment-id") ?? stringRecordField(deploymentReport?.deployment, "deploymentId"),
    operatorId: stringFlag(flags, "operator-id") ?? stringRecordField(deploymentReport?.session, "operatorId"),
    gatewayId: stringFlag(flags, "gateway-id") ?? stringRecordField(deploymentReport?.operator, "gatewayId"),
    validatorId: stringFlag(flags, "validator-id") ?? process.env.VALIDATOR_ID ?? "switchboard-validator-local",
    mode: validationMode(flags),
    timeoutMs: numberFlag(flags, "timeout-ms", Number(process.env.VALIDATION_TIMEOUT_MS ?? "10000")),
    ...signing
  });

  const submitted = await submitValidationReport(validationReport, reportSubmitUrls);
  if (flags.has("json")) {
    console.log(JSON.stringify({ report: validationReport, submitted }, null, 2));
    return;
  }

  console.log(validationReport.success ? "Switchboard route validator: ok" : `Switchboard route validator: ${validationReport.failureReason ?? "failed"}`);
  console.log(`Session: ${sessionId}`);
  console.log(`Hostname: ${hostname}`);
  console.log(`Signer: ${validationReport.signature?.signer ?? "unsigned"}`);
  console.log(`Report: ${validationReport.reportId}`);
  console.log(`Submitted: ${submitted.successes.map((item) => item.url).join(", ")}`);
}

async function submitValidationReport(
  report: Awaited<ReturnType<typeof validateSwitchboardRoute>>,
  urls: string[]
): Promise<{
  successes: Array<{ url: string; response: Record<string, unknown> }>;
  failures: Array<{ url: string; error: string }>;
}> {
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ report })
        });
        const body = await response.text();
        if (!response.ok) {
          return { ok: false as const, url, error: `${response.status} ${body}` };
        }
        return { ok: true as const, url, response: JSON.parse(body) as Record<string, unknown> };
      } catch (error: unknown) {
        return { ok: false as const, url, error: error instanceof Error ? error.message : String(error) };
      }
    })
  );
  const successes = results
    .filter((result): result is Extract<typeof result, { ok: true }> => result.ok)
    .map(({ url, response }) => ({ url, response }));
  const failures = results
    .filter((result): result is Extract<typeof result, { ok: false }> => !result.ok)
    .map(({ url, error }) => ({ url, error }));
  if (successes.length === 0) {
    throw new Error(`Validation report submit failed for all relays: ${failures.map((item) => `${item.url}: ${item.error}`).join("; ")}`);
  }
  return { successes, failures };
}

async function validationReportSubmitUrls(flags: Map<string, string | boolean>, deploymentReport: Record<string, any> | undefined): Promise<string[]> {
  const explicitUrls = splitCsv(
    stringFlag(flags, "report-urls") ??
      process.env.PROOF_VALIDATOR_REPORT_URLS ??
      process.env.VALIDATION_REPORT_URLS ??
      ""
  );
  const singleUrl = stringFlag(flags, "report-url") ?? process.env.PROOF_VALIDATOR_REPORT_URL;
  const urls = [...explicitUrls, ...(singleUrl ? [singleUrl] : [])];
  if (urls.length > 0) {
    return uniqueStrings(urls.map(normalizeReportSubmitUrl));
  }

  const manifestUrl = stringFlag(flags, "manifest-url") ?? process.env.PROOF_NETWORK_MANIFEST_URL;
  const manifestSigner = stringFlag(flags, "manifest-signer") ?? process.env.PROOF_NETWORK_MANIFEST_SIGNER;
  if (manifestUrl || manifestSigner) {
    const discovery = await discoverServices({
      manifestUrlCandidates: [manifestUrl ?? DEFAULT_NETWORK_MANIFEST_URL],
      expectedManifestSigner: manifestSigner ?? DEFAULT_NETWORK_MANIFEST_SIGNER,
      allowExpiredManifest: flags.has("allow-expired-manifest"),
      allowExpiredCatalogs: flags.has("allow-expired-manifest")
    });
    const discoveredUrls = resolveValidationReportSubmitUrls(discovery);
    if (discoveredUrls.length > 0) {
      return discoveredUrls;
    }
  }

  const controlPlaneUrl = requiredValue(
    stringFlag(flags, "control-plane-url") ??
      stringFlag(flags, "relay-url") ??
      stringRecordField(deploymentReport?.relay, "url") ??
      process.env.PROOF_CONTROL_PLANE_URL ??
      process.env.RELAY_URL,
    "--report-urls, --control-plane-url, PROOF_VALIDATOR_REPORT_URLS, PROOF_CONTROL_PLANE_URL, RELAY_URL, or --report"
  );
  return [new URL("/v1/validation-reports", controlPlaneUrl).toString()];
}

function normalizeReportSubmitUrl(value: string): string {
  const url = new URL(value);
  if (url.pathname === "/" || url.pathname === "") {
    return new URL("/v1/validation-reports", url).toString();
  }
  return url.toString();
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function validatorSigningConfig(flags: Map<string, string | boolean>) {
  const seed = stringFlag(flags, "validator-seed") ?? process.env.VALIDATOR_REPORT_SEED ?? process.env.PROOF_VALIDATOR_REPORT_SEED;
  if (seed) {
    return {
      signingKey: seed,
      signingScheme: "substrate-sr25519" as const,
      signingSs58Format: numberFlag(flags, "ss58-format", Number(process.env.VALIDATOR_REPORT_SS58_FORMAT ?? "42"))
    };
  }
  const privateKey =
    stringFlag(flags, "validator-private-key") ??
    process.env.VALIDATOR_REPORT_PRIVATE_KEY ??
    process.env.PROOF_VALIDATOR_REPORT_PRIVATE_KEY;
  if (privateKey) {
    return {
      signingKey: privateKey,
      signingScheme: "eip191-secp256k1" as const
    };
  }
  throw new Error("Missing --validator-seed or VALIDATOR_REPORT_SEED");
}

function validationMode(flags: Map<string, string | boolean>): "route_open" | "reachability" {
  const mode = stringFlag(flags, "mode") ?? process.env.VALIDATION_MODE ?? "route_open";
  if (mode !== "route_open" && mode !== "reachability") {
    throw new Error("--mode must be route_open or reachability");
  }
  return mode;
}

function parseFlags(args: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      flags.set(rawName, inlineValue);
      continue;
    }
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(rawName, next);
      index += 1;
      continue;
    }
    flags.set(rawName, true);
  }
  return flags;
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFlag(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  const raw = stringFlag(flags, name);
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

function stringRecordField(record: unknown, name: string): string | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const value = (record as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredValue(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
