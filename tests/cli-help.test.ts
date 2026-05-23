import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertNoRemovedPublicCommandFlags, printHelp, runSwitchboardCli, sanitizeOutputValue } from "../cli/src/index.js";

function captureHelp(options?: { advanced?: boolean }): string {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line?: unknown) => {
    lines.push(String(line ?? ""));
  };
  try {
    printHelp(options);
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

describe("switchboard help", () => {
  it("shows operator commands in default help while keeping PROOF admin commands advanced", () => {
    const help = captureHelp();

    assert.match(help, /operator setup/);
    assert.match(help, /operator discover/);
    assert.match(help, /launch-demo/);
    assert.match(help, /deploy doctor/);
    assert.match(help, /Deploy doctor:/);
    assert.match(help, /Launch demo:/);
    assert.match(help, /switchboard launch-demo --yes-spend/);
    assert.match(help, /--max-cost-per-execution <n>\s+Default 40000000000/);
    assert.match(help, /Acurast start delay\s+Fixed 3 minutes/);
    assert.doesNotMatch(help, /^\s+logs$/m);
    assert.doesNotMatch(help, /Decrypt encrypted job logs/);
    assert.doesNotMatch(help, /log-sink/);
    assert.match(help, /Operator setup:/);
    assert.match(help, /--generate-report-seed/);
    assert.match(help, /--prepare-admission/);
    assert.match(help, /--admission-file <path>/);
    assert.match(help, /--payout-address <0xaddress>/);
    assert.match(help, /--processor-file <path>/);
    assert.match(help, /Operator status and upgrade:/);
    assert.match(help, /--capability-token-env <env>/);
    assert.match(help, /PROOF-required and admin commands are hidden/);
    assert.doesNotMatch(help, /Advanced session commands:/);
    assert.doesNotMatch(help, /PROOF ops commands:/);
    assert.doesNotMatch(help, /Admin relay commands:/);
  });

  it("shows PROOF/admin namespaces with advanced help", () => {
    const help = captureHelp({ advanced: true });

    assert.match(help, /operator setup/);
    assert.match(help, /Advanced session commands:/);
    assert.match(help, /PROOF ops commands:/);
    assert.match(help, /Admin relay commands:/);
    const deployHelp = help.slice(help.indexOf("Deploy defaults:"));
    assert.doesNotMatch(deployHelp, /--route-activation-mode/);
    assert.doesNotMatch(deployHelp, /--record-fulfillment/);
    assert.doesNotMatch(deployHelp, /--validator-mode/);
    assert.doesNotMatch(help, /--control-plane-token-env/);
  });

  it("can run compatibility help through the exported CLI runner", async () => {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (line?: unknown) => {
      lines.push(String(line ?? ""));
    };

    try {
      await runSwitchboardCli(["--help"], { contextStorePath: "/tmp/switchboard-test-contexts.json" });
    } finally {
      console.log = originalLog;
    }

    const help = lines.join("\n");
    assert.match(help, /Switchboard, a PROOF project/);
    assert.match(help, /switchboard launch-demo --yes-spend/);
  });

  it("rejects removed public deploy and status flags", () => {
    assert.throws(
      () => assertNoRemovedPublicCommandFlags("deploy", new Map([["route-activation-mode", "control-plane"]])),
      /Removed public deploy option\(s\): --route-activation-mode/
    );
    assert.throws(
      () => assertNoRemovedPublicCommandFlags("launch-demo", new Map([["record-fulfillment", true]])),
      /Removed public launch-demo option\(s\): --record-fulfillment/
    );
    assert.throws(
      () => assertNoRemovedPublicCommandFlags("deployment-status", new Map([["repair-route", true]])),
      /Removed public status option\(s\): --repair-route/
    );
    assert.doesNotThrow(() => assertNoRemovedPublicCommandFlags("relay-deploy", new Map([["route-activation-mode", "control-plane"]])));
  });

  it("redacts JSON output secrets while preserving env var references", () => {
    assert.deepEqual(
      sanitizeOutputValue({
        token: "live-token",
        privateKey: "0xabc",
        seed: "mnemonic",
        seedEnv: "POLKADOT_SEED",
        nested: {
          authorizationHeader: "Bearer live-token",
          controlPlaneTokenEnv: "PROOF_CONTROL_PLANE_TOKEN"
        }
      }),
      {
        token: "[redacted]",
        privateKey: "[redacted]",
        seed: "[redacted]",
        seedEnv: "POLKADOT_SEED",
        nested: {
          authorizationHeader: "[redacted]",
          controlPlaneTokenEnv: "PROOF_CONTROL_PLANE_TOKEN"
        }
      }
    );
  });
});
