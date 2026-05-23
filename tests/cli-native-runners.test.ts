import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ethers } from "ethers";

import {
  runSwitchboardClaimable,
  runSwitchboardContextAdd,
  runSwitchboardContextCurrent,
  runSwitchboardContextDnsClear,
  runSwitchboardContextDnsSet,
  runSwitchboardContextList,
  runSwitchboardContextSet,
  runSwitchboardContextUse,
  runSwitchboardDeploy,
  runSwitchboardDeploymentStatus,
  runSwitchboardHostnameStatus,
  runSwitchboardLaunchDemo,
  runSwitchboardPreflight,
  runSwitchboardProjectShow,
  runSwitchboardRefundable,
  type SwitchboardContextStore
} from "../cli/src/index.js";
import { INGRESS_REGISTRY_NATIVE_PAYMENT_ABI } from "../src/ingress-contract.js";
import { signNetworkManifest, type NetworkManifest } from "../src/network-manifest.js";

const runtime = {
  projectRoot: path.join(process.cwd(), ".switchboard-native-runner-test"),
  projectConfigPath: path.join(process.cwd(), ".switchboard-native-runner-test", "switchboard.json"),
  projectStatePath: path.join(process.cwd(), ".switchboard-native-runner-test", ".switchboard", "state.json"),
  projectConfig: {
    project: "native-runner-test"
  },
  projectState: {
    latestReport: ".switchboard/latest-report.json"
  },
  contextStorePath: path.join(process.cwd(), ".switchboard-native-runner-test", "contexts.json")
};
const runtimeWithoutLatestReport = {
  projectRoot: runtime.projectRoot,
  contextStorePath: runtime.contextStorePath
};
const manifestSignerSeed = "//Alice//switchboard-network-manifest";
const registryAddress = "0x65d6b76bec50f46d198ffa3598e381a298025da0";
const assetAddress = "0x0000000000000000000000000000000000001337";
const recipientAddress = "0x000000000000000000000000000000000000bEEF";
const developerAddress = "0x000000000000000000000000000000000000dEaD";
const sessionId = `0x${"11".repeat(32)}`;
const accountingInterface = new ethers.Interface(INGRESS_REGISTRY_NATIVE_PAYMENT_ABI);

