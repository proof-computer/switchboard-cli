import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployRunnerUrl = pathToFileURL(path.join(cliRoot, "scripts/acurast/switchboard-deploy.ts")).href;

describe("switchboard deploy helper script resolution", () => {
  it("resolves the source pnpm runner in checkout mode", async () => {
    const mod = await importCliIndex();
    const mapped = await mod.resolveDeployRunner(
      ["switchboard:internal:deploy-runner", "--", "--yes"],
      { OPERATOR_ID: "operator-a" },
      { workDir: cliRoot, currentFile: path.join(cliRoot, "cli/src/index.ts") }
    );

    assert.equal(mapped.command, "pnpm");
    assert.deepEqual(mapped.args, ["--silent", "switchboard:internal:deploy-runner", "--", "--yes"]);
    assert.equal(mapped.cwd, cliRoot);
    assert.equal(mapped.env.SWITCHBOARD_WORK_DIR, cliRoot);
  });

  it("resolves the packaged dist runner when no source script is available", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-packaged-workload-"));
    const packageRoot = await mkdtemp(path.join(tmpdir(), "switchboard-packaged-cli-"));
    try {
      const distDir = path.join(packageRoot, "dist");
      const internalDir = path.join(distDir, "internal");
      await mkdir(internalDir, { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "switchboard-cli", type: "module" }), "utf8");
      await writeFile(path.join(distDir, "index.js"), "", "utf8");
      await writeFile(path.join(internalDir, "switchboard-deploy.js"), "", "utf8");

      const mod = await importCliIndex();
      const mapped = await mod.resolveDeployRunner(
        ["switchboard:internal:deploy-runner", "--", "--yes"],
        { OPERATOR_ID: "operator-a" },
        { workDir, currentFile: path.join(distDir, "index.js") }
      );

      assert.equal(mapped.command, process.execPath);
      assert.deepEqual(mapped.args, [path.join(internalDir, "switchboard-deploy.js"), "--yes"]);
      assert.equal(mapped.env.SWITCHBOARD_WORK_DIR, workDir);
      assert.equal(mapped.env.SWITCHBOARD_INTERNAL_BIN_DIR, internalDir);
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("runs internal helper scripts from the CLI package when the workload root is elsewhere", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-workload-root-"));

    try {
      const mod = await importDeployRunnerWithWorkDir(workDir);
      const mapped = mod.mapSwitchboardDeployPnpmScript(
        "pnpm",
        ["--silent", "hub:fund-native-asset-quote", "--", "--dry-run"],
        undefined
      );

      assert.ok(mapped);
      assert.equal(mapped.command, "pnpm");
      assert.deepEqual(mapped.args, ["--silent", "hub:fund-native-asset-quote", "--", "--dry-run"]);
      assert.equal(mapped.cwd, cliRoot);
      assert.equal(mapped.env.SWITCHBOARD_WORK_DIR, workDir);
      assert.equal(mapped.env.DOTENV_CONFIG_PATH, path.join(workDir, ".env"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("does not remap unrelated pnpm scripts", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-workload-root-"));

    try {
      const mod = await importDeployRunnerWithWorkDir(workDir);
      const mapped = mod.mapSwitchboardDeployPnpmScript("pnpm", ["--silent", "test"], undefined);
      assert.equal(mapped, undefined);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("builds public deployment-intent create payloads without hostname inputs", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-workload-root-"));

    try {
      const mod = await importDeployRunnerWithWorkDir(workDir);
      const config = {
        leaseSeconds: 600,
        runId: "payload-test",
        operatorId: `0x${"11".repeat(32)}`,
        managerId: "9470",
        gatewayId: "gateway-a",
        capabilityReportId: "capability-a",
        capabilityReportExpiresAt: "2026-05-13T12:00:00.000Z",
        operatorPublicAddresses: ["203.0.113.10"],
        targetName: "polkadot-hub-testnet"
      };
      const single = mod.buildDeploymentIntentCreateBody(config, {
        jobId: `0x${"22".repeat(32)}`,
        processorId: `0x${"33".repeat(32)}`
      });
      assert.equal("endpointHostname" in single, false);
      assert.equal("validationHostname" in single, false);
      assert.equal("preferredDomain" in single, false);
      assert.equal("allocation" in single, false);
      assert.equal(single.gatewayId, "gateway-a");
      assert.equal(mod.deploymentIntentGatewayUpstreamPort({
        GATEWAY_UPSTREAM_PORT: "9443",
        SWITCHBOARD_UPSTREAM_PORT: "3443",
        PORT: "3000"
      }), 9443);
      assert.equal(mod.deploymentIntentGatewayUpstreamPort({
        SWITCHBOARD_UPSTREAM_PORT: "3443",
        PORT: "3000"
      }), 3443);
      assert.equal(mod.deploymentIntentGatewayUpstreamPort({
        PORT: "3000"
      }), 3000);
      assert.equal(mod.deploymentIntentGatewayUpstreamPort({}), 3000);

      const group = mod.buildDeploymentIntentGroupCreateBody({
        ...config,
        group: {
          expectedReplicas: 1,
          minReady: 1,
          members: [
            {
              memberId: "az-a",
              operatorId: config.operatorId,
              processorId: `0x${"44".repeat(32)}`,
              processor: "processor-a",
              gatewayId: "gateway-a"
            }
          ]
        }
      });
      assert.equal("endpointHostname" in group, false);
      assert.equal("preferredDomain" in group, false);
      const member = (group.members as Array<Record<string, unknown>>)[0];
      assert.equal("validationHostname" in member, false);
      assert.equal("allocation" in member, false);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("prefers relay readback hostnames over funding helper fallbacks", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-workload-hostnames-"));

    try {
      const mod = await importDeployRunnerWithWorkDir(workDir);
      const funding = {
        endpointHostname: "e-funded.acurast.ingress.directory"
      };
      const status = {
        ok: true,
        intent: {
          endpointHostname: "e-readback.acurast.ingress.directory",
          validationHostname: "e-readback.acurast.ingress.directory"
        }
      };

      assert.deepEqual(mod.deploymentIntentHostnamesFromRecords(funding, status), {
        hostname: "e-readback.acurast.ingress.directory",
        validationHostname: "e-readback.acurast.ingress.directory"
      });
      assert.deepEqual(mod.deploymentIntentHostnamesFromRecords(funding), {
        hostname: "e-funded.acurast.ingress.directory",
        validationHostname: "e-funded.acurast.ingress.directory"
      });
      assert.deepEqual(mod.deploymentIntentHostnamesFromRecords(undefined, { ok: true, intent: {} }), {});
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("parses and validates precreated deployment-intent payloads fail-closed", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-workload-precreated-"));

    try {
      const mod = await importDeployRunnerWithWorkDir(workDir);
      const payload = {
        workflowId: "wf-test",
        jobId: `0x${"22".repeat(32)}`,
        capacity: {
          operatorId: `0x${"11".repeat(32)}`,
          processorId: `0x${"33".repeat(32)}`,
          processor: "processor-a",
          gatewayId: "gateway-a",
          managerId: "9470"
        },
        deploymentIntent: {
          intentId: "di_test",
          cliToken: "cli-token",
          env: {
            SWITCHBOARD_RELAY_URL: "https://relay.test",
            SWITCHBOARD_INTENT_ID: "di_test",
            SWITCHBOARD_INTENT_TOKEN: "intent-token"
          }
        },
        sensitiveFields: [
          "deploymentIntent.cliToken",
          "deploymentIntent.env.SWITCHBOARD_INTENT_TOKEN"
        ]
      };
      const parsed = mod.parsePrecreatedDeployIntentPayloadJson(JSON.stringify(payload));
      assert.equal(parsed.workflowId, "wf-test");
      assert.equal(parsed.deploymentIntent.intentId, "di_test");

      assert.doesNotThrow(() => mod.validatePrecreatedDeployIntentPayload(parsed, {
        relayUrl: "https://relay.test",
        operatorId: payload.capacity.operatorId,
        gatewayId: "gateway-a",
        managerId: "9470"
      }, {
        processor: "processor-a",
        processorId: payload.capacity.processorId
      }));

      assert.throws(
        () => mod.parsePrecreatedDeployIntentPayloadJson("{not-json"),
        /not valid JSON/
      );
      assert.throws(
        () => mod.parsePrecreatedDeployIntentPayloadJson(JSON.stringify({
          ...payload,
          deploymentIntent: {
            ...payload.deploymentIntent,
            env: {
              ...payload.deploymentIntent.env,
              SWITCHBOARD_INTENT_ID: "di_other"
            }
          }
        })),
        /SWITCHBOARD_INTENT_ID does not match intentId/
      );
      assert.throws(
        () => mod.validatePrecreatedDeployIntentPayload(parsed, {
          relayUrl: "https://relay.test",
          operatorId: payload.capacity.operatorId,
          gatewayId: "gateway-other",
          managerId: "9470"
        }, {
          processor: "processor-a",
          processorId: payload.capacity.processorId
        }),
        /gatewayId mismatch/
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("parses and validates precreated deployment-intent group payloads fail-closed", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-workload-precreated-group-"));

    try {
      const mod = await importDeployRunnerWithWorkDir(workDir);
      const payload = {
        workflowId: "wf-group",
        deploymentMode: "group",
        jobId: `0x${"22".repeat(32)}`,
        capacity: {
          operatorId: `0x${"11".repeat(32)}`,
          processorId: `0x${"33".repeat(32)}`,
          processor: "processor-a",
          gatewayId: "gateway-a",
          managerId: "9470"
        },
        group: {
          expectedReplicas: 2,
          minReady: 2,
          members: [
            { memberId: "member-1", operatorId: `0x${"11".repeat(32)}`, processorId: `0x${"33".repeat(32)}`, processor: "processor-a", gatewayId: "gateway-a", managerId: "9470" },
            { memberId: "member-2", operatorId: `0x${"11".repeat(32)}`, processorId: `0x${"44".repeat(32)}`, processor: "processor-b", gatewayId: "gateway-b", managerId: "9470" }
          ]
        },
        deploymentIntentGroup: {
          groupId: "dig_test",
          cliToken: "group-cli-token",
          env: {
            SWITCHBOARD_RELAY_URL: "https://relay.test",
            SWITCHBOARD_INTENT_GROUP_ID: "dig_test",
            SWITCHBOARD_INTENT_TOKEN: "group-job-token"
          },
          members: [
            { memberId: "member-1", intentId: "di_1", jobId: `0x${"55".repeat(32)}`, operatorId: `0x${"11".repeat(32)}`, processorId: `0x${"33".repeat(32)}`, processor: "processor-a", gatewayId: "gateway-a" },
            { memberId: "member-2", intentId: "di_2", jobId: `0x${"66".repeat(32)}`, operatorId: `0x${"11".repeat(32)}`, processorId: `0x${"44".repeat(32)}`, processor: "processor-b", gatewayId: "gateway-b" }
          ]
        },
        sensitiveFields: [
          "deploymentIntentGroup.cliToken",
          "deploymentIntentGroup.env.SWITCHBOARD_INTENT_TOKEN"
        ]
      };
      const parsed = mod.parsePrecreatedDeployGroupPayloadJson(JSON.stringify(payload));
      assert.equal(parsed.workflowId, "wf-group");
      assert.equal(parsed.deploymentIntentGroup.groupId, "dig_test");
      assert.doesNotThrow(() => mod.validatePrecreatedDeployGroupPayload(parsed, {
        relayUrl: "https://relay.test",
        operatorId: payload.capacity.operatorId,
        gatewayId: "gateway-a",
        managerId: "9470",
        group: payload.group
      }));
      assert.throws(
        () => mod.validatePrecreatedDeployGroupPayload(parsed, {
          relayUrl: "https://relay.test",
          operatorId: payload.capacity.operatorId,
          gatewayId: "gateway-a",
          managerId: "9470",
          group: { ...payload.group, minReady: 1 }
        }),
        /minReady mismatch/
      );
      assert.throws(
        () => mod.validatePrecreatedDeployGroupPayload(parsed, {
          relayUrl: "https://relay.test",
          operatorId: payload.capacity.operatorId,
          gatewayId: "gateway-a",
          managerId: "9470",
          group: {
            ...payload.group,
            members: payload.group.members.map((member, index) => index === 1 ? { ...member, processor: "processor-other" } : member)
          }
        }),
        /processor mismatch/
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

async function importDeployRunnerWithWorkDir(workDir: string): Promise<{
  mapSwitchboardDeployPnpmScript: (
    command: string,
    args: string[],
    env: Record<string, string | undefined> | undefined
  ) => { command: string; args: string[]; env: Record<string, string | undefined>; cwd?: string } | undefined;
  buildDeploymentIntentCreateBody: (
    config: Record<string, unknown>,
    input: { jobId: string; processorId: string }
  ) => Record<string, unknown>;
  buildDeploymentIntentGroupCreateBody: (config: Record<string, unknown>) => Record<string, unknown>;
  deploymentIntentGatewayUpstreamPort: (config: Record<string, string | undefined>) => number;
  deploymentIntentHostnamesFromRecords: (
    funding: Record<string, unknown> | undefined,
    status?: Record<string, unknown>
  ) => { hostname?: string; validationHostname?: string };
  parsePrecreatedDeployIntentPayloadJson: (raw: string) => Record<string, any>;
  parsePrecreatedDeployGroupPayloadJson: (raw: string) => Record<string, any>;
  validatePrecreatedDeployIntentPayload: (
    payload: Record<string, any>,
    config: Record<string, unknown>,
    selected: { processor: string; processorId: string }
  ) => void;
  validatePrecreatedDeployGroupPayload: (
    payload: Record<string, any>,
    config: Record<string, unknown>
  ) => void;
}> {
  const oldWorkDir = process.env.SWITCHBOARD_WORK_DIR;
  const oldInternalBinDir = process.env.SWITCHBOARD_INTERNAL_BIN_DIR;
  delete process.env.SWITCHBOARD_INTERNAL_BIN_DIR;
  process.env.SWITCHBOARD_WORK_DIR = workDir;
  try {
    return await import(`${deployRunnerUrl}?case=${Date.now()}-${Math.random()}`);
  } finally {
    if (oldWorkDir === undefined) {
      delete process.env.SWITCHBOARD_WORK_DIR;
    } else {
      process.env.SWITCHBOARD_WORK_DIR = oldWorkDir;
    }
    if (oldInternalBinDir === undefined) {
      delete process.env.SWITCHBOARD_INTERNAL_BIN_DIR;
    } else {
      process.env.SWITCHBOARD_INTERNAL_BIN_DIR = oldInternalBinDir;
    }
  }
}

async function importCliIndex(): Promise<{
  resolveDeployRunner: (
    repoChildArgs: string[],
    childEnv: Record<string, string | undefined>,
    context?: { workDir?: string; currentFile?: string }
  ) => Promise<{ command: string; args: string[]; env: Record<string, string | undefined>; cwd?: string }>;
}> {
  const cliUrl = pathToFileURL(path.join(cliRoot, "cli/src/index.ts")).href;
  return await import(`${cliUrl}?case=${Date.now()}-${Math.random()}`);
}
