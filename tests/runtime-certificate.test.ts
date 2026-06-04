import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { describe, it } from "node:test";

import {
  createSwitchboardCertificateSigningRequest,
  createEncryptedSwitchboardLogger,
  generateProofLogEncryptionKey,
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

  it("rejects plaintext relay and log transports before fetch", async () => {
    let certificateFetches = 0;
    await assert.rejects(
      () => requestCertificateWithRelay(
        { ...exampleCertificateConfig(), relayUrl: "http://relay.example.test" },
        async () => {
          certificateFetches += 1;
          return new Response("{}", { status: 200 });
        }
      ),
      /Switchboard relay URL must use https:\/\//
    );
    assert.equal(certificateFetches, 0);

    const originalFetch = globalThis.fetch;
    const logErrors: unknown[] = [];
    let logFetches = 0;
    globalThis.fetch = (async () => {
      logFetches += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const logger = createEncryptedSwitchboardLogger({
        logUrl: "http://logs.example.test/ingest",
        writeToken: "log-secret",
        encryptionKey: generateProofLogEncryptionKey(),
        onError: (error) => logErrors.push(error)
      });
      await logger("transport-test");
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(logFetches, 0);
    assert.match(String((logErrors[0] as Error | undefined)?.message ?? ""), /Switchboard log URL must use https:\/\//);
  });

  it("allows explicit local HTTP but rejects other URL schemes", async () => {
    const urls: string[] = [];
    await requestCertificateWithRelay(
      { ...exampleCertificateConfig(), relayUrl: "http://127.0.0.1:3000", allowInsecureHttp: true },
      async (url) => {
        urls.push(url.toString());
        return new Response(JSON.stringify({ certificatePem: "cert", issuer: "test" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    );
    assert.deepEqual(urls, ["http://127.0.0.1:3000/v1/certificates"]);

    await assert.rejects(
      () => requestCertificateWithRelay(
        { ...exampleCertificateConfig(), relayUrl: "file:///tmp/relay.json", allowInsecureHttp: true },
        async () => new Response("{}", { status: 200 })
      ),
      /unsupported URL protocol file:/
    );
  });

  it("uses ECDSA CSRs by default while keeping the rsa escape hatch", async () => {
    const defaultCsr = await createSwitchboardCertificateSigningRequest("demo.example.com");
    const rsaCsr = await createSwitchboardCertificateSigningRequest("demo.example.com", {
      keyAlgorithm: "rsa-2048"
    });

    assert.equal(createPrivateKey(defaultCsr.privateKeyPem).asymmetricKeyType, "ec");
    assert.equal(createPrivateKey(rsaCsr.privateKeyPem).asymmetricKeyType, "rsa");
  });

  it("rejects invalid key algorithms and pre-fetch signing timeouts", async () => {
    let fetches = 0;
    await assert.rejects(
      () => requestCertificateWithRelay(
        {
          ...exampleCertificateConfig(),
          csrPem: undefined,
          privateKeyPem: undefined,
          certificateKeyAlgorithm: "ed25519" as never
        },
        async () => {
          fetches += 1;
          return new Response("{}", { status: 200 });
        }
      ),
      (error) => {
        assert.ok(error instanceof SwitchboardCertificateError);
        assert.equal(error.stage, "certificate_config");
        assert.equal(error.hostname, "demo.example.com");
        assert.equal(error.details?.certificateKeyAlgorithm, "ed25519");
        return true;
      }
    );
    assert.equal(fetches, 0);

    const progress: Array<{ stage: string; hostname: string }> = [];
    await assert.rejects(
      () => requestCertificateWithRelay(
        {
          ...exampleCertificateConfig(),
          jobSigner: {
            async getAddress() {
              return JOB_SIGNER;
            },
            async signRegistration() {
              return SIGNATURE;
            },
            async signCertificateRequest() {
              return new Promise<string>(() => undefined);
            }
          },
          requestTimeoutMs: 5,
          onProgress: (event) => {
            progress.push(event);
          }
        },
        async () => {
          fetches += 1;
          return new Response("{}", { status: 200 });
        }
      ),
      (error) => {
        assert.ok(error instanceof SwitchboardCertificateError);
        assert.equal(error.stage, "request_signing");
        assert.equal(error.hostname, "demo.example.com");
        assert.equal(error.details?.timeoutMs, 5);
        return true;
      }
    );
    assert.deepEqual(progress.map((event) => event.stage), ["request_signing"]);
    assert.equal(fetches, 0);
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
