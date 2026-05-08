import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, encodeAddress, mnemonicGenerate } from "@polkadot/util-crypto";

import { checkMnemonicSeed, checkSeedAddressMatch } from "../cli/src/preflight/mnemonic-check.js";

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

describe("checkSeedAddressMatch", () => {
  it("flags a mismatch when the address belongs to a different account", async () => {
    const seedA = mnemonicGenerate(12);
    const seedB = mnemonicGenerate(12);
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    const otherAddress = keyring.addFromMnemonic(seedB).address;

    const result = await checkSeedAddressMatch(seedA, otherAddress, "POLKADOT_ADDRESS");
    assert.equal(result.ok, false);
    assert.match(result.detail, /seed derives to/);
    assert.match(result.detail, /POLKADOT_ADDRESS/);
    assert.match(result.detail, /different account/);
  });

  it("accepts a matching seed/address pair (same SS58 prefix)", async () => {
    const seed = mnemonicGenerate(12);
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    const address = keyring.addFromMnemonic(seed).address;

    const result = await checkSeedAddressMatch(seed, address, "POLKADOT_ADDRESS");
    assert.equal(result.ok, true, `expected ok, got detail: ${result.detail}`);
    assert.match(result.detail, /matches seed-derived/);
  });

  it("accepts a matching seed/address pair across different SS58 prefixes", async () => {
    const seed = mnemonicGenerate(12);
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    const pair = keyring.addFromMnemonic(seed);
    const polkadotPrefix = encodeAddress(pair.publicKey, 0);
    const genericPrefix = encodeAddress(pair.publicKey, 42);
    assert.notEqual(polkadotPrefix, genericPrefix, "fixture sanity: prefixes should produce different strings");

    const polkadotResult = await checkSeedAddressMatch(seed, polkadotPrefix, "POLKADOT_ADDRESS");
    const genericResult = await checkSeedAddressMatch(seed, genericPrefix, "POLKADOT_ADDRESS");
    assert.equal(polkadotResult.ok, true, `prefix 0 should match: ${polkadotResult.detail}`);
    assert.equal(genericResult.ok, true, `prefix 42 should match: ${genericResult.detail}`);
  });

  it("flags a non-SS58 address string with a clear error", async () => {
    const seed = mnemonicGenerate(12);
    const result = await checkSeedAddressMatch(seed, "not-an-address", "POLKADOT_ADDRESS");
    assert.equal(result.ok, false);
    assert.match(result.detail, /not a valid SS58 address/);
  });
});
