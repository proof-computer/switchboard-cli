import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildSwitchboardDeployDoctorReport,
  runSwitchboardDeployDoctor,
  sanitizeOutputValue,
  type CliRuntime,
  type DeployDoctorAdapters,
  type DeployDoctorProbeResult
} from "../cli/src/index.js";

const operatorId = `0x${"aa".repeat(32)}`;
const processorId = `0x${"11".repeat(32)}`;
const processor = `0x${"11".repeat(32)}`;
const jobId = `0x${"33".repeat(32)}`;
const gatewayId = "gateway-doctor";
const hostname = "e-doctor.acurast.ingress.test";
const relayUrl = "https://relay.example.test";

describe("switchboard deploy doctor", () => {
  it("classifies a healthy route when the public SSH banner probe succeeds", async () => {
    const requests: Array<{ method: string; pathname: string }> = [];
    const output = await buildSwitchboardDeployDoctorReport(
      doctorFlags({ probe: true }),
      runtime(),
      {
        fetchImpl: fakeFetch({
          requests,
          observability: fakeObservability({ routeActive: true, upstreamIps: ["192.168.3.242"] })
        }),
        dnsLookup: async () => [{ address: "192.0.2.44", family: 4 }],
        probeSshOverTls: async () => sshProbe({ banner: "SSH-2.0-dropbear_2024.85" })
      }
    );

    assert.equal(output.ok, true);
    assert.equal(output.classification.status, "healthy");
    assert.equal(output.classification.stage, "SSH banner");
    assert.equal((output.publicProbe as DeployDoctorProbeResult).ssh.banner, "SSH-2.0-dropbear_2024.85");
    assert.deepEqual(requests.map((request) => request.method), ["GET", "GET"]);
  });

  it("classifies funded deployments without an active route as route missing", async () => {
    const output = await buildSwitchboardDeployDoctorReport(
      doctorFlags(),
      runtime(),
      {
        fetchImpl: fakeFetch({
          observability: fakeObservability({ routeActive: false, routeReason: "route_state_missing" })
        }),
        dnsLookup: async () => [{ address: "192.0.2.44", family: 4 }]
      }
    );

    assert.equal(output.ok, false);
    assert.equal(output.classification.status, "route_missing");
    assert.equal(output.classification.stage, "route-state");
    assert.match(output.classification.summary, /route_state_missing/u);
  });

  it("includes safe Cargo bridge diagnostic instructions for SSH/Cargo reports", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-deploy-doctor-bridge-"));
    try {
      const runDir = path.join(cwd, "run");
      await mkdir(runDir, { recursive: true });
      await writePrivateSnapshot(runDir, deploySnapshot({ step: "complete", ssh: true }));

      const output = await buildSwitchboardDeployDoctorReport(
        flags({ "run-dir": runDir }),
        runtime(cwd),
        {
          fetchImpl: fakeFetch({
            observability: fakeObservability({ routeActive: true })
          }),
          dnsLookup: async () => [{ address: "192.0.2.44", family: 4 }]
        }
      );

      assert.equal(output.bridgeDiagnostic.available, true);
      assert.equal(output.bridgeDiagnostic.command, "switchboard-cargo-bridge-doctor");
      assert.equal(output.bridgeDiagnostic.signerMode, "cargo-bridge-secp256k1");
      assert.equal(output.commands.bridgeDoctor, "switchboard-cargo-bridge-doctor");
      assert.match(output.commands.sshBridgeDoctor, /switchboard-cargo-bridge-doctor/u);
      assert.doesNotMatch(JSON.stringify(output.bridgeDiagnostic), /BRIDGE_SOCKET|intent-token-secret|privateKey|seed/u);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("classifies an active route with a TLS reset as a public route failure", async () => {
    const output = await buildSwitchboardDeployDoctorReport(
      doctorFlags({ probe: true }),
      runtime(),
      {
        fetchImpl: fakeFetch({ observability: fakeObservability({ routeActive: true }) }),
        dnsLookup: async () => [{ address: "192.0.2.44", family: 4 }],
        probeSshOverTls: async () => ({
          checked: true,
          tls: { ok: false, error: "read ECONNRESET", code: "ECONNRESET" },
          ssh: { ok: false, error: "read ECONNRESET" }
        })
      }
    );

    assert.equal(output.ok, false);
    assert.equal(output.classification.status, "tls_route_reset");
    assert.equal(output.classification.stage, "public TLS/SNI");
  });

  it("classifies an active TLS route without an SSH banner", async () => {
    const output = await buildSwitchboardDeployDoctorReport(
      doctorFlags({ probe: true }),
      runtime(),
      {
        fetchImpl: fakeFetch({ observability: fakeObservability({ routeActive: true }) }),
        dnsLookup: async () => [{ address: "192.0.2.44", family: 4 }],
        probeSshOverTls: async () => sshProbe({ banner: "HTTP/1.1 400 Bad Request" })
      }
    );

    assert.equal(output.ok, false);
    assert.equal(output.classification.status, "ssh_banner_missing");
    assert.equal(output.classification.stage, "SSH banner");
  });

  it("refuses late funding windows before other recovery actions", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-deploy-doctor-late-"));
    try {
      const runDir = path.join(cwd, "run");
      await mkdir(runDir, { recursive: true });
      await writePrivateSnapshot(runDir, deploySnapshot({ step: "quote_ready", schedule: expiredStartWindowSchedule() }));

      const output = await buildSwitchboardDeployDoctorReport(
        flags({ "run-dir": runDir }),
        runtime(cwd),
        {
          fetchImpl: fakeFetch({ observability: fakeObservability({ fundingStatus: null, routeActive: false }) }),
          dnsLookup: async () => [{ address: "192.0.2.44", family: 4 }]
        }
      );

      assert.equal(output.ok, false);
      assert.equal(output.classification.status, "late_funding_window");
      assert.equal(output.classification.stage, "funding");
      assert.match(output.classification.summary, /Refusing late funding/u);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("classifies unauthorized operator capability reads separately from route failures", async () => {
    const output = await buildSwitchboardDeployDoctorReport(
      doctorFlags(),
      runtime(),
      {
        fetchImpl: fakeFetch({
          observability: fakeObservability({ routeActive: true }),
          capabilityStatus: 401,
          capabilityBody: { ok: false, error: "unauthorized" }
        }),
        dnsLookup: async () => [{ address: "192.0.2.44", family: 4 }]
      }
    );

    assert.equal(output.ok, false);
    assert.equal(output.classification.status, "capability_token_unauthorized");
    assert.equal(output.classification.stage, "operator capability");
    assert.equal(output.warnings.some((warning) => /capability read was unauthorized/u.test(warning)), true);
  });

  it("redacts tokens, seeds, and private keys from JSON doctor output", async () => {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (line?: unknown) => {
      lines.push(String(line ?? ""));
    };

    try {
      await runSwitchboardDeployDoctor(
        ["--json", "--intent-id", "di_doctor", "--relay-url", relayUrl, "--intent-token", "intent-token-secret"],
        runtime(),
        {
          fetchImpl: fakeFetch({
            observability: fakeObservability({
              routeActive: true,
              extra: {
                token: "relay-token-secret",
                seed: "seed phrase",
                privateKey: "0xabc123",
                nested: { authorizationHeader: "Bearer relay-token-secret" }
              }
            })
          }),
          dnsLookup: async () => [{ address: "192.0.2.44", family: 4 }]
        }
      );
    } finally {
      console.log = originalLog;
    }

    const printed = lines.join("\n");
    assert.doesNotMatch(printed, /intent-token-secret|relay-token-secret|seed phrase|0xabc123/u);
    const parsed = JSON.parse(printed);
    assert.equal(parsed.relay.observability.value.token, "[redacted]");
    assert.equal(parsed.relay.observability.value.seed, "[redacted]");
    assert.equal(parsed.relay.observability.value.privateKey, "[redacted]");
    assert.equal(parsed.relay.observability.value.nested.authorizationHeader, "[redacted]");
    assert.deepEqual(sanitizeOutputValue({ seedEnv: "POLKADOT_SEED" }), { seedEnv: "POLKADOT_SEED" });
  });
});

function doctorFlags(extra: Record<string, string | boolean | undefined> = {}): Map<string, string | boolean> {
  return flags({
    "intent-id": "di_doctor",
    "relay-url": relayUrl,
    "intent-token": "intent-token-secret",
    ...extra
  });
}

function flags(values: Record<string, string | boolean | undefined>): Map<string, string | boolean> {
  return new Map(
    Object.entries(values).filter((entry): entry is [string, string | boolean] => entry[1] !== undefined)
  );
}

function runtime(projectRoot = process.cwd()): CliRuntime {
  return {
    projectRoot,
    contextStorePath: path.join(projectRoot, ".switchboard-test-contexts.json")
  };
}

function fakeFetch(input: {
  requests?: Array<{ method: string; pathname: string }>;
  observability: Record<string, unknown>;
  capabilityStatus?: number;
  capabilityBody?: Record<string, unknown>;
}): typeof fetch {
  return (async (urlInput: string | URL | Request, init?: RequestInit) => {
    const url = new URL(urlInput instanceof URL ? urlInput.href : typeof urlInput === "string" ? urlInput : urlInput.url);
    const method = init?.method ?? "GET";
    input.requests?.push({ method, pathname: url.pathname });
    if (url.pathname === "/v1/deployment-intents/di_doctor/observability") {
      return jsonResponse(input.observability);
    }
    if (url.pathname === "/v1/deployment-intents/di_existing/observability") {
      return jsonResponse(input.observability);
    }
    if (url.pathname === "/v1/operator-capabilities") {
      return jsonResponse(
        input.capabilityBody ?? {
          ok: true,
          latest: [
            {
              report: {
                reportId: "capability-doctor",
                reportedAt: "2026-05-21T12:00:00.000Z",
                expiresAt: "2030-05-21T12:00:00.000Z",
                operator: { operatorId, gatewayId }
              },
              receivedAt: "2026-05-21T12:00:05.000Z",
              signer: "0x5000000000000000000000000000000000000005"
            }
          ]
        },
        input.capabilityStatus ?? 200
      );
    }
    return jsonResponse({ ok: false, error: "not_found" }, 404);
  }) as typeof fetch;
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function fakeObservability(input: {
  fundingStatus?: string | null;
  routeActive: boolean;
  routeReason?: string;
  upstreamIps?: string[];
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ok: true,
    ...(input.extra ?? {}),
    availability: {
      endpointHostname: hostname,
      sessionId: `0x${"22".repeat(32)}`,
      funding: input.fundingStatus === null
        ? undefined
        : { status: input.fundingStatus ?? "funded", sessionId: `0x${"22".repeat(32)}` },
      route: input.routeActive
        ? { status: "active", hostname }
        : { status: "missing", reason: input.routeReason ?? "route_missing" },
      health: {
        status: "ready",
        upstreamIps: input.upstreamIps ?? ["192.168.3.242"]
      }
    },
    gateway: {
      operatorId,
      gatewayId,
      processorId,
      capability: {
        available: true,
        latestReport: {
          reportId: "capability-observability",
          reportedAt: "2026-05-21T12:00:00.000Z",
          expiresAt: "2030-05-21T12:00:00.000Z"
        }
      }
    },
    routeState: {
      desired: input.routeActive,
      reason: input.routeActive ? undefined : input.routeReason ?? "route_missing",
      runtimeHttpsReady: input.routeActive,
      hostname
    },
    dns: {
      canonical: { hostname }
    }
  };
}

function sshProbe(input: { banner: string }): DeployDoctorProbeResult {
  return {
    checked: true,
    tls: { ok: true, authorized: true },
    ssh: input.banner.startsWith("SSH-")
      ? { ok: true, banner: input.banner }
      : { ok: false, banner: input.banner, error: "first bytes were not an SSH banner" }
  };
}

function deploySnapshot(input: { step: string; schedule?: Record<string, unknown>; ssh?: boolean }): Record<string, any> {
  const capacity = { operatorId, processorId, processor, gatewayId, managerId: "9470" };
  return {
    version: 1,
    workflowId: "wf_doctor",
    step: input.step,
    input: {
      relayUrl,
      jobId,
      durationSeconds: 900,
      entrypoint: "index.ts",
      runtime: input.ssh ? {
        kind: "script",
        entrypoint: "acurast.sh",
        authorizedKeys: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeSwitchboardTestKey"
      } : undefined,
      capacity,
      pins: capacity,
      source: { mode: "test" },
      deploymentMode: "single"
    },
    data: {
      capacity,
      deploymentIntent: {
        intentId: "di_existing",
        cliToken: "intent-token-secret",
        env: {
          SWITCHBOARD_RELAY_URL: relayUrl,
          SWITCHBOARD_INTENT_ID: "di_existing",
          SWITCHBOARD_INTENT_TOKEN: "intent-token-secret"
        },
        intent: {
          intentId: "di_existing",
          jobId,
          operatorId,
          processorId,
          gatewayId
        }
      },
      deployment: {
        adapter: "acurast-sdk",
        ok: true,
        deploymentId: "63499",
        jobId,
        processor,
        processorId,
        operatorId,
        gatewayId,
        schedule: input.schedule ?? validSchedule()
      },
      runtime: {
        runtimeSigner: "0x5000000000000000000000000000000000000005",
        upstreamIps: ["192.168.3.242"],
        signerMode: input.ssh ? "cargo-bridge-secp256k1" : undefined,
        applicationProtocol: input.ssh ? "ssh" : undefined
      },
      quote: {
        ok: true,
        quote: {
          sessionId: `0x${"22".repeat(32)}`,
          jobId,
          operatorId,
          processorId
        }
      }
    },
    events: [{ sequence: 1, at: new Date().toISOString(), type: input.step }],
    updatedAt: new Date().toISOString()
  };
}

async function writePrivateSnapshot(runDir: string, snapshot: Record<string, any>): Promise<void> {
  await writeFile(path.join(runDir, "switchboard-deploy-workflow.private.json"), `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path.join(runDir, "switchboard-deploy-workflow.private.json"), 0o600);
  await writeFile(path.join(runDir, "switchboard-deploy-workflow.snapshot.json"), `${JSON.stringify(redactSnapshot(snapshot), null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "report.json"), `${JSON.stringify({ deploymentIntent: { intentId: "di_existing", relayUrl } }, null, 2)}\n`, "utf8");
}

function redactSnapshot(snapshot: Record<string, any>): Record<string, any> {
  return JSON.parse(JSON.stringify(snapshot, (key, value) => /token/i.test(key) && typeof value === "string" ? "[redacted]" : value));
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
