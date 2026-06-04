import { readFile } from "node:fs/promises";

import { readEncryptedSwitchboardLogs } from "../../../src/runtime/index.js";
import { relayStatePath } from "../switchboard-paths.js";

export interface RunRelayLogsOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  io?: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  /** Replace the underlying reader (for tests). */
  reader?: typeof readEncryptedSwitchboardLogs;
}

interface SavedLogSinkState {
  relayId: string;
  sinkId: string;
  writeUrl: string;
  readUrl: string;
  readToken: string;
  encryptionKey: string;
  createdAt: string;
}

/**
 * Decrypt and print the encrypted log sink for a relay.
 *
 * Resolves config in this order:
 *   --read-url            > $PROOF_LOG_READ_URL > saved sink state
 *   --read-token-env      > $PROOF_LOG_READ_TOKEN > saved sink state
 *   --encryption-key-env  > $SWITCHBOARD_LOG_ENCRYPTION_KEY > saved sink state
 *
 * The saved sink state is `.switchboard/relays/<id>.log-sink.json`,
 * written by current relay ops runbooks or older lifecycle tooling when
 * encrypted relay logging is enabled. That makes `switchboard relay logs <id>`
 * work without flags once read-side state has been provisioned.
 *
 * The log encryption key is purely client-side (AES-256-GCM); the relay
 * only sees ciphertext. This command does not store the key anywhere
 * other than the saved sink state file (which is mode 0600).
 */
export async function runRelayLogs(options: RunRelayLogsOptions): Promise<void> {
  const io = options.io ?? defaultIo();
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  // positionals shape: ["relay", "logs", "<id>?"]
  const relayId = (options.positionals ?? [])[2];
  if (relayId && !/^[a-z0-9-]+$/.test(relayId)) {
    throw new Error(`Invalid relay id ${JSON.stringify(relayId)}`);
  }

  const savedState = relayId ? await loadSavedSinkState(cwd, relayId) : undefined;

  const readUrl = stringFlag(options.flags, "read-url") ?? env.PROOF_LOG_READ_URL ?? savedState?.readUrl;
  if (!readUrl) {
    throw new Error(
      `relay logs requires --read-url <url>, PROOF_LOG_READ_URL, or a saved sink state at .switchboard/relays/${relayId ?? "<id>"}.log-sink.json.`
    );
  }
  const readTokenEnv = stringFlag(options.flags, "read-token-env");
  const readToken = readTokenEnv
    ? env[readTokenEnv]
    : env.PROOF_LOG_READ_TOKEN ?? savedState?.readToken;
  const encryptionKeyEnv = stringFlag(options.flags, "encryption-key-env");
  const encryptionKey = encryptionKeyEnv
    ? env[encryptionKeyEnv]
    : env.SWITCHBOARD_LOG_ENCRYPTION_KEY ?? savedState?.encryptionKey;
  if (!encryptionKey) {
    throw new Error(
      "relay logs requires --encryption-key-env, SWITCHBOARD_LOG_ENCRYPTION_KEY, or a saved sink state (the local AES-256-GCM key)"
    );
  }

  const timeoutMs = numberFlag(options.flags, "timeout-ms", 15_000);
  const limit = numberFlag(options.flags, "limit", 100);
  const reader = options.reader ?? readEncryptedSwitchboardLogs;
  const events = await reader({ readUrl, readToken, encryptionKey, timeoutMs });
  const sliced = events.slice(-limit);

  if (boolFlag(options.flags, "json")) {
    io.log(JSON.stringify(sliced, null, 2));
    return;
  }

  if (sliced.length === 0) {
    io.log("(no log events)");
    return;
  }
  io.log(`${sliced.length} event(s)${relayId ? ` for ${relayId}` : ""}:`);
  io.log("");
  for (const event of sliced) {
    const eventRecord = event as unknown as Record<string, unknown>;
    const messagePart = eventRecord.message ?? eventRecord.body ?? structuredEventMessage(eventRecord);
    const messageString = typeof messagePart === "string" ? messagePart : JSON.stringify(messagePart);
    io.log(`#${event.sequence}  ${event.receivedAt}  ${messageString}`);
  }
}

function structuredEventMessage(event: Record<string, unknown>): string {
  const eventName = typeof event.event === "string" ? event.event : undefined;
  const details = event.details && typeof event.details === "object" && !Array.isArray(event.details)
    ? event.details as Record<string, unknown>
    : undefined;
  const detailsError = details?.error && typeof details.error === "object" && !Array.isArray(details.error)
    ? details.error as Record<string, unknown>
    : undefined;
  const errorMessage = typeof detailsError?.message === "string"
    ? detailsError.message
    : typeof details?.error === "string"
      ? details.error
      : undefined;
  if (eventName && errorMessage) return `${eventName}: ${errorMessage}`;
  if (eventName) return eventName;
  if (errorMessage) return errorMessage;
  return "";
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function numberFlag(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  const value = stringFlag(flags, name);
  if (!value) return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return Number(value);
}

function defaultIo() {
  return {
    log: (line: string) => console.log(line),
    warn: (line: string) => console.warn(line),
    error: (line: string) => console.error(line)
  };
}

async function loadSavedSinkState(cwd: string, relayId: string): Promise<SavedLogSinkState | undefined> {
  const statePath = relayStatePath(cwd, `${relayId}.log-sink.json`);
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SavedLogSinkState>;
    if (!parsed.readUrl || !parsed.readToken || !parsed.encryptionKey) return undefined;
    return parsed as SavedLogSinkState;
  } catch {
    return undefined;
  }
}
