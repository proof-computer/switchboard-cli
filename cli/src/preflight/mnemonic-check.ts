import { mnemonicValidate } from "@polkadot/util-crypto";

export interface MnemonicCheckResult {
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
