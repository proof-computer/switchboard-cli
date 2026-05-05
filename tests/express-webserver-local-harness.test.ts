import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jobPrivateKey = `0x${"00".repeat(31)}01`;

describe("express-webserver local Acurast harness", () => {
  it("runs the packaged bundle against a fake relay and observes intent and health", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-express-local-"));
    const relay = new FakeRelay();

    try {
      await relay.start();
      const bundlePath = await buildPackagedExpressBundle(workDir);
      const preloadPath = await writeAcurastPreload(workDir);
      const jobPort = await reservePort();
      const child = spawnPackagedJob(bundlePath, preloadPath, relay.runtimeEnv(jobPort));

      await waitFor(
        () =>
          relay.claims.length > 0 &&
          relay.health.some((body) => body.state === "waiting_funding"),
        6_000,
        () => childOutput(child)
      );

      const page = await fetchText(`http://127.0.0.1:${jobPort}/`);
      assert.match(page, /proof-wordmark">PROOF<span class="dot">\.<\/span>/);
      assert.match(page, /Switchboard · Acurast webserver/);
      assert.match(page, /Running on <span class="acurast-accent">Acurast,/);
      assert.match(page, /TLS Certificate/);
      assert.match(page, /Hub Registration/);
      assert.match(page, /Acurast Runtime/);
      assert.doesNotMatch(page, /Live proof/);
      assert.doesNotMatch(page, /Challenge served/);

      const exit = await waitForExit(child, 3_000);
      if (!exit) {
        child.process.kill("SIGTERM");
        await waitForExit(child, 1_000);
      } else {
        assert.equal(exit.code, 0, childOutput(child));
      }

      assert.equal(relay.claims[0]?.acurastJobId, "local-acurast-job-123");
      assert.equal(relay.claims[0]?.signerMode, "private-key");
      assert.match(String(relay.claims[0]?.runtimeSigner), /^0x[0-9a-fA-F]{40}$/);
      assert.ok(Array.isArray(relay.claims[0]?.upstreamIps));
    } finally {
      await relay.close();
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("refuses prebuilt prepare when intent build config is not mirrored into runtime env", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-express-prepare-"));

    try {
      const bundlePath = await buildPackagedExpressBundle(workDir);
      const configPath = path.join(workDir, "acurast-config.json");
      const stageDir = path.join(workDir, "stage");
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            PORT: "3443",
            SWITCHBOARD_HOST: "0.0.0.0",
            SWITCHBOARD_RELAY_URL: "https://relay-a.switchboard.proof.computer",
            SWITCHBOARD_INTENT_ID: "di_local"
          },
          null,
          2
        )}\n`
      );

      const run = spawnNode([
        "--import",
        "tsx",
        path.join(repoRoot, "scripts/acurast/express-harness.ts"),
        "prepare",
        "--stage-dir",
        stageDir
      ], {
        ACURAST_COMPACT_ENV: "true",
        SWITCHBOARD_BUILD_CONFIG_FILE: configPath,
        SWITCHBOARD_PREBUILT_JOB_BUNDLE: bundlePath,
        SWITCHBOARD_WORK_DIR: repoRoot
      });
      const exit = await run.exit;

      assert.notEqual(exit.code, 0, childOutput(run));
      assert.match(childOutput(run), /Prebuilt Acurast job bundles cannot read SWITCHBOARD_BUILD_CONFIG_FILE at runtime/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("builds the configured project entrypoint when packaged assets are present", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-express-custom-entrypoint-"));

    try {
      const assetsDir = path.join(workDir, "assets");
      const stageDir = path.join(workDir, "stage");
      await mkdir(path.join(assetsDir, "jobs", "express-webserver"), { recursive: true });
      await mkdir(path.join(workDir, "src"), { recursive: true });
      await writeFile(
        path.join(assetsDir, "jobs", "express-webserver", "bundle.cjs"),
        "console.log('BUILT_IN_PACKAGE_SENTINEL');\n"
      );
      await writeFile(
        path.join(workDir, "src", "server.ts"),
        "globalThis.__SWITCHBOARD_DX_CUSTOM_SENTINEL = 'CUSTOM_PROJECT_SENTINEL';\n"
      );

      const run = spawnNode([
        "--import",
        "tsx",
        path.join(repoRoot, "scripts/acurast/express-harness.ts"),
        "prepare",
        "--stage-dir",
        stageDir
      ], {
        ACURAST_ENTRYPOINT: "src/server.ts",
        SWITCHBOARD_WORK_DIR: workDir,
        SWITCHBOARD_PACKAGED_ASSETS_DIR: assetsDir
      });
      const exit = await run.exit;

      assert.equal(exit.code, 0, childOutput(run));
      const bundle = await readFile(path.join(stageDir, "dist", "bundle.cjs"), "utf8");
      assert.match(bundle, /CUSTOM_PROJECT_SENTINEL/);
      assert.doesNotMatch(bundle, /BUILT_IN_PACKAGE_SENTINEL/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("rejects custom entrypoints with top-level await before upload", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-express-tla-entrypoint-"));

    try {
      const stageDir = path.join(workDir, "stage");
      await mkdir(path.join(workDir, "src"), { recursive: true });
      await writeFile(path.join(workDir, "src", "server.ts"), "await Promise.resolve();\n");

      const run = spawnNode([
        "--import",
        "tsx",
        path.join(repoRoot, "scripts/acurast/express-harness.ts"),
        "prepare",
        "--stage-dir",
        stageDir
      ], {
        ACURAST_ENTRYPOINT: "src/server.ts",
        SWITCHBOARD_WORK_DIR: workDir
      });
      const exit = await run.exit;

      assert.notEqual(exit.code, 0, childOutput(run));
      assert.match(childOutput(run), /Acurast NodeJSWithBundle loads project bundles with require\(\)/);
      assert.match(childOutput(run), /top-level await is not supported/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

class FakeRelay {
  readonly intentId = "di_local";
  readonly intentToken = "intent-token";
  readonly claims: Array<Record<string, unknown>> = [];
  readonly health: Array<Record<string, unknown>> = [];

  private server = http.createServer((request, response) => {
    void this.handle(request, response);
  });
  private baseUrl?: string;

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        assert.ok(address && typeof address === "object");
        this.baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    }).catch(() => undefined);
  }

  runtimeEnv(port = 0): Record<string, string> {
    return {
      SWITCHBOARD_CONFIG: JSON.stringify({
        PORT: String(port),
        SWITCHBOARD_HOST: "127.0.0.1",
        SWITCHBOARD_RELAY_URL: this.url,
        SWITCHBOARD_INTENT_ID: this.intentId,
        SWITCHBOARD_INTENT_TOKEN: this.intentToken,
        SWITCHBOARD_INTENT_POLL_MS: "20",
        SWITCHBOARD_INTENT_MAX_ATTEMPTS: "1",
        SWITCHBOARD_INTENT_REQUEST_TIMEOUT_MS: "1000",
        SWITCHBOARD_EXIT_AFTER_MS: "1200"
      }),
      JOB_SIGNER_PRIVATE_KEY: jobPrivateKey
    };
  }

  private get url(): string {
    assert.ok(this.baseUrl, "fake relay has not started");
    return this.baseUrl;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", this.url);
      const body = request.method === "POST" ? await readJsonBody(request) : {};
      const intentPrefix = `/v1/deployment-intents/${encodeURIComponent(this.intentId)}`;

      if (url.pathname === `${intentPrefix}/claim` && request.method === "POST") {
        this.assertBearer(request, this.intentToken);
        this.claims.push(asRecord(body));
        writeJsonResponse(response, 200, { ok: true });
        return;
      }

      if (url.pathname === `${intentPrefix}/health` && request.method === "POST") {
        this.assertBearer(request, this.intentToken);
        this.health.push(asRecord(body));
        writeJsonResponse(response, 200, { ok: true });
        return;
      }

      if (url.pathname === `${intentPrefix}/runtime-config` && request.method === "GET") {
        this.assertBearer(request, this.intentToken);
        writeJsonResponse(response, 202, {
          ok: false,
          state: "waiting_funding",
          intent: { status: "deploy_submitted" }
        });
        return;
      }

      writeJsonResponse(response, 404, { ok: false, error: "not found" });
    } catch (error) {
      writeJsonResponse(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private assertBearer(request: IncomingMessage, token: string): void {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
  }
}

async function reservePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.text();
}

async function buildPackagedExpressBundle(workDir: string): Promise<string> {
  const outfile = path.join(workDir, "bundle.cjs");
  await build({
    entryPoints: [path.join(repoRoot, "src/jobs/express-webserver.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: false,
    minify: true,
    legalComments: "none",
    define: {
      __SWITCHBOARD_BUILD_CONFIG__: "process.env.SWITCHBOARD_BUILD_CONFIG"
    },
    logLevel: "silent"
  });
  return outfile;
}

async function writeAcurastPreload(workDir: string): Promise<string> {
  const preloadPath = path.join(workDir, "acurast-preload.cjs");
  await writeFile(
    preloadPath,
    `
globalThis._STD_ = {
  env: {},
  job: { getId: () => "local-acurast-job-123" },
  net: { addAllowedHostnames: async () => undefined },
  app_info: { version: "local-harness" }
};
globalThis.environment = (name) => process.env[name];
`.trimStart()
  );
  return preloadPath;
}

function spawnPackagedJob(bundlePath: string, preloadPath: string, env: Record<string, string>): SpawnedProcess {
  return spawnNode(["--require", preloadPath, bundlePath], env);
}

function spawnNode(args: string[], env: Record<string, string>): SpawnedProcess {
  const output = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: {
      ...baseChildEnv(),
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output.stderr += chunk;
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { process: child, output, exit };
}

function baseChildEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: "test"
  };
}

async function waitForExit(
  child: SpawnedProcess,
  timeoutMs: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | undefined> {
  return Promise.race([
    child.exit,
    sleep(timeoutMs).then(() => undefined)
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number, debug: () => string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (condition()) {
      return;
    }
    await sleep(25);
  }
  assert.fail(`Timed out waiting for local express job harness\n${debug()}`);
}

function childOutput(child: SpawnedProcess): string {
  return [
    "--- stdout ---",
    child.output.stdout.trim(),
    "--- stderr ---",
    child.output.stderr.trim()
  ].join("\n");
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve(text ? JSON.parse(text) : {});
    });
    request.on("error", reject);
  });
}

function writeJsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SpawnedProcess {
  process: ChildProcess;
  output: {
    stdout: string;
    stderr: string;
  };
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}
