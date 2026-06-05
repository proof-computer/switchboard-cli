import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertNoRemovedPublicCommandFlags, printHelp, runStandaloneSwitchboardCli, sanitizeOutputValue } from "../cli/src/index.js";

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
  it("prints the standalone migration handoff instead of command compatibility help", () => {
    const help = captureHelp();

    assert.match(help, /standalone switchboard command router has moved/);
    assert.match(help, /proof switchboard --help/);
    assert.match(help, /command-specific shared runner exports/);
    assert.doesNotMatch(help, /switchboard launch-demo --yes-spend/);
    assert.doesNotMatch(help, /Gateway setup:/);
  });

  it("ignores old advanced help and keeps the migration handoff", () => {
    const help = captureHelp({ advanced: true });

    assert.match(help, /proof switchboard --help/);
    assert.doesNotMatch(help, /Advanced session commands:/);
    assert.doesNotMatch(help, /Admin relay commands:/);
  });

  it("can run standalone migration help through the exported standalone runner", async () => {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (line?: unknown) => {
      lines.push(String(line ?? ""));
    };

    try {
      await runStandaloneSwitchboardCli(["--help"]);
    } finally {
      console.log = originalLog;
    }

    const help = lines.join("\n");
    assert.match(help, /proof switchboard --help/);
    assert.match(help, /No standalone command compatibility/);
  });

  it("prints command-specific migration help for a retired standalone help request", async () => {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (line?: unknown) => {
      lines.push(String(line ?? ""));
    };

    try {
      await runStandaloneSwitchboardCli(["gateway", "setup", "--help"]);
    } finally {
      console.log = originalLog;
    }

    const help = lines.join("\n");
    assert.match(help, /Requested standalone command:/);
    assert.match(help, /switchboard gateway setup --help/);
    assert.match(help, /proof switchboard gateway setup --help/);
  });

  it("rejects migrated standalone command routing", async () => {
    await assert.rejects(
      runStandaloneSwitchboardCli(["operator", "setup"]),
      /SB_STANDALONE_SWITCHBOARD_MIGRATED:.*proof switchboard operator setup/
    );
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
    assert.doesNotThrow(() => assertNoRemovedPublicCommandFlags("relay-status", new Map([["route-activation-mode", "control-plane"]])));
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
