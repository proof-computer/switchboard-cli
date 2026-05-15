import { Buffer } from "node:buffer";

export const ACURAST_MAX_ENV_VARS = 10;
export const ACURAST_ENV_KEY_MAX_BYTES = 32;
export const ACURAST_ENV_VALUE_MAX_BYTES = 996;

export function auditAcurastEnv(env: Record<string, string>, source: string): void {
  const entries = Object.entries(env);
  const violations: string[] = [];
  if (entries.length > ACURAST_MAX_ENV_VARS) {
    violations.push(`count ${entries.length} > ${ACURAST_MAX_ENV_VARS}`);
  }
  for (const [key, value] of entries) {
    const keyBytes = Buffer.byteLength(key, "utf8");
    if (keyBytes > ACURAST_ENV_KEY_MAX_BYTES) {
      violations.push(`key ${key} is ${keyBytes} bytes > ${ACURAST_ENV_KEY_MAX_BYTES}`);
    }
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (valueBytes > ACURAST_ENV_VALUE_MAX_BYTES) {
      violations.push(`value for ${key} is ${valueBytes} bytes > ${ACURAST_ENV_VALUE_MAX_BYTES}`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`Refusing Acurast env for ${source}: ${violations.join("; ")}`);
  }
}

export function auditAcurastEnvKeySet(keys: string[], source: string): void {
  const violations: string[] = [];
  if (keys.length > ACURAST_MAX_ENV_VARS) {
    violations.push(`count ${keys.length} > ${ACURAST_MAX_ENV_VARS}`);
  }
  for (const key of keys) {
    const keyBytes = Buffer.byteLength(key, "utf8");
    if (keyBytes > ACURAST_ENV_KEY_MAX_BYTES) {
      violations.push(`key ${key} is ${keyBytes} bytes > ${ACURAST_ENV_KEY_MAX_BYTES}`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`Refusing Acurast env for ${source}: ${violations.join("; ")}`);
  }
}
