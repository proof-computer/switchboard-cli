import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  createCloudflareTxtRecord,
  deleteCloudflareDnsRecord,
  inferCloudflareZoneName,
  normalizeDnsHostname,
  selectCloudflareZoneName,
  upsertCloudflareARecord,
  upsertCloudflareCnameRecord
} from "../src/cloudflare-dns.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Cloudflare DNS helpers", () => {
  it("normalizes hostnames and infers the root Cloudflare zone", () => {
    assert.equal(normalizeDnsHostname("Switchboard-Deploy.Ingress.Works."), "switchboard-deploy.ingress.works");
    assert.equal(inferCloudflareZoneName("switchboard-deploy.ingress.works"), "ingress.works");
    assert.throws(() => normalizeDnsHostname("bad_label.ingress.works"), /Invalid DNS hostname label/);
  });

  it("selects the longest configured Cloudflare zone for a hostname", () => {
    assert.equal(
      selectCloudflareZoneName("run-1.jobs.example.co.uk", ["example.co.uk", "jobs.example.co.uk", "ingress.works"]),
      "jobs.example.co.uk"
    );
    assert.equal(selectCloudflareZoneName("_acme-challenge.run-1.ingress.works", ["ingress.works"]), "ingress.works");
    assert.throws(
      () => selectCloudflareZoneName("session.ingress.works", ["apps.example.com"]),
      /outside configured Cloudflare zones/
    );
  });

  it("creates an A record when none exists", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });

      if (url.includes("/zones?")) {
        return jsonResponse({
          success: true,
          result: [{ id: "zone-1", name: "ingress.works" }]
        });
      }
      if (url.includes("/dns_records?")) {
        return jsonResponse({
          success: true,
          result: []
        });
      }
      if (url.endsWith("/zones/zone-1/dns_records")) {
        return jsonResponse({
          success: true,
          result: {
            id: "record-1",
            zone_id: "zone-1",
            zone_name: "ingress.works",
            name: "session.ingress.works",
            type: "A",
            content: "203.0.113.10",
            ttl: 60,
            proxied: false
          }
        });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    };

    const record = await upsertCloudflareARecord({
      apiToken: "test-token",
      hostname: "session.ingress.works",
      content: "203.0.113.10"
    });

    assert.equal(record.id, "record-1");
    assert.equal(record.name, "session.ingress.works");
    assert.equal(record.content, "203.0.113.10");
    assert.equal(requests.at(-1)?.method, "POST");
    assert.match(requests.at(-1)?.body ?? "", /"proxied":false/);
  });

  it("uses a matching configured zone when creating an A record", async () => {
    const zoneQueries: string[] = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";

      if (url.includes("/zones?")) {
        zoneQueries.push(url);
        return jsonResponse({
          success: true,
          result: [{ id: "zone-2", name: "jobs.example.co.uk" }]
        });
      }
      if (url.includes("/dns_records?")) {
        return jsonResponse({
          success: true,
          result: []
        });
      }
      if (url.endsWith("/zones/zone-2/dns_records")) {
        return jsonResponse({
          success: true,
          result: {
            id: "record-2",
            zone_id: "zone-2",
            zone_name: "jobs.example.co.uk",
            name: "run-1.jobs.example.co.uk",
            type: "A",
            content: "203.0.113.10",
            ttl: 60,
            proxied: false
          }
        });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    };

    const record = await upsertCloudflareARecord({
      apiToken: "test-token",
      hostname: "run-1.jobs.example.co.uk",
      content: "203.0.113.10",
      zoneNames: ["ingress.works", "jobs.example.co.uk"]
    });

    assert.equal(record.zoneName, "jobs.example.co.uk");
    assert.equal(zoneQueries.length, 1);
    assert.match(zoneQueries[0], /name=jobs\.example\.co\.uk/);
  });

  it("falls back from a configured service subdomain to the active parent Cloudflare zone", async () => {
    const zoneQueries: string[] = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";

      if (url.includes("/zones?")) {
        zoneQueries.push(url);
        if (url.includes("name=switchboard.proof.computer")) {
          return jsonResponse({ success: true, result: [] });
        }
        if (url.includes("name=proof.computer")) {
          return jsonResponse({ success: true, result: [{ id: "zone-proof", name: "proof.computer" }] });
        }
      }
      if (url.includes("/dns_records?")) {
        return jsonResponse({ success: true, result: [] });
      }
      if (url.endsWith("/zones/zone-proof/dns_records")) {
        return jsonResponse({
          success: true,
          result: {
            id: "record-proof",
            zone_id: "zone-proof",
            zone_name: "proof.computer",
            name: "gateway.switchboard.proof.computer",
            type: "A",
            content: "203.0.113.10",
            ttl: 60,
            proxied: false
          }
        });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    };

    const record = await upsertCloudflareARecord({
      apiToken: "test-token",
      hostname: "gateway.switchboard.proof.computer",
      content: "203.0.113.10",
      zoneNames: ["switchboard.proof.computer"]
    });

    assert.equal(record.zoneName, "proof.computer");
    assert.deepEqual(
      zoneQueries.map((url) => new URL(url).searchParams.get("name")),
      ["switchboard.proof.computer", "proof.computer"]
    );
  });

  it("patches an existing A record", async () => {
    const methods: string[] = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      methods.push(method);

      if (url.includes("/dns_records/existing-record")) {
        return jsonResponse({
          success: true,
          result: {
            id: "existing-record",
            zone_id: "zone-1",
            zone_name: "ingress.works",
            name: "session.ingress.works",
            type: "A",
            content: "203.0.113.10",
            ttl: 120,
            proxied: false
          }
        });
      }
      if (url.includes("/dns_records?")) {
        return jsonResponse({
          success: true,
          result: [{ id: "existing-record", name: "session.ingress.works", type: "A", content: "1.2.3.4" }]
        });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    };

    const record = await upsertCloudflareARecord({
      apiToken: "test-token",
      zoneId: "zone-1",
      zoneName: "ingress.works",
      hostname: "session.ingress.works",
      content: "203.0.113.10",
      ttl: 120
    });

    assert.equal(record.id, "existing-record");
    assert.equal(record.ttl, 120);
    assert.deepEqual(methods, ["GET", "PATCH"]);
  });

  it("creates and deletes a TXT record for DNS-01", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });

      if (url.endsWith("/zones/zone-1/dns_records")) {
        return jsonResponse({
          success: true,
          result: {
            id: "txt-1",
            zone_id: "zone-1",
            zone_name: "ingress.works",
            name: "_acme-challenge.session.ingress.works",
            type: "TXT",
            content: "challenge-token",
            ttl: 60
          }
        });
      }
      if (url.endsWith("/zones/zone-1/dns_records/txt-1")) {
        return jsonResponse({
          success: true,
          result: { id: "txt-1" }
        });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    };

    const record = await createCloudflareTxtRecord({
      apiToken: "test-token",
      zoneId: "zone-1",
      zoneName: "ingress.works",
      hostname: "_acme-challenge.session.ingress.works",
      content: "challenge-token"
    });
    await deleteCloudflareDnsRecord({
      apiToken: "test-token",
      zoneId: record.zoneId,
      recordId: record.id
    });

    assert.equal(record.type, "TXT");
    assert.equal(record.content, "challenge-token");
    assert.deepEqual(requests.map((request) => request.method), ["POST", "DELETE"]);
    assert.match(requests[0].body ?? "", /"type":"TXT"/);
  });

  it("upserts a CNAME record for external DNS validation", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });

      if (url.includes("/dns_records?")) {
        return jsonResponse({
          success: true,
          result: []
        });
      }
      if (url.endsWith("/zones/zone-1/dns_records")) {
        return jsonResponse({
          success: true,
          result: {
            id: "cname-1",
            zone_id: "zone-1",
            zone_name: "ingress.works",
            name: "abc.session.ingress.works",
            type: "CNAME",
            content: "abc.ca.example.com",
            ttl: 60
          }
        });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    };

    const record = await upsertCloudflareCnameRecord({
      apiToken: "test-token",
      zoneId: "zone-1",
      zoneName: "ingress.works",
      hostname: "ABC.Session.Ingress.Works.",
      content: "ABC.CA.Example.Com."
    });

    assert.equal(record.type, "CNAME");
    assert.equal(record.name, "abc.session.ingress.works");
    assert.equal(record.content, "abc.ca.example.com");
    // Three list calls (CNAME, A, AAAA) precede the POST so the helper
    // can clear A/AAAA records that would otherwise block a CNAME at the
    // same name (RFC 1034). Empty results -> no deletes.
    assert.deepEqual(requests.map((request) => request.method), ["GET", "GET", "GET", "POST"]);
    assert.equal(requests.filter((r) => r.method === "POST").length, 1);
    const post = requests.find((r) => r.method === "POST");
    assert.match(post?.body ?? "", /"type":"CNAME"/);
  });

  it("deletes pre-existing A records before creating a CNAME", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });

      if (method === "GET" && url.includes("type=CNAME")) {
        return jsonResponse({ success: true, result: [] });
      }
      if (method === "GET" && url.includes("type=A&")) {
        return jsonResponse({
          success: true,
          result: [
            {
              id: "a-record-1",
              zone_id: "zone-1",
              zone_name: "proof.computer",
              name: "relay-d.switchboard.proof.computer",
              type: "A",
              content: "195.22.134.246",
              ttl: 60
            }
          ]
        });
      }
      if (method === "GET" && url.includes("type=AAAA")) {
        return jsonResponse({ success: true, result: [] });
      }
      if (method === "DELETE" && url.endsWith("/zones/zone-1/dns_records/a-record-1")) {
        return jsonResponse({ success: true, result: { id: "a-record-1" } });
      }
      if (method === "POST" && url.endsWith("/zones/zone-1/dns_records")) {
        return jsonResponse({
          success: true,
          result: {
            id: "cname-1",
            zone_id: "zone-1",
            zone_name: "proof.computer",
            name: "relay-d.switchboard.proof.computer",
            type: "CNAME",
            content: "gateway.switchboard.proof.computer",
            ttl: 60
          }
        });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    };

    const record = await upsertCloudflareCnameRecord({
      apiToken: "test-token",
      zoneId: "zone-1",
      zoneName: "proof.computer",
      hostname: "relay-d.switchboard.proof.computer",
      content: "gateway.switchboard.proof.computer"
    });

    assert.equal(record.type, "CNAME");
    assert.equal(record.content, "gateway.switchboard.proof.computer");
    const methods = requests.map((r) => r.method);
    // Order: list CNAME (empty), list A (one record), DELETE that record,
    // list AAAA (empty), POST CNAME.
    assert.deepEqual(methods, ["GET", "GET", "DELETE", "GET", "POST"]);
  });

  it("PATCHes an existing CNAME without listing A/AAAA", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });

      if (method === "GET" && url.includes("type=CNAME")) {
        return jsonResponse({
          success: true,
          result: [
            {
              id: "cname-existing",
              zone_id: "zone-1",
              zone_name: "proof.computer",
              name: "relay-d.switchboard.proof.computer",
              type: "CNAME",
              content: "old-target.switchboard.proof.computer",
              ttl: 60
            }
          ]
        });
      }
      if (method === "PATCH" && url.endsWith("/zones/zone-1/dns_records/cname-existing")) {
        return jsonResponse({
          success: true,
          result: {
            id: "cname-existing",
            zone_id: "zone-1",
            zone_name: "proof.computer",
            name: "relay-d.switchboard.proof.computer",
            type: "CNAME",
            content: "gateway.switchboard.proof.computer",
            ttl: 60
          }
        });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    };

    const record = await upsertCloudflareCnameRecord({
      apiToken: "test-token",
      zoneId: "zone-1",
      zoneName: "proof.computer",
      hostname: "relay-d.switchboard.proof.computer",
      content: "gateway.switchboard.proof.computer"
    });

    assert.equal(record.content, "gateway.switchboard.proof.computer");
    // When a CNAME already exists, only the CNAME-list and the PATCH
    // are issued — the A/AAAA cleanup step is skipped.
    assert.deepEqual(requests.map((r) => r.method), ["GET", "PATCH"]);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}
