#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const roots = process.argv.slice(2);

if (roots.length === 0) {
  console.error("Usage: node scripts/mainnet/scan-acurast-artifact-secrets.mjs <file-or-directory>...");
  process.exit(64);
}

const secretNamePatterns = [
  /(^|_)PRIVATE_KEY$/,
  /(^|_)SEED$/,
  /(^|_)MNEMONIC$/,
  /(^|_)TOKEN$/,
  /(^|_)API_KEY$/,
  /(^|_)HMAC_KEY$/,
  /(^|_)ENCRYPTION_KEY$/,
  /^ACME_EAB_/,
  /^CLOUDFLARE_/,
  /^PROOF_.*_(SECRET|TOKEN|KEY|SEED)$/,
  /^ACURAST_.*_(SEED|TOKEN|KEY)$/
];

const excludedNames = new Set([
  "PATH",
  "OLDPWD",
  "PWD",
  "SHELL",
  "SHLVL",
  "TERM",
  "USER"
]);

const secretValues = Object.entries(process.env)
  .filter(([name, value]) => isSecretName(name) && typeof value === "string" && value.length >= 8)
  .map(([name, value]) => ({ name, value }));

if (secretValues.length === 0) {
  console.log("No sourced secret-like environment values found to scan.");
  process.exit(0);
}

const files = [];
for (const root of roots) {
  await collectFiles(path.resolve(root), files);
}

// Operator-side dotenv files are consumed by the Acurast deploy CLI on
// the local machine; they do not ride along to IPFS. Excluding them
// prevents false positives on the deployer seed and on runtime secrets
// that are routed through Acurast's encrypted env channel at submit
// time. The IPFS-bound artifact is the wrapper bundle plus acurast.json
// (deploy params only); both are still scanned.
const excludedBasenames = new Set([".env", ".env.local", ".env.production", ".env.development"]);
const filteredFiles = files.filter((file) => !excludedBasenames.has(path.basename(file)));

const leaks = [];
for (const file of filteredFiles) {
  const bytes = await readFile(file);
  const contents = bytes.toString("utf8");
  for (const secret of secretValues) {
    if (contents.includes(secret.value)) {
      leaks.push({ file, name: secret.name });
    }
  }
}

if (leaks.length > 0) {
  console.error("Secret value(s) found in IPFS-bound Acurast artifact:");
  for (const leak of leaks) {
    console.error(`- ${leak.name} in ${leak.file}`);
  }
  process.exit(1);
}

const skipped = files.length - filteredFiles.length;
const skipNote = skipped > 0 ? ` (skipped ${skipped} operator-side .env file(s); deploy CLI consumes those locally)` : "";
console.log(`Scanned ${filteredFiles.length} IPFS-bound file(s) against ${secretValues.length} sourced secret-like value(s); no matches found${skipNote}.`);

function isSecretName(name) {
  if (excludedNames.has(name)) {
    return false;
  }
  return secretNamePatterns.some((pattern) => pattern.test(name));
}

async function collectFiles(candidate, files) {
  const details = await stat(candidate);
  if (details.isFile()) {
    files.push(candidate);
    return;
  }
  if (!details.isDirectory()) {
    return;
  }

  const entries = await readdir(candidate, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(candidate, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
}
