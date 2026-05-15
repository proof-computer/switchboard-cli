import { createCipheriv, createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export const SWITCHBOARD_CODE_KEY_ENV = "SWITCHBOARD_CODE_KEY";
export const ENCRYPTED_BUNDLE_LOADER_MARKER = "Switchboard encrypted Acurast relay bootstrap";

const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;

export interface EncryptAcurastBundleInput {
  keyHex: string;
  randomBytes?: (size: number) => Buffer;
}

export interface EncryptAcurastBundleResult {
  bundlePath: string;
  plaintextSha256: string;
  ciphertextBytes: number;
  loaderBytes: number;
}

export function generateSwitchboardCodeKey(randomBytes: (size: number) => Buffer = nodeRandomBytes): string {
  return randomBytes(32).toString("hex");
}

export async function encryptAcurastBundleFile(
  bundlePath: string,
  input: EncryptAcurastBundleInput
): Promise<EncryptAcurastBundleResult> {
  const plaintext = await readFile(bundlePath);
  const encrypted = encryptAcurastBundle(plaintext, input);
  await writeFile(bundlePath, encrypted.loader, { encoding: "utf8", mode: 0o644 });
  return {
    bundlePath,
    plaintextSha256: encrypted.plaintextSha256,
    ciphertextBytes: encrypted.ciphertextBytes,
    loaderBytes: Buffer.byteLength(encrypted.loader, "utf8")
  };
}

export function encryptAcurastBundle(
  plaintext: Buffer,
  input: EncryptAcurastBundleInput
): {
  loader: string;
  plaintextSha256: string;
  ciphertextBytes: number;
} {
  if (!KEY_HEX_RE.test(input.keyHex)) {
    throw new Error(`${SWITCHBOARD_CODE_KEY_ENV} must be a 32-byte hex string`);
  }
  const rng = input.randomBytes ?? nodeRandomBytes;
  const key = Buffer.from(input.keyHex, "hex");
  const iv = rng(12);
  if (iv.length !== 12) {
    throw new Error("encrypted bundle IV generator must return 12 bytes");
  }
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const plaintextSha256 = createHash("sha256").update(plaintext).digest("hex");
  return {
    loader: buildEncryptedBundleLoader({
      ciphertextBase64: ciphertext.toString("base64"),
      ivBase64: iv.toString("base64"),
      tagBase64: tag.toString("base64"),
      plaintextSha256
    }),
    plaintextSha256,
    ciphertextBytes: ciphertext.length
  };
}

export function buildEncryptedBundleLoader(input: {
  ciphertextBase64: string;
  ivBase64: string;
  tagBase64: string;
  plaintextSha256: string;
}): string {
  return `"use strict";
// ${ENCRYPTED_BUNDLE_LOADER_MARKER}. The relay bundle is AES-256-GCM
// ciphertext; ${SWITCHBOARD_CODE_KEY_ENV} is delivered through Acurast encrypted env.
const crypto = require("node:crypto");
const path = require("node:path");
const { createRequire } = require("node:module");

const SWITCHBOARD_CODE_CIPHERTEXT_B64 = ${JSON.stringify(input.ciphertextBase64)};
const SWITCHBOARD_CODE_IV_B64 = ${JSON.stringify(input.ivBase64)};
const SWITCHBOARD_CODE_TAG_B64 = ${JSON.stringify(input.tagBase64)};
const SWITCHBOARD_CODE_PLAINTEXT_SHA256 = ${JSON.stringify(input.plaintextSha256)};
const SWITCHBOARD_CODE_KEY_ENV = ${JSON.stringify(SWITCHBOARD_CODE_KEY_ENV)};

function loaderLog(stage, details) {
  console.log(JSON.stringify({
    event: "switchboard.encrypted_code." + stage.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, ""),
    component: "switchboard-code-loader",
    stage,
    details: sanitizeForLog(details)
  }));
}

function loaderError(stage, error) {
  console.error(JSON.stringify({
    event: "switchboard.encrypted_code.error",
    component: "switchboard-code-loader",
    stage,
    error: safeError(error)
  }));
}

function safeError(error) {
  if (error && typeof error === "object") {
    const out = {
      name: typeof error.name === "string" ? error.name : "Error",
      message: typeof error.message === "string" ? truncate(error.message) : truncate(String(error))
    };
    if (typeof error.stack === "string") {
      out.stack = truncate(error.stack, 1200);
    }
    for (const key of ["code", "errno", "syscall", "address", "port", "host", "hostname", "status", "statusCode"]) {
      const value = error[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        out[key] = value;
      }
    }
    return out;
  }
  return { name: typeof error, message: truncate(String(error)) };
}

function sanitizeForLog(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(sanitizeForLog);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    out[key] = /secret|token|key|private|password|seed|bearer|authorization|ciphertext|signature/i.test(key)
      ? "[redacted]"
      : typeof item === "string"
        ? truncate(item)
        : item && typeof item === "object"
          ? sanitizeForLog(item)
          : item;
  }
  return out;
}

function truncate(value, maxLength) {
  const limit = maxLength || 1000;
  const text = String(value);
  return text.length > limit ? text.slice(0, limit) + "..." : text;
}

function runtimeEnvValue(name) {
  const processEnvAvailable = typeof process !== "undefined" && !!process.env;
  const stdEnv = globalThis && globalThis._STD_ && globalThis._STD_.env;
  const stdEnvAvailable = !!stdEnv;
  const environmentFunctionAvailable = typeof globalThis.environment === "function";

  if (processEnvAvailable && process.env[name]) {
    return {
      value: process.env[name],
      source: "process.env",
      processEnvAvailable,
      stdEnvAvailable,
      environmentFunctionAvailable
    };
  }
  if (stdEnvAvailable && stdEnv[name]) {
    return {
      value: stdEnv[name],
      source: "_STD_.env",
      processEnvAvailable,
      stdEnvAvailable,
      environmentFunctionAvailable
    };
  }
  if (environmentFunctionAvailable) {
    const value = globalThis.environment(name);
    if (value) {
      return {
        value,
        source: "environment",
        processEnvAvailable,
        stdEnvAvailable,
        environmentFunctionAvailable
      };
    }
  }
  return {
    value: undefined,
    source: "none",
    processEnvAvailable,
    stdEnvAvailable,
    environmentFunctionAvailable
  };
}

function requiredCodeKey() {
  const lookup = runtimeEnvValue(SWITCHBOARD_CODE_KEY_ENV);
  loaderLog("code-key lookup", {
    env: SWITCHBOARD_CODE_KEY_ENV,
    source: lookup.source,
    processEnvAvailable: lookup.processEnvAvailable,
    stdEnvAvailable: lookup.stdEnvAvailable,
    environmentFunctionAvailable: lookup.environmentFunctionAvailable
  });
  const value = lookup.value;
  if (!value) {
    throw new Error(SWITCHBOARD_CODE_KEY_ENV + " is required to decrypt the Switchboard relay bundle");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(SWITCHBOARD_CODE_KEY_ENV + " must be a 32-byte hex string");
  }
  loaderLog("code-key validated", { source: lookup.source, bytes: 32 });
  return Buffer.from(value, "hex");
}

function decryptBundle() {
  const ciphertext = Buffer.from(SWITCHBOARD_CODE_CIPHERTEXT_B64, "base64");
  const iv = Buffer.from(SWITCHBOARD_CODE_IV_B64, "base64");
  const tag = Buffer.from(SWITCHBOARD_CODE_TAG_B64, "base64");
  const codeKey = requiredCodeKey();
  loaderLog("decrypt start", {
    ciphertextBytes: ciphertext.length,
    ivBytes: iv.length,
    tagBytes: tag.length,
    expectedSha256Prefix: SWITCHBOARD_CODE_PLAINTEXT_SHA256.slice(0, 12)
  });
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    codeKey,
    iv
  );
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
  const actualHash = crypto.createHash("sha256").update(plaintext).digest("hex");
  if (actualHash !== SWITCHBOARD_CODE_PLAINTEXT_SHA256) {
    throw new Error("decrypted Switchboard relay bundle hash mismatch");
  }
  loaderLog("decrypt complete", {
    plaintextBytes: plaintext.length,
    sha256Prefix: actualHash.slice(0, 12)
  });
  return plaintext.toString("utf8");
}

function loadEncryptedBundle() {
  const decryptedFilename = path.join(__dirname, "bundle.decrypted.cjs");
  const decryptedModule = { exports: {} };
  const decryptedRequire = createRequire(decryptedFilename);
  loaderLog("bootstrap start", {
    ciphertextBytes: Buffer.from(SWITCHBOARD_CODE_CIPHERTEXT_B64, "base64").length,
    expectedSha256Prefix: SWITCHBOARD_CODE_PLAINTEXT_SHA256.slice(0, 12)
  });
  const decryptedSource = decryptBundle();
  loaderLog("bundle compile start");
  const run = new Function("exports", "require", "module", "__filename", "__dirname", decryptedSource);
  loaderLog("bundle compile complete");
  loaderLog("bundle evaluate start");
  run(decryptedModule.exports, decryptedRequire, decryptedModule, decryptedFilename, __dirname);
  loaderLog("bundle evaluate complete");
  return decryptedModule.exports;
}

try {
  module.exports = loadEncryptedBundle();
} catch (error) {
  loaderError("bootstrap", error);
  throw error;
}
`;
}
