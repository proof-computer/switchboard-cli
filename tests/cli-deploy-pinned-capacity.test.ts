import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { encodeAddress } from "@polkadot/util-crypto";

import { signNetworkManifest, type NetworkManifest } from "../src/network-manifest.js";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(cliRoot, "cli/src/index.ts");
const manifestSignerSeed = "//Alice//switchboard-network-manifest";

describe("switchboard deploy pinned capacity selection", () => {
  it("selects a route-state gateway for operator-only contexts", async () => {
    const operatorId = hex32("aa");
    const otherOperatorId = hex32("bb");
    const report = capacityReport({ operatorId, gatewayId: "gateway-context", processorId: hex32("11"), routeStateAvailable: true });
    const otherReport = capacityReport({ operatorId: otherOperatorId, gatewayId: "gateway-other", processorId: hex32("22"), routeStateAvailable: true });

    await withControlPlane([otherReport, report], async ({ baseUrl, manifestSigner }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-context-deploy-"));
      try {
        const entrypoint = path.join(cwd, "index.ts");
        await writeFile(entrypoint, "console.log('hello switchboard');\n", "utf8");
        await writeContext(cwd, {
          manifestUrl: `${baseUrl}/v1/network-manifest`,
          manifestSigner,
          operatorId,
          relayUrl: baseUrl
        });
        const result = await runCli(cwd, [
          "deploy",
          "--yes",
          "--dry-run",
          "--json",
          "--entrypoint",
          entrypoint
        ]);

        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.env.OPERATOR_ID, operatorId);
        assert.equal(output.env.SWITCHBOARD_DEPLOY_GATEWAY_ID, "gateway-context");
        assert.equal(output.env.SWITCHBOARD_DEPLOY_CAPABILITY_REPORT_ID, "report-gateway-context");
        assert.equal(output.env.SWITCHBOARD_DEPLOY_CAPABILITY_REPORT_EXPIRES_AT, report.report.expiresAt);
        assert.equal(output.env.SWITCHBOARD_DEPLOY_OPERATOR_PUBLIC_ADDRESSES, JSON.stringify(["195.22.134.245"]));
        assert.equal(output.env.SWITCHBOARD_DEPLOY_PROCESSOR, hex32("11"));
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it("selects a route-state gateway for pinned operator/processor dry-runs", async () => {
    const operatorId = hex32("aa");
    const processorId = hex32("11");
    const processor = ss58(processorId);
    const report = capacityReport({ operatorId, gatewayId: "gateway-pinned", processorId, routeStateAvailable: true });

    await withControlPlane([report], async ({ baseUrl, manifestSigner }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-pinned-deploy-"));
      try {
        const entrypoint = path.join(cwd, "index.ts");
        await writeFile(entrypoint, "console.log('hello switchboard');\n", "utf8");
        const result = await runCli(cwd, [
          "deploy",
          "--yes",
          "--dry-run",
          "--json",
          "--manifest-url",
          `${baseUrl}/v1/network-manifest`,
          "--manifest-signer",
          manifestSigner,
          "--relay-url",
          baseUrl,
          "--entrypoint",
          entrypoint,
          "--operator-id",
          operatorId,
          "--processor",
          processor
        ]);

        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.env.SWITCHBOARD_DEPLOY_GATEWAY_ID, "gateway-pinned");
        assert.equal(output.env.SWITCHBOARD_DEPLOY_CAPABILITY_REPORT_ID, "report-gateway-pinned");
        assert.equal(output.env.SWITCHBOARD_DEPLOY_CAPABILITY_REPORT_EXPIRES_AT, report.report.expiresAt);
        assert.equal(output.env.SWITCHBOARD_DEPLOY_OPERATOR_PUBLIC_ADDRESSES, JSON.stringify(["195.22.134.245"]));
        assert.equal(output.env.SWITCHBOARD_DEPLOY_PROCESSOR, processor);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it("does not auto-select when a gateway is explicitly pinned", async () => {
    const operatorId = hex32("aa");
    const processor = ss58(hex32("11"));
    let capacityRequests = 0;

    await withControlPlane([], async ({ baseUrl, manifestSigner }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-explicit-gateway-"));
      try {
        const entrypoint = path.join(cwd, "index.ts");
        await writeFile(entrypoint, "console.log('hello switchboard');\n", "utf8");
        const result = await runCli(cwd, [
          "deploy",
          "--yes",
          "--dry-run",
          "--json",
          "--manifest-url",
          `${baseUrl}/v1/network-manifest`,
          "--manifest-signer",
          manifestSigner,
          "--relay-url",
          baseUrl,
          "--entrypoint",
          entrypoint,
          "--operator-id",
          operatorId,
          "--processor",
          processor,
          "--gateway-id",
          "gateway-explicit"
        ]);

        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.env.SWITCHBOARD_DEPLOY_GATEWAY_ID, "gateway-explicit");
        assert.equal(output.env.SWITCHBOARD_DEPLOY_CAPABILITY_REPORT_ID, undefined);
        assert.equal(capacityRequests, 0);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }, () => {
      capacityRequests += 1;
    });
  });

  it("fails before deploy runner execution when no route-state allocation matches", async () => {
    const operatorId = hex32("aa");
    const processor = ss58(hex32("11"));
    const report = capacityReport({ operatorId, gatewayId: "gateway-route-less", processorId: hex32("11"), routeStateAvailable: false });

    await withControlPlane([report], async ({ baseUrl, manifestSigner }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-pinned-deploy-missing-"));
      try {
        const entrypoint = path.join(cwd, "index.ts");
        await writeFile(entrypoint, "console.log('hello switchboard');\n", "utf8");
        const result = await runCli(cwd, [
          "deploy",
          "--yes",
          "--dry-run",
          "--json",
          "--manifest-url",
          `${baseUrl}/v1/network-manifest`,
          "--manifest-signer",
          manifestSigner,
          "--relay-url",
          baseUrl,
          "--entrypoint",
          entrypoint,
          "--operator-id",
          operatorId,
          "--processor",
          processor
        ]);

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /No route-state-capable operator capacity matched pinned operator/);
        assert.match(result.stderr, /route-state polling unavailable/);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it("fails operator-only deploys before runner execution when no route-state allocation matches", async () => {
    const operatorId = hex32("aa");
    const report = capacityReport({ operatorId, gatewayId: "gateway-route-less", processorId: hex32("11"), routeStateAvailable: false });

    await withControlPlane([report], async ({ baseUrl, manifestSigner }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-context-deploy-missing-"));
      try {
        const entrypoint = path.join(cwd, "index.ts");
        await writeFile(entrypoint, "console.log('hello switchboard');\n", "utf8");
        await writeContext(cwd, {
          manifestUrl: `${baseUrl}/v1/network-manifest`,
          manifestSigner,
          operatorId,
          relayUrl: baseUrl
        });
        const result = await runCli(cwd, [
          "deploy",
          "--yes",
          "--dry-run",
          "--json",
          "--entrypoint",
          entrypoint
        ]);

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /No route-state-capable deploy capacity matched operator/);
        assert.match(result.stderr, /route-state polling unavailable/);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });
});

async function withControlPlane(
  reports: unknown[],
  fn: (input: { baseUrl: string; manifestSigner: string }) => Promise<void>,
  onCapacityRequest: () => void = () => {}
): Promise<void> {
  let signedManifest: unknown;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = new URL(request.url ?? "/", baseUrl);
    if (url.pathname === "/v1/network-manifest") {
      sendJson(response, signedManifest);
      return;
    }
    if (url.pathname === "/v1/operator-capacity") {
      onCapacityRequest();
      sendJson(response, { ok: true, latest: reports });
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
    await fn({ baseUrl, manifestSigner: (signedManifest as { signature: { signer: string } }).signature.signer });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function capacityReport(input: {
  operatorId: string;
  gatewayId: string;
  processorId: string;
  routeStateAvailable: boolean;
}): any {
  const now = new Date();
  return {
    receivedAt: now.toISOString(),
    report: {
      version: 1,
      kind: "switchboard.operator.capability",
      reportId: `report-${input.gatewayId}`,
      reportedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 120_000).toISOString(),
      operator: {
        operatorId: input.operatorId,
        gatewayId: input.gatewayId,
        managerIds: ["9470"]
      },
      gateway: {
        publicAddresses: ["195.22.134.245"],
        routeStateAvailable: input.routeStateAvailable,
        activeRouteCount: 0,
        routeCapacity: 20,
        supportedClasses: ["node-webserver"]
      },
      processorScopes: [
        {
          kind: "explicit",
          processors: [input.processorId]
        }
      ]
    }
  };
}

function runCli(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [command, ...rest] = args;
    const cliArgs = command ? [command, "--project-dir", cwd, ...rest] : args;
    const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...cliArgs], {
      cwd: cliRoot,
      env: {
        ...process.env,
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

async function writeContext(
  cwd: string,
  context: { manifestUrl: string; manifestSigner: string; operatorId: string; relayUrl: string }
): Promise<void> {
  const home = path.join(cwd, ".switchboard-home");
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(home, "contexts.json"),
    JSON.stringify({
      current: "test",
      contexts: {
        test: {
          target: "polkadot-hub",
          acurastNetwork: "mainnet",
          ...context
        }
      }
    }, null, 2)
  );
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function ss58(processorId: string): string {
  return encodeAddress(Buffer.from(processorId.slice(2), "hex"), 42);
}

function hex32(byte: string): string {
  return `0x${byte.repeat(32)}`;
}
