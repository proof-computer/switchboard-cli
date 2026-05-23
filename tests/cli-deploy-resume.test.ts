import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { runSwitchboardDeployResume, runSwitchboardDeployStatus } from "../cli/src/index.js";
import { signNetworkManifest, type NetworkManifest } from "../src/network-manifest.js";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(cliRoot, "cli/src/index.ts");
const manifestSignerSeed = "//Alice//switchboard-network-manifest";
const workflowSnapshotFile = "switchboard-deploy-workflow.snapshot.json";
const privateSnapshotFile = "switchboard-deploy-workflow.private.json";

describe("switchboard deploy resume/status", () => {
  it("resumes deploy_action_required without creating a second intent", async () => {
    await withControlPlane(async ({ baseUrl, manifestSigner: _manifestSigner, requests }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-resume-deploy-action-"));
      try {
        const runDir = path.join(cwd, "run");
        await mkdir(runDir, { recursive: true });
        const snapshot = deploySnapshot({ baseUrl, step: "deploy_action_required" });
        await writePrivateSnapshot(runDir, snapshot);
        const fakeBin = path.join(cwd, "fake-bin");
        await mkdir(fakeBin, { recursive: true });
        await writeFakePnpm(path.join(fakeBin, "pnpm"), path.join(cwd, "funding-observed.json"));

        const result = await runCli(cwd, ["deploy", "resume", "--yes", "--json", "--run-dir", runDir], {
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          SWITCHBOARD_FAKE_ACURAST_SDK_SUBMIT_JSON: JSON.stringify({ deploymentId: "63500", txHash: "0xdeploy" })
        });

        assert.equal(result.code, 0, result.stderr);
        assert.equal(requests.createIntent.length, 0);
        assert.equal(requests.deploymentUpdate.length, 1);
        const output = JSON.parse(result.stdout);
        assert.equal(output.action, "deploy-resume");
        assert.equal(output.phase, "complete");
        const privateSnapshot = JSON.parse(await readFile(path.join(runDir, privateSnapshotFile), "utf8"));
        assert.equal(privateSnapshot.step, "complete");
        assert.equal(privateSnapshot.data.deploymentIntent.cliToken, "intent-token-original");
        const redactedSnapshot = JSON.parse(await readFile(path.join(runDir, workflowSnapshotFile), "utf8"));
        assert.equal(redactedSnapshot.data.deploymentIntent.cliToken, "[redacted]");
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it("resumes runtime_claimed using the original intent token for quote and funding", async () => {
    await withControlPlane(async ({ baseUrl, requests }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-resume-runtime-claimed-"));
      try {
        const runDir = path.join(cwd, "run");
        await mkdir(runDir, { recursive: true });
        await writePrivateSnapshot(runDir, deploySnapshot({ baseUrl, step: "runtime_claimed" }));
        const observedPath = path.join(cwd, "funding-observed.json");
        const fakeBin = path.join(cwd, "fake-bin");
        await mkdir(fakeBin, { recursive: true });
        await writeFakePnpm(path.join(fakeBin, "pnpm"), observedPath);

        const result = await runCli(cwd, ["deploy", "resume", "--yes", "--json", "--run-dir", runDir], {
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`
        });

        assert.equal(result.code, 0, result.stderr);
        assert.equal(requests.createIntent.length, 0);
        const observations = JSON.parse(await readFile(observedPath, "utf8"));
        assert.deepEqual(observations.map((item: Record<string, unknown>) => item.token), ["intent-token-original", "intent-token-original"]);
        assert.deepEqual(observations.map((item: Record<string, unknown>) => item.dryRun), [true, false]);
        const output = JSON.parse(result.stdout);
        assert.equal(output.phase, "complete");
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it("hydrates a redacted snapshot from report-local secret state", async () => {
    await withControlPlane(async ({ baseUrl }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-resume-hydrate-"));
      try {
        const runDir = path.join(cwd, "run");
        await mkdir(runDir, { recursive: true });
        const snapshot = redactSnapshot(deploySnapshot({ baseUrl, step: "runtime_claimed" }));
        await writeFile(path.join(runDir, workflowSnapshotFile), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
        await writeFile(path.join(runDir, "report.json"), `${JSON.stringify(deployReport({ baseUrl }), null, 2)}\n`, "utf8");
        const fakeBin = path.join(cwd, "fake-bin");
        await mkdir(fakeBin, { recursive: true });
        await writeFakePnpm(path.join(fakeBin, "pnpm"), path.join(cwd, "funding-observed.json"));

        const result = await runCli(cwd, ["deploy", "resume", "--yes", "--json", "--run-dir", runDir], {
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`
        });

        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.phase, "complete");
        assert.equal(output.warnings.some((warning: string) => warning.includes("Hydrated")), true);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it("fails cleanly when only a redacted token is available", async () => {
    await withControlPlane(async ({ baseUrl }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-resume-missing-token-"));
      try {
        const runDir = path.join(cwd, "run");
        await mkdir(runDir, { recursive: true });
        await writeFile(path.join(runDir, workflowSnapshotFile), `${JSON.stringify(redactSnapshot(deploySnapshot({ baseUrl, step: "runtime_claimed" })), null, 2)}\n`, "utf8");

        const result = await runCli(cwd, ["deploy", "resume", "--yes", "--json", "--run-dir", runDir]);

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /Missing unredacted deployment intent token/);
        assert.match(result.stderr, /switchboard-deploy-workflow.private.json/);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it("reports status with no POST, deploy, or funding side effects", async () => {
    await withControlPlane(async ({ baseUrl, requests }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-deploy-status-"));
      try {
        const runDir = path.join(cwd, "run");
        await mkdir(runDir, { recursive: true });
        await writePrivateSnapshot(runDir, deploySnapshot({ baseUrl, step: "runtime_claimed" }));

        const result = await runCli(cwd, ["deploy", "status", "--json", "--run-dir", runDir]);

        assert.equal(result.code, 0, result.stderr);
        assert.equal(requests.createIntent.length, 0);
        assert.equal(requests.deploymentUpdate.length, 0);
        assert.equal(requests.fundingRefresh.length, 0);
        assert.equal(requests.routeRefresh.length, 0);
        assert.equal(requests.intentRead.length, 1);
        const output = JSON.parse(result.stdout);
        assert.equal(output.action, "deploy-status");
        assert.equal(output.phase, "runtime claimed");
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it("exports a shared deploy status runner for native plugin reuse", async () => {
    await withControlPlane(async ({ baseUrl, requests }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-deploy-status-runner-"));
      const originalLog = console.log;
      const lines: string[] = [];
      console.log = (line?: unknown) => {
        lines.push(String(line ?? ""));
      };
      try {
        const runDir = path.join(cwd, "run");
        await mkdir(runDir, { recursive: true });
        await writePrivateSnapshot(runDir, deploySnapshot({ baseUrl, step: "runtime_claimed" }));

        await runSwitchboardDeployStatus(["--json", "--run-dir", runDir], {
          projectRoot: cwd,
          contextStorePath: path.join(cwd, ".switchboard-home", "contexts.json")
        });

        assert.equal(requests.createIntent.length, 0);
        assert.equal(requests.deploymentUpdate.length, 0);
        assert.equal(requests.fundingRefresh.length, 0);
        assert.equal(requests.routeRefresh.length, 0);
        assert.equal(requests.intentRead.length, 1);
        const output = JSON.parse(lines.join("\n"));
        assert.equal(output.action, "deploy-status");
        assert.equal(output.phase, "runtime claimed");
      } finally {
        console.log = originalLog;
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it("exports a shared deploy resume runner for native plugin reuse", async () => {
    await withControlPlane(async ({ baseUrl, requests }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-deploy-resume-runner-"));
      const originalLog = console.log;
      const lines: string[] = [];
      console.log = (line?: unknown) => {
        lines.push(String(line ?? ""));
      };
      try {
        const runDir = path.join(cwd, "run");
        await mkdir(runDir, { recursive: true });
        await writePrivateSnapshot(runDir, deploySnapshot({ baseUrl, step: "complete" }));

        await runSwitchboardDeployResume(["--yes", "--json", "--run-dir", runDir], {
          projectRoot: cwd,
          contextStorePath: path.join(cwd, ".switchboard-home", "contexts.json")
        });

        assert.equal(requests.createIntent.length, 0);
        assert.equal(requests.deploymentUpdate.length, 0);
        assert.equal(requests.fundingRefresh.length, 0);
        assert.equal(requests.routeRefresh.length, 0);
        assert.equal(requests.intentRead.length, 1);
        const output = JSON.parse(lines.join("\n"));
        assert.equal(output.action, "deploy-resume");
        assert.equal(output.phase, "complete");
      } finally {
        console.log = originalLog;
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it("refuses late funding unless --allow-late-funding is present", async () => {
    await withControlPlane(async ({ baseUrl }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-resume-late-funding-"));
      try {
        const runDir = path.join(cwd, "run");
        await mkdir(runDir, { recursive: true });
        await writePrivateSnapshot(runDir, deploySnapshot({ baseUrl, step: "quote_ready", schedule: expiredStartWindowSchedule() }));
        const observedPath = path.join(cwd, "funding-observed.json");
        const fakeBin = path.join(cwd, "fake-bin");
        await mkdir(fakeBin, { recursive: true });
        await writeFakePnpm(path.join(fakeBin, "pnpm"), observedPath);

        const refused = await runCli(cwd, ["deploy", "resume", "--yes", "--json", "--run-dir", runDir], {
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`
        });
        assert.notEqual(refused.code, 0);
        assert.match(refused.stderr, /Refusing late funding/);
        await assert.rejects(readFile(observedPath, "utf8"));

        const allowed = await runCli(cwd, ["deploy", "resume", "--yes", "--allow-late-funding", "--json", "--run-dir", runDir], {
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`
        });
        assert.equal(allowed.code, 0, allowed.stderr);
        assert.equal(JSON.parse(allowed.stdout).phase, "complete");
        const observations = JSON.parse(await readFile(observedPath, "utf8"));
        assert.equal(observations.at(-1).token, "intent-token-original");
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });
});

async function withControlPlane(
  fn: (input: {
    baseUrl: string;
    manifestSigner: string;
    requests: {
      createIntent: Record<string, unknown>[];
      deploymentUpdate: Record<string, unknown>[];
      fundingRefresh: string[];
      routeRefresh: string[];
      intentRead: string[];
    };
  }) => Promise<void>
): Promise<void> {
  let signedManifest: unknown;
  const requests = {
    createIntent: [] as Record<string, unknown>[],
    deploymentUpdate: [] as Record<string, unknown>[],
    fundingRefresh: [] as string[],
    routeRefresh: [] as string[],
    intentRead: [] as string[]
  };
  const intents = new Map<string, Record<string, unknown>>();
  intents.set("di_existing", {
    intentId: "di_existing",
    jobId: hex32("33"),
    operatorId: hex32("aa"),
    processorId: hex32("11"),
    gatewayId: "gateway-resume",
    runtimeSigner: "0x5000000000000000000000000000000000000005",
    upstreamIps: ["203.0.113.10"],
    status: "claimed"
  });

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = new URL(request.url ?? "/", baseUrl);
    if (url.pathname === "/v1/network-manifest") {
      sendJson(response, signedManifest);
      return;
    }
    if (url.pathname === "/v1/deployment-intents" && request.method === "POST") {
      void readRequestJson(request).then((body) => {
        requests.createIntent.push(body);
        sendJson(response, { ok: true, intentId: "di_new", cliToken: "new-token", job: { token: "new-token", env: { SWITCHBOARD_RELAY_URL: baseUrl, SWITCHBOARD_INTENT_ID: "di_new", SWITCHBOARD_INTENT_TOKEN: "new-token" } } });
      });
      return;
    }
    const deploymentUpdateMatch = url.pathname.match(/^\/v1\/deployment-intents\/([^/]+)\/deployment$/);
    if (deploymentUpdateMatch && request.method === "POST") {
      void readRequestJson(request).then((body) => {
        const intentId = decodeURIComponent(deploymentUpdateMatch[1]);
        requests.deploymentUpdate.push(body);
        intents.set(intentId, { ...(intents.get(intentId) ?? { intentId }), deployment: body, runtimeSigner: "0x5000000000000000000000000000000000000005", upstreamIps: ["203.0.113.10"], status: "claimed" });
        sendJson(response, { ok: true, intent: intents.get(intentId) });
      });
      return;
    }
    const fundingRefreshMatch = url.pathname.match(/^\/v1\/deployment-intents\/([^/]+)\/funding-refresh$/);
    if (fundingRefreshMatch && request.method === "POST") {
      const intentId = decodeURIComponent(fundingRefreshMatch[1]);
      requests.fundingRefresh.push(request.headers.authorization ?? "");
      const intent = { ...(intents.get(intentId) ?? { intentId }), funding: { status: "funded", sessionId: hex32("22") }, dns: { status: "propagated", hostname: "e-resume.acurast.ingress.test" }, status: "funded" };
      intents.set(intentId, intent);
      sendJson(response, { ok: true, intent });
      return;
    }
    const routeRefreshMatch = url.pathname.match(/^\/v1\/deployment-intents\/([^/]+)\/route-refresh$/);
    if (routeRefreshMatch && request.method === "POST") {
      const intentId = decodeURIComponent(routeRefreshMatch[1]);
      requests.routeRefresh.push(request.headers.authorization ?? "");
      const intent = { ...(intents.get(intentId) ?? { intentId }), route: { status: "active", hostname: "e-resume.acurast.ingress.test" }, status: "active" };
      intents.set(intentId, intent);
      sendJson(response, { ok: true, intent, route: intent.route });
      return;
    }
    const intentReadMatch = url.pathname.match(/^\/v1\/deployment-intents\/([^/]+)$/);
    if (intentReadMatch && request.method === "GET") {
      const intentId = decodeURIComponent(intentReadMatch[1]);
      requests.intentRead.push(request.headers.authorization ?? "");
      sendJson(response, { ok: true, intent: intents.get(intentId) ?? { intentId } });
      return;
    }
    if (url.pathname === "/v1/validation-reports") {
      sendJson(response, { ok: true, reports: [{ reportId: "vr_resume", success: true }] });
      return;
    }
    response.statusCode = 404;
    sendJson(response, { error: "not_found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const manifest: NetworkManifest = {
      version: 1,
      sequence: 1,
      issuedAt: "2026-05-07T00:00:00.000Z",
      expiresAt: "2030-05-07T00:00:00.000Z",
      chain: { name: "polkadot-hub", chainId: "420420419" },
      registries: {
        active: [{ status: "active", address: "0x65d6b76bec50f46d198ffa3598e381a298025da0" }],
        deprecated: [],
        retired: []
      },
      rpc: {
        eth: ["https://services.polkadothub-rpc.com/mainnet"],
        substrate: ["wss://polkadot-asset-hub-rpc.polkadot.io"]
      },
      supportedAssets: [{ address: "0x0000000000000000000000000000000000001337", symbol: "USDC", decimals: 6, kind: "erc20" }],
      controlPlane: { apiBaseUrl: baseUrl },
      relays: [{ relayId: "relay-a", controlPlaneUrl: baseUrl, active: true }]
    };
    signedManifest = await signNetworkManifest(manifest, manifestSignerSeed, { scheme: "substrate-sr25519", ss58Format: 42 });
    await fn({ baseUrl, manifestSigner: (signedManifest as { signature: { signer: string } }).signature.signer, requests });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function deploySnapshot(input: { baseUrl: string; step: string; schedule?: Record<string, unknown> }): Record<string, any> {
  const capacity = {
    operatorId: hex32("aa"),
    processorId: hex32("11"),
    processor: hex32("11"),
    gatewayId: "gateway-resume",
    managerId: "9470"
  };
  const deploymentIntent = {
    intentId: "di_existing",
    cliToken: "intent-token-original",
    env: {
      SWITCHBOARD_RELAY_URL: input.baseUrl,
      SWITCHBOARD_INTENT_ID: "di_existing",
      SWITCHBOARD_INTENT_TOKEN: "intent-token-original"
    },
    intent: {
      intentId: "di_existing",
      jobId: hex32("33"),
      operatorId: capacity.operatorId,
      processorId: capacity.processorId,
      gatewayId: capacity.gatewayId
    },
    raw: {
      intentId: "di_existing",
      cliToken: "intent-token-original",
      job: {
        token: "intent-token-original",
        env: {
          SWITCHBOARD_RELAY_URL: input.baseUrl,
          SWITCHBOARD_INTENT_ID: "di_existing",
          SWITCHBOARD_INTENT_TOKEN: "intent-token-original"
        }
      }
    }
  };
  const snapshot: Record<string, any> = {
    version: 1,
    workflowId: "wf_resume",
    step: input.step,
    input: {
      relayUrl: input.baseUrl,
      allowInsecureHttp: true,
      jobId: hex32("33"),
      target: {
        name: "polkadot-hub",
        chainId: "420420419",
        registryAddress: "0x65d6b76bec50f46d198ffa3598e381a298025da0",
        ethRpcUrl: "https://services.polkadothub-rpc.com/mainnet",
        substrateWsUrl: "wss://polkadot-asset-hub-rpc.polkadot.io"
      },
      durationSeconds: 900,
      entrypoint: "index.ts",
      asset: "0x0000000000000000000000000000000000001337",
      certificateMode: "job-acme",
      validatorMode: "skip",
      capacity,
      pins: capacity,
      source: { mode: "test" },
      deploymentMode: "single"
    },
    data: {
      capacity,
      deploymentIntent
    },
    events: [{ sequence: 1, at: new Date().toISOString(), type: input.step }],
    updatedAt: new Date().toISOString()
  };
  if (input.step === "deploy_action_required") {
    snapshot.requiredAction = {
      id: "cli-runner-acurast-deploy",
      kind: "acurast.deploy",
      description: "Run the compatibility switchboard-deploy runner",
      payload: {
        workflowId: snapshot.workflowId,
        jobId: snapshot.input.jobId,
        capacity,
        deploymentIntent,
        sensitiveFields: ["deploymentIntent.cliToken", "deploymentIntent.env.SWITCHBOARD_INTENT_TOKEN"]
      }
    };
  }
  if (input.step === "runtime_claimed" || input.step === "quote_ready") {
    snapshot.data.deployment = {
      adapter: "acurast-sdk",
      ok: true,
      deploymentId: "63499",
      txHash: "0xdeploy",
      jobId: snapshot.input.jobId,
      processor: capacity.processor,
      processorId: capacity.processorId,
      operatorId: capacity.operatorId,
      gatewayId: capacity.gatewayId,
      schedule: input.schedule ?? validSchedule()
    };
    snapshot.data.runtime = {
      runtimeSigner: "0x5000000000000000000000000000000000000005",
      upstreamIps: ["203.0.113.10"]
    };
  }
  if (input.step === "quote_ready") {
    snapshot.data.quote = quoteResponse(snapshot.input.jobId, capacity);
  }
  return snapshot;
}

function deployReport(input: { baseUrl: string }): Record<string, unknown> {
  return {
    ok: false,
    deploymentIntent: {
      intentId: "di_existing",
      relayUrl: input.baseUrl,
      localSecret: {
        description: "Deployer-local deployment intent token. Do not publish this report.",
        cliToken: "intent-token-original"
      }
    },
    lifecycle: {
      schedule: validSchedule()
    }
  };
}

function redactSnapshot(snapshot: Record<string, any>): Record<string, any> {
  return JSON.parse(JSON.stringify(snapshot, (key, value) => /token/i.test(key) && typeof value === "string" ? "[redacted]" : value));
}

async function writePrivateSnapshot(runDir: string, snapshot: Record<string, any>): Promise<void> {
  await writeFile(path.join(runDir, privateSnapshotFile), `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path.join(runDir, privateSnapshotFile), 0o600);
  await writeFile(path.join(runDir, workflowSnapshotFile), `${JSON.stringify(redactSnapshot(snapshot), null, 2)}\n`, "utf8");
}

async function writeFakePnpm(filePath: string, observedPath: string): Promise<void> {
  await writeFile(
    filePath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (!args.includes("hub:fund-native-asset-quote")) {
  process.exit(0);
}
let observations = [];
try { observations = JSON.parse(fs.readFileSync(${JSON.stringify(observedPath)}, "utf8")); } catch {}
observations.push({
  dryRun: args.includes("--dry-run"),
  token: process.env.SWITCHBOARD_INTENT_CLI_TOKEN,
  intentId: process.env.SWITCHBOARD_INTENT_ID
});
fs.writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify(observations, null, 2) + "\\n");
const quote = {
  quoteId: "0x${"10".repeat(32)}",
  sessionId: "0x${"22".repeat(32)}",
  developer: "0x0000000000000000000000000000000000000001",
  asset: "0x0000000000000000000000000000000000001337",
  amount: "120000",
  minAmount: "120000",
  maxAmount: "120000",
  paidSeconds: process.env.PAID_SECONDS || "900",
  serviceAmount: "100000",
  setupFee: "10000",
  validationFeeCap: "10000",
  jobId: process.env.JOB_ID || "0x${"33".repeat(32)}",
  expectedJobSigner: process.env.JOB_SIGNER_ADDRESS || "0x5000000000000000000000000000000000000005",
  operatorId: process.env.OPERATOR_ID || "0x${"aa".repeat(32)}",
  processorId: process.env.PROCESSOR_ID || "0x${"11".repeat(32)}",
  endpointHash: "0x${"66".repeat(32)}",
  salt: "0x${"77".repeat(32)}",
  operatorRecipient: "0x0000000000000000000000000000000000000002",
  validatorRecipient: "0x0000000000000000000000000000000000000003",
  proofRecipient: "0x0000000000000000000000000000000000000004",
  maxOperatorBps: 8000,
  maxValidatorBps: 1000,
  maxProofBps: 1000,
  policyHash: "0x${"88".repeat(32)}",
  deadline: "9999999999"
};
console.log(JSON.stringify({
  ok: true,
  dryRun: args.includes("--dry-run"),
  quote,
  signature: "0x${"aa".repeat(65)}",
  endpointHostname: "e-resume.acurast.ingress.test",
  validationHostname: "v-resume.acurast.ingress.test",
  txs: args.includes("--dry-run") ? undefined : [{ action: "fundWithAssetQuote", txHash: "0xfund", status: "inBlock" }],
  session: args.includes("--dry-run") ? undefined : { sessionId: quote.sessionId, status: "Funded" }
}));
`,
    "utf8"
  );
  await chmod(filePath, 0o755);
}

function quoteResponse(jobId: string, capacity: Record<string, string>): Record<string, unknown> {
  return {
    ok: true,
    quote: {
      quoteId: hex32("10"),
      sessionId: hex32("22"),
      developer: "0x0000000000000000000000000000000000000001",
      asset: "0x0000000000000000000000000000000000001337",
      amount: "120000",
      minAmount: "120000",
      maxAmount: "120000",
      paidSeconds: "900",
      serviceAmount: "100000",
      setupFee: "10000",
      validationFeeCap: "10000",
      jobId,
      expectedJobSigner: "0x5000000000000000000000000000000000000005",
      operatorId: capacity.operatorId,
      processorId: capacity.processorId,
      endpointHash: hex32("66"),
      salt: hex32("77"),
      operatorRecipient: "0x0000000000000000000000000000000000000002",
      validatorRecipient: "0x0000000000000000000000000000000000000003",
      proofRecipient: "0x0000000000000000000000000000000000000004",
      maxOperatorBps: 8000,
      maxValidatorBps: 1000,
      maxProofBps: 1000,
      policyHash: hex32("88"),
      deadline: "9999999999"
    },
    signature: `0x${"aa".repeat(65)}`,
    endpointHostname: "e-resume.acurast.ingress.test",
    validationHostname: "v-resume.acurast.ingress.test"
  };
}

function validSchedule(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    startTime: String(now + 60),
    endTime: String(now + 3600),
    maxStartDelay: 300000
  };
}

function expiredStartWindowSchedule(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    startTime: String(now - 600),
    endTime: String(now + 3600),
    maxStartDelay: 120000
  };
}

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [command, ...rest] = args;
    const cliArgs = command ? [command, "--project-dir", cwd, ...rest] : args;
    const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...cliArgs], {
      cwd: cliRoot,
      env: {
        ...process.env,
        ...env,
        SWITCHBOARD_HOME: path.join(cwd, ".switchboard-home"),
        SWITCHBOARD_CONTEXT: "",
        NO_COLOR: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("request body must be a JSON object"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function hex32(byte: string): string {
  return `0x${byte.repeat(32)}`;
}
