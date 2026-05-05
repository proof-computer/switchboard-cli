import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { contextDnsClearCommand, contextDnsSetCommand } from "../cli/src/context/dns.js";

describe("switchboard context dns set", () => {
  let workDir: string;
  const originalHome = process.env.SWITCHBOARD_HOME;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "switchboard-context-dns-"));
    process.env.SWITCHBOARD_HOME = workDir;
  });

  after(async () => {
    if (originalHome === undefined) {
      delete process.env.SWITCHBOARD_HOME;
    } else {
      process.env.SWITCHBOARD_HOME = originalHome;
    }
    await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await writeFile(
      path.join(workDir, "contexts.json"),
      JSON.stringify(
        {
          current: "demo",
          contexts: {
            demo: { acurastSeedEnv: "ACURAST_MAINNET_SEED" }
          }
        },
        null,
        2
      )
    );
  });

  it("attaches the cloudflare token env to the current context", async () => {
    const flags = new Map<string, string | boolean>([
      ["token-env", "CF_TOKEN_PROD"],
      ["json", true]
    ]);
    await contextDnsSetCommand(flags, ["context", "dns", "set", "cloudflare"]);
    const stored = JSON.parse(await readFile(path.join(workDir, "contexts.json"), "utf8"));
    assert.equal(stored.contexts.demo.cloudflareApiTokenEnv, "CF_TOKEN_PROD");
  });

  it("targets a named context with --context", async () => {
    await writeFile(
      path.join(workDir, "contexts.json"),
      JSON.stringify(
        {
          current: "demo",
          contexts: {
            demo: { acurastSeedEnv: "X" },
            staging: { acurastSeedEnv: "Y" }
          }
        },
        null,
        2
      )
    );
    const flags = new Map<string, string | boolean>([
      ["token-env", "CF_STAGING"],
      ["context", "staging"],
      ["json", true]
    ]);
    await contextDnsSetCommand(flags, ["context", "dns", "set", "cloudflare"]);
    const stored = JSON.parse(await readFile(path.join(workDir, "contexts.json"), "utf8"));
    assert.equal(stored.contexts.demo.cloudflareApiTokenEnv, undefined);
    assert.equal(stored.contexts.staging.cloudflareApiTokenEnv, "CF_STAGING");
  });

  it("rejects unsupported providers", async () => {
    const flags = new Map<string, string | boolean>([
      ["token-env", "X"],
      ["json", true]
    ]);
    await assert.rejects(
      () => contextDnsSetCommand(flags, ["context", "dns", "set", "route53"]),
      /Unsupported DNS provider/
    );
  });

  it("rejects missing --token-env", async () => {
    const flags = new Map<string, string | boolean>([["json", true]]);
    await assert.rejects(
      () => contextDnsSetCommand(flags, ["context", "dns", "set", "cloudflare"]),
      /token-env/
    );
  });

  it("rejects when no context is selected", async () => {
    await writeFile(
      path.join(workDir, "contexts.json"),
      JSON.stringify({ contexts: {} }, null, 2)
    );
    const flags = new Map<string, string | boolean>([
      ["token-env", "X"],
      ["json", true]
    ]);
    await assert.rejects(
      () => contextDnsSetCommand(flags, ["context", "dns", "set", "cloudflare"]),
      /context/
    );
  });

  it("clears the cloudflare token env from the context", async () => {
    await writeFile(
      path.join(workDir, "contexts.json"),
      JSON.stringify(
        {
          current: "demo",
          contexts: { demo: { cloudflareApiTokenEnv: "CF_TOKEN_PROD" } }
        },
        null,
        2
      )
    );
    const flags = new Map<string, string | boolean>([["json", true]]);
    await contextDnsClearCommand(flags, ["context", "dns", "clear", "cloudflare"]);
    const stored = JSON.parse(await readFile(path.join(workDir, "contexts.json"), "utf8"));
    assert.equal(stored.contexts.demo.cloudflareApiTokenEnv, undefined);
  });
});
