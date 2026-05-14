import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fetchLaunchDemoQuotePreview,
  formatLaunchDemoQuoteLineItems,
  formatLaunchDemoQuotePreview
} from "../cli/src/index.js";

describe("launch-demo quote preview formatting", () => {
  const manifestConfig = {
    manifest: {
      supportedAssets: [
        {
          address: "0x0000000000000000000000000000000000001337",
          symbol: "USDC",
          decimals: 6
        }
      ]
    }
  } as any;

  it("keeps old relay preview responses compact", () => {
    assert.equal(
      formatLaunchDemoQuotePreview({
        ok: true,
        asset: "0x0000000000000000000000000000000000001337",
        amount: "3024000",
        paidSeconds: "2419200",
        formattedAmount: "3.024 USDC",
        preview: {
          amount: "3024000",
          asset: "0x0000000000000000000000000000000000001337",
          paidSeconds: "2419200"
        }
      } as any),
      "3.024 USDC"
    );
  });

  it("formats additive line-item metadata when a relay returns it", () => {
    const lineItemSummary = formatLaunchDemoQuoteLineItems(
      {
        amount: "3024000",
        asset: "0x0000000000000000000000000000000000001337",
        lineItems: [
          { code: "base_route", label: "Base route", amount: "3024000", unit: "asset_base_units" },
          { code: "setup_reserve", label: "Setup reserve", amount: "0", unit: "asset_base_units" },
          { code: "validation_cap", label: "Validation cap", amount: "0", unit: "asset_base_units" },
          { code: "dns_tls", label: "DNS/TLS", amount: "0", unit: "asset_base_units", detail: "included", included: true },
          {
            code: "fair_use_bandwidth",
            label: "Fair-use bandwidth",
            amount: "0",
            unit: "asset_base_units",
            detail: "standard",
            included: true
          }
        ]
      },
      "0x0000000000000000000000000000000000001337",
      manifestConfig
    );

    assert.equal(lineItemSummary, "Base route 3.024 USDC; DNS/TLS included; Fair-use bandwidth standard");
    assert.equal(
      formatLaunchDemoQuotePreview({
        ok: true,
        asset: "0x0000000000000000000000000000000000001337",
        amount: "3024000",
        paidSeconds: "2419200",
        formattedAmount: `3.024 USDC (${lineItemSummary})`,
        lineItemSummary,
        preview: {}
      } as any),
      "3.024 USDC (Base route 3.024 USDC; DNS/TLS included; Fair-use bandwidth standard)"
    );
  });

  it("retries transient quote preview timeouts before launch-demo spends", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return new Response(JSON.stringify({
        ok: true,
        preview: {
          amount: "9000",
          asset: "0x0000000000000000000000000000000000001337",
          paidSeconds: "7200"
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    try {
      const preview = await fetchLaunchDemoQuotePreview({
        relayUrl: "https://relay.test",
        assetAddress: "0x0000000000000000000000000000000000001337",
        paidSeconds: "7200",
        manifestConfig,
        timeoutMs: 10,
        retries: 1,
        retryDelayMs: 1
      });

      assert.equal(calls, 2);
      assert.equal(preview.ok, true);
      assert.equal(preview.ok ? preview.amount : "", "9000");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry non-transient quote preview rejections", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: false, error: "bad_request" }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    try {
      const preview = await fetchLaunchDemoQuotePreview({
        relayUrl: "https://relay.test",
        assetAddress: "0x0000000000000000000000000000000000001337",
        paidSeconds: "7200",
        manifestConfig,
        timeoutMs: 10,
        retries: 3,
        retryDelayMs: 1
      });

      assert.equal(calls, 1);
      assert.equal(preview.ok, false);
      assert.match(preview.ok ? "" : preview.error, /400/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
