import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { runBootstrapAcurastSubcommand } from "../cli/src/bootstrap/acurast.js";
import type { runRelayDeploy } from "../cli/src/relay/index.js";

interface CapturedIo {
  log: string[];
  warn: string[];
  error: string[];
}

function makeIo(): { io: { log: (l: string) => void; warn: (l: string) => void; error: (l: string) => void }; captured: CapturedIo } {
  const captured: CapturedIo = { log: [], warn: [], error: [] };
  return {
    io: {
      log: (line) => captured.log.push(line),
      warn: (line) => captured.warn.push(line),
      error: (line) => captured.error.push(line)
    },
    captured
  };
}

const bootstrapSpec = {
  version: 1,
  relayId: "bootstrap-acurast",
  target: "acurast",
  catalogState: "candidate",
  apiBaseUrl: "https://bootstrap.switchboard.proof.computer:3000",
  peers: [],
  secrets: {
    relayerPrivateKeyEnv: "PROOF_BOOTSTRAP_RELAYER_PRIVATE_KEY",
    validationReadTokenEnv: "PROOF_VALIDATION_READ_TOKEN",
    controlPlaneTokenEnv: "PROOF_CONTROL_PLANE_TOKEN"
  },
  relay: {
    enableValidationReports: true,
    enableControlPlane: true,
    enablePeerBackfill: false,
    enableMonitoring: true,
    enableRateLimits: true
  },
  acurast: {
    deployerSeedEnv: "PROOF_ACURAST_MAINNET_DEPLOYER_SEED",
    network: "mainnet",
    projectName: "switchboard-bootstrap-acurast",
    stageDir: "dist/acurast/switchboard-bootstrap-acurast",
    maxCostPerExecution: "41999580000",
    managerId: "9470",
    instantMatchProcessors: ["5EYNfUtMgdxNQUwif5byPvzDWeMWcrv9tEnSAcsAVMuNbUHF"],
    includeEnv: [],
    executionMs: 1800000
  }
};

