import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const defaultUrl = "https://e-kfxhvj7hizmig4poi6cd.acurast.ingress.digital/status";
const defaultOut = "tests/fixtures/express-webserver-live-status.json";
const args = parseArgs(process.argv.slice(2));
const url = args.url ?? defaultUrl;
const out = resolve(args.out ?? defaultOut);

const response = await fetch(url, {
  headers: { accept: "application/json" },
  signal: AbortSignal.timeout(Number(args.timeoutMs ?? 20_000))
});

if (!response.ok) {
  throw new Error(`Snapshot request failed: ${response.status} ${response.statusText}`);
}

const status = await response.json();
validateStatusSnapshot(status);
assertNoUnredactedSecrets(status);

await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(status, null, 2)}\n`);
console.log(`Wrote ${out}`);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") {
      continue;
    } else if (value === "--url") {
      parsed.url = values[++index];
    } else if (value === "--out") {
      parsed.out = values[++index];
    } else if (value === "--timeout-ms") {
      parsed.timeoutMs = values[++index];
    } else if (value === "--help" || value === "-h") {
      console.log("Usage: node scripts/snapshot-express-demo-status.mjs [--url URL] [--out PATH] [--timeout-ms MS]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}

function validateStatusSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Status snapshot must be a JSON object");
  }
  if (value.ok !== true) {
    throw new Error("Status snapshot must include ok=true");
  }
  const required = [
    ["public", "url"],
    ["ids", "sessionId"],
    ["ids", "jobId"],
    ["registration", "state"],
    ["certificate", "state"],
    ["runtime", "nodeVersion"]
  ];
  for (const path of required) {
    if (readPath(value, path) === undefined) {
      throw new Error(`Status snapshot missing ${path.join(".")}`);
    }
  }
}

function assertNoUnredactedSecrets(value, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnredactedSecrets(item, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (/token|secret|private.?key|password|hmac/i.test(key) && typeof nested === "string" && !isRedactedSecretValue(nested)) {
      throw new Error(`Refusing to write unredacted secret-like field ${nextPath.join(".")}`);
    }
    assertNoUnredactedSecrets(nested, nextPath);
  }
}

function isRedactedSecretValue(value) {
  return value === "" || value === "[redacted]" || value.toLowerCase() === "redacted";
}

function readPath(value, path) {
  return path.reduce((current, key) => current && typeof current === "object" ? current[key] : undefined, value);
}