describe("native command runners", () => {
  it("exports a shared project show runner for native plugin reuse", async () => {
    const bare = await captureConsole(() => runSwitchboardProjectShow(["--json"], runtime));
    const prefixed = await captureConsole(() => runSwitchboardProjectShow(["project", "show", "--json"], runtime));

    for (const output of [JSON.parse(bare), JSON.parse(prefixed)]) {
      assert.equal(output.action, "project-show");
      assert.equal(output.projectRoot, runtime.projectRoot);
      assert.equal(output.config.project, "native-runner-test");
      assert.equal(output.state.latestReport, ".switchboard/latest-report.json");
    }
  });

  it("exports a shared preflight runner for native plugin reuse", async () => {
    const missingManifestUrl = `file://${path.join(runtime.projectRoot, "missing-network-manifest.json")}`;

    const bare = await captureConsole(() =>
      runSwitchboardPreflight(["--json", "--manifest-url", missingManifestUrl], runtime)
    );
    const prefixed = await captureConsole(() =>
      runSwitchboardPreflight(["preflight", "--json", "--manifest-url", missingManifestUrl], runtime)
    );

    for (const output of [JSON.parse(bare), JSON.parse(prefixed)]) {
      assert.equal(output.action, "preflight");
      assert.equal(output.ok, false);
      assert.equal(output.checks.some((check: Record<string, unknown>) => check.name === "network manifest" && check.ok === false), true);
    }
  });

  it("exports a shared launch-demo runner for native plugin reuse", async () => {
    await assert.rejects(
      runSwitchboardLaunchDemo([], runtime),
      /Refusing to launch a paid demo without --yes-spend/
    );

    await assert.rejects(
      runSwitchboardLaunchDemo(["launch-demo"], runtime),
      /Refusing to launch a paid demo without --yes-spend/
    );
  });

  it("exports a shared deploy runner for native plugin reuse", async () => {
    await assert.rejects(
      runSwitchboardDeploy(["--dry-run"], runtime),
      /switchboard deploy is for project workloads/
    );

    await assert.rejects(
      runSwitchboardDeploy(["deploy", "--dry-run"], runtime),
      /switchboard deploy is for project workloads/
    );
  });

  it("rejects deploy subcommand args in the fresh deploy runner", async () => {
    await assert.rejects(
      runSwitchboardDeploy(["deploy", "status"], runtime),
      /runSwitchboardDeploy expected deploy args/
    );
  });

  it("exports a shared deployment status runner for native plugin reuse", async () => {
    await withManifestServer(async ({ manifestUrl, manifestSigner }) => {
      await assert.rejects(
        runSwitchboardDeploymentStatus(["--manifest-url", manifestUrl, "--manifest-signer", manifestSigner], runtimeWithoutLatestReport),
        /Missing --session-id or --report/
      );

      await assert.rejects(
        runSwitchboardDeploymentStatus(["status", "--manifest-url", manifestUrl, "--manifest-signer", manifestSigner], runtimeWithoutLatestReport),
        /Missing --session-id or --report/
      );
    });
  });

  it("exports a shared context list runner with sanitized context output", async () => {
    await withContextStore(async (contextStorePath) => {
      const runtimeWithContexts = {
        ...runtime,
        projectConfig: {
          project: "native-runner-test",
          context: "project-mainnet"
        },
        contextStorePath
      };
      const bare = await captureConsole(() => runSwitchboardContextList(["--json"], runtimeWithContexts));
      const prefixed = await captureConsole(() => runSwitchboardContextList(["context", "list", "--json"], runtimeWithContexts));

      for (const output of [JSON.parse(bare), JSON.parse(prefixed)]) {
        assert.equal(output.action, "context-list");
        assert.equal(output.current, "global-mainnet");
        assert.equal(output.projectContext, "project-mainnet");
        assert.deepEqual(output.contexts.map((context: Record<string, unknown>) => context.name), ["global-mainnet", "project-mainnet"]);

        const current = output.contexts.find((context: Record<string, unknown>) => context.name === "global-mainnet");
        assert.equal(current.current, true);
        assert.equal(current.project, false);
        assert.equal(current.relayUrl, "https://relay-global.example");
        assert.equal(Object.prototype.hasOwnProperty.call(current, "controlPlaneTokenEnv"), false);

        const project = output.contexts.find((context: Record<string, unknown>) => context.name === "project-mainnet");
        assert.equal(project.current, false);
        assert.equal(project.project, true);
        assert.equal(project.manifestUrl, "https://control.example/v1/network-manifest");
        assert.equal(Object.prototype.hasOwnProperty.call(project, "operatorSshHost"), false);
      }
    });
  });

  it("exports a shared context current runner for project-selected contexts", async () => {
    const currentRuntime = {
      ...runtime,
      projectConfig: {
        project: "native-runner-test",
        context: "project-mainnet"
      },
      contextName: "project-mainnet",
      context: {
        manifestUrl: "https://control.example/v1/network-manifest",
        polkadotSeedEnv: "POLKADOT_SEED"
      }
    };
    const bare = await captureConsole(() => runSwitchboardContextCurrent(["--json"], currentRuntime));
    const prefixed = await captureConsole(() => runSwitchboardContextCurrent(["context", "current", "--json"], currentRuntime));

    for (const output of [JSON.parse(bare), JSON.parse(prefixed)]) {
      assert.equal(output.action, "context-current");
      assert.equal(output.ok, true);
      assert.equal(output.name, "project-mainnet");
      assert.equal(output.source, "project");
      assert.equal(output.context.manifestUrl, "https://control.example/v1/network-manifest");
      assert.equal(output.context.polkadotSeedEnv, "POLKADOT_SEED");
    }
  });

  it("exports a shared context current runner for global-selected contexts", async () => {
    const currentRuntime = {
      ...runtime,
      projectConfig: {
        project: "native-runner-test"
      },
      contextName: "global-mainnet",
      context: {
        target: "polkadot-hub",
        relayUrl: "https://relay-global.example"
      }
    };
    const output = JSON.parse(await captureConsole(() => runSwitchboardContextCurrent(["--json"], currentRuntime)));

    assert.equal(output.action, "context-current");
    assert.equal(output.ok, true);
    assert.equal(output.name, "global-mainnet");
    assert.equal(output.source, "global");
    assert.equal(output.context.target, "polkadot-hub");
    assert.equal(output.context.relayUrl, "https://relay-global.example");
  });

  it("keeps context current no-selected-context behavior unchanged", async () => {
    const output = JSON.parse(await captureConsole(() => runSwitchboardContextCurrent(["--json"], runtimeWithoutLatestReport)));

    assert.equal(output.action, "context-current");
    assert.equal(output.ok, false);
    assert.equal(output.name, undefined);
    assert.equal(output.context, undefined);
  });

  it("exports a shared context use runner for native plugin reuse", async () => {
    await withContextStore(async (contextStorePath) => {
      const contextRuntime = {
        ...runtimeWithoutLatestReport,
        contextStorePath
      };
      const bare = JSON.parse(await captureConsole(() => runSwitchboardContextUse(["project-mainnet", "--json"], contextRuntime)));
      const afterBare = await readStoredContexts(contextStorePath);
      const prefixed = JSON.parse(
        await captureConsole(() => runSwitchboardContextUse(["context", "use", "global-mainnet", "--json"], contextRuntime))
      );
      const afterPrefixed = await readStoredContexts(contextStorePath);

      assert.equal(bare.action, "context-use");
      assert.equal(bare.current, "project-mainnet");
      assert.equal(bare.contextStorePath, contextStorePath);
      assert.equal(afterBare.current, "project-mainnet");
      assert.deepEqual(Object.keys(afterBare.contexts ?? {}).sort(), ["global-mainnet", "project-mainnet"]);

      assert.equal(prefixed.action, "context-use");
      assert.equal(prefixed.current, "global-mainnet");
      assert.equal(prefixed.contextStorePath, contextStorePath);
      assert.equal(afterPrefixed.current, "global-mainnet");
      assert.deepEqual(Object.keys(afterPrefixed.contexts ?? {}).sort(), ["global-mainnet", "project-mainnet"]);
    });
  });

  it("keeps context use unknown-context behavior unchanged", async () => {
    await withContextStore(async (contextStorePath) => {
      const contextRuntime = {
        ...runtimeWithoutLatestReport,
        contextStorePath
      };

      await assert.rejects(
        runSwitchboardContextUse(["missing-mainnet"], contextRuntime),
        /Unknown context "missing-mainnet"/
      );

      const store = await readStoredContexts(contextStorePath);
      assert.equal(store.current, "global-mainnet");
    });
  });

  it("exports a shared context set runner for native plugin reuse", async () => {
    await withContextStore(async (contextStorePath) => {
      const contextRuntime = {
        ...runtimeWithoutLatestReport,
        contextStorePath
      };
      const bare = JSON.parse(
        await captureConsole(() =>
          runSwitchboardContextSet(
            [
              "dev-mainnet",
              "--json",
              "--relay-url",
              "https://relay-dev.example",
              "--polkadot-address-env",
              "DEV_POLKADOT_ADDRESS",
              "--use"
            ],
            contextRuntime
          )
        )
      );
      const afterBare = await readStoredContexts(contextStorePath);
      const prefixed = JSON.parse(
        await captureConsole(() =>
          runSwitchboardContextSet(["context", "set", "global-mainnet", "--json", "--relay-url", "https://relay-updated.example"], contextRuntime)
        )
      );
      const afterPrefixed = await readStoredContexts(contextStorePath);

      assert.equal(bare.action, "context-set");
      assert.equal(bare.name, "dev-mainnet");
      assert.equal(bare.current, "dev-mainnet");
      assert.equal(bare.context.relayUrl, "https://relay-dev.example");
      assert.equal(bare.context.polkadotAddressEnv, "DEV_POLKADOT_ADDRESS");
      assert.equal(afterBare.current, "dev-mainnet");
      assert.equal(afterBare.contexts?.["dev-mainnet"]?.relayUrl, "https://relay-dev.example");

      assert.equal(prefixed.action, "context-set");
      assert.equal(prefixed.name, "global-mainnet");
      assert.equal(prefixed.current, "dev-mainnet");
      assert.equal(prefixed.context.relayUrl, "https://relay-updated.example");
      assert.equal(Object.prototype.hasOwnProperty.call(prefixed.context, "controlPlaneTokenEnv"), false);
      assert.equal(afterPrefixed.contexts?.["global-mainnet"]?.relayUrl, "https://relay-updated.example");
      assert.equal(Object.prototype.hasOwnProperty.call(afterPrefixed.contexts?.["global-mainnet"] ?? {}, "controlPlaneTokenEnv"), false);
    });
  });

  it("keeps context set removed flag rejection unchanged", async () => {
    await withContextStore(async (contextStorePath) => {
      await assert.rejects(
        runSwitchboardContextSet(["mainnet", "--control-plane-token-env", "PROOF_CONTROL_PLANE_TOKEN"], {
          ...runtimeWithoutLatestReport,
          contextStorePath
        }),
        /Removed builder context option\(s\): --control-plane-token-env/
      );
    });
  });

  it("exports a shared context dns set runner for native plugin reuse", async () => {
    await withContextStore(async (contextStorePath) => {
      const contextRuntime = {
        ...runtimeWithoutLatestReport,
        contextStorePath
      };
      const bare = JSON.parse(
        await captureConsole(() =>
          runSwitchboardContextDnsSet(["cloudflare", "--token-env", "CF_TOKEN_PROD", "--json"], contextRuntime)
        )
      );
      const afterBare = await readStoredContexts(contextStorePath);
      const prefixed = JSON.parse(
        await captureConsole(() =>
          runSwitchboardContextDnsSet(
            ["context", "dns", "set", "cloudflare", "--token-env", "CF_TOKEN_PROJECT", "--context", "project-mainnet", "--json"],
            contextRuntime
          )
        )
      );
      const afterPrefixed = await readStoredContexts(contextStorePath);

      assert.equal(bare.action, "context-dns-set");
      assert.equal(bare.context, "global-mainnet");
      assert.equal(bare.provider, "cloudflare");
      assert.equal(bare.tokenEnv, "CF_TOKEN_PROD");
      assert.equal(afterBare.contexts?.["global-mainnet"]?.cloudflareApiTokenEnv, "CF_TOKEN_PROD");

      assert.equal(prefixed.action, "context-dns-set");
      assert.equal(prefixed.context, "project-mainnet");
      assert.equal(prefixed.tokenEnv, "CF_TOKEN_PROJECT");
      assert.equal(afterPrefixed.contexts?.["global-mainnet"]?.cloudflareApiTokenEnv, "CF_TOKEN_PROD");
      assert.equal(afterPrefixed.contexts?.["project-mainnet"]?.cloudflareApiTokenEnv, "CF_TOKEN_PROJECT");
    });
  });

  it("keeps context dns set validation unchanged", async () => {
    await withContextStore(async (contextStorePath) => {
      const contextRuntime = {
        ...runtimeWithoutLatestReport,
        contextStorePath
      };

      await assert.rejects(
        runSwitchboardContextDnsSet(["cloudflare"], contextRuntime),
        /token-env/
      );
      await assert.rejects(
        runSwitchboardContextDnsSet(["route53", "--token-env", "ROUTE53_TOKEN"], contextRuntime),
        /Unsupported DNS provider/
      );
    });
  });

  it("exports a shared context dns clear runner for native plugin reuse", async () => {
    await withContextStore(async (contextStorePath) => {
      const contextRuntime = {
        ...runtimeWithoutLatestReport,
        contextStorePath
      };

      await captureConsole(() =>
        runSwitchboardContextDnsSet(["cloudflare", "--token-env", "CF_TOKEN_PROD", "--json"], contextRuntime)
      );
      const bare = JSON.parse(await captureConsole(() => runSwitchboardContextDnsClear(["cloudflare", "--json"], contextRuntime)));
      const afterBare = await readStoredContexts(contextStorePath);

      await captureConsole(() =>
        runSwitchboardContextDnsSet(["cloudflare", "--token-env", "CF_TOKEN_PROJECT", "--context", "project-mainnet", "--json"], contextRuntime)
      );
      const removeAlias = JSON.parse(
        await captureConsole(() =>
          runSwitchboardContextDnsClear(
            ["context", "dns", "remove", "cloudflare", "--context", "project-mainnet", "--json"],
            contextRuntime
          )
        )
      );
      const afterRemoveAlias = await readStoredContexts(contextStorePath);

      await captureConsole(() =>
        runSwitchboardContextDnsSet(["cloudflare", "--token-env", "CF_TOKEN_PROD", "--json"], contextRuntime)
      );
      const rmAlias = JSON.parse(
        await captureConsole(() => runSwitchboardContextDnsClear(["context", "dns", "rm", "--json"], contextRuntime))
      );
      const afterRmAlias = await readStoredContexts(contextStorePath);

      assert.equal(bare.action, "context-dns-clear");
      assert.equal(bare.context, "global-mainnet");
      assert.equal(bare.provider, "cloudflare");
      assert.equal(afterBare.contexts?.["global-mainnet"]?.cloudflareApiTokenEnv, undefined);

      assert.equal(removeAlias.action, "context-dns-clear");
      assert.equal(removeAlias.context, "project-mainnet");
      assert.equal(afterRemoveAlias.contexts?.["project-mainnet"]?.cloudflareApiTokenEnv, undefined);

      assert.equal(rmAlias.action, "context-dns-clear");
      assert.equal(rmAlias.context, "global-mainnet");
      assert.equal(afterRmAlias.contexts?.["global-mainnet"]?.cloudflareApiTokenEnv, undefined);
    });
  });

  it("keeps context dns clear no-matching-context behavior unchanged", async () => {
    await withContextStore(async (contextStorePath) => {
      await assert.rejects(
        runSwitchboardContextDnsClear(["cloudflare", "--context", "missing-mainnet"], {
          ...runtimeWithoutLatestReport,
          contextStorePath
        }),
        /No matching context/
      );
    });
  });

  it("exports a shared context add runner while preserving interactive-only behavior", async () => {
    await withContextStore(async (contextStorePath) => {
      const contextRuntime = {
        ...runtimeWithoutLatestReport,
        contextStorePath
      };

      await assert.rejects(
        runSwitchboardContextAdd(["demo", "--json"], contextRuntime),
        /interactive/
      );

      await assert.rejects(
        runSwitchboardContextAdd(["context", "add", "demo", "--json"], contextRuntime),
        /interactive/
      );
    });
  });

  it("exports a shared claimable runner for native plugin reuse", async () => {
    await withCleanSignerEnv(async () => {
      await withAccountingServer({ claimableBalance: 1_250_000n }, async ({ manifestUrl, manifestSigner, rpcMethods }) => {
        const args = ["--json", "--recipient", recipientAddress, "--manifest-url", manifestUrl, "--manifest-signer", manifestSigner];
        const bare = await captureConsole(() => runSwitchboardClaimable(args, runtimeWithoutLatestReport));
        const prefixed = await captureConsole(() => runSwitchboardClaimable(["claimable", ...args], runtimeWithoutLatestReport));

        for (const output of [JSON.parse(bare), JSON.parse(prefixed)]) {
          assert.equal(output.action, "claimable");
          assert.equal(output.target, "revive-local");
          assert.equal(output.registryAddress, ethers.getAddress(registryAddress));
          assert.equal(output.asset.address, ethers.getAddress(assetAddress));
          assert.equal(output.recipient, ethers.getAddress(recipientAddress));
          assert.equal(output.claimable.raw, "1250000");
        }
        assert.equal(rpcMethods.some((method) => method.startsWith("eth_send")), false);
      });
    });
  });

  it("exports a shared refundable runner that keeps the existing missing-session error path", async () => {
    await withManifestServer(async ({ manifestUrl, manifestSigner }) => {
      await assert.rejects(
        runSwitchboardRefundable(["--manifest-url", manifestUrl, "--manifest-signer", manifestSigner], runtimeWithoutLatestReport),
        /Missing --session-id or --report/
      );

      await assert.rejects(
        runSwitchboardRefundable(["refundable", "--manifest-url", manifestUrl, "--manifest-signer", manifestSigner], runtimeWithoutLatestReport),
        /Missing --session-id or --report/
      );
    });
  });

  it("exports a shared refundable runner for native plugin reuse", async () => {
    await withCleanSignerEnv(async () => {
      await withAccountingServer({ session: refundableSession() }, async ({ manifestUrl, manifestSigner, rpcMethods }) => {
        const args = ["--json", "--session-id", sessionId, "--manifest-url", manifestUrl, "--manifest-signer", manifestSigner];
        const bare = await captureConsole(() => runSwitchboardRefundable(args, runtimeWithoutLatestReport));
        const prefixed = await captureConsole(() => runSwitchboardRefundable(["refundable", ...args], runtimeWithoutLatestReport));
        const sessionPrefixed = await captureConsole(() => runSwitchboardRefundable(["session", "refundable", ...args], runtimeWithoutLatestReport));

        for (const output of [JSON.parse(bare), JSON.parse(prefixed), JSON.parse(sessionPrefixed)]) {
          assert.equal(output.action, "refundable");
          assert.equal(output.target, "revive-local");
          assert.equal(output.registryAddress, ethers.getAddress(registryAddress));
          assert.equal(output.sessionId, sessionId);
          assert.equal(output.developer, ethers.getAddress(developerAddress));
          assert.equal(output.refundable.raw, "4000000");
          assert.equal(output.refund.eligible, true);
          assert.equal(output.refund.callName, "refundAfterActivationTimeout");
        }
        assert.equal(rpcMethods.some((method) => method.startsWith("eth_send")), false);
      });
    });
  });

  it("exports a shared hostname status runner for native plugin reuse", async () => {
    await withManifestServer(async ({ manifestUrl, manifestSigner }) => {
      const requests: string[] = [];
      const args = [
        "app.example.com",
        "--endpoint",
        "demo.ingress.example",
        "--json",
        "--relay-url",
        "https://relay.example",
        "--manifest-url",
        manifestUrl,
        "--manifest-signer",
        manifestSigner,
        "--skip-readiness-checks"
      ];
      const adapters = hostnameStatusAdapters(hostnameStatusPayload({ status: "pending_dns" }), requests);
      const bare = await captureConsole(() => runSwitchboardHostnameStatus(args, runtimeWithoutLatestReport, adapters));
      const prefixed = await captureConsole(() =>
        runSwitchboardHostnameStatus(["hostname", "status", ...args], runtimeWithoutLatestReport, adapters)
      );

      for (const output of [JSON.parse(bare), JSON.parse(prefixed)]) {
        assert.equal(output.ok, false);
        assert.equal(output.status, "pending_dns");
        assert.equal(output.customerHostname, "app.example.com");
        assert.equal(output.endpointHostname, "demo.ingress.example");
        assert.equal(output.dnsProviderHint.provider.name, "Example DNS");
      }
      assert.deepEqual(requests, [
        "https://relay.example/v1/endpoints/demo.ingress.example/customer-hostnames/app.example.com",
        "https://relay.example/v1/endpoints/demo.ingress.example/customer-hostnames/app.example.com"
      ]);
    });
  });

  it("keeps hostname status readiness skipped when requested", async () => {
    await withManifestServer(async ({ manifestUrl, manifestSigner }) => {
      let readinessCalled = false;
      const output = JSON.parse(
        await captureConsole(() =>
          runSwitchboardHostnameStatus(
            hostnameStatusArgs({ manifestUrl, manifestSigner, extra: ["--skip-readiness-checks"] }),
            runtimeWithoutLatestReport,
            {
              ...hostnameStatusAdapters(hostnameStatusPayload({ status: "dns_validated" })),
              readinessChecks: async () => {
                readinessCalled = true;
                return {};
              }
            }
          )
        )
      );

      assert.equal(output.status, "dns_validated");
      assert.equal(Object.prototype.hasOwnProperty.call(output, "readiness"), false);
      assert.equal(readinessCalled, false);
    });
  });

  it("uses the hostname status readiness adapter after DNS validation", async () => {
    await withManifestServer(async ({ manifestUrl, manifestSigner }) => {
      let readinessInput: Record<string, unknown> | undefined;
      const output = JSON.parse(
        await captureConsole(() =>
          runSwitchboardHostnameStatus(
            hostnameStatusArgs({
              manifestUrl,
              manifestSigner,
              extra: [
                "--route-intent-url",
                "http://operator.example/route-intents",
                "--operator-ssh-host",
                "operator.example",
                "--check-timeout-ms",
                "1234"
              ]
            }),
            runtimeWithoutLatestReport,
            {
              ...hostnameStatusAdapters(hostnameStatusPayload({ status: "dns_validated" })),
              readinessChecks: async (input) => {
                readinessInput = { ...input };
                return {
                  route: { checked: true, ok: true, routeId: "route-1" },
                  https: { checked: true, ok: true, challengeOk: true, jobCertificateIssued: true }
                };
              }
            }
          )
        )
      );

      assert.deepEqual(readinessInput, {
        customerHostname: "app.example.com",
        sessionId,
        routeIntentUrl: "http://operator.example/route-intents",
        operatorSshHost: "operator.example",
        timeoutMs: 1234
      });
      assert.equal(output.readiness.route.ok, true);
      assert.equal(output.readiness.https.jobCertificateIssued, true);
    });
  });

  it("keeps hostname status required-argument errors unchanged", async () => {
    await withManifestServer(async ({ manifestUrl, manifestSigner }) => {
      const manifestArgs = ["--manifest-url", manifestUrl, "--manifest-signer", manifestSigner, "--relay-url", "https://relay.example"];

      await assert.rejects(
        runSwitchboardHostnameStatus(["app.example.com", ...manifestArgs], runtimeWithoutLatestReport),
        /Missing --endpoint, --endpoint-id, ENDPOINT_HOSTNAME, or --report/
      );

      await assert.rejects(
        runSwitchboardHostnameStatus(["--endpoint", "demo.ingress.example", ...manifestArgs], runtimeWithoutLatestReport),
        /Missing customer hostname\. Use `switchboard hostname status app\.example\.com --endpoint <endpoint>`\./
      );
    });
  });
});

