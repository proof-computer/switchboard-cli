import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { applyRelayDns, removeRelayDns, runRelayDnsSubcommand } from "../cli/src/relay/dns.js";

const originalFetch = globalThis.fetch;

interface Captured {
  log: string[];
  warn: string[];
  error: string[];
}

function makeIo(): { io: { log: (l: string) => void; warn: (l: string) => void; error: (l: string) => void }; captured: Captured } {
  const captured: Captured = { log: [], warn: [], error: [] };
  return {
    io: {
      log: (line) => captured.log.push(line),
      warn: (line) => captured.warn.push(line),
      error: (line) => captured.error.push(line)
    },
    captured
  };
}

function makeSpec(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    relayId: "relay-d",
    target: "acurast",
    catalogState: "candidate",
    apiBaseUrl: "https://relay-d.switchboard.proof.computer",
    secrets: { relayerPrivateKeyEnv: "PROOF_MAINNET_RELAY_D_RECORDER_PRIVATE_KEY" },
    acurast: {
      deployerSeedEnv: "PROOF_ACURAST_MAINNET_DEPLOYER_SEED",
      projectName: "switchboard-mainnet-relay-d",
      stageDir: "dist/acurast/switchboard-mainnet-relay-d",
      maxCostPerExecution: 41_999_580_000
    },
    dns: {
      provider: "cloudflare",
      cnameTarget: "gateway.switchboard.proof.computer"
    },
    ...overrides
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function cloudflareEnv(apiToken = "tk"): NodeJS.ProcessEnv {
  return {
    CLOUDFLARE_API_TOKEN: apiToken,
    CLOUDFLARE_ZONE_NAMES: "proof.computer,ingress.works"
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("relay dns helpers", () => {
  it("applyRelayDns upserts a CNAME with the expected target", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (method === "GET" && url.includes("/zones?name=proof.computer")) {
        return jsonResponse({ success: true, result: [{ id: "zone-proof", name: "proof.computer" }] });
      }
      if (method === "GET" && url.includes("type=CNAME")) return jsonResponse({ success: true, result: [] });
      if (method === "GET" && url.includes("type=A&")) return jsonResponse({ success: true, result: [] });
      if (method === "GET" && url.includes("type=AAAA")) return jsonResponse({ success: true, result: [] });
      if (method === "POST" && url.endsWith("/zones/zone-proof/dns_records")) {
        return jsonResponse({
          success: true,
          result: {
            id: "cname-1",
            zone_id: "zone-proof",
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

    const spec = makeSpec();
    const result = await applyRelayDns(JSON.parse(JSON.stringify(spec)) as never, cloudflareEnv("test-token"));
    assert.equal(result.hostname, "relay-d.switchboard.proof.computer");
    assert.equal(result.cnameTarget, "gateway.switchboard.proof.computer");
    assert.equal(result.record.type, "CNAME");
    assert.equal(result.record.content, "gateway.switchboard.proof.computer");
    const post = requests.find((r) => r.method === "POST");
    assert.match(post?.body ?? "", /"type":"CNAME"/);
    assert.match(post?.body ?? "", /"content":"gateway.switchboard.proof.computer"/);
  });

  it("applyRelayDns clears a pre-existing A record before creating the CNAME", async () => {
    const methods: string[] = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "GET" && url.includes("/zones?name=proof.computer")) {
        return jsonResponse({ success: true, result: [{ id: "zone-proof", name: "proof.computer" }] });
      }
      if (method === "GET" && url.includes("type=CNAME")) return jsonResponse({ success: true, result: [] });
      if (method === "GET" && url.includes("type=A&")) {
        return jsonResponse({
          success: true,
          result: [
            {
              id: "a-rec",
              zone_id: "zone-proof",
              zone_name: "proof.computer",
              name: "relay-d.switchboard.proof.computer",
              type: "A",
              content: "195.22.134.246",
              ttl: 60
            }
          ]
        });
      }
      if (method === "DELETE" && url.endsWith("/zones/zone-proof/dns_records/a-rec")) {
        return jsonResponse({ success: true, result: { id: "a-rec" } });
      }
      if (method === "GET" && url.includes("type=AAAA")) return jsonResponse({ success: true, result: [] });
      if (method === "POST" && url.endsWith("/zones/zone-proof/dns_records")) {
        return jsonResponse({
          success: true,
          result: {
            id: "cname-2",
            zone_id: "zone-proof",
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

    await applyRelayDns(JSON.parse(JSON.stringify(makeSpec())) as never, cloudflareEnv());
    // zone lookup, list CNAME, list A, DELETE, list AAAA, POST
    assert.deepEqual(methods, ["GET", "GET", "GET", "DELETE", "GET", "POST"]);
  });

  it("applyRelayDns refuses to run without CLOUDFLARE_API_TOKEN", async () => {
    await assert.rejects(
      () => applyRelayDns(JSON.parse(JSON.stringify(makeSpec())) as never, {}),
      /CLOUDFLARE_API_TOKEN is required/
    );
  });

  it("applyRelayDns refuses when spec has no dns block", async () => {
    const noDns = makeSpec({ dns: undefined });
    delete (noDns as { dns?: unknown }).dns;
    await assert.rejects(
      () => applyRelayDns(JSON.parse(JSON.stringify(noDns)) as never, cloudflareEnv()),
      /no dns block/
    );
  });

  it("removeRelayDns deletes the CNAME if present", async () => {
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/zones?name=proof.computer")) {
        return jsonResponse({ success: true, result: [{ id: "zone-proof", name: "proof.computer" }] });
      }
      if (method === "GET" && url.includes("type=CNAME")) {
        return jsonResponse({
          success: true,
          result: [
            {
              id: "cname-doomed",
              zone_id: "zone-proof",
              zone_name: "proof.computer",
              name: "relay-d.switchboard.proof.computer",
              type: "CNAME",
              content: "gateway.switchboard.proof.computer"
            }
          ]
        });
      }
      if (method === "DELETE" && url.endsWith("/zones/zone-proof/dns_records/cname-doomed")) {
        return jsonResponse({ success: true, result: { id: "cname-doomed" } });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    };

    const result = await removeRelayDns(JSON.parse(JSON.stringify(makeSpec())) as never, cloudflareEnv());
    assert.equal(result.removedRecordId, "cname-doomed");
  });

  it("removeRelayDns is a no-op when no CNAME exists", async () => {
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/zones?name=proof.computer")) {
        return jsonResponse({ success: true, result: [{ id: "zone-proof", name: "proof.computer" }] });
      }
      if (method === "GET" && url.includes("type=CNAME")) {
        return jsonResponse({ success: true, result: [] });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    };

    const result = await removeRelayDns(JSON.parse(JSON.stringify(makeSpec())) as never, cloudflareEnv());
    assert.equal(result.removedRecordId, undefined);
  });
});

describe("relay dns CLI subcommand", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "relay-dns-cli-"));
    await mkdir(path.join(tmp, "relays"), { recursive: true });
    await writeFile(path.join(tmp, "relays", "relay-d.json"), JSON.stringify(makeSpec(), null, 2), "utf8");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("plan prints a no-op message for a spec without a dns block", async () => {
    const noDns = makeSpec({ dns: undefined });
    delete (noDns as { dns?: unknown }).dns;
    await writeFile(path.join(tmp, "relays", "relay-d.json"), JSON.stringify(noDns, null, 2), "utf8");
    const { io, captured } = makeIo();
    await runRelayDnsSubcommand({
      flags: new Map(),
      positionals: ["relay", "dns", "plan", "relay-d"],
      cwd: tmp,
      env: {},
      io
    });
    assert.ok(captured.log.some((line) => line.includes("(no dns block in spec")));
  });

  it("apply uses the spec to write a CNAME in the proof.computer Cloudflare zone", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (method === "GET" && url.includes("/zones?name=proof.computer")) {
        return jsonResponse({ success: true, result: [{ id: "zone-proof", name: "proof.computer" }] });
      }
      if (method === "GET" && url.includes("type=CNAME")) return jsonResponse({ success: true, result: [] });
      if (method === "GET" && url.includes("type=A&")) return jsonResponse({ success: true, result: [] });
      if (method === "GET" && url.includes("type=AAAA")) return jsonResponse({ success: true, result: [] });
      if (method === "POST") {
        return jsonResponse({
          success: true,
          result: {
            id: "cname-x",
            zone_id: "zone-proof",
            zone_name: "proof.computer",
            name: "relay-d.switchboard.proof.computer",
            type: "CNAME",
            content: "gateway.switchboard.proof.computer",
            ttl: 60
          }
        });
      }
      throw new Error(`Unexpected ${method} ${url}`);
    };

    const { io, captured } = makeIo();
    await runRelayDnsSubcommand({
      flags: new Map(),
      positionals: ["relay", "dns", "apply", "relay-d"],
      cwd: tmp,
      env: cloudflareEnv(),
      io
    });
    assert.ok(captured.log.some((line) => line.includes("recordId    : cname-x")));
    assert.ok(captured.log.some((line) => line.includes("cnameTarget : gateway.switchboard.proof.computer")));
  });

  it("rejects unknown verbs and invalid relay ids", async () => {
    await assert.rejects(
      () =>
        runRelayDnsSubcommand({
          flags: new Map(),
          positionals: ["relay", "dns", "explode", "relay-d"],
          cwd: tmp,
          env: {}
        }),
      /Usage: switchboard relay dns/
    );
    await assert.rejects(
      () =>
        runRelayDnsSubcommand({
          flags: new Map(),
          positionals: ["relay", "dns", "apply", "BAD ID"],
          cwd: tmp,
          env: cloudflareEnv()
        }),
      /relay-id must be lowercase/
    );
  });
});
