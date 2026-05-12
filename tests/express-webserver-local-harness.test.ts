import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jobPrivateKey = `0x${"00".repeat(31)}01`;

describe("express-webserver local Acurast harness", () => {
  it("builds the configured project entrypoint when packaged assets are present", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-express-custom-entrypoint-"));

    try {
      const assetsDir = path.join(workDir, "assets");
      const stageDir = path.join(workDir, "stage");
      await mkdir(path.join(assetsDir, "jobs", "validator-job"), { recursive: true });
      await mkdir(path.join(workDir, "src"), { recursive: true });
      await writeFile(
        path.join(assetsDir, "jobs", "validator-job", "bundle.cjs"),
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

  it("terminates hung Acurast CLI child trees after success output", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-acurast-runner-"));
    const stageDir = path.join(workDir, "stage");
    const bundlePath = path.join(workDir, "bundle.cjs");
    const fakeNpx = path.join(workDir, "fake-npx.cjs");
    const grandchildPidPath = path.join(workDir, "grandchild.pid");
    let run: SpawnedProcess | undefined;

    try {
      await writeFile(bundlePath, "console.log('prebuilt bundle');\n");
      await writeFile(
        fakeNpx,
        `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);"], {
  stdio: "ignore"
});
if (process.env.FAKE_NPX_GRANDCHILD_PID) {
  writeFileSync(process.env.FAKE_NPX_GRANDCHILD_PID, String(grandchild.pid));
}
process.on("SIGTERM", () => {});
console.log("environment variables set");
setInterval(() => {}, 1000);
`.trimStart()
      );
      await chmod(fakeNpx, 0o755);

      run = spawnNode([
        "--import",
        "tsx",
        path.join(repoRoot, "scripts/acurast/express-harness.ts"),
        "update-env",
        "--deployment-id",
        "123",
        "--stage-dir",
        stageDir
      ], {
        ACURAST_CANARY_SEED: "bottom drive obey lake curtain smoke basket hold race lonely fit walk",
        ACURAST_CLI_PACKAGE: "fake-acurast-cli",
        ACURAST_CLI_TERMINATE_GRACE_MS: "100",
        FAKE_NPX_GRANDCHILD_PID: grandchildPidPath,
        NPX_BINARY: fakeNpx,
        SWITCHBOARD_PREBUILT_JOB_BUNDLE: bundlePath,
        SWITCHBOARD_WORK_DIR: repoRoot,
        ACURAST_EXPLICIT_ENV_ONLY: "true",
        ACURAST_INCLUDE_ENV: "VALIDATOR_DEPLOYMENT_ID,VALIDATOR_ACURAST_JOB_ID",
        VALIDATOR_DEPLOYMENT_ID: "123",
        VALIDATOR_ACURAST_JOB_ID: "job-123"
      });
      const currentRun = run;
      const exit = await waitForExit(currentRun, 12_000);

      assert.ok(exit, childOutput(currentRun));
      assert.equal(exit.code, 0, childOutput(currentRun));
      assert.match(childOutput(currentRun), /environment variables set/);
      const stagedEnv = await readFile(path.join(stageDir, ".env"), "utf8");
      assert.match(stagedEnv, /^VALIDATOR_DEPLOYMENT_ID="123"$/m);
      assert.match(stagedEnv, /^VALIDATOR_ACURAST_JOB_ID="job-123"$/m);

      const grandchildPid = Number((await readFile(grandchildPidPath, "utf8")).trim());
      await waitFor(async () => !processAlive(grandchildPid), 3_000, () => childOutput(currentRun));
    } finally {
      if (run) {
        run.process.kill("SIGKILL");
      }
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

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number, debug: () => string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (await condition()) {
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
