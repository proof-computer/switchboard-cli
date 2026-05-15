import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { runRelayDeploy } from "../cli/src/relay/index.js";

interface CapturedIo {
  log: string[];
  warn: string[];
  error: string[];
}

function makeIo(): { io: { log: (l: string) => void; warn: (l: string) => void; error: (l: string) => void }; captured: CapturedIo } {
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

const baseAcurastSpec = {
  version: 1,
  relayId: "relay-d",
  target: "acurast",
  catalogState: "candidate",
  apiBaseUrl: "https://relay-d.switchboard.proof.computer",
  peers: [
    {
      relayId: "relay-a",
      apiBaseUrl: "https://relay-a.switchboard.proof.computer",
      readTokenEnv: "PROOF_VALIDATION_READ_TOKEN"
    }
  ],
  secrets: {
    relayerPrivateKeyEnv: "PROOF_RELAY_D_RELAYER_PRIVATE_KEY",
    validationReadTokenEnv: "PROOF_VALIDATION_READ_TOKEN"
  },
  acurast: {
    deployerSeedEnv: "PROOF_ACURAST_MAINNET_DEPLOYER_SEED",
    projectName: "switchboard-mainnet-relay-d",
    stageDir: "dist/acurast/switchboard-mainnet-relay-d",
    maxCostPerExecution: 40_000_000_000,
    includeEnv: ["CHAIN_ID", "HUB_ETH_RPC_URL", "INGRESS_REGISTRY_ADDRESS"]
  }
};

describe("switchboard relay deploy (dry-run)", () => {
  let workDir: string;
  let prevCwd: string;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "switchboard-relay-cli-"));
    prevCwd = process.cwd();
    process.chdir(workDir);
  });

  after(async () => {
    process.chdir(prevCwd);
    await rm(workDir, { recursive: true, force: true });
  });

  it("loads relays/<id>.json by default and prints the dry-run plan", async () => {
    await writeSpec(workDir, "relay-d", baseAcurastSpec);
    const { io, captured } = makeIo();

    await runRelayDeploy({
      flags: new Map<string, string | boolean>([["dry-run", true]]),
      positionals: ["relay", "deploy", "relay-d"],
      io
    });

    const output = captured.log.join("\n");
    assert.match(output, /relay deploy --dry-run/);
    assert.match(output, /relay id\s*:\s*relay-d/);
    assert.match(output, /target\s*:\s*acurast/);
    assert.match(output, /catalog state\s*:\s*candidate$/m);
    assert.match(output, /project name\s*:\s*switchboard-mainnet-relay-d/);
    assert.match(output, /encrypted code\s*:\s*enabled \(AES-256-GCM bootstrap\)/);
    assert.match(output, /secret intent plan:/);
    assert.match(output, /authority profile\s*:\s*durable-relay/);
    assert.match(output, /public build config \(IPFS-public\):/);
    assert.match(output, /encrypted runtime env:/);
    assert.match(output, /SWITCHBOARD_CODE_KEY/);
    assert.match(output, /local only:/);
    assert.match(output, /PROOF_ACURAST_MAINNET_DEPLOYER_SEED/);
    assert.match(output, /prepare the Acurast project bundle/);
    assert.match(output, /replace dist\/bundle\.cjs with encrypted-code bootstrap/);
    assert.match(output, /poll https:\/\/relay-d\.switchboard\.proof\.computer\/health/);
  });

  it("honors --spec-file and applies --state override with annotation", async () => {
    const altPath = path.join(workDir, "alt-relay-d.json");
    await writeFile(altPath, JSON.stringify(baseAcurastSpec), "utf8");
    const { io, captured } = makeIo();

    await runRelayDeploy({
      flags: new Map<string, string | boolean>([
        ["spec-file", altPath],
        ["state", "degraded"],
        ["dry-run", true]
      ]),
      positionals: ["relay", "deploy", "relay-d"],
      io
    });

    const output = captured.log.join("\n");
    assert.match(output, /catalog state\s*:\s*degraded \(overridden by --state\)/);
  });

  it("honors --api-base-url and --bootstrap-url one-off overrides", async () => {
    const autoRegisterSpec = {
      ...baseAcurastSpec,
      relay: {
        autoRegister: true,
        bootstrapRelayUrl: "https://old-bootstrap.example.test",
        enableLogs: true
      }
    };
    await writeSpec(workDir, "relay-d", autoRegisterSpec);
    const { io, captured } = makeIo();

    await runRelayDeploy({
      flags: new Map<string, string | boolean>([
        ["dry-run", true],
        ["manager-id", "1234"],
        ["api-base-url", "https://[2001:db8::10]:3000"],
        ["bootstrap-url", "https://bootstrap.switchboard.proof.computer:3000"]
      ]),
      positionals: ["relay", "deploy", "relay-d"],
      io
    });

    const output = captured.log.join("\n");
    assert.match(output, /--manager-id override: spec\.acurast\.managerId = 1234/);
    assert.match(output, /--api-base-url override: spec\.apiBaseUrl = https:\/\/\[2001:db8::10\]:3000/);
    assert.match(output, /--bootstrap-url override: spec\.relay\.bootstrapRelayUrl = https:\/\/bootstrap\.switchboard\.proof\.computer:3000/);
    assert.match(output, /api base url\s*:\s*https:\/\/\[2001:db8::10\]:3000/);
    assert.match(output, /provision encrypted log sink on https:\/\/bootstrap\.switchboard\.proof\.computer:3000/);
  });

  it("rejects unknown --state values before producing any plan", async () => {
    await writeSpec(workDir, "relay-d", baseAcurastSpec);
    const { io, captured } = makeIo();

    await assert.rejects(
      runRelayDeploy({
        flags: new Map<string, string | boolean>([
          ["state", "bogus"],
          ["dry-run", true]
        ]),
        positionals: ["relay", "deploy", "relay-d"],
        io
      }),
      /candidate\|active\|degraded\|draining\|disabled/
    );
    assert.equal(captured.log.length, 0, "no plan output should be printed when --state is invalid");
  });

  it("rejects --target conflicts with the spec's target", async () => {
    await writeSpec(workDir, "relay-d", baseAcurastSpec);
    const { io } = makeIo();

    await assert.rejects(
      runRelayDeploy({
        flags: new Map<string, string | boolean>([
          ["target", "bootstrap"],
          ["dry-run", true]
        ]),
        positionals: ["relay", "deploy", "relay-d"],
        io
      }),
      /target=acurast.*--target=bootstrap/
    );
  });

  it("refuses to deploy to Acurast without --yes", async () => {
    await writeSpec(workDir, "relay-d", baseAcurastSpec);
    const { io } = makeIo();

    await assert.rejects(
      runRelayDeploy({
        flags: new Map<string, string | boolean>(),
        positionals: ["relay", "deploy", "relay-d"],
        io
      }),
      /Refusing to deploy to Acurast without --yes/
    );
  });

  it("rejects a spec whose relayId does not match the invoked id", async () => {
    await writeSpec(workDir, "relay-x", { ...baseAcurastSpec, relayId: "relay-d" });
    const { io } = makeIo();

    await assert.rejects(
      runRelayDeploy({
        flags: new Map<string, string | boolean>([["dry-run", true]]),
        positionals: ["relay", "deploy", "relay-x"],
        io
      }),
      /declares relayId=relay-d, but command was invoked for relay-x/
    );
  });

  it("rejects an invalid relay id", async () => {
    const { io } = makeIo();
    await assert.rejects(
      runRelayDeploy({
        flags: new Map<string, string | boolean>([["dry-run", true]]),
        positionals: ["relay", "deploy", "Relay D"],
        io
      }),
      /Invalid relay id/
    );
  });

  it("surfaces zod errors when the spec includes a forbidden Acurast env name", async () => {
    const tainted = {
      ...baseAcurastSpec,
      acurast: {
        ...baseAcurastSpec.acurast,
        includeEnv: [...baseAcurastSpec.acurast.includeEnv, "PROOF_NETWORK_MANIFEST_SIGNING_KEY"]
      }
    };
    await writeSpec(workDir, "relay-d", tainted);
    const { io } = makeIo();

    await assert.rejects(
      runRelayDeploy({
        flags: new Map<string, string | boolean>([["dry-run", true]]),
        positionals: ["relay", "deploy", "relay-d"],
        io
      }),
      /Invalid relay deployment spec.*forbidden Acurast list/s
    );
  });
});

async function writeSpec(workDir: string, relayId: string, spec: unknown): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  const dir = path.join(workDir, "relays");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${relayId}.json`), JSON.stringify(spec, null, 2), "utf8");
}
