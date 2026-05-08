import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, decodeAddress, mnemonicValidate } from "@polkadot/util-crypto";

export interface MnemonicCheckResult {
  ok: boolean;
  detail: string;
}

export interface SeedAddressMatchResult {
  ok: boolean;
  detail: string;
}

/**
 * Validate a mnemonic loaded from the user's environment for preflight.
 *
 * Catches the common fish/bash/zsh footgun where `export VAR=word1 word2 word3`
 * is left unquoted, so only the first word lands in the env var. The
 * @acurast/cli and @polkadot signers don't fail until deploy time with a
 * generic "must be a valid mnemonic" error, by which point preflight has
 * already passed.
 */
export function checkMnemonicSeed(seed: string | undefined, envHint: string): MnemonicCheckResult {
  if (!seed) {
    return { ok: false, detail: envHint };
  }
  const trimmed = seed.trim();
  if (trimmed.length === 0) {
    return { ok: false, detail: `${envHint} is set but empty` };
  }
  if (mnemonicValidate(trimmed)) {
    const wordCount = trimmed.split(/\s+/).length;
    return { ok: true, detail: `${envHint} (${wordCount}-word mnemonic)` };
  }
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount === 1) {
    return {
      ok: false,
      detail: `${envHint} is set to a single word — looks like the mnemonic was unquoted in your shell (e.g. \`export VAR="word1 word2 …"\`)`
    };
  }
  return {
    ok: false,
    detail: `${envHint} is set (${wordCount} words) but is not a valid BIP-39 mnemonic`
  };
}

/**
 * Confirm a seed actually derives the address the operator told us to expect.
 *
 * The Acurast deploy helper and the Hub funding helper both perform this check
 * at runtime and abort with errors like "POLKADOT_SEED resolves to X, not
 * POLKADOT_ADDRESS Y" — but only after expensive setup has already run. Doing
 * the same check in preflight surfaces the mismatch before any spend.
 *
 * Comparison happens on decoded public keys, not strings, so the same key
 * displayed under different SS58 prefixes still matches.
 */
export async function checkSeedAddressMatch(
  seed: string,
  expectedAddress: string,
  envHint: string
): Promise<SeedAddressMatchResult> {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  const pair = keyring.addFromMnemonic(seed.trim());
  const derivedKey = decodeAddress(pair.address);
  let expectedKey: Uint8Array;
  try {
    expectedKey = decodeAddress(expectedAddress);
  } catch {
    return { ok: false, detail: `${envHint} is not a valid SS58 address (got "${expectedAddress}")` };
  }
  if (Buffer.from(derivedKey).equals(Buffer.from(expectedKey))) {
    return { ok: true, detail: `matches seed-derived ${pair.address}` };
  }
  return {
    ok: false,
    detail: `seed derives to ${pair.address}, but ${envHint} is set to ${expectedAddress} (different account)`
  };
}
