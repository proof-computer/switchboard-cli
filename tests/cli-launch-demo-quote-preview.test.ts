import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatLaunchDemoQuoteLineItems, formatLaunchDemoQuotePreview } from "../cli/src/index.js";

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
        amount: "4032000",
        paidSeconds: "2419200",
        formattedAmount: "4.032 USDC",
        preview: {
          amount: "4032000",
          asset: "0x0000000000000000000000000000000000001337",
          paidSeconds: "2419200"
        }
      } as any),
      "4.032 USDC"
    );
  });

  it("formats additive line-item metadata when a relay returns it", () => {
    const lineItemSummary = formatLaunchDemoQuoteLineItems(
      {
        amount: "4032000",
        asset: "0x0000000000000000000000000000000000001337",
        lineItems: [
          { code: "base_route", label: "Base route", amount: "4032000", unit: "asset_base_units" },
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

    assert.equal(lineItemSummary, "Base route 4.032 USDC; DNS/TLS included; Fair-use bandwidth standard");
    assert.equal(
      formatLaunchDemoQuotePreview({
        ok: true,
        asset: "0x0000000000000000000000000000000000001337",
        amount: "4032000",
        paidSeconds: "2419200",
        formattedAmount: `4.032 USDC (${lineItemSummary})`,
        lineItemSummary,
        preview: {}
      } as any),
      "4.032 USDC (Base route 4.032 USDC; DNS/TLS included; Fair-use bandwidth standard)"
    );
  });
});
