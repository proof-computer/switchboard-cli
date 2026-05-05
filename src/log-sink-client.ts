import { randomBytes } from "node:crypto";

export interface CreateLogSinkInput {
  /** Base URL of the relay that hosts the log-sink endpoint (typically the bootstrap relay). */
  relayUrl: string;
  /** Bearer used by the deployer to authorize sink creation. */
  createToken: string;
  /** Replace fetch (used by tests). */
  fetchImpl?: typeof fetch;
  /** Replace random-bytes (used by tests). */
  randomBytes?: (size: number) => Buffer;
  /** Request timeout (default 15s). */
  timeoutMs?: number;
}

export interface CreatedLogSink {
  /** Server-issued sink identifier. */
  sinkId: string;
  /** URL the Acurast job posts encrypted log events to (`SWITCHBOARD_LOG_URL`). */
  writeUrl: string;
  /** URL the deployer reads logs back from (used by `switchboard relay logs`). */
  readUrl: string;
  /** Bearer token the job uses on each write (`SWITCHBOARD_LOG_TOKEN`). */
  writeToken: string;
  /** Bearer token the deployer uses to read back. */
  readToken: string;
  /** Fresh AES-256-GCM key (32-byte hex). The relay never sees this — encryption happens client-side in the job. */
  encryptionKey: string;
}

/**
 * Create a fresh per-deploy encrypted log sink on a relay that hosts the
 * `/v1/log-sinks` endpoint (bootstrap relay-a in the canary path; eventually
 * a dedicated `logging.switchboard.proof.computer` once the v2 logging service lands).
 *
 * The encryption key is generated client-side; the server only ever sees
 * ciphertext. Operators who hold the key can decrypt; the relay process
 * itself encrypts before posting and never roundtrips plaintext.
 */
export async function createLogSink(input: CreateLogSinkInput): Promise<CreatedLogSink> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const rng = input.randomBytes ?? randomBytes;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const response = await fetchImpl(new URL("/v1/log-sinks", input.relayUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${input.createToken}`
    },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${input.relayUrl}/v1/log-sinks failed (${response.status}): ${text.slice(0, 500)}`);
  }
  let parsed: {
    sinkId?: string;
    writeUrl?: string;
    readUrl?: string;
    writeToken?: string;
    readToken?: string;
  };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch (error) {
    throw new Error(`Log-sink response was not JSON: ${(error as Error).message}: ${text.slice(0, 200)}`);
  }
  if (!parsed.sinkId || !parsed.writeUrl || !parsed.readUrl || !parsed.writeToken || !parsed.readToken) {
    throw new Error(`Log-sink response missing fields: ${text.slice(0, 500)}`);
  }
  return {
    sinkId: parsed.sinkId,
    writeUrl: parsed.writeUrl,
    readUrl: parsed.readUrl,
    writeToken: parsed.writeToken,
    readToken: parsed.readToken,
    encryptionKey: rng(32).toString("base64url")
  };
}