async function captureConsole(fn: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line?: unknown) => {
    lines.push(String(line ?? ""));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

async function withContextStore(fn: (contextStorePath: string) => Promise<void>): Promise<void> {
  const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-context-"));
  try {
    const contextStorePath = path.join(workDir, "contexts.json");
    await writeFile(
      contextStorePath,
      JSON.stringify(
        {
          current: "global-mainnet",
          contexts: {
            "global-mainnet": {
              target: "polkadot-hub",
              relayUrl: "https://relay-global.example",
              controlPlaneTokenEnv: "PROOF_CONTROL_PLANE_TOKEN"
            },
            "project-mainnet": {
              manifestUrl: "https://control.example/v1/network-manifest",
              manifestSigner: "5EpwnRzamXpqWo3jW9h4ecSJHL9LBjR6jTMW5Wzw6p9nMTh7",
              polkadotSeedEnv: "POLKADOT_SEED",
              operatorSshHost: "operator.internal"
            }
          }
        },
        null,
        2
      )
    );
    await fn(contextStorePath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function readStoredContexts(contextStorePath: string): Promise<SwitchboardContextStore> {
  return JSON.parse(await readFile(contextStorePath, "utf8")) as SwitchboardContextStore;
}

function hostnameStatusArgs(input: { manifestUrl: string; manifestSigner: string; extra?: readonly string[] }): string[] {
  return [
    "app.example.com",
    "--endpoint",
    "demo.ingress.example",
    "--json",
    "--relay-url",
    "https://relay.example",
    "--manifest-url",
    input.manifestUrl,
    "--manifest-signer",
    input.manifestSigner,
    ...(input.extra ?? [])
  ];
}

function hostnameStatusAdapters(payload: Record<string, unknown>, requests: string[] = []) {
  const fetchImpl: typeof fetch = async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  };
  return {
    fetchImpl,
    dnsProviderHint: async () => ({
      nameServers: ["ns1.example"],
      zone: "example.com",
      provider: {
        name: "Example DNS",
        loginUrl: "https://dns.example"
      }
    })
  };
}

function hostnameStatusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: false,
    status: "pending_dns",
    customerHostname: "app.example.com",
    endpointHostname: "demo.ingress.example",
    endpointId: "demo.ingress.example",
    sessionId,
    instructions: {
      summary: "Create CNAME app.example.com -> demo.ingress.example"
    },
    dns: {
      results: []
    },
    certificate: {
      authorized: false
    },
    tls: {
      mode: "proof-acme"
    },
    certificateValidation: {
      mode: "dns01-cname-delegation"
    },
    routeIntent: {
      configured: false
    },
    ...overrides
  };
}

async function withManifestServer(
  fn: (input: { manifestUrl: string; manifestSigner: string }) => Promise<void>
): Promise<void> {
  let signedManifest: unknown;
  const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(signedManifest));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const manifest = testNetworkManifest(baseUrl, { ethRpcUrl: "http://127.0.0.1:9" });
    signedManifest = await signNetworkManifest(manifest, manifestSignerSeed, { scheme: "substrate-sr25519", ss58Format: 42 });
    const manifestSigner = (signedManifest as { signature: { signer: string } }).signature.signer;
    await fn({ manifestUrl: `${baseUrl}/v1/network-manifest`, manifestSigner });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function withAccountingServer(
  options: { claimableBalance?: bigint; session?: readonly unknown[] },
  fn: (input: { manifestUrl: string; manifestSigner: string; rpcMethods: string[] }) => Promise<void>
): Promise<void> {
  let signedManifest: unknown;
  const rpcMethods: string[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.method === "GET" && request.url === "/v1/network-manifest") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(signedManifest));
        return;
      }
      if (request.method !== "POST") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      const payload = JSON.parse(await readRequestBody(request)) as JsonRpcRequest | JsonRpcRequest[];
      const result = Array.isArray(payload)
        ? payload.map((item) => handleAccountingRpc(item, options, rpcMethods))
        : handleAccountingRpc(payload, options, rpcMethods);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    signedManifest = await signNetworkManifest(testNetworkManifest(baseUrl, { ethRpcUrl: baseUrl }), manifestSignerSeed, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const manifestSigner = (signedManifest as { signature: { signer: string } }).signature.signer;
    await fn({ manifestUrl: `${baseUrl}/v1/network-manifest`, manifestSigner, rpcMethods });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

interface JsonRpcRequest {
  id?: string | number | null;
  method: string;
  params?: unknown[];
}

function handleAccountingRpc(
  request: JsonRpcRequest,
  options: { claimableBalance?: bigint; session?: readonly unknown[] },
  rpcMethods: string[]
): Record<string, unknown> {
  rpcMethods.push(request.method);
  if (request.method === "eth_chainId") {
    return { jsonrpc: "2.0", id: request.id ?? null, result: ethers.toQuantity(31337) };
  }
  if (request.method === "net_version") {
    return { jsonrpc: "2.0", id: request.id ?? null, result: "31337" };
  }
  if (request.method === "eth_blockNumber") {
    return { jsonrpc: "2.0", id: request.id ?? null, result: "0x1" };
  }
  if (request.method === "eth_estimateGas") {
    return { jsonrpc: "2.0", id: request.id ?? null, result: "0x5208" };
  }
  if (request.method === "eth_call") {
    const call = (request.params?.[0] ?? {}) as { data?: string };
    const parsed = accountingInterface.parseTransaction({ data: call.data ?? "0x" });
    if (parsed?.name === "claimableBalances") {
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: accountingInterface.encodeFunctionResult("claimableBalances", [options.claimableBalance ?? 0n])
      };
    }
    if (parsed?.name === "getSession") {
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: accountingInterface.encodeFunctionResult("getSession", [options.session ?? refundableSession()])
      };
    }
  }
  return {
    jsonrpc: "2.0",
    id: request.id ?? null,
    error: {
      code: -32601,
      message: `unsupported test rpc method ${request.method}`
    }
  };
}

