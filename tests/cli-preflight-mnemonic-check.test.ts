import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mnemonicGenerate } from "@polkadot/util-crypto";

import { checkMnemonicSeed } from "../cli/src/preflight/mnemonic-check.js";

describe("checkMnemonicSeed", () => {
  it("flags missing seed as not ok and returns the env hint as detail", () => {
    const result = checkMnemonicSeed(undefined, "ACURAST_MAINNET_SEED or ACURAST_SEED");
    assert.equal(result.ok, false);
    assert.equal(result.detail, "ACURAST_MAINNET_SEED or ACURAST_SEED");
  });

  it("flags empty/whitespace seed as not ok", () => {
    const result = checkMnemonicSeed("   ", "POLKADOT_SEED");
    assert.equal(result.ok, false);
    assert.match(result.detail, /set but empty/);
  });

  it("flags single-word seed and points at the unquoted-export footgun", () => {
    const result = checkMnemonicSeed("fish", "ACURAST_MAINNET_SEED");
    assert.equal(result.ok, false);
    assert.match(result.detail, /single word/);
    assert.match(result.detail, /unquoted/);
  });

  it("flags multi-word but invalid mnemonic with the actual word count", () => {
    const result = checkMnemonicSeed(
      "fish method water vague travel wealth amused river curtain stadium digital notarealword",
      "ACURAST_MAINNET_SEED"
    );
    assert.equal(result.ok, false);
    assert.match(result.detail, /12 words/);
    assert.match(result.detail, /not a valid BIP-39 mnemonic/);
  });

  it("flags wrong-length mnemonic (e.g. 11 words) as invalid", () => {
    const result = checkMnemonicSeed(
      "fish method water vague travel wealth amused river curtain stadium digital",
      "ACURAST_MAINNET_SEED"
    );
    assert.equal(result.ok, false);
    assert.match(result.detail, /11 words/);
    assert.match(result.detail, /not a valid BIP-39 mnemonic/);
  });

  it("accepts a freshly generated 12-word mnemonic", () => {
    const seed = mnemonicGenerate(12);
    const result = checkMnemonicSeed(seed, "ACURAST_MAINNET_SEED");
    assert.equal(result.ok, true, `expected ok, got detail: ${result.detail}`);
    assert.match(result.detail, /12-word mnemonic/);
  });

  it("accepts a freshly generated 24-word mnemonic", () => {
    const seed = mnemonicGenerate(24);
    const result = checkMnemonicSeed(seed, "POLKADOT_SEED");
    assert.equal(result.ok, true, `expected ok, got detail: ${result.detail}`);
    assert.match(result.detail, /24-word mnemonic/);
  });

  it("accepts a valid mnemonic with surrounding whitespace", () => {
    const seed = mnemonicGenerate(12);
    const result = checkMnemonicSeed(`  ${seed}  \n`, "ACURAST_MAINNET_SEED");
    assert.equal(result.ok, true, `expected ok, got detail: ${result.detail}`);
  });
});
