import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  DEFAULT_ACURAST_IPFS_API_KEY,
  DEFAULT_ACURAST_IPFS_URL,
  acurastSdkIpfsUploadConfig,
  buildAcurastSdkEnvVars,
  buildAcurastSdkProjectConfig,
  type AcurastSdkSubmitActionPayload
} from "../cli/src/acurast-submit-adapter.js";

const actionPayload: AcurastSdkSubmitActionPayload = {
  workflowId: "wf_1",
  jobId: `0x${"11".repeat(32)}`,
  capacity: {
    operatorId: `0x${"22".repeat(32)}`,
    processorId: `0x${"33".repeat(32)}`,
    processor: "5GrwvaEF5zXb26Fz9rcQpDWS2jxYzFNK4W7FvR2RLe3bkNbA",
    gatewayId: "gateway-a",
    managerId: "9470"
  },
  deploymentIntent: {
    intentId: "di_1",
    cliToken: "cli-secret",
    env: {
      SWITCHBOARD_RELAY_URL: "https://relay.test",
      SWITCHBOARD_INTENT_ID: "di_1",
      SWITCHBOARD_INTENT_TOKEN: "job-secret"
    }
  },
  sensitiveFields: ["deploymentIntent.cliToken", "deploymentIntent.env.SWITCHBOARD_INTENT_TOKEN"]
};

describe("Acurast SDK submit adapter builders", () => {
  it("builds a single-replica SDK project config from Switchboard deploy env", () => {
    const config = buildAcurastSdkProjectConfig({
      env: {
        ACURAST_NETWORK: "mainnet",
        ACURAST_PROJECT_NAME: "switchboard-test",
        ACURAST_EXECUTION_MS: "1200000",
        ACURAST_START_DELAY_MS: "180000",
        ACURAST_INSTANT_MATCH_START_DELAY_MS: "180000",
        ACURAST_MAX_COST_PER_EXECUTION: "750000000",
        ACURAST_MAX_NETWORK_REQUESTS: "1000"
      },
      bundlePath: path.join("/tmp", "bundle.cjs"),
      processor: actionPayload.capacity.processor!
    });

    assert.equal(config.projectName, "switchboard-test");
    assert.equal(config.numberOfReplicas, 1);
    assert.equal(config.network, "mainnet");
    assert.equal(config.maxCostPerExecution, 750000000);
    assert.equal(config.assignmentStrategy.type, "Single");
    assert.equal(config.assignmentStrategy.instantMatch?.[0].processor, actionPayload.capacity.processor);
    assert.equal(config.execution.type, "onetime");
    assert.equal(config.execution.maxExecutionTimeInMs, 1200000);
  });

  it("carries precreated deployment-intent env and explicit included env", () => {
    const envVars = buildAcurastSdkEnvVars({
      PORT: "3000",
      SWITCHBOARD_DEMO_VERSION: "0.1.0",
      ACURAST_INCLUDE_ENV: "EXTRA_TOKEN",
      EXTRA_TOKEN: "extra-secret"
    }, actionPayload);
    const byKey = new Map(envVars.map((item) => [item.key, item.value]));
    const switchboardConfig = JSON.parse(byKey.get("SWITCHBOARD_CONFIG")!);

    assert.equal(switchboardConfig.SWITCHBOARD_RELAY_URL, "https://relay.test");
    assert.equal(switchboardConfig.SWITCHBOARD_INTENT_ID, "di_1");
    assert.equal(switchboardConfig.SWITCHBOARD_INTENT_TOKEN, "job-secret");
    assert.equal(switchboardConfig.SWITCHBOARD_DEMO_VERSION, "0.1.0");
    assert.equal(byKey.get("EXTRA_TOKEN"), "extra-secret");
  });

  it("rejects missing explicit included env without falling back to CLI harness inputs", () => {
    assert.throws(
      () => buildAcurastSdkEnvVars({ ACURAST_INCLUDE_ENV: "MISSING_TOKEN" }, actionPayload),
      /MISSING_TOKEN is listed in ACURAST_INCLUDE_ENV but is not set/
    );
  });

  it("mirrors acurast-cli IPFS upload defaults while allowing overrides", () => {
    assert.deepEqual(acurastSdkIpfsUploadConfig({}), {
      endpoint: DEFAULT_ACURAST_IPFS_URL,
      apiKey: DEFAULT_ACURAST_IPFS_API_KEY
    });
    assert.deepEqual(acurastSdkIpfsUploadConfig({
      ACURAST_IPFS_URL: "https://ipfs.example.test",
      ACURAST_IPFS_API_KEY: "test-key"
    }), {
      endpoint: "https://ipfs.example.test",
      apiKey: "test-key"
    });
  });
});