function refundableSession(): readonly unknown[] {
  const zeroBytes = `0x${"00".repeat(32)}`;
  return [
    developerAddress,
    assetAddress,
    5_000_000n,
    5_000_000n,
    0n,
    0n,
    1n,
    900n,
    2_000_000_000n,
    zeroBytes,
    zeroBytes,
    zeroBytes,
    ethers.ZeroAddress,
    zeroBytes,
    zeroBytes,
    zeroBytes,
    zeroBytes,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    0,
    0,
    0,
    false,
    0n,
    0n,
    1n,
    0n,
    0n,
    0n,
    0n,
    0n,
    1_000_000n,
    1
  ];
}

function testNetworkManifest(baseUrl: string, options: { ethRpcUrl: string }): NetworkManifest {
  return {
    version: 1,
    sequence: 1,
    issuedAt: "2026-05-22T00:00:00.000Z",
    expiresAt: "2030-05-22T00:00:00.000Z",
    chain: { name: "revive-local", chainId: "31337" },
    registries: {
      active: [{ status: "active", address: registryAddress }],
      deprecated: [],
      retired: []
    },
    rpc: {
      eth: [options.ethRpcUrl],
      substrate: ["ws://127.0.0.1:9"]
    },
    supportedAssets: [{ address: assetAddress, symbol: "USDC", decimals: 6, kind: "erc20" }],
    controlPlane: { apiBaseUrl: baseUrl },
    relays: [{ relayId: "relay-a", controlPlaneUrl: baseUrl, active: true }]
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function withCleanSignerEnv(fn: () => Promise<void>): Promise<void> {
  const names = [
    "PROOF_CLAIM_PRIVATE_KEY",
    "CLAIM_PRIVATE_KEY",
    "DEVELOPER_PRIVATE_KEY",
    "EVM_PRIVATE_KEY",
    "POLKADOT_SEED",
    "ACURAST_MAINNET_SEED",
    "ACURAST_SEED",
    "POLKADOT_ADDRESS",
    "ACURAST_MAINNET_ADDRESS",
    "ACURAST_ADDRESS",
    "PROOF_POLKADOT_SIGNER"
  ];
  const previous = new Map<string, string | undefined>();
  for (const name of names) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }
  try {
    await fn();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}
