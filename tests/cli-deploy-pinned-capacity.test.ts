import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { encodeAddress } from "@polkadot/util-crypto";

import { readLaunchDemoCapabilityReports } from "../cli/src/index.js";
import { signNetworkManifest, type NetworkManifest } from "../src/network-manifest.js";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(cliRoot, "cli/src/index.ts");
const manifestSignerSeed = "//Alice//switchboard-network-manifest";

describe("switchboard deploy pinned capacity selection", () => {
  it("reads launch capacity from another catalog relay when one relay is stale", async () => {
    const operatorId = hex32("aa");
    const report = capacityReport({ operatorId, gatewayId: "gateway-fresh", processorId: hex32("11"), routeStateAvailable: true });
    const stale = await startJsonServer((_url, response) => {
      response.statusCode = 503;
      sendJson(response, {
        error: "stale_read_model",
        retryable: true,
        mutationApplied: false,
        dataSet: "operatorCapacity",
        staleReason: "no_local_operator_capability_reports_after_dns_fanout"
      });
    });
    const fresh = await startJsonServer((url, response) => {
      if (url.pathname === "/v1/operator-capacity") {
        sendJson(response, { ok: true, latest: [report] });
        return;
      }
      response.statusCode = 404;
      sendJson(response, { error: "not_found" });
    });
    try {
      const reports = await readLaunchDemoCapabilityReports([stale.baseUrl, fresh.baseUrl]);
      assert.equal(reports.length, 1);
      assert.equal(reports[0].report.operator.gatewayId, "gateway-fresh");
      assert.equal(reports[0].sourceRelayUrl, fresh.baseUrl);
    } finally {
      await stale.close();
      await fresh.close();
    }
  });

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

    await withControlPlane([report], async ({ baseUrl, manifestSigner, createIntentRequests }) => {
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
        assert.equal(output.workflow.input.capacity.gatewayId, "gateway-pinned");
        assert.equal(output.workflow.input.capacity.processor, processor);
        assert.equal(output.workflow.snapshot.step, "capacity_selected");
        assert.equal(output.workflow.snapshot.events.at(-1).type, "capacity_selected");
        assert.doesNotThrow(() => JSON.stringify(output.workflow.snapshot));
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

    await withControlPlane([report], async ({ baseUrl, manifestSigner, createIntentRequests }) => {
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

    await withControlPlane([report], async ({ baseUrl, manifestSigner, createIntentRequests }) => {
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

  it("submits single-replica deploys through the SDK adapter from a deploy_action_required snapshot", async () => {
    const operatorId = hex32("aa");
    const processorId = hex32("11");
    const processor = ss58(processorId);
    const report = capacityReport({ operatorId, gatewayId: "gateway-runner", processorId, routeStateAvailable: true });

    await withControlPlane([report], async ({ baseUrl, manifestSigner, createIntentRequests }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-deploy-runner-workflow-"));
      try {
        const fakeBin = path.join(cwd, "fake-bin");
        const runDir = path.join(cwd, "run");
        const observedPath = path.join(cwd, "observed-runner.json");
        await mkdir(fakeBin, { recursive: true });
        await writeFakePnpm(path.join(fakeBin, "pnpm"), observedPath, {
          ok: true,
          deploymentId: "59399",
          sessionId: `0x${"22".repeat(32)}`,
          hostname: "e-runner.acurast.ingress.test"
        });
        const entrypoint = path.join(cwd, "index.ts");
        await writeFile(entrypoint, "console.log('hello switchboard');\n", "utf8");
        const result = await runCli(cwd, [
          "deploy",
          "--yes",
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
          "--run-dir",
          runDir
        ], {
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          SWITCHBOARD_FAKE_ACURAST_SDK_SUBMIT_JSON: JSON.stringify({ deploymentId: "59399", txHash: "0xdeploy" })
        });

        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.ok, true);
        assert.equal(output.workflow.step, "complete");
        assert.equal(output.workflow.events.some((event: Record<string, unknown>) => event.type === "deploy_action_required"), true);
        assert.equal(output.workflow.events.some((event: Record<string, unknown>) => event.type === "deploy_action_submitted"), true);
        assert.equal(output.workflow.data.actionReceipts.at(-1).kind, "acurast.deploy");
        assert.equal(output.workflow.data.actionReceipts.at(-1).receipt.adapter, "acurast-sdk");
        assert.equal(createIntentRequests.length, 1);
        assert.equal(createIntentRequests[0].jobId, output.workflow.input.jobId);
        assert.equal(createIntentRequests[0].gatewayId, "gateway-runner");
        await assert.rejects(readFile(observedPath, "utf8"));

        const savedSnapshot = JSON.parse(await readFile(path.join(runDir, "switchboard-deploy-workflow.snapshot.json"), "utf8"));
        assert.equal(savedSnapshot.step, "complete");
        assert.equal(savedSnapshot.data.funding.txHash, "0xfund");
        assert.equal(savedSnapshot.data.actionReceipts.at(-1).receipt.deploymentId, "59399");
        assert.equal(savedSnapshot.data.actionReceipts.at(-1).receipt.deploymentIntentId, "di_1");
        assert.equal(savedSnapshot.data.deploymentIntent.cliToken, "[redacted]");
        assert.equal(savedSnapshot.requiredAction, undefined);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it("keeps a failed SDK submit report resumable with an acurast.deploy required action", async () => {
    const operatorId = hex32("aa");
    const processorId = hex32("11");
    const processor = ss58(processorId);
    const report = capacityReport({ operatorId, gatewayId: "gateway-runner-fail", processorId, routeStateAvailable: true });

    await withControlPlane([report], async ({ baseUrl, manifestSigner, createIntentRequests }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-deploy-runner-failed-"));
      try {
        const fakeBin = path.join(cwd, "fake-bin");
        const runDir = path.join(cwd, "run");
        const observedPath = path.join(cwd, "observed-runner.json");
        await mkdir(fakeBin, { recursive: true });
        await writeFakePnpm(path.join(fakeBin, "pnpm"), observedPath, {
          ok: false,
          deploymentId: "59400",
          sessionId: `0x${"33".repeat(32)}`,
          hostname: "e-failed.acurast.ingress.test",
          failure: { stage: "route_activation", message: "runtime_https_not_ready" }
        });
        const entrypoint = path.join(cwd, "index.ts");
        await writeFile(entrypoint, "console.log('hello switchboard');\n", "utf8");
        const result = await runCli(cwd, [
          "deploy",
          "--yes",
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
          "--run-dir",
          runDir
        ], {
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          SWITCHBOARD_FAKE_ACURAST_SDK_SUBMIT_JSON: JSON.stringify({ ok: false, message: "runtime_https_not_ready" })
        });

        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.ok, false);
        assert.equal(output.workflow.step, "failed");
        assert.equal(output.requiredAction.kind, "acurast.deploy");
        assert.equal(output.requiredAction.payload.reportPath, path.join(runDir, "report.json"));
        assert.equal(output.workflow.data.actionReceipts.at(-1).receipt.ok, false);
        assert.equal(createIntentRequests.length, 1);
        assert.equal(output.workflow.data.actionReceipts.at(-1).receipt.adapter, "acurast-sdk");
        assert.equal(output.workflow.data.actionReceipts.at(-1).receipt.failure.stage, "acurast-deploy");
        await assert.rejects(readFile(observedPath, "utf8"));
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });
});

describe("switchboard launch-demo workflow shell", () => {
  it("adds workflow metadata to single-replica dry-run JSON without changing selected capacity output", async () => {
    const operatorId = hex32("aa");
    const processorId = hex32("11");
    const report = launchDemoCapacityReport({ operatorId, gatewayId: "gateway-demo", processorId, routeStateAvailable: true });

    await withControlPlane([report], async ({ baseUrl, manifestSigner, createIntentRequests }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-launch-demo-workflow-"));
      const demoPackage = await mkDemoPackage(cwd);
      try {
        const result = await runCli(cwd, [
          "launch-demo",
          "--dry-run",
          "--json",
          "--manifest-url",
          `${baseUrl}/v1/network-manifest`,
          "--manifest-signer",
          manifestSigner,
          "--relay-url",
          baseUrl,
          "--demo-package",
          `file:${demoPackage}`,
          "--operator-id",
          operatorId,
          "--processor",
          processorId,
          "--quote-preview-timeout-ms",
          "1000"
        ]);

        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.action, "launch-demo-dry-run");
        assert.equal(output.relayUrl, baseUrl);
        assert.equal(output.ingressEstimate.ok, true);
        assert.equal(output.ingressEstimate.amount, "3024000");
        assert.equal(output.selection.gatewayId, "gateway-demo");
        assert.equal(output.selection.processorId, processorId);
        assert.equal(output.env.SWITCHBOARD_DEPLOY_GATEWAY_ID, "gateway-demo");
        assert.equal(output.env.SWITCHBOARD_DEPLOY_CAPABILITY_REPORT_ID, "report-gateway-demo");
        assert.equal(output.demoProject.packageSpec, `file:${demoPackage}`);
        assert.equal(output.note, "No Acurast deployment, Hub transaction, DNS change, or route mutation was attempted.");
        assert.equal(output.workflow.input.capacity.gatewayId, "gateway-demo");
        assert.equal(output.workflow.input.capacity.processorId, processorId);
        assert.equal(output.workflow.input.runtime.kind, "switchboard-express-demo");
        assert.equal(output.workflow.input.validatorMode, "skip");
        assert.equal(output.workflow.snapshot.step, "capacity_selected");
        assert.equal(output.workflow.snapshot.events.at(-1).type, "capacity_selected");
        assert.doesNotThrow(() => JSON.stringify(output.workflow.snapshot));
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it("adds group workflow metadata to launch-demo --ha dry-run while preserving selection/env output", async () => {
    const operatorId = hex32("aa");
    const reportA = launchDemoCapacityReport({ operatorId, gatewayId: "gateway-demo-a", processorId: hex32("11"), routeStateAvailable: true });
    const reportB = launchDemoCapacityReport({ operatorId, gatewayId: "gateway-demo-b", processorId: hex32("22"), routeStateAvailable: true });

    await withControlPlane([reportA, reportB], async ({ baseUrl, manifestSigner }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-launch-demo-ha-"));
      const demoPackage = await mkDemoPackage(cwd);
      try {
        const result = await runCli(cwd, [
          "launch-demo",
          "--ha",
          "--processor-count",
          "2",
          "--min-ready",
          "2",
          "--dry-run",
          "--json",
          "--manifest-url",
          `${baseUrl}/v1/network-manifest`,
          "--manifest-signer",
          manifestSigner,
          "--relay-url",
          baseUrl,
          "--demo-package",
          `file:${demoPackage}`,
          "--operator-id",
          operatorId,
          "--quote-preview-timeout-ms",
          "1000"
        ]);

        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.action, "launch-demo-dry-run");
        assert.equal(output.workflow.input.deploymentMode, "group");
        assert.equal(output.workflow.input.group.expectedReplicas, 2);
        assert.equal(output.workflow.input.group.minReady, 2);
        assert.equal(output.workflow.input.group.members.length, 2);
        assert.equal(output.workflow.snapshot.step, "capacity_selected");
        assert.equal(output.env.SWITCHBOARD_DEPLOY_GROUP_MODE, "true");
        assert.equal(output.env.SWITCHBOARD_DEPLOY_EXPECTED_REPLICAS, "2");
        assert.equal(output.selection.members.length, 2);
        assert.deepEqual(
          output.selection.members.map((member: Record<string, unknown>) => member.gatewayId).sort(),
          ["gateway-demo-a", "gateway-demo-b"]
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it("runs the single-replica compatibility runner from deploy_action_required and records the runner receipt", async () => {
    const operatorId = hex32("aa");
    const processorId = hex32("11");
    const report = launchDemoCapacityReport({ operatorId, gatewayId: "gateway-demo-runner", processorId, routeStateAvailable: true });

    await withControlPlane([report], async ({ baseUrl, manifestSigner, createIntentRequests }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-launch-demo-runner-workflow-"));
      const demoPackage = await mkDemoPackage(cwd);
      try {
        const fakeBin = path.join(cwd, "fake-bin");
        const runDir = path.join(cwd, "run");
        const observedPath = path.join(cwd, "observed-runner.json");
        await mkdir(fakeBin, { recursive: true });
        await writeFakeNpm(path.join(fakeBin, "npm"));
        await writeFakePnpm(path.join(fakeBin, "pnpm"), observedPath, {
          ok: true,
          deploymentId: "59401",
          sessionId: `0x${"44".repeat(32)}`,
          hostname: "e-demo-runner.acurast.ingress.test"
        });
        const result = await runCli(cwd, [
          "launch-demo",
          "--yes-spend",
          "--json",
          "--manifest-url",
          `${baseUrl}/v1/network-manifest`,
          "--manifest-signer",
          manifestSigner,
          "--relay-url",
          baseUrl,
          "--demo-package",
          `file:${demoPackage}`,
          "--operator-id",
          operatorId,
          "--processor",
          processorId,
          "--quote-preview-timeout-ms",
          "1000",
          "--run-dir",
          runDir
        ], {
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          SWITCHBOARD_FAKE_RUN_DIR: runDir,
          SWITCHBOARD_FAKE_ACURAST_SDK_SUBMIT_JSON: JSON.stringify({ deploymentId: "59401", txHash: "0xdeploy" })
        });

        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.action, "launch-demo");
        assert.equal(output.ok, true);
        assert.equal(output.workflow.step, "complete");
        assert.equal(output.workflow.input.runtime.kind, "switchboard-express-demo");
        assert.equal(output.workflow.events.some((event: Record<string, unknown>) => event.type === "deploy_action_required"), true);
        assert.equal(output.workflow.data.actionReceipts.at(-1).kind, "acurast.deploy");
        assert.equal(output.workflow.data.actionReceipts.at(-1).receipt.adapter, "acurast-sdk");
        assert.equal(createIntentRequests.length, 1);
        assert.equal(createIntentRequests[0].jobId, output.workflow.input.jobId);
        await assert.rejects(readFile(observedPath, "utf8"));

        const savedSnapshot = JSON.parse(await readFile(path.join(runDir, "switchboard-deploy-workflow.snapshot.json"), "utf8"));
        assert.equal(savedSnapshot.step, "complete");
        assert.equal(savedSnapshot.data.actionReceipts.at(-1).receipt.deploymentId, "59401");
        assert.equal(savedSnapshot.data.deploymentIntent.env.SWITCHBOARD_INTENT_TOKEN, "[redacted]");
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it("runs HA launch-demo through group submit-only runner mode and SDK-owned lifecycle", async () => {
    const operatorId = hex32("aa");
    const reportA = launchDemoCapacityReport({ operatorId, gatewayId: "gateway-demo-a", processorId: hex32("11"), routeStateAvailable: true });
    const reportB = launchDemoCapacityReport({ operatorId, gatewayId: "gateway-demo-b", processorId: hex32("22"), routeStateAvailable: true });

    await withControlPlane([reportA, reportB], async ({ baseUrl, manifestSigner, createIntentRequests }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-launch-demo-ha-runner-workflow-"));
      const demoPackage = await mkDemoPackage(cwd);
      try {
        const fakeBin = path.join(cwd, "fake-bin");
        const runDir = path.join(cwd, "run");
        const observedPath = path.join(cwd, "observed-runner.json");
        await mkdir(fakeBin, { recursive: true });
        await writeFakeNpm(path.join(fakeBin, "npm"));
        await writeFakePnpm(path.join(fakeBin, "pnpm"), observedPath, {
          ok: true,
          deploymentId: "59402",
          sessionId: `0x${"44".repeat(32)}`,
          hostname: "e-demo-ha.acurast.ingress.test"
        });
        const result = await runCli(cwd, [
          "launch-demo",
          "--ha",
          "--processor-count",
          "2",
          "--min-ready",
          "2",
          "--yes-spend",
          "--json",
          "--manifest-url",
          `${baseUrl}/v1/network-manifest`,
          "--manifest-signer",
          manifestSigner,
          "--relay-url",
          baseUrl,
          "--demo-package",
          `file:${demoPackage}`,
          "--operator-id",
          operatorId,
          "--quote-preview-timeout-ms",
          "1000",
          "--run-dir",
          runDir
        ], {
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          SWITCHBOARD_FAKE_RUN_DIR: runDir
        });

        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.action, "launch-demo");
        assert.equal(output.ok, true);
        assert.equal(output.workflow.step, "complete");
        assert.equal(output.workflow.input.deploymentMode, "group");
        assert.equal(output.workflow.data.groupMembers.length, 2);
        assert.equal(output.workflow.events.some((event: Record<string, unknown>) => event.type === "group_validation_observed"), true);
        assert.equal(createIntentRequests.length, 1);

        const observed = JSON.parse(await readFile(observedPath, "utf8"));
        assert.equal(observed.runnerMode, "acurast-group-submit-only");
        assert.equal(observed.precreatedGroup.deploymentIntentGroup.groupId, output.workflow.data.deploymentIntentGroup.groupId);
        assert.equal(observed.precreatedGroup.group.members.length, 2);

        const savedSnapshot = JSON.parse(await readFile(path.join(runDir, "switchboard-deploy-workflow.snapshot.json"), "utf8"));
        assert.equal(savedSnapshot.step, "complete");
        assert.equal(savedSnapshot.data.deploymentIntentGroup.env.SWITCHBOARD_INTENT_TOKEN, "[redacted]");
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });
});

async function withControlPlane(
  reports: unknown[],
  fn: (input: { baseUrl: string; manifestSigner: string; createIntentRequests: Record<string, unknown>[] }) => Promise<void>,
  onCapacityRequest: () => void = () => {}
): Promise<void> {
  let signedManifest: unknown;
  const createIntentRequests: Record<string, unknown>[] = [];
  const intents = new Map<string, Record<string, unknown>>();
  const groups = new Map<string, Record<string, unknown>>();
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
    if (url.pathname === "/v1/deployment-intents" && request.method === "POST") {
      void readRequestJson(request).then((body) => {
        createIntentRequests.push(body);
        const intentId = `di_${createIntentRequests.length}`;
        const token = `intent-token-${createIntentRequests.length}`;
        intents.set(intentId, {
          intentId,
          jobId: body.jobId,
          operatorId: body.operatorId,
          processorId: body.processorId,
          gatewayId: body.gatewayId,
          runtimeSigner: "0x5000000000000000000000000000000000000005",
          upstreamIps: ["203.0.113.10"],
          status: "claimed"
        });
        sendJson(response, {
          ok: true,
          intentId,
          cliToken: token,
          job: {
            token,
            env: {
              SWITCHBOARD_RELAY_URL: baseUrl,
              SWITCHBOARD_INTENT_ID: intentId,
              SWITCHBOARD_INTENT_TOKEN: token
            }
          },
          intent: {
            intentId,
            jobId: body.jobId,
            operatorId: body.operatorId,
            processorId: body.processorId,
            gatewayId: body.gatewayId
          }
        });
      }).catch((error) => {
        response.statusCode = 400;
        sendJson(response, { ok: false, error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (url.pathname === "/v1/deployment-intent-groups" && request.method === "POST") {
      void readRequestJson(request).then((body) => {
        createIntentRequests.push(body);
        const groupId = `dig_${createIntentRequests.length}`;
        const token = `group-token-${createIntentRequests.length}`;
        const members = Array.isArray(body.members)
          ? body.members.map((member: Record<string, unknown>, index: number) => ({
              ...member,
              intentId: `di_group_${index + 1}`,
              validationHostname: `v-group-${index + 1}.workflow.test`,
              runtimeSigner: `0x500000000000000000000000000000000000000${index + 1}`,
              upstreamIps: [`203.0.113.${index + 1}`]
            }))
          : [];
        for (const member of members) {
          intents.set(String(member.intentId), {
            ...member,
            status: "claimed"
          });
        }
        groups.set(groupId, {
          groupId,
          expectedReplicas: body.expectedReplicas,
          minReady: body.minReady,
          members
        });
        sendJson(response, {
          ok: true,
          groupId,
          cliToken: token,
          job: {
            token,
            env: {
              SWITCHBOARD_RELAY_URL: baseUrl,
              SWITCHBOARD_INTENT_GROUP_ID: groupId,
              SWITCHBOARD_INTENT_TOKEN: token
            }
          },
          group: groups.get(groupId),
          members
        });
      }).catch((error) => {
        response.statusCode = 400;
        sendJson(response, { ok: false, error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (url.pathname === "/v1/quote-preview") {
      sendJson(response, {
        ok: true,
        preview: {
          amount: "3024000",
          asset: "0x0000000000000000000000000000000000001337",
          paidSeconds: "900"
        }
      });
      return;
    }
    const groupUpdateMatch = url.pathname.match(/^\/v1\/deployment-intent-groups\/([^/]+)\/deployment$/);
    if (groupUpdateMatch && request.method === "POST") {
      void readRequestJson(request).then((body) => {
        const groupId = decodeURIComponent(groupUpdateMatch[1]);
        const group = groups.get(groupId) ?? { groupId, members: [] };
        groups.set(groupId, { ...group, deployment: body });
        sendJson(response, { ok: true, group: groups.get(groupId) });
      }).catch((error) => {
        response.statusCode = 400;
        sendJson(response, { ok: false, error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    const groupFundingRefreshMatch = url.pathname.match(/^\/v1\/deployment-intent-groups\/([^/]+)\/members\/([^/]+)\/funding-refresh$/);
    if (groupFundingRefreshMatch && request.method === "POST") {
      const intentId = decodeURIComponent(groupFundingRefreshMatch[2]);
      const existing = intents.get(intentId) ?? { intentId };
      const intent = {
        ...existing,
        funding: { status: "funded", sessionId: `0x${"22".repeat(32)}` },
        dns: { status: "propagated", hostname: "e-workflow.acurast.ingress.test" },
        status: "funded"
      };
      intents.set(intentId, intent);
      sendJson(response, { ok: true, intent });
      return;
    }
    const groupRouteRefreshMatch = url.pathname.match(/^\/v1\/deployment-intent-groups\/([^/]+)\/members\/([^/]+)\/route-refresh$/);
    if (groupRouteRefreshMatch && request.method === "POST") {
      const intentId = decodeURIComponent(groupRouteRefreshMatch[2]);
      const existing = intents.get(intentId) ?? { intentId };
      const intent = {
        ...existing,
        route: { status: "active", hostname: "e-workflow.acurast.ingress.test" },
        status: "active"
      };
      intents.set(intentId, intent);
      sendJson(response, { ok: true, intent, route: intent.route });
      return;
    }
    const groupReadMatch = url.pathname.match(/^\/v1\/deployment-intent-groups\/([^/]+)$/);
    if (groupReadMatch && request.method === "GET") {
      const groupId = decodeURIComponent(groupReadMatch[1]);
      const group = groups.get(groupId) ?? { groupId, members: [] };
      const members = Array.isArray(group.members)
        ? group.members.map((member: Record<string, unknown>) => ({ ...member, ...(intents.get(String(member.intentId)) ?? {}) }))
        : [];
      sendJson(response, { ok: true, group: { ...group, members } });
      return;
    }
    const deploymentUpdateMatch = url.pathname.match(/^\/v1\/deployment-intents\/([^/]+)\/deployment$/);
    if (deploymentUpdateMatch && request.method === "POST") {
      void readRequestJson(request).then((body) => {
        const intentId = decodeURIComponent(deploymentUpdateMatch[1]);
        const existing = intents.get(intentId) ?? { intentId };
        intents.set(intentId, {
          ...existing,
          deployment: body,
          runtimeSigner: "0x5000000000000000000000000000000000000005",
          upstreamIps: ["203.0.113.10"],
          status: "claimed"
        });
        sendJson(response, { ok: true, intent: intents.get(intentId) });
      }).catch((error) => {
        response.statusCode = 400;
        sendJson(response, { ok: false, error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    const fundingRefreshMatch = url.pathname.match(/^\/v1\/deployment-intents\/([^/]+)\/funding-refresh$/);
    if (fundingRefreshMatch && request.method === "POST") {
      const intentId = decodeURIComponent(fundingRefreshMatch[1]);
      const existing = intents.get(intentId) ?? { intentId };
      const intent = {
        ...existing,
        funding: { status: "funded", sessionId: `0x${"22".repeat(32)}` },
        dns: { status: "propagated", hostname: "e-workflow.acurast.ingress.test" },
        status: "funded"
      };
      intents.set(intentId, intent);
      sendJson(response, { ok: true, intent });
      return;
    }
    const routeRefreshMatch = url.pathname.match(/^\/v1\/deployment-intents\/([^/]+)\/route-refresh$/);
    if (routeRefreshMatch && request.method === "POST") {
      const intentId = decodeURIComponent(routeRefreshMatch[1]);
      const existing = intents.get(intentId) ?? { intentId };
      const intent = {
        ...existing,
        route: { status: "active", hostname: "e-workflow.acurast.ingress.test" },
        status: "active"
      };
      intents.set(intentId, intent);
      sendJson(response, { ok: true, intent, route: intent.route });
      return;
    }
    const intentReadMatch = url.pathname.match(/^\/v1\/deployment-intents\/([^/]+)$/);
    if (intentReadMatch && request.method === "GET") {
      const intentId = decodeURIComponent(intentReadMatch[1]);
      sendJson(response, { ok: true, intent: intents.get(intentId) ?? { intentId } });
      return;
    }
    if (url.pathname === "/v1/validation-reports") {
      sendJson(response, { ok: true, reports: [{ reportId: "vr_workflow", success: true }] });
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
    await fn({ baseUrl, manifestSigner: (signedManifest as { signature: { signer: string } }).signature.signer, createIntentRequests });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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

async function mkDemoPackage(cwd: string): Promise<string> {
  const dir = path.join(cwd, "demo-package");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "@proofcomputer/switchboard-express-demo",
      version: "9.9.9",
      type: "module"
    }),
    "utf8"
  );
  return dir;
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

function launchDemoCapacityReport(input: {
  operatorId: string;
  gatewayId: string;
  processorId: string;
  routeStateAvailable: boolean;
}): any {
  const output = capacityReport(input);
  output.report.processorScopes = [
    {
      kind: "manager",
      managerId: "9470",
      processors: [input.processorId]
    }
  ];
  return output;
}

async function writeFakePnpm(
  filePath: string,
  observedPath: string,
  report: {
    ok: boolean;
    deploymentId: string;
    sessionId: string;
    hostname: string;
    failure?: Record<string, unknown>;
  }
): Promise<void> {
  await writeFile(
    filePath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("acurast:estimate-express")) {
  console.log(JSON.stringify({ estimatedFee: "1", currency: "ACU" }));
  process.exit(0);
}
if (args.includes("hub:fund-native-asset-quote")) {
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
    operatorId: process.env.OPERATOR_ID || "0x${"44".repeat(32)}",
    processorId: process.env.PROCESSOR_ID || "0x${"55".repeat(32)}",
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
  const output = {
    ok: true,
    dryRun: args.includes("--dry-run"),
    quote,
    signature: "0x${"aa".repeat(65)}",
    endpointHostname: "e-workflow.acurast.ingress.test",
    validationHostname: "v-workflow.acurast.ingress.test",
    txs: args.includes("--dry-run") ? undefined : [{ action: "fundWithAssetQuote", txHash: "0xfund", status: "inBlock" }],
    session: args.includes("--dry-run") ? undefined : { sessionId: quote.sessionId, status: "Funded" }
  };
  console.log(JSON.stringify(output));
  process.exit(0);
}
const runDir = args.includes("--run-dir") ? args[args.indexOf("--run-dir") + 1] : process.env.SWITCHBOARD_FAKE_RUN_DIR;
if (!runDir) throw new Error("fake pnpm expected --run-dir");
const snapshotPath = path.join(runDir, "switchboard-deploy-workflow.snapshot.json");
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const precreatedIntent = process.env.SWITCHBOARD_DEPLOY_PRECREATED_INTENT_JSON
  ? JSON.parse(process.env.SWITCHBOARD_DEPLOY_PRECREATED_INTENT_JSON)
  : undefined;
const precreatedGroup = process.env.SWITCHBOARD_DEPLOY_PRECREATED_GROUP_JSON
  ? JSON.parse(process.env.SWITCHBOARD_DEPLOY_PRECREATED_GROUP_JSON)
  : undefined;
fs.writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({ args, snapshot, precreatedIntent, precreatedGroup, runnerMode: process.env.SWITCHBOARD_DEPLOY_RUNNER_MODE }, null, 2) + "\\n");
const reportPath = path.join(runDir, "report.json");
const submitOnly = process.env.SWITCHBOARD_DEPLOY_RUNNER_MODE === "acurast-submit-only";
const groupSubmitOnly = process.env.SWITCHBOARD_DEPLOY_RUNNER_MODE === "acurast-group-submit-only";
const report = {
  ok: ${JSON.stringify(report.ok)},
  mode: process.env.SWITCHBOARD_DEPLOY_RUNNER_MODE,
  deployment: { deploymentId: ${JSON.stringify(report.deploymentId)}, txHash: "0xdeploy" },
  deploymentIntentGroup: precreatedGroup ? {
    groupId: precreatedGroup.deploymentIntentGroup.groupId,
    relayUrl: process.env.SWITCHBOARD_DEPLOY_RELAY_URL,
    expectedReplicas: precreatedGroup.group.expectedReplicas,
    minReady: precreatedGroup.group.minReady,
    members: precreatedGroup.deploymentIntentGroup.members
  } : undefined,
  session: {
    sessionId: ${JSON.stringify(report.sessionId)},
    jobId: "job-runner",
    jobSigner: "0x5000000000000000000000000000000000000005",
    hostname: ${JSON.stringify(report.hostname)},
    validationHostname: "v-${report.hostname}"
  },
  funding: submitOnly ? undefined : { txHash: "0xfund" },
  route: submitOnly ? undefined : { status: ${report.ok ? JSON.stringify("active") : JSON.stringify("failed")}, hostname: ${JSON.stringify(report.hostname)} },
  lifecycle: { durationMinutes: 15, scheduleBufferMinutes: 5 },
  relay: { url: process.env.SWITCHBOARD_DEPLOY_RELAY_URL },
  artifacts: { runDir },
  failure: ${JSON.stringify(report.failure)}
};
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\\n");
console.log("[switchboard-deploy] report=" + reportPath);
`,
    "utf8"
  );
  await chmod(filePath, 0o755);
}

async function writeFakeNpm(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    `#!/usr/bin/env node
process.exit(0);
`,
    "utf8"
  );
  await chmod(filePath, 0o755);
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

async function startJsonServer(
  handler: (url: URL, response: ServerResponse, request: IncomingMessage) => void
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    handler(new URL(request.url ?? "/", baseUrl), response, request);
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
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
