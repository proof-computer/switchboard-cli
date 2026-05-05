#!/usr/bin/env node
import "dotenv/config";

import { readFile } from "node:fs/promises";

import { readEncryptedSwitchboardLogs } from "../../src/runtime/index.js";

async function main(): Promise<void> {
  const reportPath = stringFlag("--report") ?? process.env.SWITCHBOARD_DEPLOY_REPORT;
  const report = reportPath ? JSON.parse(await readFile(reportPath, "utf8")) as Record<string, any> : undefined;
  const logSink = report?.logSink && typeof report.logSink === "object" ? report.logSink as Record<string, any> : undefined;
  const credentials = logSinkCredentials(logSink);

  const readUrl = stringFlag("--read-url") ?? process.env.SWITCHBOARD_LOG_READ_URL ?? credentials.readUrl;
  const readToken = stringFlag("--read-token") ?? process.env.SWITCHBOARD_LOG_READ_TOKEN ?? credentials.readToken;
  const encryptionKey =
    stringFlag("--encryption-key") ?? process.env.SWITCHBOARD_LOG_ENCRYPTION_KEY ?? credentials.encryptionKey;
  if (!readUrl || !encryptionKey) {
    throw new Error("Pass --read-url and --encryption-key, set SWITCHBOARD_LOG_READ_URL/SWITCHBOARD_LOG_ENCRYPTION_KEY, or pass --report");
  }

  const limit = Number(stringFlag("--limit") ?? "50");
  const url = new URL(readUrl);
  url.searchParams.set("limit", String(limit));
  const events = await readEncryptedSwitchboardLogs({
    readUrl: url.toString(),
    readToken,
    encryptionKey
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ events }, null, 2));
    return;
  }

  console.log(`Encrypted PROOF log events: ${events.length}`);
  if (!process.argv.includes("--verbose")) {
    console.log("Use --verbose to print sanitized event details.");
  }
  for (const event of events) {
    console.log("");
    console.log(
      [
        `#${event.sequence}`,
        event.receivedAt,
        `event=${event.event}`,
        event.deploymentId ? `deployment=${event.deploymentId}` : undefined,
        event.context ? `context=${event.context}` : undefined
      ]
        .filter(Boolean)
        .join(" ")
    );
    if (event.details && Object.keys(event.details).length > 0) {
      console.log(`  details: ${compactJson(event.details, 500)}`);
      if (process.argv.includes("--verbose")) {
        console.log(JSON.stringify(sanitizeValue(event.details), null, 2));
      }
    }
  }
}

function stringFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
    return inline?.slice(name.length + 1);
  }

  return process.argv[index + 1];
}

function stringField(record: Record<string, any> | undefined, name: string): string | undefined {
  const value = record?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function logSinkCredentials(logSink: Record<string, any> | undefined): {
  readUrl?: string;
  readToken?: string;
  encryptionKey?: string;
} {
  const localSecret =
    logSink?.localSecret && typeof logSink.localSecret === "object" ? logSink.localSecret as Record<string, any> : undefined;
  return {
    readUrl: stringField(logSink, "readUrl"),
    readToken: stringField(logSink, "readToken") ?? stringField(localSecret, "readToken"),
    encryptionKey: stringField(logSink, "encryptionKey") ?? stringField(localSecret, "encryptionKey")
  };
}

function compactJson(value: unknown, maxLength: number): string {
  const serialized = JSON.stringify(sanitizeValue(value));
  return truncate(serialized ?? String(value), maxLength);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return truncate(value, 300);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (depth >= 4) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 8).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > 8) {
      items.push(`[${value.length - 8} more]`);
    }
    return items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const output: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, 30)) {
      output[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeValue(item, depth + 1);
    }
    if (entries.length > 30) {
      output.__truncatedKeys = entries.length - 30;
    }
    return output;
  }
  return truncate(String(value), 300);
}

function isSensitiveKey(key: string): boolean {
  return /(?:private|secret|seed|token|password|authorization|credential|encryptionKey|readToken|writeToken)/i.test(key);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
