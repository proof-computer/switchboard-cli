import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  runBootstrapHostSubcommand,
  type BootstrapHostCommandResult,
  type BootstrapHostRunner
} from "../cli/src/bootstrap/host.js";

interface CapturedIo {
  log: string[];
  warn: string[];
  error: string[];
}

function makeIo(): {
  io: { log: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
  captured: CapturedIo;
} {
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

function makeRunner(): {
  runner: BootstrapHostRunner;
  calls: Array<{ command: string; args: string[]; input?: string }>;
} {
  const calls: Array<{ command: string; args: string[]; input?: string }> = [];
  return {
    calls,
    runner: async (command, args, options): Promise<BootstrapHostCommandResult> => {
      calls.push({ command, args, input: options.input });
      return { code: 0, stdout: "ok\n", stderr: "" };
    }
  };
}

describe("switchboard bootstrap host", () => {
  let workDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "switchboard-bootstrap-host-"));
    await mkdir(path.join(workDir, "relays"), { recursive: true });
    await writeFile(
      path.join(workDir, "relays", "catalog.json"),
      JSON.stringify(
        [
          {
            relayId: "relay-a",
            apiBaseUrl: "https://relay-a.example.invalid",
            validationReportUrl: "https://relay-a.example.invalid/v1/validation-reports",
            state: "active"
          }
        ],
        null,
        2
      )
    );
    env = {
      SWITCHBOARD_HOME: path.join(workDir, "home"),
      PROOF_MAINNET_QUOTE_SIGNER_PRIVATE_KEY: "quote-key",
      PROOF_MAINNET_QUOTE_ENDPOINT_ID_SECRET: "endpoint-secret",
      PROOF_MAINNET_MANIFEST_SIGNING_KEY: "manifest-key",
      PROOF_SERVICE_CATALOG_SIGNING_KEY: "",
      PROOF_MAINNET_RELAY_A_RECORDER_PRIVATE_KEY: "relay-a-key",
      PROOF_MAINNET_RELAY_B_RECORDER_PRIVATE_KEY: "relay-b-key",
      PROOF_MAINNET_RELAY_C_RECORDER_PRIVATE_KEY: "relay-c-key",
      PROOF_RELAY_A_RECORDER_ADDRESS: "0x00000000000000000000000000000000000000a1",
      PROOF_RELAY_B_RECORDER_ADDRESS: "0x00000000000000000000000000000000000000b2",
      PROOF_RELAY_C_RECORDER_ADDRESS: "0x00000000000000000000000000000000000000c3",
      PROOF_VALIDATION_READ_TOKEN: "validation-token",
      PROOF_VALIDATION_ALLOWED_SIGNERS: "5ValidationSigner",
      PROOF_OPERATOR_CAPABILITY_ALLOWED_SIGNERS: "5OperatorSigner",
      PROOF_CONTROL_PLANE_TOKEN: "control-token",
      PROOF_MANAGED_MAILBOX_TOKEN: "managed-mailbox-token",
      PROOF_LOG_CREATE_TOKEN: "log-create-token",
      PROOF_MAINNET_OPERATOR_REPORT_SEED: "operator-report-seed",
      PROOF_MAINNET_OPERATOR_RECIPIENT: "0x0000000000000000000000000000000000000001",
      PROOF_MAINNET_VALIDATOR_RECIPIENT: "0x0000000000000000000000000000000000000002",
      PROOF_MAINNET_TREASURY_RECIPIENT: "0x0000000000000000000000000000000000000003",
      QUOTE_SIGNER_ADDRESS: "0x0000000000000000000000000000000000000004",
      PROOF_NETWORK_MANIFEST_SIGNER: "5ManifestSigner",
      ACME_EMAIL: "ops@example.invalid",
      OPERATOR_ID: "0x00000000000000000000000000000000000000000000000000000000000000aa",
      GATEWAY_ID: "gateway-example",
      OPERATOR_MANAGER_IDS: "123",
      INGRESS_REGISTRY_ADDRESS: "0xA902E4212895ba4d5E5018a3540b96c2856e6Dce",
      PROOF_RECORDER_COORDINATOR_ADDRESS: "0x128dc0d76Ee356AaB732992AAd95EC9e13FB0F77",
      OPERATOR_PUBLIC_ADDRESSES: "203.0.113.10",
      SWITCHBOARD_BOOTSTRAP_HOST: "ops@example.invalid",
      SWITCHBOARD_BOOTSTRAP_REMOTE_DIR: "/srv/switchboard"
    };
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("renders an env plan with secret values redacted", async () => {
    const { io, captured } = makeIo();
    await runBootstrapHostSubcommand({
      flags: new Map(),
      positionals: ["bootstrap", "host", "env", "plan"],
      cwd: workDir,
      env,
      io
    });

    const output = captured.log.join("\n");
    assert.match(output, /bootstrap host env plan/);
    assert.match(output, /ACME_EMAIL=ops@example\.invalid/);
    assert.match(output, /GATEWAY_ID=gateway-example/);
    assert.match(output, /INGRESS_REGISTRY_ADDRESS=0xA902E4212895ba4d5E5018a3540b96c2856e6Dce/);
    assert.match(output, /PROOF_RECORDER_COORDINATOR_ADDRESS=0x128dc0d76Ee356AaB732992AAd95EC9e13FB0F77/);
    assert.match(output, /PROOF_DEPLOYMENT_INTENT_STORE_DIR=\/data\/deployment-intents/);
    assert.match(output, /PROOF_DEPLOYMENT_INTENT_PEER_BACKFILL_ENABLED=true/);
    assert.match(output, /PROOF_DEPLOYMENT_INTENT_PEER_BACKFILL_AUTOSTART=true/);
    assert.match(output, /PROOF_MANAGED_MAILBOX_ENABLED=true/);
    assert.match(output, /PROOF_MANAGED_MAILBOX_TOKEN=<redacted>/);
    assert.match(output, /PROOF_MANAGED_MAILBOX_SQLITE_FILE=\/data\/validation-reports\/proof-relay\.sqlite/);
    assert.match(output, /PROOF_MANAGED_MAILBOX_PEER_BACKFILL_ENABLED=true/);
    assert.match(output, /PROOF_MANAGED_MAILBOX_PEER_BACKFILL_AUTOSTART=true/);
    assert.match(output, /PROOF_CERTIFICATE_ISSUANCE_STORE_DIR=\/data\/certificate-issuance/);
    assert.match(output, /QUOTE_SIGNER_PRIVATE_KEY=<redacted>/);
    assert.match(output, /PROOF_EXPLORER_RELAY_READ_TOKEN=<redacted>/);
    assert.match(output, /PROOF_LOG_CREATE_TOKEN=<redacted>/);
    assert.match(output, /PROOF_CONTROL_PLANE_TOKEN=<redacted>/);
    assert.doesNotMatch(output, /quote-key/);
    assert.doesNotMatch(output, /validation-token/);
    assert.doesNotMatch(output, /managed-mailbox-token/);
    assert.doesNotMatch(output, /log-create-token/);
    assert.doesNotMatch(output, /control-token/);
  });

  it("streams env rows to the remote upsert helper on apply", async () => {
    const { io } = makeIo();
    const { runner, calls } = makeRunner();
    await runBootstrapHostSubcommand({
      flags: new Map<string, string | boolean>([
        ["yes", true],
        ["no-build", true],
        ["no-push", true],
        ["host", "ops@example.invalid"],
        ["remote-dir", "/srv/switchboard"]
      ]),
      positionals: ["bootstrap", "host", "env", "apply"],
      cwd: workDir,
      env,
      io,
      runner
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "ssh");
    assert.match(calls[0].args.join(" "), /upsert-env-from-stdin.py/);
    assert.match(calls[0].input ?? "", /control\tACME_EMAIL\tops@example\.invalid/);
    assert.match(calls[0].input ?? "", /operator\tGATEWAY_ID\tgateway-example/);
    assert.match(calls[0].input ?? "", /control\tINGRESS_REGISTRY_ADDRESS\t0xA902E4212895ba4d5E5018a3540b96c2856e6Dce/);
    assert.match(calls[0].input ?? "", /control\tPROOF_RECORDER_COORDINATOR_ADDRESS\t0x128dc0d76Ee356AaB732992AAd95EC9e13FB0F77/);
    assert.match(calls[0].input ?? "", /control\tPROOF_DEPLOYMENT_INTENT_STORE_DIR\t\/data\/deployment-intents/);
    assert.match(calls[0].input ?? "", /control\tPROOF_DEPLOYMENT_INTENT_PEER_BACKFILL_ENABLED\ttrue/);
    assert.match(calls[0].input ?? "", /control\tPROOF_DEPLOYMENT_INTENT_PEER_BACKFILL_AUTOSTART\ttrue/);
    assert.match(calls[0].input ?? "", /control\tPROOF_MANAGED_MAILBOX_ENABLED\ttrue/);
    assert.match(calls[0].input ?? "", /control\tPROOF_MANAGED_MAILBOX_TOKEN\tmanaged-mailbox-token/);
    assert.match(calls[0].input ?? "", /control\tPROOF_MANAGED_MAILBOX_SQLITE_FILE\t\/data\/validation-reports\/proof-relay\.sqlite/);
    assert.match(calls[0].input ?? "", /control\tPROOF_MANAGED_MAILBOX_PEER_BACKFILL_ENABLED\ttrue/);
    assert.match(calls[0].input ?? "", /control\tPROOF_MANAGED_MAILBOX_PEER_BACKFILL_AUTOSTART\ttrue/);
    assert.match(calls[0].input ?? "", /control\tPROOF_CERTIFICATE_ISSUANCE_STORE_DIR\t\/data\/certificate-issuance/);
    const operatorProfilesRow = calls[0].input
      ?.split("\n")
      .find((line) => line.startsWith("control\tPROOF_OPERATOR_PROFILES_JSON\t"));
    assert.ok(operatorProfilesRow);
    const operatorProfiles = JSON.parse(operatorProfilesRow.split("\t")[2]);
    assert.deepEqual(operatorProfiles[0].gatewayIds, []);
    assert.deepEqual(operatorProfiles[0].managerIds, ["123"]);
    assert.match(calls[0].input ?? "", /control\tQUOTE_SIGNER_PRIVATE_KEY\tquote-key/);
    assert.match(calls[0].input ?? "", /control\tPROOF_LOG_CREATE_TOKEN\tlog-create-token/);
    assert.match(calls[0].input ?? "", /control\tPROOF_CONTROL_PLANE_TOKEN\tcontrol-token/);
    assert.match(calls[0].input ?? "", /explorer\tPROOF_EXPLORER_RELAY_READ_TOKEN\tvalidation-token/);
  });

  it("builds catalogs with the expected host defaults", async () => {
    const { io } = makeIo();
    let seenOutput: string | undefined;
    let seenSigningKey: string | undefined;
    await runBootstrapHostSubcommand({
      flags: new Map(),
      positionals: ["bootstrap", "host", "catalog", "build"],
      cwd: workDir,
      env,
      io,
      catalogBuilder: async (options) => {
        seenOutput = options.env?.PROOF_SERVICE_CATALOGS_OUTPUT_FILE;
        seenSigningKey = options.env?.PROOF_SERVICE_CATALOG_SIGNING_KEY;
        return {
          specsDir: path.join(workDir, "relays"),
          entries: [],
          outputFile: seenOutput,
          signer: "5Signer"
        };
      }
    });

    assert.equal(seenOutput, path.join(workDir, ".control-plane/service-catalogs/service-catalogs.signed.json"));
    assert.equal(seenSigningKey, "manifest-key");
  });

  it("constructs the remote relay compose command from the requested service name", async () => {
    const { io, captured } = makeIo();
    await runBootstrapHostSubcommand({
      flags: new Map<string, string | boolean>([["dry-run", true]]),
      positionals: ["bootstrap", "host", "deploy", "relay-a"],
      cwd: workDir,
      env,
      io
    });

    const output = captured.log.join("\n");
    assert.match(output, /\.control-plane\/legacy-deployment-intents\/relay/);
    assert.match(output, /\/app\/tmp\/deployment-intents\/\./);
    assert.match(output, /\/data\/deployment-intents/);
    assert.match(output, /docker-compose\.control-plane\.yaml/);
    assert.match(output, /up -d --no-deps --build --force-recreate relay-a/);
  });

  it("constructs rsync commands for worktree sync and catalog push", async () => {
    const { io } = makeIo();
    const { runner, calls } = makeRunner();
    await runBootstrapHostSubcommand({
      flags: new Map<string, string | boolean>([
        ["yes", true],
        ["dry-run", true]
      ]),
      positionals: ["bootstrap", "host", "sync"],
      cwd: workDir,
      env,
      io,
      runner
    });
    await runBootstrapHostSubcommand({
      flags: new Map<string, string | boolean>([
        ["yes", true],
        ["dry-run", true]
      ]),
      positionals: ["bootstrap", "host", "catalog", "push"],
      cwd: workDir,
      env,
      io,
      runner
    });

    assert.equal(calls[0].command, "rsync");
    assert.ok(calls[0].args.includes("--exclude"));
    assert.ok(calls[0].args.includes(".control-plane/"));
    assert.equal(calls[1].command, "rsync");
    assert.ok(calls[1].args.includes("--dry-run"));
    assert.ok(calls[1].args.some((arg) => arg.endsWith(".control-plane/service-catalogs/")));
  });
});
