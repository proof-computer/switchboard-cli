import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  quoteResponseFromDeploymentIntentStatus,
  requestDeploymentIntentGroupMemberQuoteOrResume,
  requestDeploymentIntentQuoteOrResume
} from "../scripts/hub/fund-asset-quote-native.js";

const developer = "0x4000000000000000000000000000000000000004";
const asset = "0x0000000000000000000000000000000000001337";
const quote = {
  quoteId: "0x1111111111111111111111111111111111111111111111111111111111111111",
  sessionId: "0x2222222222222222222222222222222222222222222222222222222222222222",
  developer,
  asset,
  amount: "120000",
  minAmount: "120000",
  maxAmount: "120000",
  paidSeconds: "600",
  serviceAmount: "100000",
  setupFee: "10000",
  validationFeeCap: "10000",
  jobId: "0x3333333333333333333333333333333333333333333333333333333333333333",
  expectedJobSigner: "0x5000000000000000000000000000000000000005",
  operatorId: "0x4444444444444444444444444444444444444444444444444444444444444444",
  processorId: "0x5555555555555555555555555555555555555555555555555555555555555555",
  endpointHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
  salt: "0x7777777777777777777777777777777777777777777777777777777777777777",
  operatorRecipient: "0x1000000000000000000000000000000000000001",
  validatorRecipient: "0x2000000000000000000000000000000000000002",
  proofRecipient: "0x3000000000000000000000000000000000000003",
  maxOperatorBps: 8000,
  maxValidatorBps: 500,
  maxProofBps: 2000,
  policyHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
  deadline: "4102444800"
};
const signature = `0x${"11".repeat(65)}`;
const quoteBindingRequest = {
  developer,
  asset,
  paidSeconds: "600",
  expectedJobSigner: quote.expectedJobSigner,
  jobId: quote.jobId,
  operatorId: quote.operatorId,
  processorId: quote.processorId,
  salt: quote.salt
};

describe("deployment-intent native quote recovery", () => {
  it("requests deployment intent group member quotes through the group endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    const bodies: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (init?.body) {
        bodies.push(String(init.body));
      }
      assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, "Bearer cli-token");
      return jsonResponse({
        ok: true,
        quote,
        signature,
        endpointHostname: "e-test.acurast.ingress.works"
      });
    }) as typeof fetch;

    try {
      const response = await requestDeploymentIntentGroupMemberQuoteOrResume(
        "https://relay.test",
        "dig_test",
        "di_child",
        { developer, asset, paidSeconds: "600", maxAmount: "120000" },
        "cli-token",
        10,
        { ...quoteBindingRequest, maxAmount: "120000" }
      );
      assert.equal(response.quote.sessionId, quote.sessionId);
      assert.equal(response.endpointHostname, "e-test.acurast.ingress.works");
      assert.deepEqual(calls, ["POST /v1/deployment-intent-groups/dig_test/members/di_child/quote"]);
      assert.deepEqual(JSON.parse(bodies[0]), { developer, asset, paidSeconds: "600", maxAmount: "120000" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resumes from a persisted quote after the quote request times out", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    const bodies: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (init?.body) {
        bodies.push(String(init.body));
      }
      if (url.pathname.endsWith("/quote")) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return jsonResponse({
        ok: true,
        intent: {
          intentId: "di_test",
          status: "waiting_funding",
          endpointHostname: "e-test.acurast.ingress.works",
          quote: {
            quote,
            signature,
            policy: { unit: "active_endpoint_minute" }
          }
        }
      });
    }) as typeof fetch;

    try {
      const response = await requestDeploymentIntentQuoteOrResume(
        "https://relay.test",
        "di_test",
        { developer, asset, paidSeconds: "600", maxAmount: "120000" },
        "cli-token",
        10,
        { ...quoteBindingRequest, maxAmount: "120000" }
      );
      assert.equal(response.quote.sessionId, quote.sessionId);
      assert.equal(response.signature, signature);
      assert.equal(response.endpointHostname, "e-test.acurast.ingress.works");
      assert.deepEqual(calls, [
        "POST /v1/deployment-intents/di_test/quote",
        "GET /v1/deployment-intents/di_test"
      ]);
      assert.deepEqual(JSON.parse(bodies[0]), { developer, asset, paidSeconds: "600", maxAmount: "120000" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("describes intent state when a timed-out quote has nothing reusable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      if (url.pathname.endsWith("/quote")) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return jsonResponse({
        ok: true,
        intent: {
          intentId: "di_test",
          status: "waiting_quote",
          dns: {
            status: "failed",
            lastError: "dns_target_unavailable:no_matching_operator_capability"
          },
          events: [
            {
              type: "dns_materialization_failed",
              details: {
                lastError: "dns_target_unavailable:no_matching_operator_capability"
              }
            }
          ]
        }
      });
    }) as typeof fetch;

    try {
      await assert.rejects(
        requestDeploymentIntentQuoteOrResume(
          "https://relay.test",
          "di_test",
          { developer, asset, paidSeconds: "600" },
          "cli-token",
          10,
          quoteBindingRequest
        ),
        /status=waiting_quote dns=failed dnsError=dns_target_unavailable:no_matching_operator_capability/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps polling briefly after a quote timeout before failing", async () => {
    const originalFetch = globalThis.fetch;
    let statusReads = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      if (url.pathname.endsWith("/quote")) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      statusReads += 1;
      return jsonResponse({
        ok: true,
        intent: statusReads === 1
          ? {
              intentId: "di_test",
              status: "waiting_quote",
              events: [{ type: "health:waiting_quote" }]
            }
          : {
              intentId: "di_test",
              status: "waiting_funding",
              endpointHostname: "e-test.acurast.ingress.works",
              quote: {
                quote,
                signature
              }
            }
      });
    }) as typeof fetch;

    try {
      const response = await requestDeploymentIntentQuoteOrResume(
        "https://relay.test",
        "di_test",
        { developer, asset, paidSeconds: "600" },
        "cli-token",
        1_000,
        quoteBindingRequest
      );
      assert.equal(response.signature, signature);
      assert.equal(statusReads, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects mismatched or expired status quotes", () => {
    assert.equal(
      quoteResponseFromDeploymentIntentStatus(
        {
          ok: true,
          intent: {
            endpointHostname: "e-test.acurast.ingress.works",
            quote: {
              quote: { ...quote, paidSeconds: "601" },
              signature
            }
          }
        },
        quoteBindingRequest,
        1
      ),
      undefined
    );
    assert.equal(
      quoteResponseFromDeploymentIntentStatus(
        {
          ok: true,
          intent: {
            endpointHostname: "e-test.acurast.ingress.works",
            quote: {
              quote: { ...quote, amount: "120001", maxAmount: "120001" },
              signature
            }
          }
        },
        { ...quoteBindingRequest, maxAmount: "120000" },
        1
      ),
      undefined
    );
    assert.equal(
      quoteResponseFromDeploymentIntentStatus(
        {
          ok: true,
          intent: {
            endpointHostname: "e-test.acurast.ingress.works",
            quote: {
              quote: { ...quote, expectedJobSigner: "0x9000000000000000000000000000000000000009" },
              signature
            }
          }
        },
        quoteBindingRequest,
        1
      ),
      undefined
    );
    assert.equal(
      quoteResponseFromDeploymentIntentStatus(
        {
          ok: true,
          intent: {
            endpointHostname: "e-test.acurast.ingress.works",
            quote: {
              quote: { ...quote, deadline: "1" },
              signature
            }
          }
        },
        quoteBindingRequest,
        1
      ),
      undefined
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
