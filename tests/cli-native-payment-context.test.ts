import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nativePaymentAddressFromRuntime, nativePaymentSeedFromRuntime } from "../cli/src/index.js";

const ENV_NAMES = [
  "POLKADOT_SEED",
  "POLKADOT_ADDRESS",
  "ACURAST_MAINNET_SEED",
  "ACURAST_MAINNET_ADDRESS",
  "ACURAST_SEED",
  "ACURAST_ADDRESS",
  "CUSTOM_ACURAST_SEED",
  "CUSTOM_ACURAST_ADDRESS",
  "CUSTOM_PAYMENT_SEED",
  "CUSTOM_PAYMENT_ADDRESS"
] as const;

function withEnv(values: Partial<Record<(typeof ENV_NAMES)[number], string>>, fn: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const name of ENV_NAMES) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(values)) {
    process.env[name] = value;
  }
  try {
    fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

describe("native Hub payment context", () => {
  it("uses explicit Polkadot payment env before Acurast fallback", () => {
    withEnv(
      {
        POLKADOT_SEED: "polkadot seed",
        POLKADOT_ADDRESS: "polkadot address",
        ACURAST_MAINNET_SEED: "acurast seed",
        ACURAST_MAINNET_ADDRESS: "acurast address"
      },
      () => {
        assert.equal(nativePaymentSeedFromRuntime({}), "polkadot seed");
        assert.equal(nativePaymentAddressFromRuntime({}), "polkadot address");
      }
    );
  });

  it("falls back to the Acurast deployer when no explicit Polkadot payment env is configured", () => {
    withEnv(
      {
        ACURAST_MAINNET_SEED: "acurast seed",
        ACURAST_MAINNET_ADDRESS: "acurast address"
      },
      () => {
        assert.equal(nativePaymentSeedFromRuntime({}), "acurast seed");
        assert.equal(nativePaymentAddressFromRuntime({}), "acurast address");
      }
    );
  });

  it("honors context env names for both explicit payment and Acurast fallback modes", () => {
    withEnv(
      {
        CUSTOM_PAYMENT_SEED: "context payment seed",
        CUSTOM_PAYMENT_ADDRESS: "context payment address",
        CUSTOM_ACURAST_SEED: "context acurast seed",
        CUSTOM_ACURAST_ADDRESS: "context acurast address"
      },
      () => {
        assert.equal(
          nativePaymentSeedFromRuntime({
            context: {
              polkadotSeedEnv: "CUSTOM_PAYMENT_SEED",
              acurastSeedEnv: "CUSTOM_ACURAST_SEED"
            }
          }),
          "context payment seed"
        );
        assert.equal(
          nativePaymentAddressFromRuntime({
            context: {
              polkadotAddressEnv: "CUSTOM_PAYMENT_ADDRESS",
              acurastAddressEnv: "CUSTOM_ACURAST_ADDRESS"
            }
          }),
          "context payment address"
        );
        assert.equal(
          nativePaymentSeedFromRuntime({
            context: {
              acurastSeedEnv: "CUSTOM_ACURAST_SEED"
            }
          }),
          "context acurast seed"
        );
        assert.equal(
          nativePaymentAddressFromRuntime({
            context: {
              acurastAddressEnv: "CUSTOM_ACURAST_ADDRESS"
            }
          }),
          "context acurast address"
        );
      }
    );
  });
});
