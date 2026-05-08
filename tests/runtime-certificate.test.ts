import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  requestCertificateWithRelay,
  SwitchboardCertificateError,
  type SwitchboardJobSigner
} from "../src/runtime/index.js";

const REGISTRY = "0x65d6B76BeC50F46D198fFa3598E381a298025Da0";
const JOB_SIGNER = "0x0000000000000000000000000000000000000009";
const SIGNATURE = `0x${"11".repeat(65)}`;

describe("Switchboard runtime certificate requests", () => {
  it("classifies relay hostname lock contention as a retryable certificate lock", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: "certificate_hostname_lock_unavailable",
          hostname: "demo.example.com",
          retryAfterMs: 4250
        }),
        {
          status: 423,
          headers: { "content-type": "application/json" }
        }
      );

    await assert.rejects(
      () => requestCertificateWithRelay(exampleCertificateConfig(), fetchImpl),
      (error) => {
        assert.ok(error instanceof SwitchboardCertificateError);
        assert.equal(error.stage, "certificate_lock");
        assert.equal(error.status, 423);
        assert.equal(error.hostname, "demo.example.com");
        assert.deepEqual(error.relayResponse, {
          error: "certificate_hostname_lock_unavailable",
          hostname: "demo.example.com",
          retryAfterMs: 4250
        });
        return true;
      }
    );
  });
});

function exampleCertificateConfig() {
  return {
    relayUrl: "https://relay-a.switchboard.proof.computer",
    chainId: 420420419,
    registryAddress: REGISTRY,
    sessionId: `0x${"01".repeat(32)}`,
    hostname: "Demo.Example.Com",
    csrPem: "-----BEGIN CERTIFICATE REQUEST-----\nTEST\n-----END CERTIFICATE REQUEST-----\n",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n",
    jobSigner: fakeJobSigner(),
    requestTimeoutMs: 1000
  };
}

function fakeJobSigner(): SwitchboardJobSigner {
  return {
    async getAddress() {
      return JOB_SIGNER;
    },
    async signRegistration() {
      return SIGNATURE;
    },
    async signCertificateRequest() {
      return SIGNATURE;
    }
  };
}
