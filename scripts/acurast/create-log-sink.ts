#!/usr/bin/env node
import "dotenv/config";

import { generateProofLogEncryptionKey } from "../../src/runtime/index.js";

async function main(): Promise<void> {
  const relayUrl = stringFlag("--relay-url") ?? process.env.PROOF_LOG_RELAY_URL ?? process.env.RELAY_URL;
  if (!relayUrl) {
    throw new Error("Pass --relay-url <url> or set PROOF_LOG_RELAY_URL/RELAY_URL");
  }

  const response = await fetch(new URL("/v1/log-sinks", relayUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...bearerAuthHeader(stringFlag("--create-token") ?? process.env.PROOF_LOG_CREATE_TOKEN)
    },
    body: "{}"
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Proof encrypted log sink creation failed (${response.status}): ${body}`);
  }

  const sink = JSON.parse(body) as {
    sinkId?: string;
    writeUrl?: string;
    readUrl?: string;
    writeToken?: string;
    readToken?: string;
  };
  if (!sink.sinkId || !sink.writeUrl || !sink.readUrl || !sink.writeToken || !sink.readToken) {
    throw new Error(`Proof encrypted log sink response was incomplete: ${body}`);
  }

  const encryptionKey = generateProofLogEncryptionKey();
  const output = {
    mode: "encrypted-proof-log",
    sinkId: sink.sinkId,
    logUrl: sink.writeUrl,
    readUrl: sink.readUrl,
    writeToken: sink.writeToken,
    readToken: sink.readToken,
    encryptionKey
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Created encrypted PROOF log sink: ${sink.sinkId}`);
  console.log("Relay stores ciphertext only. Keep the read token and encryption key local to the deployer.");
  console.log("");
  console.log("Fish:");
  console.log(`set -gx SWITCHBOARD_LOG_URL ${fishQuote(sink.writeUrl)}`);
  console.log(`set -gx SWITCHBOARD_LOG_TOKEN ${fishQuote(sink.writeToken)}`);
  console.log(`set -gx SWITCHBOARD_LOG_ENCRYPTION_KEY ${fishQuote(encryptionKey)}`);
  console.log(`set -gx SWITCHBOARD_LOG_READ_URL ${fishQuote(sink.readUrl)}`);
  console.log(`set -gx SWITCHBOARD_LOG_READ_TOKEN ${fishQuote(sink.readToken)}`);
}

function bearerAuthHeader(token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function stringFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
    return inline?.slice(name.length + 1);
  }

  return process.argv[index + 1];
}

function fishQuote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