describe("switchboard bootstrap acurast", () => {
  let workDir: string;
  let home: string;
  let stateFile: string;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "switchboard-bootstrap-acurast-"));
    home = path.join(workDir, "home");
    stateFile = path.join(workDir, "bootstrap-state.json");
    await mkdir(home, { recursive: true });
    await writeSpec(workDir, bootstrapSpec);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("plans by delegating to relay deploy dry-run with bootstrap defaults", async () => {
    const { io, captured } = makeIo();
    let relayed: Parameters<typeof runRelayDeploy>[0] | undefined;

    await runBootstrapAcurastSubcommand({
      flags: new Map<string, string | boolean>([
        ["state-file", stateFile],
        ["port", "3000"],
        ["manager-id", "1234"]
      ]),
      positionals: ["bootstrap", "acurast", "plan", "bootstrap-acurast"],
      cwd: workDir,
      env: { SWITCHBOARD_HOME: home },
      io,
      relayDeploy: async (args) => {
        relayed = args;
        args.io?.log("relay dry-run stub");
      }
    });

    assert.equal(relayed?.positionals.join(" "), "relay deploy bootstrap-acurast");
    assert.equal(relayed?.flags.get("target"), "acurast");
    assert.equal(relayed?.flags.get("dry-run"), true);
    assert.equal(relayed?.flags.get("no-catalog"), true);
    assert.equal(relayed?.flags.get("duration"), "30m");
    assert.equal(relayed?.flags.get("manager-id"), "1234");
    assert.match(captured.log.join("\n"), /bootstrap acurast plan/);
  });

  it("rejects unsupported bootstrap ports for now", async () => {
    const { io } = makeIo();
    await assert.rejects(
      runBootstrapAcurastSubcommand({
        flags: new Map<string, string | boolean>([
          ["state-file", stateFile],
          ["port", "8080"]
        ]),
        positionals: ["bootstrap", "acurast", "plan", "bootstrap-acurast"],
        cwd: workDir,
        env: { SWITCHBOARD_HOME: home },
        io,
        relayDeploy: async () => {}
      }),
      /supports only --port 3000/
    );
  });

  it("deploys through relay deploy and records local bootstrap state", async () => {
    const { io } = makeIo();
    let relayed: Parameters<typeof runRelayDeploy>[0] | undefined;
    const now = new Date("2026-05-05T12:00:00.000Z");

    await runBootstrapAcurastSubcommand({
      flags: new Map<string, string | boolean>([
        ["state-file", stateFile],
        ["yes", true]
      ]),
      positionals: ["bootstrap", "acurast", "deploy", "bootstrap-acurast"],
      cwd: workDir,
      env: { SWITCHBOARD_HOME: home },
      io,
      now: () => now,
      relayDeploy: async (args) => {
        relayed = args;
      }
    });

    assert.equal(relayed?.flags.get("target"), "acurast");
    assert.equal(relayed?.flags.get("no-catalog"), true);
    const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>;
    assert.equal(state.kind, "acurast-direct");
    assert.equal(state.status, "active");
    assert.equal(state.endpointUrl, "https://bootstrap.switchboard.proof.computer:3000");
    assert.equal(state.expiresAt, "2026-05-05T12:30:00.000Z");
  });

  it("records and prints an explicitly selected endpoint", async () => {
    const { io, captured } = makeIo();
    await runBootstrapAcurastSubcommand({
      flags: new Map<string, string | boolean>([
        ["state-file", stateFile],
        ["url", "https://[2001:db8::1]:3000"]
      ]),
      positionals: ["bootstrap", "acurast", "use"],
      cwd: workDir,
      env: { SWITCHBOARD_HOME: home },
      io,
      now: () => new Date("2026-05-05T12:05:00.000Z")
    });

    assert.match(captured.log.join("\n"), /SWITCHBOARD_BOOTSTRAP_URL/);

    const endpointOutput = makeIo();
    await runBootstrapAcurastSubcommand({
      flags: new Map<string, string | boolean>([
        ["state-file", stateFile],
        ["json", true]
      ]),
      positionals: ["bootstrap", "acurast", "endpoint"],
      cwd: workDir,
      env: { SWITCHBOARD_HOME: home },
      io: endpointOutput.io
    });
    assert.deepEqual(JSON.parse(endpointOutput.captured.log.join("\n")), {
      ok: true,
      url: "https://[2001:db8::1]:3000"
    });
  });

  it("rejects token-bearing operations over public http unless explicitly allowed", async () => {
    const { io } = makeIo();
    await assert.rejects(
      runBootstrapAcurastSubcommand({
        flags: new Map<string, string | boolean>([
          ["state-file", stateFile],
          ["url", "http://203.0.113.10:3000"]
        ]),
        positionals: ["bootstrap", "acurast", "use"],
        cwd: workDir,
        env: { SWITCHBOARD_HOME: home },
        io
      }),
      /Refusing to use insecure bootstrap URL/
    );
  });

  it("probes bootstrap status with the saved endpoint", async () => {
    const { io, captured } = makeIo();
    await runBootstrapAcurastSubcommand({
      flags: new Map<string, string | boolean>([
        ["state-file", stateFile],
        ["url", "https://bootstrap.switchboard.proof.computer:3000"]
      ]),
      positionals: ["bootstrap", "acurast", "status"],
      cwd: workDir,
      env: { SWITCHBOARD_HOME: home },
      io,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/health")) return jsonResponse({ ok: true });
        if (url.endsWith("/v1/relay-status")) return jsonResponse({ relayId: "bootstrap-acurast" });
        if (url.endsWith("/v1/service-catalogs/relay")) {
          return jsonResponse({ catalog: { role: "relays", members: [] } });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const output = captured.log.join("\n");
    assert.match(output, /bootstrap acurast status/);
    assert.match(output, /health: ok/);
    assert.match(output, /relay-status: ok/);
  });

  it("publishes signed catalog bundles with the control-plane bearer", async () => {
    const catalogFile = path.join(workDir, "catalogs.json");
    await writeFile(catalogFile, JSON.stringify({ relays: { signature: "0x00" } }), "utf8");
    const { io, captured } = makeIo();
    const seen: Array<{ url: string; authorization: string | null; body: string | null }> = [];

    await runBootstrapAcurastSubcommand({
      flags: new Map<string, string | boolean>([
        ["state-file", stateFile],
        ["url", "https://bootstrap.switchboard.proof.computer:3000"],
        ["catalog-file", catalogFile]
      ]),
      positionals: ["bootstrap", "acurast", "publish-catalog"],
      cwd: workDir,
      env: {
        SWITCHBOARD_HOME: home,
        PROOF_CONTROL_PLANE_TOKEN: "control-token"
      },
      io,
      fetchImpl: async (input, init) => {
        seen.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
          body: typeof init?.body === "string" ? init.body : null
        });
        return jsonResponse({ ok: true });
      }
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://bootstrap.switchboard.proof.computer:3000/v1/admin/service-catalogs");
    assert.equal(seen[0].authorization, "Bearer control-token");
    assert.match(seen[0].body ?? "", /relays/);
    assert.match(captured.log.join("\n"), /Published service-catalogs/);
  });
});

async function writeSpec(workDir: string, spec: unknown): Promise<void> {
  const dir = path.join(workDir, "relays");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "bootstrap-acurast.json"), JSON.stringify(spec, null, 2), "utf8");
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
