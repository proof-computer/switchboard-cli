import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ethers } from "ethers";

import {
  runSwitchboardCli,
  runSwitchboardCatalogBuild,
  runSwitchboardCatalogInspect,
  runSwitchboardCatalogSetState,
  runSwitchboardCatalogVerify,
  runSwitchboardClaim,
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
  runSwitchboardGatewayDiscover,
  runSwitchboardGatewaySetup,
  runSwitchboardGatewayStatus,
  runSwitchboardGatewayUpgrade,
  runSwitchboardHostnameAdd,
  runSwitchboardHostnameRemove,
  runSwitchboardHostnameStatus,
  runSwitchboardLaunchDemo,
  runSwitchboardPreflight,
  runSwitchboardProjectInit,
  runSwitchboardProjectShow,
  runSwitchboardRefund,
  runSwitchboardRefundable,
  runSwitchboardRelayBudget,
  runSwitchboardRelayCatalogBuild,
  runSwitchboardRelayCatalogSetState,
  runSwitchboardRelayDnsPlan,
  runSwitchboardRelayDnsVerify,
  runSwitchboardRelayDiff,
  runSwitchboardRelayKeygen,
  runSwitchboardRelayList,
  runSwitchboardRelayLogs,
  runSwitchboardRelayPickProcessor,
  runSwitchboardRelayScaffold,
  runSwitchboardRelayStatus,
  runSwitchboardRelaySync,
  runSwitchboardRelayWatch,
  runSwitchboardRelayVerify,
  runSwitchboardRelayWhoami,
  runSwitchboardSessionRegister,
  runSwitchboardSessionStatus,
  runSwitchboardValidatorScript,
  type SwitchboardContextStore
} from "../cli/src/index.js";
import type { ManagerProcessorInventory, ProcessorInfo } from "../src/acurast-manager.js";
import { INGRESS_REGISTRY_NATIVE_PAYMENT_ABI } from "../src/ingress-contract.js";
import { signNetworkManifest, type NetworkManifest } from "../src/network-manifest.js";
import { encryptProofLogRecord } from "../src/proof-log-crypto.js";
import { signServiceCatalog, verifySignedServiceCatalog, type ServiceCatalog } from "../src/service-catalog.js";

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
const catalogSignerSeed = "//Alice//switchboard-service-catalog";
const otherCatalogSignerSeed = "//Bob//switchboard-service-catalog";
const registryAddress = "0x65d6b76bec50f46d198ffa3598e381a298025da0";
const assetAddress = "0x0000000000000000000000000000000000001337";
const recipientAddress = "0x000000000000000000000000000000000000bEEF";
const developerAddress = "0x000000000000000000000000000000000000dEaD";
const hostnameDeveloperPrivateKey = "0x59c6995e998f97a5a0044966f094538101d6bd64b3c088debf60833bd5d0bf39";
const registrationJobSignerPrivateKey = hostnameDeveloperPrivateKey;
const mismatchedJobSignerPrivateKey = "0x8b3a350cf5c34c9194ca1b8c5ec9114eface155829ad17665d9395234c0cb5a0";
const relayKeygenPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const relayWhoamiSeed = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const relayLogsEncryptionKey = Buffer.alloc(32, 0xab).toString("base64url");
const sessionId = `0x${"11".repeat(32)}`;
const accountingInterface = new ethers.Interface(INGRESS_REGISTRY_NATIVE_PAYMENT_ABI);

describe("native command runners", () => {
  it("exports a shared project init runner for native plugin reuse", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-init-"));
    try {
      const bareDir = path.join(workDir, "bare");
      const initDir = path.join(workDir, "init");
      const projectInitDir = path.join(workDir, "project-init");
      const baseArgs = [
        "--json",
        "--project",
        "native-init-test",
        "--context",
        "mainnet"
      ];
      const bare = JSON.parse(
        await captureConsole(() =>
          runSwitchboardProjectInit([...baseArgs, "--project-dir", bareDir], runtimeWithoutLatestReport)
        )
      );
      const prefixed = JSON.parse(
        await captureConsole(() =>
          runSwitchboardProjectInit(["init", ...baseArgs, "--project-dir", initDir], runtimeWithoutLatestReport)
        )
      );
      const projectPrefixed = JSON.parse(
        await captureConsole(() =>
          runSwitchboardProjectInit(["project", "init", ...baseArgs, "--project-dir", projectInitDir], runtimeWithoutLatestReport)
        )
      );

      for (const [output, projectDir] of [[bare, bareDir], [prefixed, initDir], [projectPrefixed, projectInitDir]] as const) {
        assert.equal(output.ok, true);
        assert.equal(output.action, "project-init");
        assert.equal(output.projectRoot, projectDir);
        assert.equal(output.config.project, "native-init-test");
        assert.equal(output.config.context, "mainnet");
        assert.equal(output.config.endpoint, undefined);
        assert.equal(output.config.deploy.hostname, undefined);

        const config = JSON.parse(await readFile(path.join(projectDir, "switchboard.json"), "utf8"));
        assert.equal(config.project, "native-init-test");
        assert.equal(config.endpoint, undefined);
        assert.equal(config.deploy.hostname, undefined);
        assert.match(await readFile(path.join(projectDir, ".gitignore"), "utf8"), /\.switchboard\/?/);
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps project init overwrite, force, and removed flag behavior unchanged", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-init-errors-"));
    try {
      await captureConsole(() =>
        runSwitchboardProjectInit(["--project-dir", workDir, "--project", "first", "--json"], runtimeWithoutLatestReport)
      );

      await assert.rejects(
        runSwitchboardProjectInit(["--project-dir", workDir, "--project", "second"], runtimeWithoutLatestReport),
        /switchboard\.json already exists/
      );
      await assert.rejects(
        runSwitchboardProjectInit(["init", "--project-dir", path.join(workDir, "bad-template"), "--template", "node"], runtimeWithoutLatestReport),
        /Unsupported project template/
      );
      await assert.rejects(
        runSwitchboardProjectInit(["project", "init", "--project-dir", path.join(workDir, "removed"), "--route-intent-url", "https://relay.example"], runtimeWithoutLatestReport),
        /Removed project deploy option\(s\): --route-intent-url/
      );
      await assert.rejects(
        runSwitchboardProjectInit(["--project-dir", path.join(workDir, "endpoint"), "--endpoint", "demo.ingress.example"], runtimeWithoutLatestReport),
        /Removed project deploy option\(s\): --endpoint/
      );
      await assert.rejects(
        runSwitchboardProjectInit(["--project-dir", path.join(workDir, "hostname"), "--hostname", "demo.ingress.example"], runtimeWithoutLatestReport),
        /Removed project deploy option\(s\): --hostname/
      );
      await assert.rejects(
        runSwitchboardProjectInit(["--project-dir", path.join(workDir, "endpoint-id"), "--endpoint-id", "demo"], runtimeWithoutLatestReport),
        /Removed project deploy option\(s\): --endpoint-id/
      );

      const forced = JSON.parse(
        await captureConsole(() =>
          runSwitchboardProjectInit(["--project-dir", workDir, "--project", "second", "--force", "--json"], runtimeWithoutLatestReport)
        )
      );
      assert.equal(forced.ok, true);
      assert.equal(forced.config.project, "second");
      const config = JSON.parse(await readFile(path.join(workDir, "switchboard.json"), "utf8"));
      assert.equal(config.project, "second");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("exports a shared SSH project init runner while preserving generated files and modes", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-init-ssh-"));
    try {
      const keyFile = path.join(workDir, "id_ed25519.pub");
      const projectDir = path.join(workDir, "ssh-project");
      await writeFile(keyFile, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeSwitchboardTestKey\n", "utf8");

      const output = JSON.parse(
        await captureConsole(() =>
          runSwitchboardProjectInit(
            [
              "project",
              "init",
              "--project-dir",
              projectDir,
              "--template",
              "ssh",
              "--distro",
              "ubuntu",
              "--project",
              "ssh-demo",
              "--ssh-public-key-file",
              keyFile,
              "--json"
            ],
            runtimeWithoutLatestReport
          )
        )
      );

      assert.equal(output.ok, true);
      assert.equal(output.template, "ssh");
      assert.equal(output.distro, "ubuntu");
      assert.deepEqual(output.files, [
        "switchboard.json",
        "acurast.sh",
        "switchboard-cargo-bootstrap.sh",
        "switchboard-cargo-bootstrap.py",
        "stunnel.conf",
        "getifaddrs_override.c",
        "authorized_keys.example",
        "authorized_keys"
      ]);
      const config = JSON.parse(await readFile(path.join(projectDir, "switchboard.json"), "utf8"));
      assert.equal(config.endpoint, undefined);
      assert.equal(config.deploy.hostname, undefined);
      assert.equal(config.acurast.runtime, "script");
      assert.equal(config.acurast.entrypoint, "acurast.sh");
      assert.deepEqual(config.acurast.scriptFiles, [
        "acurast.sh",
        "switchboard-cargo-bootstrap.sh",
        "switchboard-cargo-bootstrap.py",
        "stunnel.conf",
        "getifaddrs_override.c"
      ]);
      assert.equal(await readFile(path.join(projectDir, "authorized_keys"), "utf8"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeSwitchboardTestKey\n");
      assert.equal((await stat(path.join(projectDir, "acurast.sh"))).mode & 0o777, 0o755);
      assert.equal((await stat(path.join(projectDir, "switchboard-cargo-bootstrap.sh"))).mode & 0o777, 0o755);

      await assert.rejects(
        runSwitchboardProjectInit(["--project-dir", path.join(workDir, "bad-distro"), "--template", "ssh", "--distro", "debian"], runtimeWithoutLatestReport),
        /Unsupported SSH template distro/
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

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

  it("rejects stale caller-owned endpoint defaults before deploy readiness checks", async () => {
    await assert.rejects(
      runSwitchboardPreflight(["--quote"], {
        ...runtimeWithoutLatestReport,
        projectConfigPath: "switchboard.json",
        projectConfig: {
          project: "legacy",
          endpoint: {
            hostname: "demo.ingress.example"
          }
        }
      }),
      /uses removed project field: endpoint/
    );

    await assert.rejects(
      runSwitchboardPreflight(["--quote"], {
        ...runtimeWithoutLatestReport,
        projectConfigPath: "switchboard.json",
        projectConfig: {
          project: "legacy",
          deploy: {
            hostname: "demo.ingress.example"
          }
        }
      }),
      /uses removed deploy field\(s\): hostname/
    );
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

  it("exports a shared session status runner that keeps the existing missing-session error path", async () => {
    await withManifestServer(async ({ manifestUrl, manifestSigner }) => {
      await assert.rejects(
        runSwitchboardSessionStatus(["--manifest-url", manifestUrl, "--manifest-signer", manifestSigner], runtimeWithoutLatestReport),
        /Missing --session-id or SESSION_ID/
      );

      await assert.rejects(
        runSwitchboardSessionStatus(["session", "status", "--manifest-url", manifestUrl, "--manifest-signer", manifestSigner], runtimeWithoutLatestReport),
        /Missing --session-id or SESSION_ID/
      );
    });
  });

  it("exports a shared session status runner for native plugin reuse", async () => {
    await withAccountingServer({ session: refundableSession() }, async ({ manifestUrl, manifestSigner, rpcMethods }) => {
      const args = ["--json", "--session-id", sessionId, "--manifest-url", manifestUrl, "--manifest-signer", manifestSigner];
      const bare = await captureConsole(() => runSwitchboardSessionStatus(args, runtimeWithoutLatestReport));
      const prefixed = await captureConsole(() => runSwitchboardSessionStatus(["session", "status", ...args], runtimeWithoutLatestReport));

      for (const output of [JSON.parse(bare), JSON.parse(prefixed)]) {
        assert.equal(output.action, "status");
        assert.equal(output.target, "revive-local");
        assert.equal(output.registryAddress, ethers.getAddress(registryAddress));
        assert.equal(output.sessionId, sessionId);
        assert.equal(ethers.getAddress(output.session.developer), ethers.getAddress(developerAddress));
        assert.equal(ethers.getAddress(output.session.asset), ethers.getAddress(assetAddress));
        assert.equal(output.session.amountPaid, "5000000");
        assert.equal(output.session.status, "1");
      }
      assert.equal(rpcMethods.some((method) => method.startsWith("eth_send")), false);
    });
  });

  it("exports a shared session register runner that keeps the existing --yes refusal", async () => {
    await withCleanSessionRegisterEnv(async () => {
      await assert.rejects(
        runSwitchboardSessionRegister(["--session-id", sessionId], runtimeWithoutLatestReport),
        /Refusing to relay registration without --yes/
      );

      await assert.rejects(
        runSwitchboardSessionRegister(["session", "register", "--session-id", sessionId], runtimeWithoutLatestReport),
        /Refusing to relay registration without --yes/
      );
    });
  });

  it("keeps session register funded-session and signer guardrails unchanged", async () => {
    await withCleanSessionRegisterEnv(async () => {
      await withAccountingServer({ session: missingFundedSession() }, async ({ baseUrl }) => {
        await assert.rejects(
          runSwitchboardSessionRegister(sessionRegisterArgs({ baseUrl, extra: ["--job-signer-private-key", registrationJobSignerPrivateKey] }), runtimeWithoutLatestReport),
          /Session .* is not funded/
        );
      });

      await withAccountingServer({ session: registrationSession({ registered: true }) }, async ({ baseUrl }) => {
        await assert.rejects(
          runSwitchboardSessionRegister(sessionRegisterArgs({ baseUrl, extra: ["--job-signer-private-key", registrationJobSignerPrivateKey] }), runtimeWithoutLatestReport),
          /Session .* is already registered/
        );
      });

      await withAccountingServer({ session: registrationSession() }, async ({ baseUrl }) => {
        await assert.rejects(
          runSwitchboardSessionRegister(sessionRegisterArgs({ baseUrl }), runtimeWithoutLatestReport),
          /Missing --job-signer-private-key or JOB_SIGNER_PRIVATE_KEY/
        );
      });

      await withAccountingServer({ session: registrationSession() }, async ({ baseUrl }) => {
        await assert.rejects(
          runSwitchboardSessionRegister(sessionRegisterArgs({ baseUrl, extra: ["--job-signer-private-key", mismatchedJobSignerPrivateKey] }), runtimeWithoutLatestReport),
          /JOB_SIGNER_PRIVATE_KEY resolves to .* not funded session signer/
        );
      });

      await withAccountingServer({ session: registrationSession() }, async ({ baseUrl }) => {
        await assert.rejects(
          runSwitchboardSessionRegister(
            sessionRegisterArgs({
              baseUrl,
              extra: ["--job-signer-private-key", registrationJobSignerPrivateKey, "--local-relay"]
            }),
            runtimeWithoutLatestReport
          ),
          /--local-relay is not included in the public CLI package; pass --relay-url instead/
        );
      });
    });
  });

  it("exports a shared session register runner for native plugin reuse", async () => {
    await withCleanSessionRegisterEnv(async () => {
      let registered = false;
      const relayRequests: Array<{ url: string; payload: Record<string, any> }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url !== "https://relay.example/v1/ingress-registrations") {
          throw new Error(`Unexpected fetch ${url}`);
        }
        const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
        relayRequests.push({ url, payload });
        registered = true;
        return new Response(JSON.stringify({ ok: true, txHash: `0x${"44".repeat(32)}` }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch;
      try {
        await withAccountingServer(
          { session: () => registrationSession({ registered }) },
          async ({ baseUrl, rpcMethods }) => {
            const args = sessionRegisterArgs({
              baseUrl,
              extra: ["--job-signer-private-key", registrationJobSignerPrivateKey, "--deadline", "2000000000", "--json"]
            });
            const bare = JSON.parse(await captureConsole(() => runSwitchboardSessionRegister(args, runtimeWithoutLatestReport)));
            registered = false;
            const prefixed = JSON.parse(
              await captureConsole(() =>
                runSwitchboardSessionRegister(["session", "register", ...args], runtimeWithoutLatestReport)
              )
            );

            for (const output of [bare, prefixed]) {
              assert.equal(output.ok, true);
              assert.equal(output.action, "session-register");
              assert.equal(output.target, "revive-local");
              assert.equal(output.chainId, "31337");
              assert.equal(output.registryAddress, ethers.getAddress(registryAddress));
              assert.equal(output.relayUrl, "https://relay.example");
              assert.equal(output.relayResponse.txHash, `0x${"44".repeat(32)}`);
              assert.equal(output.registration.sessionId, sessionId);
              assert.equal(output.registration.jobSigner, new ethers.Wallet(registrationJobSignerPrivateKey).address);
              assert.equal(output.registration.nonce, "7");
              assert.equal(output.registration.deadline, "2000000000");
              assert.equal(typeof output.signature, "string");
              assert.equal(output.session.registered, true);
            }

            assert.equal(relayRequests.length, 2);
            for (const request of relayRequests) {
              assert.equal(request.payload.registration.sessionId, sessionId);
              assert.equal(request.payload.registration.jobSigner, new ethers.Wallet(registrationJobSignerPrivateKey).address);
              assert.equal(typeof request.payload.signature, "string");
            }
            assert.equal(rpcMethods.some((method) => method.startsWith("eth_send")), false);
          }
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("exports a shared validator script runner for native plugin reuse", async () => {
    await withCleanValidatorScriptEnv(async () => {
      await withValidatorScriptLookupServer(
        {
          networkScript: {
            scriptIpfs: "ipfs://bafyvalidatornetwork",
            scriptHash: "sha256:network"
          }
        },
        async ({ manifestUrl, manifestSigner, requests }) => {
          const args = ["--json", "--manifest-url", manifestUrl, "--manifest-signer", manifestSigner];
          const bare = await captureConsole(() => runSwitchboardValidatorScript(args, runtimeWithoutLatestReport));
          const prefixed = await captureConsole(() =>
            runSwitchboardValidatorScript(["validator", "script", ...args], runtimeWithoutLatestReport)
          );

          for (const output of [JSON.parse(bare), JSON.parse(prefixed)]) {
            assert.equal(output.ok, true);
            assert.equal(output.scriptIpfs, "ipfs://bafyvalidatornetwork");
            assert.equal(output.scriptHash, "sha256:network");
            assert.equal(output.source, manifestUrl);
          }
          assert.deepEqual(requests, ["GET /v1/network-manifest", "GET /v1/network-manifest"]);
        }
      );
    });
  });

  it("keeps validator script manifest fallback order and output shape", async () => {
    await withCleanValidatorScriptEnv(async () => {
      const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-validator-script-"));
      try {
        const manifestFile = path.join(workDir, "validator-script-manifest.json");
        await writeFile(
          manifestFile,
          JSON.stringify({
            scriptIpfs: "ipfs://bafyvalidatorfile",
            scriptHash: "sha256:file"
          })
        );

        await withValidatorScriptLookupServer(
          {
            scriptManifest: {
              scriptIpfs: "ipfs://bafyvalidatorurl",
              bundleSha256: "url"
            }
          },
          async ({ manifestUrl, manifestSigner, validatorScriptManifestUrl }) => {
            const manifestArgs = ["--json", "--manifest-url", manifestUrl, "--manifest-signer", manifestSigner];
            const fromJson = JSON.parse(
              await captureConsole(() =>
                runSwitchboardValidatorScript(
                  [
                    ...manifestArgs,
                    "--validator-script-manifest-json",
                    JSON.stringify({
                      scriptIpfs: "ipfs://bafyvalidatorjson",
                      bundleSha256: "json"
                    }),
                    "--validator-script-manifest-file",
                    manifestFile,
                    "--validator-script-manifest-url",
                    validatorScriptManifestUrl
                  ],
                  runtimeWithoutLatestReport
                )
              )
            );
            const fromFile = JSON.parse(
              await captureConsole(() =>
                runSwitchboardValidatorScript(
                  [
                    ...manifestArgs,
                    "--validator-script-manifest-file",
                    manifestFile,
                    "--validator-script-manifest-url",
                    validatorScriptManifestUrl
                  ],
                  runtimeWithoutLatestReport
                )
              )
            );
            const fromUrl = JSON.parse(
              await captureConsole(() =>
                runSwitchboardValidatorScript(
                  [
                    "validator",
                    "script",
                    ...manifestArgs,
                    "--validator-script-manifest-url",
                    validatorScriptManifestUrl
                  ],
                  runtimeWithoutLatestReport
                )
              )
            );

            assert.deepEqual(
              [fromJson, fromFile, fromUrl].map((output) => ({
                scriptIpfs: output.scriptIpfs,
                scriptHash: output.scriptHash,
                source: output.source
              })),
              [
                { scriptIpfs: "ipfs://bafyvalidatorjson", scriptHash: "sha256:json", source: "inline" },
                { scriptIpfs: "ipfs://bafyvalidatorfile", scriptHash: "sha256:file", source: manifestFile },
                { scriptIpfs: "ipfs://bafyvalidatorurl", scriptHash: "sha256:url", source: validatorScriptManifestUrl }
              ]
            );
          }
        );
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  it("keeps validator script error paths unchanged", async () => {
    await withCleanValidatorScriptEnv(async () => {
      await withValidatorScriptLookupServer({}, async ({ manifestUrl, manifestSigner }) => {
        const manifestArgs = ["--manifest-url", manifestUrl, "--manifest-signer", manifestSigner];

        await assert.rejects(
          runSwitchboardValidatorScript(manifestArgs, runtimeWithoutLatestReport),
          /No validator script pin found in the network manifest or validator script manifest/
        );

        await assert.rejects(
          runSwitchboardValidatorScript(
            [
              ...manifestArgs,
              "--validator-script-manifest-json",
              JSON.stringify({
                scriptIpfs: "https://example.com/not-ipfs"
              })
            ],
            runtimeWithoutLatestReport
          ),
          /Validator script manifest must include scriptIpfs as an ipfs:\/\/ URI/
        );
      });
    });
  });

  it("exports a shared catalog build runner for native plugin reuse", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-catalog-build-"));
    try {
      const specFile = path.join(workDir, "catalog-build-spec.json");
      await writeFile(
        specFile,
        JSON.stringify({
          version: 1,
          ttlSeconds: 3600,
          sequence: 42,
          issuedAt: "2030-05-01T12:00:00.000Z",
          controlApi: [
            {
              serviceId: "control-bootstrap",
              apiBaseUrl: "https://control.example",
              capabilities: ["quotes"]
            }
          ],
          relays: [
            { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "active" },
            { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "candidate" }
          ]
        }),
        "utf8"
      );
      const bareOutput = path.join(workDir, "bare", "service-catalogs.signed.json");
      const prefixedOutput = path.join(workDir, "prefixed", "service-catalogs.signed.json");
      const baseArgs = ["--spec", specFile, "--signing-key", catalogSignerSeed];

      await captureConsole(() =>
        runSwitchboardCatalogBuild([...baseArgs, "--output", bareOutput], runtimeWithoutLatestReport)
      );
      await captureConsole(() =>
        runSwitchboardCatalogBuild(["catalog", "build", ...baseArgs, "--output", prefixedOutput], runtimeWithoutLatestReport)
      );

      const outputs = [
        JSON.parse(await readFile(bareOutput, "utf8")) as { controlApi: unknown; relays: unknown },
        JSON.parse(await readFile(prefixedOutput, "utf8")) as { controlApi: unknown; relays: unknown }
      ];
      const verified = await Promise.all(outputs.map((output) => verifySignedServiceCatalog(output.relays)));

      assert.equal(verified[0].signer, verified[1].signer);
      for (const result of verified) {
        assert.equal(result.catalog.role, "relay");
        assert.equal(result.catalog.sequence, 42);
        assert.deepEqual(
          result.catalog.members.map((member) => [member.serviceId, member.state]),
          [
            ["relay-a", "active"],
            ["relay-d", "candidate"]
          ]
        );
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps catalog build input and signing errors unchanged", async () => {
    await withCleanCatalogBuildEnv(async () => {
      const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-catalog-build-errors-"));
      try {
        const specFile = path.join(workDir, "catalog-build-spec.json");
        await writeFile(
          specFile,
          JSON.stringify({
            version: 1,
            controlApi: [
              {
                serviceId: "control-bootstrap",
                apiBaseUrl: "https://control.example"
              }
            ],
            relays: [
              { relayId: "relay-a", apiBaseUrl: "https://relay-a.example" }
            ]
          }),
          "utf8"
        );

        await assert.rejects(
          runSwitchboardCatalogBuild(["--spec", specFile], runtimeWithoutLatestReport),
          /requires a signing key/
        );
        await assert.rejects(
          runSwitchboardCatalogBuild(["catalog", "build"], runtimeWithoutLatestReport),
          /needs either --spec <file> or PROOF_CONTROL_PLANE_URL/
        );
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  it("exports a shared relay catalog build runner for native plugin reuse", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-catalog-build-"));
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      await writeFile(
        path.join(workDir, "relays", "catalog.json"),
        JSON.stringify([
          { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "active" },
          { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "disabled" }
        ]),
        "utf8"
      );
      await writeFile(
        path.join(workDir, "relays", "relay-a.json"),
        JSON.stringify({
          relayId: "relay-a",
          target: "bootstrap",
          apiBaseUrl: "https://relay-a.example",
          catalogState: "active"
        }),
        "utf8"
      );
      await writeFile(
        path.join(workDir, "relays", "relay-d.json"),
        JSON.stringify({
          relayId: "relay-d",
          target: "bootstrap",
          apiBaseUrl: "https://relay-d.example",
          catalogState: "candidate"
        }),
        "utf8"
      );

      const bareOutput = path.join(workDir, "bare", "service-catalogs.signed.json");
      const prefixedOutput = path.join(workDir, "prefixed", "service-catalogs.signed.json");
      const options = {
        cwd: workDir,
        env: {
          PROOF_SERVICE_CATALOG_SIGNING_KEY: catalogSignerSeed,
          PROOF_CONTROL_PLANE_URL: "https://control.example"
        }
      };

      await captureConsole(() =>
        runSwitchboardRelayCatalogBuild(["--output", bareOutput], runtimeWithoutLatestReport, options)
      );
      await captureConsole(() =>
        runSwitchboardRelayCatalogBuild(["relay", "catalog", "build", "--output-file", prefixedOutput], runtimeWithoutLatestReport, options)
      );

      const outputs = [
        JSON.parse(await readFile(bareOutput, "utf8")) as { relays: unknown },
        JSON.parse(await readFile(prefixedOutput, "utf8")) as { relays: unknown }
      ];
      const verified = await Promise.all(outputs.map((output) => verifySignedServiceCatalog(output.relays)));
      assert.equal(verified[0].signer, verified[1].signer);
      for (const result of verified) {
        assert.equal(result.catalog.role, "relay");
        assert.deepEqual(
          result.catalog.members.map((member) => [member.serviceId, member.state]),
          [
            ["relay-a", "active"],
            ["relay-d", "disabled"]
          ]
        );
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps relay catalog build input and signing errors unchanged", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-catalog-build-errors-"));
    try {
      await assert.rejects(
        runSwitchboardRelayCatalogBuild([], runtimeWithoutLatestReport, {
          cwd: workDir,
          env: {
            PROOF_SERVICE_CATALOG_SIGNING_KEY: catalogSignerSeed,
            PROOF_CONTROL_PLANE_URL: "https://control.example"
          }
        }),
        /found no spec files/
      );

      await mkdir(path.join(workDir, "relays"), { recursive: true });
      await writeFile(
        path.join(workDir, "relays", "relay-a.json"),
        JSON.stringify({
          relayId: "relay-a",
          target: "bootstrap",
          apiBaseUrl: "https://relay-a.example",
          catalogState: "active"
        }),
        "utf8"
      );

      await assert.rejects(
        runSwitchboardRelayCatalogBuild(["relay", "catalog", "build"], runtimeWithoutLatestReport, {
          cwd: workDir,
          env: { PROOF_CONTROL_PLANE_URL: "https://control.example" }
        }),
        /requires a signing key/
      );
      await assert.rejects(
        runSwitchboardRelayCatalogBuild(["relay", "catalog", "build"], runtimeWithoutLatestReport, {
          cwd: workDir,
          env: { PROOF_SERVICE_CATALOG_SIGNING_KEY: catalogSignerSeed }
        }),
        /needs either --spec <file> or PROOF_CONTROL_PLANE_URL/
      );
      await assert.rejects(
        runSwitchboardRelayCatalogBuild(["relay", "catalog", "bogus"], runtimeWithoutLatestReport),
        /Unknown command: relay catalog bogus/
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("exports a shared relay catalog set-state runner for native plugin reuse", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-catalog-set-state-"));
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      const defaultCatalogFile = path.join(workDir, "relays", "catalog.json");
      const overrideCatalogFile = path.join(workDir, "override-catalog.json");
      const aliasCatalogFile = path.join(workDir, "alias-catalog.json");
      const rebuildCatalogFile = path.join(workDir, "rebuild-catalog.json");
      const catalog = [
        { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "active" },
        { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "candidate" }
      ];
      await writeFile(defaultCatalogFile, JSON.stringify(catalog), "utf8");
      await writeFile(overrideCatalogFile, JSON.stringify(catalog), "utf8");
      await writeFile(aliasCatalogFile, JSON.stringify(catalog), "utf8");
      await writeFile(rebuildCatalogFile, JSON.stringify(catalog), "utf8");

      const lines: string[] = [];
      const io = {
        log: (line: string) => lines.push(line),
        warn: (line: string) => lines.push(`warn:${line}`),
        error: (line: string) => lines.push(`error:${line}`)
      };

      let skippedBuildCalls = 0;
      await runSwitchboardRelayCatalogSetState(
        ["relay-d", "draining", "--no-rebuild"],
        runtimeWithoutLatestReport,
        {
          cwd: workDir,
          io,
          build: async () => {
            skippedBuildCalls += 1;
            return undefined;
          }
        }
      );
      await runSwitchboardRelayCatalogSetState(
        ["relay", "catalog", "set-state", "relay-d", "active", "--catalog-file", overrideCatalogFile, "--no-rebuild"],
        runtimeWithoutLatestReport,
        { cwd: workDir, io }
      );
      await runSwitchboardRelayCatalogSetState(
        ["relay", "catalog", "state", "relay-d", "disabled", "--catalog-file", aliasCatalogFile, "--no-rebuild"],
        runtimeWithoutLatestReport,
        { cwd: workDir, io }
      );

      assert.equal(skippedBuildCalls, 0);
      const defaultCatalog = JSON.parse(await readFile(defaultCatalogFile, "utf8")) as Array<{ relayId: string; state: string }>;
      const overrideCatalog = JSON.parse(await readFile(overrideCatalogFile, "utf8")) as Array<{ relayId: string; state: string }>;
      const aliasCatalog = JSON.parse(await readFile(aliasCatalogFile, "utf8")) as Array<{ relayId: string; state: string }>;
      assert.deepEqual(defaultCatalog.map((relay) => [relay.relayId, relay.state]), [
        ["relay-a", "active"],
        ["relay-d", "draining"]
      ]);
      assert.deepEqual(overrideCatalog.map((relay) => [relay.relayId, relay.state]), [
        ["relay-a", "active"],
        ["relay-d", "active"]
      ]);
      assert.deepEqual(aliasCatalog.map((relay) => [relay.relayId, relay.state]), [
        ["relay-a", "active"],
        ["relay-d", "disabled"]
      ]);

      let capturedEnv: NodeJS.ProcessEnv | undefined;
      await runSwitchboardRelayCatalogSetState(
        ["relay-d", "active", "--catalog-file", rebuildCatalogFile],
        runtimeWithoutLatestReport,
        {
          cwd: workDir,
          env: { PROOF_SERVICE_CATALOG_SIGNING_KEY: catalogSignerSeed },
          io,
          build: async ({ env }) => {
            capturedEnv = env;
            return undefined;
          }
        }
      );
      assert.equal(capturedEnv?.PROOF_SERVICE_CATALOG_SIGNING_KEY, catalogSignerSeed);
      const relays = JSON.parse(capturedEnv!.PROOF_NETWORK_MANIFEST_RELAYS_JSON!) as Array<{ relayId: string; state: string }>;
      assert.deepEqual(relays.map((relay) => [relay.relayId, relay.state]), [
        ["relay-a", "active"],
        ["relay-d", "active"]
      ]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps relay catalog set-state validation errors unchanged", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-catalog-set-state-errors-"));
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      const catalogFile = path.join(workDir, "relays", "catalog.json");
      await writeFile(
        catalogFile,
        JSON.stringify([
          { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "active" },
          { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "candidate" }
        ]),
        "utf8"
      );
      const options = {
        cwd: workDir,
        io: {
          log: () => undefined,
          warn: () => undefined,
          error: () => undefined
        }
      };

      await assert.rejects(
        runSwitchboardRelayCatalogSetState([], runtimeWithoutLatestReport, options),
        /Usage: switchboard relay catalog set-state <relay-id> <state>/
      );
      await assert.rejects(
        runSwitchboardRelayCatalogSetState(["BadRelay", "active"], runtimeWithoutLatestReport, options),
        /Invalid relay id/
      );
      await assert.rejects(
        runSwitchboardRelayCatalogSetState(["relay-d", "bogus"], runtimeWithoutLatestReport, options),
        /candidate\|active\|degraded\|draining\|disabled/
      );
      await assert.rejects(
        runSwitchboardRelayCatalogSetState(["relay-missing", "active"], runtimeWithoutLatestReport, options),
        /relay relay-missing is not present in the catalog file/
      );
      await assert.rejects(
        runSwitchboardRelayCatalogSetState(
          ["relay-d", "active", "--catalog-file", path.join(workDir, "missing.json")],
          runtimeWithoutLatestReport,
          options
        ),
        /Could not read a relay catalog file/
      );
      await assert.rejects(
        runSwitchboardRelayCatalogSetState(["relay", "catalog", "bogus", "relay-d", "active"], runtimeWithoutLatestReport, options),
        /Unknown command: relay catalog bogus/
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("exports a shared catalog set-state runner for native plugin reuse", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-catalog-set-state-"));
    try {
      const spec = {
        version: 1,
        ttlSeconds: 3600,
        sequence: 43,
        issuedAt: "2030-05-01T12:00:00.000Z",
        controlApi: [
          {
            serviceId: "control-bootstrap",
            apiBaseUrl: "https://control.example",
            state: "active"
          }
        ],
        relays: [
          { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "active" },
          { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "candidate" }
        ]
      };
      const bareSpecFile = path.join(workDir, "bare-spec.json");
      const prefixedSpecFile = path.join(workDir, "prefixed-spec.json");
      await writeFile(bareSpecFile, JSON.stringify(spec), "utf8");
      await writeFile(prefixedSpecFile, JSON.stringify(spec), "utf8");
      const bareOutput = path.join(workDir, "bare", "service-catalogs.signed.json");
      const prefixedOutput = path.join(workDir, "prefixed", "service-catalogs.signed.json");

      await captureConsole(() =>
        runSwitchboardCatalogSetState(
          ["relay", "relay-d", "active", "--spec", bareSpecFile, "--output", bareOutput, "--signing-key", catalogSignerSeed],
          runtimeWithoutLatestReport
        )
      );
      await captureConsole(() =>
        runSwitchboardCatalogSetState(
          ["catalog", "set-state", "relay-d", "draining", "--spec", prefixedSpecFile, "--output", prefixedOutput, "--signing-key", catalogSignerSeed],
          runtimeWithoutLatestReport
        )
      );

      const updatedSpecs = [
        JSON.parse(await readFile(bareSpecFile, "utf8")) as { relays: Array<{ relayId: string; state: string }> },
        JSON.parse(await readFile(prefixedSpecFile, "utf8")) as { relays: Array<{ relayId: string; state: string }> }
      ];
      assert.equal(updatedSpecs[0].relays.find((relay) => relay.relayId === "relay-d")?.state, "active");
      assert.equal(updatedSpecs[1].relays.find((relay) => relay.relayId === "relay-d")?.state, "draining");

      const outputs = [
        JSON.parse(await readFile(bareOutput, "utf8")) as { relays: unknown },
        JSON.parse(await readFile(prefixedOutput, "utf8")) as { relays: unknown }
      ];
      const verified = await Promise.all(outputs.map((output) => verifySignedServiceCatalog(output.relays)));
      assert.equal(verified[0].catalog.members.find((member) => member.serviceId === "relay-d")?.state, "active");
      assert.equal(verified[1].catalog.members.find((member) => member.serviceId === "relay-d")?.state, "draining");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps catalog set-state local mutation and validation errors unchanged", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-catalog-set-state-errors-"));
    try {
      const specFile = path.join(workDir, "catalog-build-spec.json");
      await writeFile(
        specFile,
        JSON.stringify({
          version: 1,
          controlApi: [
            {
              serviceId: "control-bootstrap",
              apiBaseUrl: "https://control.example"
            }
          ],
          relays: [
            { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "active" },
            { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "candidate" }
          ]
        }),
        "utf8"
      );
      const outputFile = path.join(workDir, "service-catalogs.signed.json");

      await captureConsole(() =>
        runSwitchboardCatalogSetState(["relay-d", "disabled", "--spec", specFile, "--output", outputFile, "--no-rebuild"], runtimeWithoutLatestReport)
      );
      const updated = JSON.parse(await readFile(specFile, "utf8")) as { relays: Array<{ relayId: string; state: string }> };
      assert.equal(updated.relays.find((relay) => relay.relayId === "relay-d")?.state, "disabled");
      await assert.rejects(stat(outputFile), /ENOENT/);

      await assert.rejects(
        runSwitchboardCatalogSetState(["relay", "relay-d", "active"], runtimeWithoutLatestReport),
        /--spec/
      );
      await assert.rejects(
        runSwitchboardCatalogSetState(["relay", "missing", "active", "--spec", specFile, "--no-rebuild"], runtimeWithoutLatestReport),
        /relay\/missing is not present/
      );
      await assert.rejects(
        runSwitchboardCatalogSetState(["bogus", "relay-d", "active", "--spec", specFile, "--no-rebuild"], runtimeWithoutLatestReport),
        /role must be control-api or relay/
      );
      await assert.rejects(
        runSwitchboardCatalogSetState(["relay", "relay-d", "bogus", "--spec", specFile, "--no-rebuild"], runtimeWithoutLatestReport),
        /candidate\|active\|degraded\|draining\|disabled/
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("exports a shared catalog inspect runner for native plugin reuse", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-catalog-inspect-"));
    try {
      const signed = await signServiceCatalog(nativeRunnerRelayCatalog(), catalogSignerSeed, {
        scheme: "substrate-sr25519",
        ss58Format: 42,
        signedAt: "2030-05-01T12:00:00.000Z"
      });
      const file = path.join(workDir, "relay.json");
      await writeFile(file, JSON.stringify(signed), "utf8");
      const args = ["--file", file, "--signer", signed.signature.signer, "--json"];
      const bare = await captureConsole(() => runSwitchboardCatalogInspect(args, runtimeWithoutLatestReport));
      const prefixed = await captureConsole(() =>
        runSwitchboardCatalogInspect(["catalog", "inspect", ...args], runtimeWithoutLatestReport)
      );

      for (const output of [JSON.parse(bare), JSON.parse(prefixed)]) {
        assert.equal(output.length, 1);
        assert.equal(output[0].signed.catalog.role, "relay");
        assert.equal(output[0].signed.catalog.members.length, 2);
        assert.equal(output[0].signer, signed.signature.signer);
        assert.equal(output[0].expired, false);
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("exports a shared relay list runner for native plugin reuse", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-list-"));
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      await writeFile(
        path.join(workDir, "relays", "catalog.json"),
        JSON.stringify([
          { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "active" },
          { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "candidate" }
        ]),
        "utf8"
      );
      await writeFile(
        path.join(workDir, "relays", "relay-d.json"),
        JSON.stringify({
          relayId: "relay-d",
          target: "bootstrap",
          apiBaseUrl: "https://relay-d.example",
          catalogState: "candidate"
        }),
        "utf8"
      );

      await withWorkingDirectory(workDir, async () => {
        const outputs = [
          await captureConsole(() => runSwitchboardRelayList(["--json"], runtimeWithoutLatestReport)),
          await captureConsole(() => runSwitchboardRelayList(["relay", "list", "--json"], runtimeWithoutLatestReport)),
          await captureConsole(() => runSwitchboardRelayList(["relay", "ls", "--json"], runtimeWithoutLatestReport))
        ];

        for (const output of outputs) {
          const entries = JSON.parse(output) as Array<{ relayId: string; target?: string; source: string }>;
          assert.deepEqual(entries.map((entry) => entry.relayId), ["relay-a", "relay-d"]);
          assert.equal(entries.find((entry) => entry.relayId === "relay-d")?.target, "bootstrap");
          assert.equal(entries.every((entry) => entry.source === "local"), true);
        }
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps relay list live discovery and source validation unchanged", async () => {
    await withCatalogDiscoveryServer(async ({ manifestUrl, manifestSigner }) => {
      const args = ["--source", "live", "--manifest-url", manifestUrl, "--manifest-signer", manifestSigner, "--json"];
      const bare = JSON.parse(
        await captureConsole(() => runSwitchboardRelayList(args, runtimeWithoutLatestReport))
      ) as Array<{ relayId: string; signer?: string; sequence?: number; source: string }>;
      const prefixed = JSON.parse(
        await captureConsole(() => runSwitchboardRelayList(["relay", "list", ...args], runtimeWithoutLatestReport))
      ) as Array<{ relayId: string; signer?: string; sequence?: number; source: string }>;

      for (const output of [bare, prefixed]) {
        assert.deepEqual(output.map((entry) => entry.relayId), ["relay-a", "relay-d"]);
        assert.equal(output[0].source, "live");
        assert.equal(output[0].sequence, 42);
        assert.equal(typeof output[0].signer, "string");
      }

      await assert.rejects(
        runSwitchboardRelayList(["--source", "bogus"], runtimeWithoutLatestReport),
        /--source must be local or live/
      );
    });
  });

  it("exports a shared relay diff runner for native plugin reuse", async () => {
    await withCatalogDiscoveryServer(async ({ manifestUrl, manifestSigner }) => {
      const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-diff-"));
      try {
        await mkdir(path.join(workDir, "relays"), { recursive: true });
        await writeFile(
          path.join(workDir, "relays", "catalog.json"),
          JSON.stringify([
            { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "draining" },
            { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "candidate" },
            { relayId: "relay-e", apiBaseUrl: "https://relay-e.example", state: "candidate" }
          ]),
          "utf8"
        );

        await withWorkingDirectory(workDir, async () => {
          const args = ["--manifest-url", manifestUrl, "--manifest-signer", manifestSigner, "--json"];
          const outputs = [
            JSON.parse(await captureConsole(() => runSwitchboardRelayDiff(args, runtimeWithoutLatestReport))),
            JSON.parse(await captureConsole(() =>
              runSwitchboardRelayDiff(["relay", "diff", ...args], runtimeWithoutLatestReport)
            ))
          ] as Array<{ entries: Array<{ relayId: string; change: string }>; liveSequence?: number }>;

          for (const output of outputs) {
            const byId = new Map(output.entries.map((entry) => [entry.relayId, entry.change]));
            assert.equal(output.liveSequence, 42);
            assert.equal(byId.get("relay-a"), "state-change");
            assert.equal(byId.get("relay-d"), "unchanged");
            assert.equal(byId.get("relay-e"), "add");
          }
        });
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  it("exports a shared relay keygen runner for native plugin reuse", async () => {
    const wallet = new ethers.Wallet(relayKeygenPrivateKey);
    const lines: string[] = [];
    const errors: string[] = [];
    const keygenOptions = {
      io: {
        log: (line: string) => lines.push(line),
        warn: (line: string) => lines.push(`warn:${line}`),
        error: (line: string) => errors.push(line)
      },
      createWallet: () => wallet
    };

    await runSwitchboardRelayKeygen(["relay-q"], runtimeWithoutLatestReport, keygenOptions);
    assert.deepEqual(lines.slice(0, 3), [
      "relay  : relay-q",
      `address: ${wallet.address}`,
      "env    : PROOF_MAINNET_RELAY_Q_RECORDER_PRIVATE_KEY"
    ]);
    assert.deepEqual(errors, [`set -gx PROOF_MAINNET_RELAY_Q_RECORDER_PRIVATE_KEY ${relayKeygenPrivateKey}`]);

    lines.length = 0;
    errors.length = 0;
    await runSwitchboardRelayKeygen(
      ["relay", "keygen", "relay-q", "--env-name", "CUSTOM_RELAY_KEY", "--unsafe-stdout"],
      runtimeWithoutLatestReport,
      keygenOptions
    );
    const stdout = lines.join("\n");
    assert.match(stdout, /env    : CUSTOM_RELAY_KEY/u);
    assert.match(stdout, new RegExp(`private key \\(stdout\\): ${relayKeygenPrivateKey}`, "u"));
    assert.deepEqual(errors, []);

    await assert.rejects(
      runSwitchboardRelayKeygen(["BadRelay"], runtimeWithoutLatestReport, keygenOptions),
      /must match/
    );
  });

  it("exports a shared relay scaffold runner for native plugin reuse", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-scaffold-"));
    const previousPattern = process.env.SWITCHBOARD_RELAY_HOSTNAME_PATTERN;
    process.env.SWITCHBOARD_RELAY_HOSTNAME_PATTERN = "${relayId}.process.invalid";
    try {
      const lines: string[] = [];
      const io = {
        log: (line: string) => lines.push(line),
        warn: (line: string) => lines.push(`warn:${line}`),
        error: (line: string) => lines.push(`error:${line}`)
      };

      await runSwitchboardRelayScaffold(["relay-q", "--target", "bootstrap"], runtimeWithoutLatestReport, {
        cwd: workDir,
        env: {
          SWITCHBOARD_RELAY_HOSTNAME_PATTERN: "${relayId}.ops.example",
          SWITCHBOARD_GATEWAY_HOSTNAME: "gateway.ops.example"
        },
        io
      });
      const bootstrapSpecPath = path.join(workDir, "relays", "relay-q.json");
      const bootstrapSpec = JSON.parse(await readFile(bootstrapSpecPath, "utf8"));
      assert.equal(bootstrapSpec.relayId, "relay-q");
      assert.equal(bootstrapSpec.target, "bootstrap");
      assert.equal(bootstrapSpec.catalogState, "active");
      assert.equal(bootstrapSpec.apiBaseUrl, "https://relay-q.ops.example");
      assert.equal(bootstrapSpec.bootstrap.composeService, "relay-q");
      assert.equal(bootstrapSpec.bootstrap.composeFile, "docker-compose.control-plane.yaml");
      assert.equal(bootstrapSpec.bootstrap.envFile, ".control-plane/control-plane.env");
      assert.equal(bootstrapSpec.dns.cnameTarget, "gateway.ops.example");

      await assert.rejects(
        runSwitchboardRelayScaffold(["relay-q", "--target", "bootstrap"], runtimeWithoutLatestReport, {
          cwd: workDir,
          env: {},
          io
        }),
        /already exists/
      );

      await runSwitchboardRelayScaffold(
        ["relay-q", "--target", "bootstrap", "--api-base-url", "https://relay-q.override.example", "--force"],
        runtimeWithoutLatestReport,
        {
          cwd: workDir,
          env: {},
          io
        }
      );
      const overwrittenSpec = JSON.parse(await readFile(bootstrapSpecPath, "utf8"));
      assert.equal(overwrittenSpec.apiBaseUrl, "https://relay-q.override.example");

      await runSwitchboardRelayScaffold(
        [
          "relay",
          "scaffold",
          "relay-z",
          "--target",
          "acurast",
          "--manager-id",
          "9470",
          "--duration",
          "7d",
          "--relayer-private-key-env",
          "CUSTOM_RELAY_KEY"
        ],
        runtimeWithoutLatestReport,
        {
          cwd: workDir,
          env: {
            SWITCHBOARD_SERVICE_DOMAIN: "relays.example"
          },
          io
        }
      );
      const acurastSpec = JSON.parse(await readFile(path.join(workDir, "relays", "relay-z.json"), "utf8"));
      assert.equal(acurastSpec.target, "acurast");
      assert.equal(acurastSpec.catalogState, "candidate");
      assert.equal(acurastSpec.apiBaseUrl, "https://relay-z.relays.example");
      assert.equal(acurastSpec.secrets.relayerPrivateKeyEnv, "CUSTOM_RELAY_KEY");
      assert.equal(acurastSpec.acurast.managerId, "9470");
      assert.equal(acurastSpec.acurast.executionMs, 7 * 24 * 60 * 60_000);
    } finally {
      if (previousPattern === undefined) {
        delete process.env.SWITCHBOARD_RELAY_HOSTNAME_PATTERN;
      } else {
        process.env.SWITCHBOARD_RELAY_HOSTNAME_PATTERN = previousPattern;
      }
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps relay scaffold keygen secret output on stderr", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-scaffold-keygen-"));
    try {
      const wallet = new ethers.Wallet(relayKeygenPrivateKey);
      const lines: string[] = [];
      const errors: string[] = [];
      await runSwitchboardRelayScaffold(["relay-k", "--target", "bootstrap", "--keygen"], runtimeWithoutLatestReport, {
        cwd: workDir,
        env: {},
        io: {
          log: (line: string) => lines.push(line),
          warn: (line: string) => lines.push(`warn:${line}`),
          error: (line: string) => errors.push(line)
        },
        createWallet: () => wallet
      });

      const stdout = lines.join("\n");
      assert.match(stdout, new RegExp(`address: ${wallet.address}`, "u"));
      assert.match(stdout, /env    : PROOF_MAINNET_RELAY_K_RECORDER_PRIVATE_KEY/u);
      assert.deepEqual(errors, [`set -gx PROOF_MAINNET_RELAY_K_RECORDER_PRIVATE_KEY ${relayKeygenPrivateKey}`]);
      const onDisk = JSON.parse(await readFile(path.join(workDir, "relays", "relay-k.json"), "utf8"));
      assert.equal(onDisk.secrets.relayerPrivateKeyEnv, "PROOF_MAINNET_RELAY_K_RECORDER_PRIVATE_KEY");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps relay scaffold validation errors unchanged", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-scaffold-errors-"));
    try {
      await assert.rejects(
        runSwitchboardRelayScaffold(["BadRelay", "--target", "bootstrap"], runtimeWithoutLatestReport, {
          cwd: workDir,
          env: {}
        }),
        /must match/
      );
      await assert.rejects(
        runSwitchboardRelayScaffold(["relay-e", "--target", "bogus"], runtimeWithoutLatestReport, {
          cwd: workDir,
          env: {}
        }),
        /--target must be acurast or bootstrap/
      );
      await assert.rejects(
        runSwitchboardRelayScaffold(["relay-e", "--target", "acurast"], runtimeWithoutLatestReport, {
          cwd: workDir,
          env: {}
        }),
        /--manager-id <id> is required/
      );
      await assert.rejects(
        runSwitchboardRelayScaffold(
          ["relay-e", "--target", "acurast", "--manager-id", "9470", "--duration", "1month"],
          runtimeWithoutLatestReport,
          {
            cwd: workDir,
            env: {}
          }
        ),
        /Invalid duration/
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("exports a shared relay pick-processor runner with injected discovery", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-pick-"));
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      await writeFile(
        path.join(workDir, "relays", "relay-d.json"),
        JSON.stringify(relayPickProcessorSpec(), null, 2),
        "utf8"
      );
      const available = relayPickProcessor("5GrwvaEF5zXb26Fz9rcQpDWSm9Lro5nEtGhPYr8xSGWY5YHv");
      const conflicting = relayPickProcessor("5FHneW46xGXgs5mUiveU4sbTyGBzmst6m6p4Yc4AG4LQbQ9", {
        availability: {
          proposedStartIso: "2026-05-03T14:00:00.000Z",
          proposedEndIso: "2026-05-03T15:00:00.000Z",
          matches: 1,
          conflicts: 1,
          conflictingJobs: [
            { jobId: 1, status: "active", startIso: "2026-05-03T13:30:00.000Z", endIso: "2026-05-03T16:00:00.000Z" }
          ]
        }
      });
      const calls: Array<{ managerId: string; durationMs: number; maxAgeSeconds: number }> = [];
      const discover = async (input: { managerId: string; durationMs: number; maxAgeSeconds: number }) => {
        calls.push(input);
        return relayPickProcessorInventory([available, conflicting]);
      };

      const text = await captureConsole(() =>
        runSwitchboardRelayPickProcessor(["relay-d", "--limit", "1"], runtimeWithoutLatestReport, {
          cwd: workDir,
          discover
        })
      );
      const json = JSON.parse(
        await captureConsole(() =>
          runSwitchboardRelayPickProcessor(
            ["relay", "pick-processor", "relay-d", "--json", "--include-conflicting"],
            runtimeWithoutLatestReport,
            { cwd: workDir, discover }
          )
        )
      ) as {
        relayId: string;
        managerId: string;
        availableProcessors: number;
        conflictingProcessors: number;
        available: Array<{ processor: string }>;
        conflicting: Array<{ processor: string }>;
      };

      assert.match(text, /relay-d\s+network=mainnet\s+manager=9470/u);
      assert.match(text, /Available \(heartbeat-fresh, schedule-clear\): 1/u);
      assert.match(text, /Pin one in:/u);
      assert.equal(json.relayId, "relay-d");
      assert.equal(json.managerId, "9470");
      assert.equal(json.availableProcessors, 1);
      assert.equal(json.conflictingProcessors, 1);
      assert.equal(json.available[0]?.processor, available.processor);
      assert.equal(json.conflicting[0]?.processor, conflicting.processor);
      assert.equal(calls.length, 2);
      assert.equal(calls[0]?.managerId, "9470");
      assert.equal(calls[0]?.durationMs, 3_600_000);
      assert.equal(calls[0]?.maxAgeSeconds, 900);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps relay pick-processor explicit local pin behavior unchanged", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-pick-pin-"));
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      const specFile = path.join(workDir, "relays", "relay-d.json");
      await writeFile(specFile, JSON.stringify(relayPickProcessorSpec(), null, 2), "utf8");
      const available = relayPickProcessor("5GrwvaEF5zXb26Fz9rcQpDWSm9Lro5nEtGhPYr8xSGWY5YHv");
      const conflicting = relayPickProcessor("5FHneW46xGXgs5mUiveU4sbTyGBzmst6m6p4Yc4AG4LQbQ9", {
        availability: {
          proposedStartIso: "2026-05-03T14:00:00.000Z",
          proposedEndIso: "2026-05-03T15:00:00.000Z",
          matches: 1,
          conflicts: 1,
          conflictingJobs: [
            { jobId: 1, status: "active", startIso: "2026-05-03T13:30:00.000Z", endIso: "2026-05-03T16:00:00.000Z" }
          ]
        }
      });
      const discover = async () => relayPickProcessorInventory([available, conflicting]);

      await captureConsole(() =>
        runSwitchboardRelayPickProcessor(["relay", "pick-processor", "relay-d", "--pin", "auto"], runtimeWithoutLatestReport, {
          cwd: workDir,
          discover
        })
      );
      let updated = JSON.parse(await readFile(specFile, "utf8")) as { acurast: { instantMatchProcessors?: string[] } };
      assert.deepEqual(updated.acurast.instantMatchProcessors, [available.processor]);

      await assert.rejects(
        runSwitchboardRelayPickProcessor(["relay-d", "--pin", conflicting.processor], runtimeWithoutLatestReport, {
          cwd: workDir,
          discover
        }),
        /refusing to pin.*1 schedule conflict.*--force/s
      );

      await captureConsole(() =>
        runSwitchboardRelayPickProcessor(["relay-d", "--pin", conflicting.processor, "--force"], runtimeWithoutLatestReport, {
          cwd: workDir,
          discover
        })
      );
      updated = JSON.parse(await readFile(specFile, "utf8")) as { acurast: { instantMatchProcessors?: string[] } };
      assert.deepEqual(updated.acurast.instantMatchProcessors, [conflicting.processor]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps relay pick-processor argument and spec errors unchanged", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-pick-errors-"));
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      await writeFile(
        path.join(workDir, "relays", "relay-d.json"),
        JSON.stringify(relayPickProcessorSpec(), null, 2),
        "utf8"
      );
      const noManagerSpec = relayPickProcessorSpec() as { acurast: { managerId?: string } };
      delete noManagerSpec.acurast.managerId;
      await writeFile(
        path.join(workDir, "relays", "relay-no-manager.json"),
        JSON.stringify(noManagerSpec, null, 2),
        "utf8"
      );
      await writeFile(
        path.join(workDir, "relays", "relay-a.json"),
        JSON.stringify({
          version: 1,
          relayId: "relay-a",
          target: "bootstrap",
          catalogState: "active",
          apiBaseUrl: "https://relay-a.example",
          peers: [],
          secrets: { relayerPrivateKeyEnv: "PROOF_MAINNET_RELAY_A_RECORDER_PRIVATE_KEY" },
          bootstrap: { composeService: "relay-a" }
        }),
        "utf8"
      );
      const discover = async () => relayPickProcessorInventory([]);

      await assert.rejects(
        runSwitchboardRelayPickProcessor([], runtimeWithoutLatestReport, { cwd: workDir, discover }),
        /Usage: switchboard relay pick-processor <relay-id>/
      );
      await assert.rejects(
        runSwitchboardRelayPickProcessor(["BadRelay"], runtimeWithoutLatestReport, { cwd: workDir, discover }),
        /Usage: switchboard relay pick-processor <relay-id>/
      );
      await assert.rejects(
        runSwitchboardRelayPickProcessor(["missing"], runtimeWithoutLatestReport, { cwd: workDir, discover }),
        /Spec .*relays\/missing\.json not found/
      );
      await assert.rejects(
        runSwitchboardRelayPickProcessor(["relay-a"], runtimeWithoutLatestReport, { cwd: workDir, discover }),
        /target=bootstrap.*only applies to acurast/
      );
      await assert.rejects(
        runSwitchboardRelayPickProcessor(["relay-no-manager"], runtimeWithoutLatestReport, { cwd: workDir, discover }),
        /no acurast\.managerId.*Add it/s
      );
      await assert.rejects(
        runSwitchboardRelayPickProcessor(["relay-d", "--pin", "bad"], runtimeWithoutLatestReport, { cwd: workDir, discover }),
        /--pin must be "auto" or a substrate ss58 address/
      );
      await assert.rejects(
        runSwitchboardRelayPickProcessor(["relay-d", "--pin", "auto"], runtimeWithoutLatestReport, { cwd: workDir, discover }),
        /--pin auto: no schedule-clear processor found under manager 9470/
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("exports a shared relay verify runner for native plugin reuse", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-verify-"));
    const originalFetch = globalThis.fetch;
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      await writeFile(
        path.join(workDir, "relays", "catalog.json"),
        JSON.stringify([
          { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "candidate" }
        ]),
        "utf8"
      );

      const relayCatalog = await signServiceCatalog(
        {
          version: 1,
          role: "relay",
          sequence: 43,
          issuedAt: "2030-05-01T12:00:00.000Z",
          expiresAt: "2030-05-02T12:00:00.000Z",
          members: [
            { serviceId: "relay-d", state: "candidate", apiBaseUrl: "https://relay-d.example" }
          ]
        },
        catalogSignerSeed,
        { scheme: "substrate-sr25519", ss58Format: 42 }
      );
      const manifest = testNetworkManifest("https://control.example", { ethRpcUrl: "http://127.0.0.1:9" });
      manifest.catalogs = {
        relays: {
          url: "https://control.example/v1/service-catalogs/relay",
          signer: relayCatalog.signature.signer,
          required: true
        }
      };
      const signedManifest = await signNetworkManifest(manifest, manifestSignerSeed, {
        scheme: "substrate-sr25519",
        ss58Format: 42
      });
      const manifestSigner = signedManifest.signature.signer;
      globalThis.fetch = (async (input) => {
        const url = String(input);
        if (url === "https://control.example/v1/network-manifest") {
          return new Response(JSON.stringify(signedManifest), { status: 200 });
        }
        if (url === "https://control.example/v1/service-catalogs/relay") {
          return new Response(JSON.stringify(relayCatalog), { status: 200 });
        }
        if (url === "https://relay-d.example/health") {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url === "https://relay-d.example/v1/relay-status") {
          return new Response(JSON.stringify({ relayId: "relay-d", peerBackfillEnabled: true }), { status: 200 });
        }
        if (url === "https://relay-d.example/v1/service-catalogs/relay") {
          return new Response(JSON.stringify({
            catalog: { role: "relay", members: [{ serviceId: "relay-d", state: "candidate" }] }
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as typeof fetch;

      await withWorkingDirectory(workDir, async () => {
        const args = [
          "relay-d",
          "--manifest-url",
          "https://control.example/v1/network-manifest",
          "--manifest-signer",
          manifestSigner
        ];
        const outputs = [
          await captureConsole(() => runSwitchboardRelayVerify(args, runtimeWithoutLatestReport)),
          await captureConsole(() =>
            runSwitchboardRelayVerify(["relay", "verify", ...args], runtimeWithoutLatestReport)
          )
        ];

        for (const output of outputs) {
          assert.match(output, /ok\s+local-catalog-entry\s+https:\/\/relay-d\.example state=candidate/u);
          assert.match(output, /ok\s+live-catalog-publish/u);
          assert.match(output, /relay relay-d: all checks passed/u);
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps relay verify failed-check and relay-id errors unchanged", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-verify-errors-"));
    const originalFetch = globalThis.fetch;
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      await writeFile(
        path.join(workDir, "relays", "catalog.json"),
        JSON.stringify([
          { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "candidate" }
        ]),
        "utf8"
      );

      const relayCatalog = await signServiceCatalog(
        {
          version: 1,
          role: "relay",
          sequence: 43,
          issuedAt: "2030-05-01T12:00:00.000Z",
          expiresAt: "2030-05-02T12:00:00.000Z",
          members: [
            { serviceId: "relay-d", state: "candidate", apiBaseUrl: "https://relay-d.example" }
          ]
        },
        catalogSignerSeed,
        { scheme: "substrate-sr25519", ss58Format: 42 }
      );
      const manifest = testNetworkManifest("https://control.example", { ethRpcUrl: "http://127.0.0.1:9" });
      manifest.catalogs = {
        relays: {
          url: "https://control.example/v1/service-catalogs/relay",
          signer: relayCatalog.signature.signer,
          required: true
        }
      };
      const signedManifest = await signNetworkManifest(manifest, manifestSignerSeed, {
        scheme: "substrate-sr25519",
        ss58Format: 42
      });
      const manifestSigner = signedManifest.signature.signer;
      globalThis.fetch = (async (input) => {
        const url = String(input);
        if (url === "https://control.example/v1/network-manifest") {
          return new Response(JSON.stringify(signedManifest), { status: 200 });
        }
        if (url === "https://control.example/v1/service-catalogs/relay") {
          return new Response(JSON.stringify(relayCatalog), { status: 200 });
        }
        if (url === "https://relay-d.example/health") {
          return new Response(JSON.stringify({ ok: false }), { status: 503 });
        }
        if (url === "https://relay-d.example/v1/relay-status") {
          return new Response(JSON.stringify({ relayId: "relay-d", peerBackfillEnabled: true }), { status: 200 });
        }
        if (url === "https://relay-d.example/v1/service-catalogs/relay") {
          return new Response(JSON.stringify({
            catalog: { role: "relay", members: [{ serviceId: "relay-d", state: "candidate" }] }
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as typeof fetch;

      await withWorkingDirectory(workDir, async () => {
        const args = [
          "relay-d",
          "--manifest-url",
          "https://control.example/v1/network-manifest",
          "--manifest-signer",
          manifestSigner
        ];
        await captureConsole(async () => {
          await assert.rejects(
            runSwitchboardRelayVerify(args, runtimeWithoutLatestReport),
            /relay verify relay-d: 1 check\(s\) failed/
          );
        });
        await assert.rejects(
          runSwitchboardRelayVerify([], runtimeWithoutLatestReport),
          /Usage: switchboard relay verify <relay-id>/
        );
        await assert.rejects(
          runSwitchboardRelayVerify(["BadRelay"], runtimeWithoutLatestReport),
          /Usage: switchboard relay verify <relay-id>/
        );
      });
    } finally {
      globalThis.fetch = originalFetch;
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("exports a shared relay dns plan runner for native plugin reuse", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-dns-plan-"));
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      const specFile = path.join(workDir, "relays", "relay-d.json");
      await writeFile(specFile, JSON.stringify(relayDnsSpec(), null, 2), "utf8");
      const calls: Array<{ customerHostname: string; expectedTarget: string; resolvers?: string[] }> = [];
      const validateCnameTarget = async (input: { customerHostname: string; expectedTarget: string; resolvers?: string[] }) => {
        calls.push(input);
        return {
          ok: true,
          customerHostname: input.customerHostname,
          expectedTarget: input.expectedTarget,
          results: (input.resolvers ?? []).map((resolver) => ({
            resolver,
            ok: true,
            chain: [input.customerHostname, input.expectedTarget]
          }))
        };
      };

      const outputs = [
        await captureConsole(() =>
          runSwitchboardRelayDnsPlan(["relay-d", "--spec", specFile], runtimeWithoutLatestReport, {
            cwd: workDir,
            env: {},
            validateCnameTarget
          })
        ),
        await captureConsole(() =>
          runSwitchboardRelayDnsPlan(["relay", "dns", "plan", "relay-d", "--spec-file", specFile], runtimeWithoutLatestReport, {
            cwd: workDir,
            env: {},
            validateCnameTarget
          })
        )
      ];

      for (const output of outputs) {
        assert.match(output, /relay dns plan relay-d/u);
        assert.match(output, /hostname\s+: relay-d\.switchboard\.proof\.computer/u);
        assert.match(output, /cnameTarget\s+: gateway\.switchboard\.proof\.computer/u);
        assert.match(output, /current state: ok/u);
      }
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0]?.resolvers, ["1.1.1.1", "8.8.8.8"]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps relay dns plan no-dns no-op behavior without Cloudflare credentials", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-dns-plan-nodns-"));
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      const spec = relayDnsSpec();
      delete (spec as { dns?: unknown }).dns;
      await writeFile(path.join(workDir, "relays", "relay-d.json"), JSON.stringify(spec, null, 2), "utf8");
      let validationCalls = 0;
      const output = await captureConsole(() =>
        runSwitchboardRelayDnsPlan(["relay-d"], runtimeWithoutLatestReport, {
          cwd: workDir,
          env: {},
          validateCnameTarget: async () => {
            validationCalls += 1;
            throw new Error("unexpected validation");
          }
        })
      );

      assert.match(output, /no dns block in spec/u);
      assert.equal(validationCalls, 0);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("exports a shared relay dns verify runner with injected DNS validation", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-dns-verify-"));
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      const specFile = path.join(workDir, "relays", "relay-d.json");
      await writeFile(specFile, JSON.stringify(relayDnsSpec(), null, 2), "utf8");
      const calls: Array<{ customerHostname: string; expectedTarget: string; resolvers?: string[] }> = [];
      const validateCnameTarget = async (input: { customerHostname: string; expectedTarget: string; resolvers?: string[] }) => {
        calls.push(input);
        return {
          ok: true,
          customerHostname: input.customerHostname,
          expectedTarget: input.expectedTarget,
          results: (input.resolvers ?? []).map((resolver) => ({
            resolver,
            ok: true,
            chain: [input.customerHostname, input.expectedTarget]
          }))
        };
      };
      const args = ["relay-d", "--spec", specFile, "--resolvers", "9.9.9.9,8.8.4.4"];
      const outputs = [
        await captureConsole(() =>
          runSwitchboardRelayDnsVerify(args, runtimeWithoutLatestReport, {
            cwd: workDir,
            env: {},
            validateCnameTarget
          })
        ),
        await captureConsole(() =>
          runSwitchboardRelayDnsVerify(["relay", "dns", "verify", ...args], runtimeWithoutLatestReport, {
            cwd: workDir,
            env: {},
            validateCnameTarget
          })
        )
      ];

      for (const output of outputs) {
        assert.match(output, /relay dns verify relay-d/u);
        assert.match(output, /hostname\s+: relay-d\.switchboard\.proof\.computer/u);
        assert.match(output, /expectedTgt\s+: gateway\.switchboard\.proof\.computer/u);
        assert.match(output, /9\.9\.9\.9: ok/u);
        assert.match(output, /8\.8\.4\.4: ok/u);
      }
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0]?.resolvers, ["9.9.9.9", "8.8.4.4"]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps relay dns verify drift failure and relay spec errors unchanged", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-dns-errors-"));
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      await writeFile(path.join(workDir, "relays", "relay-d.json"), JSON.stringify(relayDnsSpec(), null, 2), "utf8");
      const mismatchFile = path.join(workDir, "relays", "relay-c.json");
      await writeFile(mismatchFile, JSON.stringify(relayDnsSpec({ relayId: "relay-c" }), null, 2), "utf8");
      const driftValidation = async (input: { customerHostname: string; expectedTarget: string; resolvers?: string[] }) => ({
        ok: false,
        customerHostname: input.customerHostname,
        expectedTarget: input.expectedTarget,
        results: [
          {
            resolver: "1.1.1.1",
            ok: false,
            chain: [input.customerHostname],
            error: "no CNAME record"
          }
        ]
      });

      await captureConsole(async () => {
        await assert.rejects(
          runSwitchboardRelayDnsVerify(["relay-d"], runtimeWithoutLatestReport, {
            cwd: workDir,
            env: {},
            validateCnameTarget: driftValidation
          }),
          /relay dns verify relay-d: drift detected/
        );
      });
      await assert.rejects(
        runSwitchboardRelayDnsPlan([], runtimeWithoutLatestReport, { cwd: workDir, env: {} }),
        /relay dns plan <relay-id>: relay-id must be lowercase/
      );
      await assert.rejects(
        runSwitchboardRelayDnsPlan(["BadRelay"], runtimeWithoutLatestReport, { cwd: workDir, env: {} }),
        /relay dns plan <relay-id>: relay-id must be lowercase/
      );
      await assert.rejects(
        runSwitchboardRelayDnsVerify(["missing"], runtimeWithoutLatestReport, { cwd: workDir, env: {} }),
        /Spec .*relays\/missing\.json not found/
      );
      await assert.rejects(
        runSwitchboardRelayDnsVerify(["relay-d", "--spec", mismatchFile], runtimeWithoutLatestReport, { cwd: workDir, env: {} }),
        /declares relayId=relay-c, but command was invoked for relay-d/
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("exports a shared relay budget runner for native plugin reuse", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-budget-"));
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      const specFile = path.join(workDir, "relays", "relay-d.json");
      await writeFile(
        specFile,
        JSON.stringify({
          version: 1,
          relayId: "relay-d",
          target: "acurast",
          catalogState: "candidate",
          apiBaseUrl: "https://relay-d.example",
          peers: [],
          secrets: {
            relayerPrivateKeyEnv: "PROOF_RELAY_D_RELAYER_PRIVATE_KEY"
          },
          acurast: {
            deployerSeedEnv: "RELAY_D_SEED",
            projectName: "relay-d",
            stageDir: ".switchboard/relays/relay-d",
            maxCostPerExecution: "40000000000",
            includeEnv: []
          }
        }),
        "utf8"
      );

      await withWorkingDirectory(workDir, async () => {
        const textOutputs = [
          await captureConsole(() =>
            runSwitchboardRelayBudget(["7d", "--rate-per-ms", "20000", "--margin-percent", "10"], runtimeWithoutLatestReport)
          ),
          await captureConsole(() =>
            runSwitchboardRelayBudget(
              ["relay", "budget", "7d", "--rate-per-ms", "20000", "--margin-percent", "10"],
              runtimeWithoutLatestReport
            )
          )
        ];
        assert.equal(textOutputs[0], textOutputs[1]);
        assert.match(textOutputs[0], /duration\s+: 1w \(604800000ms\)/u);
        assert.match(textOutputs[0], /rate per ms\s+: 20000 units/u);
        assert.match(textOutputs[0], /margin\s+: 10%/u);
        assert.match(textOutputs[0], /recommended max cost : 13305600000000 units/u);

        const jsonOutputs = [
          JSON.parse(await captureConsole(() =>
            runSwitchboardRelayBudget(["7d", "--rate-per-ms", "20000", "--margin-percent", "10", "--json"], runtimeWithoutLatestReport)
          )),
          JSON.parse(await captureConsole(() =>
            runSwitchboardRelayBudget(
              ["relay", "budget", "7d", "--rate-per-ms", "20000", "--margin-percent", "10", "--json"],
              runtimeWithoutLatestReport
            )
          ))
        ] as Array<{
          duration: string;
          durationMs: number;
          ratePerMs: string;
          marginPercent: number;
          baseCost: string;
          recommendedMaxCost: string;
        }>;
        assert.deepEqual(jsonOutputs[0], jsonOutputs[1]);
        assert.equal(jsonOutputs[0].duration, "7d");
        assert.equal(jsonOutputs[0].durationMs, 604_800_000);
        assert.equal(jsonOutputs[0].ratePerMs, "20000");
        assert.equal(jsonOutputs[0].baseCost, "12096000000000");
        assert.equal(jsonOutputs[0].recommendedMaxCost, "13305600000000");

        const updateOutput = await captureConsole(() =>
          runSwitchboardRelayBudget(["relay", "budget", "7d", "--update", specFile], runtimeWithoutLatestReport)
        );
        assert.match(updateOutput, /Updated .*relay-d\.json: executionMs=604800000, maxCostPerExecution=6719932800000/u);
        const updated = JSON.parse(await readFile(specFile, "utf8")) as {
          acurast: { executionMs?: number; maxCostPerExecution?: string };
        };
        assert.equal(updated.acurast.executionMs, 604_800_000);
        assert.equal(updated.acurast.maxCostPerExecution, "6719932800000");
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps relay budget argument and update errors unchanged", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-budget-errors-"));
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      const specFile = path.join(workDir, "relays", "relay-a.json");
      await writeFile(specFile, JSON.stringify({ version: 1, relayId: "relay-a", target: "bootstrap" }), "utf8");

      await withWorkingDirectory(workDir, async () => {
        await assert.rejects(
          runSwitchboardRelayBudget([], runtimeWithoutLatestReport),
          /Usage: switchboard relay budget <duration>/
        );
        await assert.rejects(
          runSwitchboardRelayBudget(["1month"], runtimeWithoutLatestReport),
          /Invalid duration/
        );
        await assert.rejects(
          runSwitchboardRelayBudget(["1h", "--rate-per-ms", "bad"], runtimeWithoutLatestReport),
          /--rate-per-ms must be a non-negative integer/
        );
        await assert.rejects(
          runSwitchboardRelayBudget(["1h", "--margin-percent", "bad"], runtimeWithoutLatestReport),
          /--margin-percent must be a non-negative integer/
        );
        await assert.rejects(
          runSwitchboardRelayBudget(["1h", "--margin-percent", "1001"], runtimeWithoutLatestReport),
          /--margin-percent must be between 0 and 1000/
        );
        await assert.rejects(
          runSwitchboardRelayBudget(["relay", "budget", "7d", "--update", specFile], runtimeWithoutLatestReport),
          /only works for acurast specs/
        );
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("exports a shared relay logs runner for encrypted log inspection", async () => {
    await withCleanRelayLogsEnv(async () => {
      const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-logs-"));
      const originalFetch = globalThis.fetch;
      const requests: Array<{ url: string; authorization: string | null }> = [];
      try {
        await mkdir(path.join(workDir, ".switchboard", "relays"), { recursive: true });
        await writeFile(
          path.join(workDir, ".switchboard", "relays", "relay-d.log-sink.json"),
          JSON.stringify({
            relayId: "relay-d",
            sinkId: "sink-relay-d",
            writeUrl: "https://control.example/v1/log-sinks/sink-relay-d/events",
            readUrl: "https://control.example/v1/log-sinks/sink-relay-d/events?direction=read",
            readToken: "saved-read-token",
            encryptionKey: relayLogsEncryptionKey,
            createdAt: "2026-05-24T12:00:00.000Z"
          }),
          "utf8"
        );
        globalThis.fetch = (async (input, init) => {
          requests.push({
            url: String(input),
            authorization: (init?.headers as Record<string, string> | undefined)?.authorization ?? null
          });
          return new Response(
            JSON.stringify({
              events: [
                {
                  sequence: 1,
                  receivedAt: "2026-05-24T12:00:00.000Z",
                  encrypted: encryptProofLogRecord(relayLogsEncryptionKey, {
                    timestamp: "2026-05-24T12:00:00.000Z",
                    event: "relay-boot",
                    message: "boot"
                  })
                },
                {
                  sequence: 2,
                  receivedAt: "2026-05-24T12:00:01.000Z",
                  encrypted: encryptProofLogRecord(relayLogsEncryptionKey, {
                    timestamp: "2026-05-24T12:00:01.000Z",
                    event: "relay-ready",
                    message: "ready"
                  })
                }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }) as typeof fetch;

        await withWorkingDirectory(workDir, async () => {
          const textOutputs = [
            await captureConsole(() => runSwitchboardRelayLogs(["relay-d", "--limit", "1"], runtimeWithoutLatestReport)),
            await captureConsole(() =>
              runSwitchboardRelayLogs(["relay", "logs", "relay-d", "--limit", "1"], runtimeWithoutLatestReport)
            )
          ];
          assert.equal(textOutputs[0], textOutputs[1]);
          assert.match(textOutputs[0], /1 event\(s\) for relay-d/u);
          assert.doesNotMatch(textOutputs[0], /boot/u);
          assert.match(textOutputs[0], /#2.*ready/u);

          const jsonOutputs = [
            JSON.parse(await captureConsole(() => runSwitchboardRelayLogs(["relay-d", "--json"], runtimeWithoutLatestReport))),
            JSON.parse(await captureConsole(() =>
              runSwitchboardRelayLogs(["relay", "logs", "relay-d", "--json"], runtimeWithoutLatestReport)
            ))
          ] as Array<Array<{ sequence: number; message: string }>>;
          assert.deepEqual(jsonOutputs[0], jsonOutputs[1]);
          assert.deepEqual(jsonOutputs[0].map((event) => [event.sequence, event.message]), [
            [1, "boot"],
            [2, "ready"]
          ]);
        });

        assert.deepEqual(
          requests.map((request) => [request.url, request.authorization]),
          [
            ["https://control.example/v1/log-sinks/sink-relay-d/events?direction=read", "Bearer saved-read-token"],
            ["https://control.example/v1/log-sinks/sink-relay-d/events?direction=read", "Bearer saved-read-token"],
            ["https://control.example/v1/log-sinks/sink-relay-d/events?direction=read", "Bearer saved-read-token"],
            ["https://control.example/v1/log-sinks/sink-relay-d/events?direction=read", "Bearer saved-read-token"]
          ]
        );
      } finally {
        globalThis.fetch = originalFetch;
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  it("keeps relay logs flag/env precedence and errors unchanged", async () => {
    await withCleanRelayLogsEnv(async () => {
      const originalFetch = globalThis.fetch;
      const requests: Array<{ url: string; authorization: string | null }> = [];
      try {
        process.env.PROOF_LOG_READ_URL = "https://env.example/v1/log-sinks/env/events";
        process.env.PROOF_LOG_READ_TOKEN = "env-token";
        process.env.SWITCHBOARD_LOG_ENCRYPTION_KEY = relayLogsEncryptionKey;
        process.env.CUSTOM_LOG_TOKEN = "custom-token";
        process.env.CUSTOM_LOG_KEY = relayLogsEncryptionKey;
        globalThis.fetch = (async (input, init) => {
          requests.push({
            url: String(input),
            authorization: (init?.headers as Record<string, string> | undefined)?.authorization ?? null
          });
          return new Response(JSON.stringify({ events: [] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }) as typeof fetch;

        const output = await captureConsole(() =>
          runSwitchboardRelayLogs(
            [
              "--json",
              "--read-url",
              "https://flag.example/v1/log-sinks/flag/events",
              "--read-token-env",
              "CUSTOM_LOG_TOKEN",
              "--encryption-key-env",
              "CUSTOM_LOG_KEY"
            ],
            runtimeWithoutLatestReport
          )
        );
        assert.deepEqual(JSON.parse(output), []);
        assert.deepEqual(requests, [
          {
            url: "https://flag.example/v1/log-sinks/flag/events",
            authorization: "Bearer custom-token"
          }
        ]);

        delete process.env.PROOF_LOG_READ_URL;
        await assert.rejects(
          runSwitchboardRelayLogs(["relay-d"], runtimeWithoutLatestReport),
          /relay logs requires --read-url/
        );
        await assert.rejects(
          runSwitchboardRelayLogs(["BadRelay", "--read-url", "https://control.example/events"], runtimeWithoutLatestReport),
          /Invalid relay id/
        );
        delete process.env.SWITCHBOARD_LOG_ENCRYPTION_KEY;
        await assert.rejects(
          runSwitchboardRelayLogs(["--read-url", "https://control.example/events"], runtimeWithoutLatestReport),
          /relay logs requires --encryption-key-env/
        );
        process.env.SWITCHBOARD_LOG_ENCRYPTION_KEY = relayLogsEncryptionKey;
        await assert.rejects(
          runSwitchboardRelayLogs(["--read-url", "https://control.example/events", "--timeout-ms", "NaN"], runtimeWithoutLatestReport),
          /--timeout-ms must be a non-negative integer/
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("exports a shared relay watch runner for native plugin reuse", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-watch-"));
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      await writeFile(
        path.join(workDir, "relays", "catalog.json"),
        JSON.stringify([
          { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "active" },
          { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "candidate" }
        ]),
        "utf8"
      );

      const lines: string[] = [];
      const watchOptions = {
        cwd: workDir,
        io: {
          log: (line: string) => lines.push(line),
          warn: (line: string) => lines.push(`warn:${line}`),
          error: (line: string) => lines.push(`error:${line}`)
        },
        fetchImpl: relayWatchFetch(),
        sleep: async () => undefined,
        now: () => 0
      };

      await runSwitchboardRelayWatch(
        ["relay-a", "--max-runs", "1", "--interval-ms", "5000"],
        runtimeWithoutLatestReport,
        watchOptions
      );
      await runSwitchboardRelayWatch(
        ["relay", "watch", "relay-d", "--max-runs", "1", "--interval-ms", "5000"],
        runtimeWithoutLatestReport,
        watchOptions
      );

      assert.equal(lines.length, 2);
      assert.match(lines[0], /^1970-01-01T00:00:00.000Z\s+relay-a\s+initial=ok\s+ok/u);
      assert.match(lines[1], /^1970-01-01T00:00:00.000Z\s+relay-d\s+initial=fail\s+health=503/u);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps relay watch interval and catalog errors unchanged", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-watch-errors-"));
    try {
      await mkdir(path.join(workDir, "relays"), { recursive: true });
      await writeFile(
        path.join(workDir, "relays", "catalog.json"),
        JSON.stringify([
          { relayId: "relay-a", apiBaseUrl: "https://relay-a.example", state: "active" },
          { relayId: "relay-d", apiBaseUrl: "https://relay-d.example", state: "candidate" }
        ]),
        "utf8"
      );

      const lines: string[] = [];
      const sleeps: number[] = [];
      const watchOptions = {
        cwd: workDir,
        io: {
          log: (line: string) => lines.push(line),
          warn: (line: string) => lines.push(`warn:${line}`),
          error: (line: string) => lines.push(`error:${line}`)
        },
        fetchImpl: relayWatchFetch(),
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        now: () => 0
      };

      await runSwitchboardRelayWatch(
        ["--max-runs", "2", "--interval-ms", "123"],
        runtimeWithoutLatestReport,
        watchOptions
      );

      assert.deepEqual(sleeps, [123]);
      assert.equal(lines.length, 2);
      assert.equal(lines.filter((line) => line.includes("initial=ok")).length, 1);
      assert.equal(lines.filter((line) => line.includes("initial=fail")).length, 1);
      await assert.rejects(
        runSwitchboardRelayWatch(["BadRelay"], runtimeWithoutLatestReport, watchOptions),
        /Invalid relay id/
      );
      await assert.rejects(
        runSwitchboardRelayWatch(["relay-missing"], runtimeWithoutLatestReport, watchOptions),
        /relay relay-missing not in catalog/
      );
      await assert.rejects(
        runSwitchboardRelayWatch(["--max-runs", "1"], runtimeWithoutLatestReport, {
          ...watchOptions,
          cwd: path.join(workDir, "empty")
        }),
        /Could not read a relay catalog file/
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("exports a shared relay whoami runner for local env/spec diagnostics", async () => {
    await withCleanRelayWhoamiEnv(async () => {
      const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-whoami-"));
      try {
        await mkdir(path.join(workDir, "relays"), { recursive: true });
        await writeFile(
          path.join(workDir, "relays", "relay-d.json"),
          JSON.stringify({
            version: 1,
            relayId: "relay-d",
            target: "acurast",
            catalogState: "candidate",
            apiBaseUrl: "https://relay-d.example",
            peers: [],
            secrets: {
              relayerPrivateKeyEnv: "PROOF_RELAY_D_RELAYER_PRIVATE_KEY"
            },
            acurast: {
              deployerSeedEnv: "RELAY_D_SEED",
              projectName: "relay-d",
              stageDir: ".switchboard/relays/relay-d",
              maxCostPerExecution: 1,
              includeEnv: []
            }
          }),
          "utf8"
        );
        process.env.RELAY_D_SEED = relayWhoamiSeed;

        await withWorkingDirectory(workDir, async () => {
          const initial = JSON.parse(
            await captureConsole(() => runSwitchboardRelayWhoami(["relay-d", "--json"], runtimeWithoutLatestReport))
          ) as { derivedAddressGeneric: string; seedEnvName: string; matches: string };
          process.env.ACURAST_MAINNET_ADDRESS = initial.derivedAddressGeneric;

          const outputs = [
            JSON.parse(await captureConsole(() =>
              runSwitchboardRelayWhoami(["relay-d", "--json"], runtimeWithoutLatestReport)
            )),
            JSON.parse(await captureConsole(() =>
              runSwitchboardRelayWhoami(["relay", "whoami", "relay-d", "--json"], runtimeWithoutLatestReport)
            ))
          ] as Array<{
            network: string;
            seedEnvName: string;
            addressEnvName: string;
            derivedAddressGeneric: string;
            derivedAddressPolkadot: string;
            configuredAddress: string;
            matches: boolean;
          }>;

          for (const output of outputs) {
            assert.equal(output.network, "mainnet");
            assert.equal(output.seedEnvName, "RELAY_D_SEED");
            assert.equal(output.addressEnvName, "ACURAST_MAINNET_ADDRESS");
            assert.equal(output.configuredAddress, initial.derivedAddressGeneric);
            assert.equal(output.matches, true);
            assert.match(output.derivedAddressGeneric, /^5/u);
            assert.match(output.derivedAddressPolkadot, /^1/u);
          }

          const text = await captureConsole(() =>
            runSwitchboardRelayWhoami(["relay", "whoami", "relay-d"], runtimeWithoutLatestReport)
          );
          assert.match(text, /seed derives the configured address/u);
        });
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  it("keeps relay whoami seed and network errors unchanged", async () => {
    await withCleanRelayWhoamiEnv(async () => {
      const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-whoami-errors-"));
      try {
        await mkdir(path.join(workDir, "relays"), { recursive: true });
        const specFile = path.join(workDir, "relays", "relay-d.json");
        await writeFile(
          specFile,
          JSON.stringify({
            version: 1,
            relayId: "relay-d",
            target: "acurast",
            catalogState: "candidate",
            apiBaseUrl: "https://relay-d.example",
            peers: [],
            secrets: {
              relayerPrivateKeyEnv: "PROOF_RELAY_D_RELAYER_PRIVATE_KEY"
            },
            acurast: {
              deployerSeedEnv: "RELAY_D_SEED",
              projectName: "relay-d",
              stageDir: ".switchboard/relays/relay-d",
              maxCostPerExecution: 1,
              includeEnv: []
            }
          }),
          "utf8"
        );

        await withWorkingDirectory(workDir, async () => {
          await assert.rejects(
            runSwitchboardRelayWhoami(["relay-d"], runtimeWithoutLatestReport),
            /Seed env RELAY_D_SEED is not set/
          );

          process.env.RELAY_D_SEED = "not a mnemonic";
          await assert.rejects(
            runSwitchboardRelayWhoami(["relay", "whoami", "relay-d"], runtimeWithoutLatestReport),
            /RELAY_D_SEED is not a valid 12\/24-word BIP-39 mnemonic/
          );

          process.env.RELAY_D_SEED = relayWhoamiSeed;
          await assert.rejects(
            runSwitchboardRelayWhoami(["relay-d", "--network", "bogus"], runtimeWithoutLatestReport),
            /--network must be mainnet or canary/
          );
          await assert.rejects(
            runSwitchboardRelayWhoami(["--spec", specFile, "--network", "bogus"], runtimeWithoutLatestReport),
            /--network must be mainnet or canary/
          );
        });
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  it("exports a shared relay status runner for native plugin reuse", async () => {
    await withRelayStatusServer(async ({ baseUrl }) => {
      const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-status-"));
      try {
        const catalogFile = path.join(workDir, "relays.json");
        await writeFile(
          catalogFile,
          JSON.stringify([
            { relayId: "relay-a", apiBaseUrl: baseUrl, state: "active" },
            { relayId: "relay-b", apiBaseUrl: "http://127.0.0.1:9", state: "candidate" }
          ]),
          "utf8"
        );
        const args = ["relay-a", "--catalog-file", catalogFile, "--timeout-ms", "500"];
        const bare = await captureConsoleAndExitCode(() =>
          runSwitchboardRelayStatus(args, runtimeWithoutLatestReport)
        );
        const prefixed = await captureConsoleAndExitCode(() =>
          runSwitchboardRelayStatus(["relay", "status", ...args], runtimeWithoutLatestReport)
        );

        for (const result of [bare, prefixed]) {
          assert.equal(result.exitCode, undefined);
          assert.match(result.stdout, /Probing 1 relay/u);
          assert.match(result.stdout, /relay relay-a \(active\)/u);
          assert.match(result.stdout, /health: ok/u);
          assert.match(result.stdout, /relay-status: ok/u);
          assert.match(result.stdout, /service-catalogs\/relay: ok/u);
          assert.match(result.stdout, /catalog members: relay-a=active/u);
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  it("keeps relay status failure exit-code behavior unchanged", async () => {
    await withRelayStatusServer({ failHealth: true }, async ({ baseUrl }) => {
      const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-status-fail-"));
      try {
        const catalogFile = path.join(workDir, "relays.json");
        await writeFile(
          catalogFile,
          JSON.stringify([{ relayId: "relay-a", apiBaseUrl: baseUrl, state: "active" }]),
          "utf8"
        );
        const result = await captureConsoleAndExitCode(() =>
          runSwitchboardRelayStatus(
            ["relay", "status", "relay-a", "--catalog-file", catalogFile, "--timeout-ms", "500"],
            runtimeWithoutLatestReport
          )
        );

        assert.equal(result.exitCode, 1);
        assert.match(result.stdout, /health: FAIL \(http=503/u);
        assert.match(result.stdout, /relay-status: ok/u);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  it("keeps relay status catalog and relay-id errors unchanged", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-status-errors-"));
    try {
      const catalogFile = path.join(workDir, "relays.json");
      await writeFile(
        catalogFile,
        JSON.stringify([{ relayId: "relay-a", apiBaseUrl: "http://127.0.0.1:9", state: "active" }]),
        "utf8"
      );

      await assert.rejects(
        runSwitchboardRelayStatus(["--catalog-file", path.join(workDir, "missing.json")], runtimeWithoutLatestReport),
        /Could not read a relay catalog file/
      );
      await assert.rejects(
        runSwitchboardRelayStatus(["BadRelay", "--catalog-file", catalogFile], runtimeWithoutLatestReport),
        /Invalid relay id/
      );
      await assert.rejects(
        runSwitchboardRelayStatus(["relay-missing", "--catalog-file", catalogFile], runtimeWithoutLatestReport),
        /relay relay-missing not found/
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps catalog inspect validation and verification errors unchanged", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-catalog-inspect-errors-"));
    try {
      const expected = await signServiceCatalog(nativeRunnerRelayCatalog(), catalogSignerSeed, {
        scheme: "substrate-sr25519",
        ss58Format: 42
      });
      const wrong = await signServiceCatalog(nativeRunnerRelayCatalog(), otherCatalogSignerSeed, {
        scheme: "substrate-sr25519",
        ss58Format: 42
      });
      const expired = await signServiceCatalog(
        { ...nativeRunnerRelayCatalog(), expiresAt: "2020-01-01T00:00:00.000Z" },
        catalogSignerSeed,
        { scheme: "substrate-sr25519", ss58Format: 42 }
      );
      const wrongFile = path.join(workDir, "wrong.json");
      const expiredFile = path.join(workDir, "expired.json");
      await writeFile(wrongFile, JSON.stringify(wrong), "utf8");
      await writeFile(expiredFile, JSON.stringify(expired), "utf8");

      await assert.rejects(
        runSwitchboardCatalogInspect([], runtimeWithoutLatestReport),
        /requires --file <path> or --url <url>/
      );
      await assert.rejects(
        runSwitchboardCatalogInspect(["--file", wrongFile, "--url", "https://catalog.example"], runtimeWithoutLatestReport),
        /accepts --file or --url, not both/
      );
      await assert.rejects(
        runSwitchboardCatalogInspect(["--file", wrongFile, "--signer", expected.signature.signer], runtimeWithoutLatestReport),
        /does not match expected signer/
      );
      await assert.rejects(
        runSwitchboardCatalogInspect(["catalog", "inspect", "--file", expiredFile], runtimeWithoutLatestReport),
        /expired/
      );

      const accepted = JSON.parse(
        await captureConsole(() =>
          runSwitchboardCatalogInspect(["--file", expiredFile, "--allow-expired", "--json"], runtimeWithoutLatestReport)
        )
      );
      assert.equal(accepted[0].expired, true);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("exports a shared catalog verify runner for native plugin reuse", async () => {
    await withCatalogDiscoveryServer(async ({ manifestUrl, manifestSigner, requests }) => {
      const args = [
        "--json",
        "--manifest-url",
        manifestUrl,
        "--manifest-signer",
        manifestSigner,
        "--required",
        "relays,control-api"
      ];
      const bare = await captureConsole(() => runSwitchboardCatalogVerify(args, runtimeWithoutLatestReport));
      const prefixed = await captureConsole(() =>
        runSwitchboardCatalogVerify(["catalog", "verify", ...args], runtimeWithoutLatestReport)
      );

      for (const output of [JSON.parse(bare), JSON.parse(prefixed)]) {
        assert.equal(output.ok, true);
        assert.equal(output.manifestUrl, manifestUrl);
        assert.equal(output.manifestSigner, manifestSigner);
        assert.deepEqual(output.requiredCatalogs, ["relays", "control-api"]);
        assert.deepEqual(
          output.catalogs.map((catalog: Record<string, unknown>) => catalog.role).sort(),
          ["control-api", "relay"]
        );
        const relayCatalog = output.catalogs.find((catalog: Record<string, unknown>) => catalog.role === "relay");
        assert.equal(relayCatalog?.activeMemberCount, 1);
      }
      assert.deepEqual(requests, [
        "GET /v1/network-manifest",
        "GET /v1/service-catalogs/relay",
        "GET /v1/service-catalogs/control-api",
        "GET /v1/network-manifest",
        "GET /v1/service-catalogs/relay",
        "GET /v1/service-catalogs/control-api"
      ]);
    });
  });

  it("keeps catalog verify manifest URL and pinned-signer errors unchanged", async () => {
    await withCleanCatalogVerifyEnv(async () => {
      await assert.rejects(
        runSwitchboardCatalogVerify([], runtimeWithoutLatestReport),
        /requires --manifest-url <url> or PROOF_NETWORK_MANIFEST_URL set/
      );
      await assert.rejects(
        runSwitchboardCatalogVerify(["catalog", "verify", "--manifest-url", "https://control.example/v1/network-manifest"], runtimeWithoutLatestReport),
        /Pin --manifest-signer <signer>/
      );
    });
  });

  it("exports a shared relay sync runner for local inventory bootstrap", async () => {
    await withCatalogDiscoveryServer(async ({ manifestUrl, manifestSigner }) => {
      const baseArgs = ["--manifest-url", manifestUrl, "--manifest-signer", manifestSigner];
      for (const argv of [baseArgs, ["relay", "sync", ...baseArgs]]) {
        const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-sync-"));
        try {
          await mkdir(path.join(workDir, "relays"), { recursive: true });
          await writeFile(
            path.join(workDir, "relays", "relay-d.json"),
            JSON.stringify({
              relayId: "relay-d",
              target: "acurast",
              apiBaseUrl: "https://locally-edited.example",
              localOnly: true
            }),
            "utf8"
          );

          await captureConsole(() =>
            runSwitchboardRelaySync(argv, runtimeWithoutLatestReport, { cwd: workDir })
          );

          const catalog = JSON.parse(await readFile(path.join(workDir, "relays", "catalog.json"), "utf8")) as Array<{
            relayId: string;
            apiBaseUrl: string;
            state: string;
          }>;
          assert.deepEqual(catalog.map((entry) => [entry.relayId, entry.apiBaseUrl, entry.state]), [
            ["relay-a", "https://relay-a.example", "active"],
            ["relay-d", "https://relay-d.example", "candidate"]
          ]);

          const relayA = JSON.parse(await readFile(path.join(workDir, "relays", "relay-a.json"), "utf8")) as Record<string, unknown>;
          assert.equal(relayA.relayId, "relay-a");
          assert.equal(relayA.target, "bootstrap");
          assert.equal(relayA.catalogState, "active");
          assert.equal((relayA.secrets as Record<string, unknown>).relayerPrivateKeyEnv, "PROOF_MAINNET_RELAY_A_RECORDER_PRIVATE_KEY");
          assert.match(String(relayA._stub), /Generated by `switchboard relay sync`/u);

          const relayD = JSON.parse(await readFile(path.join(workDir, "relays", "relay-d.json"), "utf8")) as Record<string, unknown>;
          assert.equal(relayD.apiBaseUrl, "https://locally-edited.example");
          assert.equal(relayD.localOnly, true);
        } finally {
          await rm(workDir, { recursive: true, force: true });
        }
      }
    });
  });

  it("keeps relay sync dry-run and injected env discovery behavior testable", async () => {
    const { manifestUrl, manifestSigner, fetchImpl, requests } = await relaySyncDiscoveryFixture();
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-sync-dry-run-"));
    try {
      const lines: string[] = [];
      await runSwitchboardRelaySync(["--dry-run"], runtimeWithoutLatestReport, {
        cwd: workDir,
        env: {
          PROOF_NETWORK_MANIFEST_URL: manifestUrl,
          PROOF_NETWORK_MANIFEST_SIGNER: manifestSigner
        },
        fetchImpl,
        io: {
          log: (line: string) => lines.push(line),
          warn: (line: string) => lines.push(`warn:${line}`),
          error: (line: string) => lines.push(`error:${line}`)
        }
      });

      assert.deepEqual(requests, [
        manifestUrl,
        "https://catalog.example/v1/service-catalogs/relay"
      ]);
      assert.match(lines.join("\n"), /Dry run/u);
      assert.match(lines.join("\n"), /would write .*relays\/catalog\.json/u);
      await assert.rejects(
        stat(path.join(workDir, "relays", "catalog.json")),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("uses runtime context manifest defaults for relay sync", async () => {
    const { manifestUrl, manifestSigner, fetchImpl } = await relaySyncDiscoveryFixture();
    const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-relay-sync-context-"));
    try {
      await runSwitchboardRelaySync(
        ["--dry-run"],
        {
          ...runtimeWithoutLatestReport,
          contextName: "mainnet",
          context: {
            manifestUrl,
            manifestSigner
          }
        },
        {
          cwd: workDir,
          env: {},
          fetchImpl,
          io: {
            log: () => undefined,
            warn: () => undefined,
            error: () => undefined
          }
        }
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("exports shared gateway runners while rejecting the removed operator topic", async () => {
    await assert.rejects(
      runSwitchboardGatewaySetup(["operator", "setup"], runtimeWithoutLatestReport),
      /Unknown command: gateway setup operator setup/
    );
    await assert.rejects(
      runSwitchboardGatewayDiscover(["operator", "discover"], runtimeWithoutLatestReport),
      /Unknown command: gateway discover operator discover/
    );
    await assert.rejects(
      runSwitchboardGatewayStatus(["operator", "status"], runtimeWithoutLatestReport),
      /Unknown command: gateway status operator status/
    );
    await assert.rejects(
      runSwitchboardGatewayUpgrade(["operator", "upgrade"], runtimeWithoutLatestReport),
      /Unknown command: gateway upgrade operator upgrade/
    );
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
        const yesStillReadOnly = await captureConsole(() => runSwitchboardClaimable([...args, "--yes"], runtimeWithoutLatestReport));

        for (const output of [JSON.parse(bare), JSON.parse(prefixed), JSON.parse(yesStillReadOnly)]) {
          assert.equal(output.action, "claimable");
          assert.equal(output.dryRun, true);
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

  it("exports a shared claim runner for native plugin reuse", async () => {
    await withCleanSignerEnv(async () => {
      await withAccountingServer({ claimableBalance: 1_250_000n }, async ({ manifestUrl, manifestSigner, rpcMethods }) => {
        const args = ["--json", "--recipient", recipientAddress, "--manifest-url", manifestUrl, "--manifest-signer", manifestSigner];
        const bare = await captureConsole(() => runSwitchboardClaim(args, runtimeWithoutLatestReport));
        const prefixed = await captureConsole(() => runSwitchboardClaim(["claim", ...args], runtimeWithoutLatestReport));

        for (const output of [JSON.parse(bare), JSON.parse(prefixed)]) {
          assert.equal(output.action, "claim");
          assert.equal(output.dryRun, true);
          assert.equal(output.target, "revive-local");
          assert.equal(output.registryAddress, ethers.getAddress(registryAddress));
          assert.equal(output.asset.address, ethers.getAddress(assetAddress));
          assert.equal(output.recipient, ethers.getAddress(recipientAddress));
          assert.equal(output.signer, undefined);
          assert.equal(output.claimable.raw, "1250000");
        }
        assert.equal(rpcMethods.some((method) => method.startsWith("eth_send")), false);
      });
    });
  });

  it("keeps claim submission signer guardrails unchanged", async () => {
    await withCleanSignerEnv(async () => {
      await withAccountingServer({ claimableBalance: 1_250_000n }, async ({ manifestUrl, manifestSigner }) => {
        const manifestArgs = ["--manifest-url", manifestUrl, "--manifest-signer", manifestSigner];

        await assert.rejects(
          runSwitchboardClaim(["--yes", "--recipient", recipientAddress, ...manifestArgs], runtimeWithoutLatestReport),
          /Missing claim\/refund signer/
        );

        await assert.rejects(
          runSwitchboardClaim(
            [
              "claim",
              "--yes",
              "--recipient",
              recipientAddress,
              "--claim-private-key",
              hostnameDeveloperPrivateKey,
              ...manifestArgs
            ],
            runtimeWithoutLatestReport
          ),
          /not claim recipient/
        );
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
        const yesStillReadOnly = await captureConsole(() => runSwitchboardRefundable([...args, "--yes"], runtimeWithoutLatestReport));

        for (const output of [JSON.parse(bare), JSON.parse(prefixed), JSON.parse(sessionPrefixed), JSON.parse(yesStillReadOnly)]) {
          assert.equal(output.action, "refundable");
          assert.equal(output.dryRun, true);
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

  it("exports a shared refund runner for native plugin reuse", async () => {
    await withCleanSignerEnv(async () => {
      await withAccountingServer({ session: refundableSession() }, async ({ manifestUrl, manifestSigner, rpcMethods }) => {
        const args = ["--json", "--session-id", sessionId, "--manifest-url", manifestUrl, "--manifest-signer", manifestSigner];
        const bare = await captureConsole(() => runSwitchboardRefund(args, runtimeWithoutLatestReport));
        const prefixed = await captureConsole(() => runSwitchboardRefund(["refund", ...args], runtimeWithoutLatestReport));
        const sessionPrefixed = await captureConsole(() => runSwitchboardRefund(["session", "refund", ...args], runtimeWithoutLatestReport));

        for (const output of [JSON.parse(bare), JSON.parse(prefixed), JSON.parse(sessionPrefixed)]) {
          assert.equal(output.action, "refund");
          assert.equal(output.dryRun, true);
          assert.equal(output.target, "revive-local");
          assert.equal(output.registryAddress, ethers.getAddress(registryAddress));
          assert.equal(output.sessionId, sessionId);
          assert.equal(output.developer, ethers.getAddress(developerAddress));
          assert.equal(output.signer, undefined);
          assert.equal(output.refundable.raw, "4000000");
          assert.equal(output.refund.eligible, true);
          assert.equal(output.refund.callName, "refundAfterActivationTimeout");
        }
        assert.equal(rpcMethods.some((method) => method.startsWith("eth_send")), false);
      });
    });
  });

  it("keeps refund submission signer guardrails unchanged", async () => {
    await withCleanSignerEnv(async () => {
      await withAccountingServer({ session: refundableSession() }, async ({ manifestUrl, manifestSigner }) => {
        const manifestArgs = ["--manifest-url", manifestUrl, "--manifest-signer", manifestSigner];

        await assert.rejects(
          runSwitchboardRefund(["--yes", "--session-id", sessionId, ...manifestArgs], runtimeWithoutLatestReport),
          /No configured signer matches refund developer/
        );

        await assert.rejects(
          runSwitchboardRefund(
            [
              "session",
              "refund",
              "--yes",
              "--session-id",
              sessionId,
              "--hub-signer",
              "evm",
              "--developer-private-key",
              hostnameDeveloperPrivateKey,
              ...manifestArgs
            ],
            runtimeWithoutLatestReport
          ),
          /not refund developer/
        );
      });
    });
  });

  it("exports a shared hostname add runner for native plugin reuse", async () => {
    await withCleanSignerEnv(async () => {
      await withHostnameMutationServer(async ({ baseUrl, manifestUrl, manifestSigner, requests }) => {
        const args = hostnameMutationArgs({
          baseUrl,
          manifestUrl,
          manifestSigner,
          extra: [
            "--tls-mode",
            "byo-certificate",
            "--certificate-validation-mode",
            "dns01-manual",
            "--wait-seconds",
            "1",
            "--poll-seconds",
            "1"
          ]
        });
        const bare = JSON.parse(
          await captureConsole(() =>
            runSwitchboardHostnameAdd(args, runtimeWithoutLatestReport, hostnameMutationAdapters())
          )
        );
        const prefixed = JSON.parse(
          await captureConsole(() =>
            runSwitchboardHostnameAdd(["hostname", "add", ...args], runtimeWithoutLatestReport, hostnameMutationAdapters())
          )
        );

        for (const output of [bare, prefixed]) {
          assert.equal(output.ok, true);
          assert.equal(output.status, "dns_validated");
          assert.equal(output.customerHostname, "app.example.com");
          assert.equal(output.endpointHostname, "demo.ingress.example");
          assert.equal(output.signer.kind, "evm");
          assert.equal(output.signer.address, new ethers.Wallet(hostnameDeveloperPrivateKey).address);
          assert.equal(output.dnsProviderHint.provider.name, "Example DNS");
        }

        const postRequests = requests.filter((request) => request.method === "POST");
        const statusRequests = requests.filter((request) => request.method === "GET" && request.url.includes("/customer-hostnames/"));
        assert.equal(postRequests.length, 2);
        assert.equal(statusRequests.length, 2);
        for (const request of postRequests) {
          assert.equal(request.url, "/v1/endpoints/demo.ingress.example/customer-hostnames");
          assert.equal(request.payload?.action, "attachCustomerHostname");
          assert.equal(request.payload?.endpointId, "demo.ingress.example");
          assert.equal(request.payload?.endpointHostname, "demo.ingress.example");
          assert.equal(request.payload?.customerHostname, "app.example.com");
          assert.equal(request.payload?.sessionId, sessionId);
          assert.equal(request.payload?.tlsMode, "byo-certificate");
          assert.equal(request.payload?.certificateValidationMode, "dns01-manual");
          assert.equal(request.payload?.signatureScheme, "eip712-secp256k1");
          assert.equal(request.payload?.signer, new ethers.Wallet(hostnameDeveloperPrivateKey).address);
          assert.equal((request.payload?.source as Record<string, unknown>)?.cli, "switchboard hostname add");
          assert.equal(typeof request.payload?.signature, "string");
        }
      });
    });
  });

  it("exports a shared hostname remove runner for native plugin reuse", async () => {
    await withCleanSignerEnv(async () => {
      await withHostnameMutationServer(async ({ baseUrl, manifestUrl, manifestSigner, requests }) => {
        const args = hostnameMutationArgs({
          baseUrl,
          manifestUrl,
          manifestSigner,
          extra: [
            "--deadline",
            "2000000000",
            "--nonce",
            "123"
          ]
        });
        const bare = JSON.parse(
          await captureConsole(() =>
            runSwitchboardHostnameRemove(args, runtimeWithoutLatestReport, hostnameMutationAdapters())
          )
        );
        const prefixed = JSON.parse(
          await captureConsole(() =>
            runSwitchboardHostnameRemove(["hostname", "remove", ...args], runtimeWithoutLatestReport, hostnameMutationAdapters())
          )
        );

        for (const output of [bare, prefixed]) {
          assert.equal(output.ok, true);
          assert.equal(output.status, "removed");
          assert.equal(output.customerHostname, "app.example.com");
          assert.equal(output.endpointHostname, "demo.ingress.example");
          assert.equal(output.signer.kind, "evm");
          assert.equal(output.signer.address, new ethers.Wallet(hostnameDeveloperPrivateKey).address);
        }

        const deleteRequests = requests.filter((request) => request.method === "DELETE");
        assert.equal(deleteRequests.length, 2);
        for (const request of deleteRequests) {
          assert.equal(request.url, "/v1/endpoints/demo.ingress.example/customer-hostnames/app.example.com");
          assert.equal(request.payload?.action, "removeCustomerHostname");
          assert.equal(request.payload?.endpointId, "demo.ingress.example");
          assert.equal(request.payload?.endpointHostname, "demo.ingress.example");
          assert.equal(request.payload?.customerHostname, "app.example.com");
          assert.equal(request.payload?.sessionId, sessionId);
          assert.equal(request.payload?.deadline, "2000000000");
          assert.equal(request.payload?.nonce, "123");
          assert.equal(request.payload?.signatureScheme, "eip712-secp256k1");
          assert.equal(request.payload?.signer, new ethers.Wallet(hostnameDeveloperPrivateKey).address);
          assert.equal((request.payload?.source as Record<string, unknown>)?.cli, "switchboard hostname remove");
          assert.equal(typeof request.payload?.signature, "string");
        }
      });
    });
  });

  it("keeps hostname add/remove required-argument, mode, and signer errors unchanged", async () => {
    await withCleanSignerEnv(async () => {
      await withManifestServer(async ({ manifestUrl, manifestSigner }) => {
        const manifestArgs = ["--manifest-url", manifestUrl, "--manifest-signer", manifestSigner, "--relay-url", "https://relay.example"];

        await assert.rejects(
          runSwitchboardHostnameAdd(["app.example.com", ...manifestArgs], runtimeWithoutLatestReport, hostnameMutationAdapters()),
          /Missing --endpoint, --endpoint-hostname, ENDPOINT_HOSTNAME, or --report/
        );
        await assert.rejects(
          runSwitchboardHostnameAdd(["--endpoint", "demo.ingress.example", ...manifestArgs], runtimeWithoutLatestReport, hostnameMutationAdapters()),
          /Missing customer hostname\. Use `switchboard hostname add app\.example\.com`/
        );
        await assert.rejects(
          runSwitchboardHostnameAdd(["app.example.com", "--endpoint", "demo.ingress.example", ...manifestArgs], runtimeWithoutLatestReport, hostnameMutationAdapters()),
          /Missing --session-id, SESSION_ID, or --report/
        );
        await assert.rejects(
          runSwitchboardHostnameAdd(
            [
              "app.example.com",
              "--endpoint",
              "demo.ingress.example",
              "--session-id",
              sessionId,
              "--tls-mode",
              "invalid",
              ...manifestArgs
            ],
            runtimeWithoutLatestReport,
            hostnameMutationAdapters()
          ),
          /Unsupported customer hostname TLS mode: invalid/
        );
        await assert.rejects(
          runSwitchboardHostnameAdd(
            [
              "app.example.com",
              "--endpoint",
              "demo.ingress.example",
              "--session-id",
              sessionId,
              "--certificate-validation-mode",
              "invalid",
              ...manifestArgs
            ],
            runtimeWithoutLatestReport,
            hostnameMutationAdapters()
          ),
          /Unsupported customer hostname certificate validation mode: invalid/
        );

        await assert.rejects(
          runSwitchboardHostnameRemove(["app.example.com", ...manifestArgs], runtimeWithoutLatestReport, hostnameMutationAdapters()),
          /Missing --endpoint, --endpoint-hostname, ENDPOINT_HOSTNAME, or --report/
        );
        await assert.rejects(
          runSwitchboardHostnameRemove(["--endpoint", "demo.ingress.example", ...manifestArgs], runtimeWithoutLatestReport, hostnameMutationAdapters()),
          /Missing customer hostname\. Use `switchboard hostname remove app\.example\.com`/
        );
        await assert.rejects(
          runSwitchboardHostnameRemove(["app.example.com", "--endpoint", "demo.ingress.example", ...manifestArgs], runtimeWithoutLatestReport, hostnameMutationAdapters()),
          /Missing --session-id, SESSION_ID, or --report/
        );

        const workDir = await mkdtemp(path.join(tmpdir(), "switchboard-native-hostname-mismatch-"));
        try {
          const reportPath = path.join(workDir, "report.json");
          await writeFile(
            reportPath,
            JSON.stringify({
              relay: { url: "https://relay.example" },
              session: {
                hostname: "demo.ingress.example",
                sessionId
              },
              funding: {
                session: {
                  developer: developerAddress
                }
              }
            }),
            "utf8"
          );
          await assert.rejects(
            runSwitchboardHostnameAdd(
              [
                "app.example.com",
                "--report",
                reportPath,
                "--developer-private-key",
                hostnameDeveloperPrivateKey,
                ...manifestArgs
              ],
              runtimeWithoutLatestReport,
              hostnameMutationAdapters()
            ),
            /Configured EVM developer key resolves to .* not customer hostname session developer/
          );
        } finally {
          await rm(workDir, { recursive: true, force: true });
        }
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

async function captureConsoleAndExitCode(
  fn: () => Promise<void>
): Promise<{ stdout: string; exitCode: NodeJS.Process["exitCode"] }> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const stdout = await captureConsole(fn);
    return { stdout, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExitCode;
  }
}

async function withWorkingDirectory(cwd: string, fn: () => Promise<void>): Promise<void> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    await fn();
  } finally {
    process.chdir(previous);
  }
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

interface HostnameMutationTestRequest {
  method: string;
  url: string;
  payload?: Record<string, any>;
}

function hostnameMutationArgs(input: { baseUrl: string; manifestUrl: string; manifestSigner: string; extra?: readonly string[] }): string[] {
  return [
    "app.example.com",
    "--endpoint",
    "demo.ingress.example",
    "--session-id",
    sessionId,
    "--relay-url",
    input.baseUrl,
    "--manifest-url",
    input.manifestUrl,
    "--manifest-signer",
    input.manifestSigner,
    "--developer-private-key",
    hostnameDeveloperPrivateKey,
    "--json",
    ...(input.extra ?? [])
  ];
}

function sessionRegisterArgs(input: { baseUrl: string; extra?: readonly string[] }): string[] {
  return [
    "--yes",
    "--session-id",
    sessionId,
    "--target",
    "revive-local",
    "--registry",
    registryAddress,
    "--eth-rpc-url",
    input.baseUrl,
    "--relay-url",
    "https://relay.example",
    ...(input.extra ?? [])
  ];
}

function hostnameMutationAdapters() {
  return {
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

function relayPickProcessorSpec(): Record<string, unknown> {
  return {
    version: 1,
    relayId: "relay-d",
    target: "acurast",
    catalogState: "candidate",
    apiBaseUrl: "https://relay-d.switchboard.proof.computer",
    peers: [],
    secrets: {
      relayerPrivateKeyEnv: "PROOF_MAINNET_RELAY_D_RECORDER_PRIVATE_KEY"
    },
    acurast: {
      deployerSeedEnv: "PROOF_ACURAST_MAINNET_DEPLOYER_SEED",
      network: "mainnet",
      managerId: "9470",
      projectName: "switchboard-mainnet-relay-d",
      stageDir: "dist/acurast/switchboard-mainnet-relay-d",
      executionMs: 3_600_000,
      maxCostPerExecution: "41999580000",
      instantMatchProcessors: ["5FHneW46xGXgs5mUiveU4sbTyGBzmst6m6p4Yc4AG4LQbQ9"],
      includeEnv: []
    }
  };
}

function relayPickProcessor(address: string, overrides: Partial<ProcessorInfo> = {}): ProcessorInfo {
  return {
    processor: address,
    heartbeatMs: Date.parse("2026-05-03T12:00:00.000Z"),
    heartbeatIso: "2026-05-03T12:00:00.000Z",
    heartbeatAgeSeconds: 2,
    version: { semver: "1.25.0" },
    availability: {
      proposedStartIso: "2026-05-03T14:00:00.000Z",
      proposedEndIso: "2026-05-03T15:00:00.000Z",
      matches: 1,
      conflicts: 0,
      conflictingJobs: []
    },
    ...overrides
  };
}

function relayPickProcessorInventory(processors: ProcessorInfo[]): ManagerProcessorInventory {
  return {
    network: "mainnet",
    managerId: "9470",
    rpcUrl: "wss://archive.mainnet.acurast.com",
    chainTimestampIso: "2026-05-03T12:00:00.000Z",
    chainLagSeconds: 0,
    processors,
    totalProcessors: processors.length,
    recentProcessors: processors.length,
    availabilityWindow: {
      proposedStartIso: "2026-05-03T14:00:00.000Z",
      proposedEndIso: "2026-05-03T15:00:00.000Z"
    }
  };
}

function relayDnsSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    relayId: "relay-d",
    target: "acurast",
    catalogState: "candidate",
    apiBaseUrl: "https://relay-d.switchboard.proof.computer",
    secrets: { relayerPrivateKeyEnv: "PROOF_MAINNET_RELAY_D_RECORDER_PRIVATE_KEY" },
    acurast: {
      deployerSeedEnv: "PROOF_ACURAST_MAINNET_DEPLOYER_SEED",
      projectName: "switchboard-mainnet-relay-d",
      stageDir: "dist/acurast/switchboard-mainnet-relay-d",
      maxCostPerExecution: "41999580000"
    },
    dns: {
      provider: "cloudflare",
      cnameTarget: "gateway.switchboard.proof.computer",
      ttl: 60
    },
    ...overrides
  };
}

async function withHostnameMutationServer(
  fn: (input: {
    baseUrl: string;
    manifestUrl: string;
    manifestSigner: string;
    requests: HostnameMutationTestRequest[];
  }) => Promise<void>
): Promise<void> {
  let signedManifest: unknown;
  const requests: HostnameMutationTestRequest[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      requests.push({ method: request.method ?? "GET", url: request.url ?? "/" });
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && request.url === "/v1/network-manifest") {
        response.end(JSON.stringify(signedManifest));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/endpoints/demo.ingress.example/customer-hostnames") {
        const payload = JSON.parse(await readRequestBody(request)) as Record<string, any>;
        requests[requests.length - 1].payload = payload;
        response.end(JSON.stringify(hostnameStatusPayload({
          ok: false,
          status: "pending_dns",
          tls: { mode: payload.tlsMode },
          certificateValidation: { mode: payload.certificateValidationMode }
        })));
        return;
      }
      if (request.method === "DELETE" && request.url === "/v1/endpoints/demo.ingress.example/customer-hostnames/app.example.com") {
        const payload = JSON.parse(await readRequestBody(request)) as Record<string, any>;
        requests[requests.length - 1].payload = payload;
        response.end(JSON.stringify({
          ok: true,
          status: "removed",
          customerHostname: "app.example.com",
          endpointHostname: "demo.ingress.example",
          endpointId: "demo.ingress.example",
          sessionId
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/v1/endpoints/demo.ingress.example/customer-hostnames/app.example.com") {
        response.end(JSON.stringify(hostnameStatusPayload({
          ok: true,
          status: "dns_validated",
          certificate: { authorized: true }
        })));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    signedManifest = await signNetworkManifest(testNetworkManifest(baseUrl, { ethRpcUrl: "http://127.0.0.1:9" }), manifestSignerSeed, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const manifestSigner = (signedManifest as { signature: { signer: string } }).signature.signer;
    await fn({ baseUrl, manifestUrl: `${baseUrl}/v1/network-manifest`, manifestSigner, requests });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function nativeRunnerRelayCatalog(): ServiceCatalog {
  return {
    version: 1,
    role: "relay",
    sequence: 42,
    issuedAt: "2030-05-01T12:00:00.000Z",
    expiresAt: "2030-05-02T12:00:00.000Z",
    members: [
      { serviceId: "relay-a", state: "active", apiBaseUrl: "https://relay-a.example" },
      { serviceId: "relay-d", state: "candidate", apiBaseUrl: "https://relay-d.example" }
    ]
  };
}

function nativeRunnerControlCatalog(): ServiceCatalog {
  return {
    version: 1,
    role: "control-api",
    sequence: 42,
    issuedAt: "2030-05-01T12:00:00.000Z",
    expiresAt: "2030-05-02T12:00:00.000Z",
    members: [
      { serviceId: "control-bootstrap", state: "active", apiBaseUrl: "https://control.example" }
    ]
  };
}

async function relaySyncDiscoveryFixture(): Promise<{
  manifestUrl: string;
  manifestSigner: string;
  fetchImpl: typeof fetch;
  requests: string[];
}> {
  const manifestUrl = "https://manifest.example/v1/network-manifest";
  const catalogUrl = "https://catalog.example/v1/service-catalogs/relay";
  const relayCatalog = await signServiceCatalog(nativeRunnerRelayCatalog(), catalogSignerSeed, {
    scheme: "substrate-sr25519",
    ss58Format: 42
  });
  const catalogSigner = relayCatalog.signature.signer;
  const manifest = testNetworkManifest("https://control.example", { ethRpcUrl: "http://127.0.0.1:9" });
  manifest.catalogs = {
    relays: {
      url: catalogUrl,
      signer: catalogSigner,
      required: true
    }
  };
  const signedManifest = await signNetworkManifest(manifest, manifestSignerSeed, {
    scheme: "substrate-sr25519",
    ss58Format: 42
  });
  const requests: string[] = [];
  const fetchImpl = (async (input: Request | URL | string) => {
    const url = String(input);
    requests.push(url);
    if (url === manifestUrl) {
      return new Response(JSON.stringify(signedManifest), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url === catalogUrl) {
      return new Response(JSON.stringify(relayCatalog), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  return {
    manifestUrl,
    manifestSigner: signedManifest.signature.signer,
    fetchImpl,
    requests
  };
}

function relayWatchFetch(): typeof fetch {
  return (async (input: Request | URL | string) => {
    const url = String(input);
    const okBody = JSON.stringify({ ok: true, catalog: { role: "relay", members: [] } });
    if (url.startsWith("https://relay-a.example/")) {
      return new Response(okBody, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://relay-d.example/health") {
      return new Response(JSON.stringify({ ok: false }), { status: 503, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://relay-d.example/")) {
      return new Response(okBody, { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function withRelayStatusServer(
  fn: (input: { baseUrl: string }) => Promise<void>
): Promise<void>;
async function withRelayStatusServer(
  options: { failHealth?: boolean },
  fn: (input: { baseUrl: string }) => Promise<void>
): Promise<void>;
async function withRelayStatusServer(
  optionsOrFn: { failHealth?: boolean } | ((input: { baseUrl: string }) => Promise<void>),
  maybeFn?: (input: { baseUrl: string }) => Promise<void>
): Promise<void> {
  const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
  if (!fn) throw new Error("withRelayStatusServer requires a callback");

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/health") {
      if (options.failHealth) {
        response.statusCode = 503;
        response.end(JSON.stringify({ ok: false }));
        return;
      }
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/relay-status") {
      response.end(JSON.stringify({ relayId: "relay-a", peerBackfillEnabled: true, recorderCoordinatorEnabled: false }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/service-catalogs/relay") {
      response.end(JSON.stringify({ catalog: { role: "relay", members: [{ serviceId: "relay-a", state: "active" }] } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await fn({ baseUrl });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function withCatalogDiscoveryServer(
  fn: (input: {
    manifestUrl: string;
    manifestSigner: string;
    requests: string[];
  }) => Promise<void>
): Promise<void> {
  let signedManifest: unknown;
  let relays: unknown;
  let controlApi: unknown;
  const requests: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/v1/network-manifest") {
      response.end(JSON.stringify(signedManifest));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/service-catalogs/relay") {
      response.end(JSON.stringify(relays));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/service-catalogs/control-api") {
      response.end(JSON.stringify(controlApi));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    relays = await signServiceCatalog(nativeRunnerRelayCatalog(), catalogSignerSeed, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    controlApi = await signServiceCatalog(nativeRunnerControlCatalog(), catalogSignerSeed, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const catalogSigner = (relays as { signature: { signer: string } }).signature.signer;
    const manifest = testNetworkManifest(baseUrl, { ethRpcUrl: "http://127.0.0.1:9" });
    manifest.catalogs = {
      relays: {
        url: `${baseUrl}/v1/service-catalogs/relay`,
        signer: catalogSigner,
        required: true
      },
      controlApi: {
        url: `${baseUrl}/v1/service-catalogs/control-api`,
        signer: catalogSigner,
        required: true
      }
    };
    signedManifest = await signNetworkManifest(manifest, manifestSignerSeed, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const manifestSigner = (signedManifest as { signature: { signer: string } }).signature.signer;
    await fn({ manifestUrl: `${baseUrl}/v1/network-manifest`, manifestSigner, requests });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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

async function withValidatorScriptLookupServer(
  options: {
    networkScript?: {
      scriptIpfs: string;
      scriptHash?: string;
    };
    scriptManifest?: Record<string, unknown>;
  },
  fn: (input: {
    manifestUrl: string;
    manifestSigner: string;
    validatorScriptManifestUrl: string;
    requests: string[];
  }) => Promise<void>
): Promise<void> {
  let signedManifest: unknown;
  const requests: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
    if (request.method === "GET" && request.url === "/v1/network-manifest") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(signedManifest));
      return;
    }
    if (request.method === "GET" && request.url === "/validator-script-manifest.json" && options.scriptManifest) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(options.scriptManifest));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const manifest = testNetworkManifest(baseUrl, { ethRpcUrl: "http://127.0.0.1:9" });
    if (options.networkScript) {
      manifest.validators = {
        launch: {
          scriptIpfs: options.networkScript.scriptIpfs,
          scriptHash: options.networkScript.scriptHash
        }
      };
    }
    signedManifest = await signNetworkManifest(manifest, manifestSignerSeed, {
      scheme: "substrate-sr25519",
      ss58Format: 42
    });
    const manifestSigner = (signedManifest as { signature: { signer: string } }).signature.signer;
    await fn({
      manifestUrl: `${baseUrl}/v1/network-manifest`,
      manifestSigner,
      validatorScriptManifestUrl: `${baseUrl}/validator-script-manifest.json`,
      requests
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

type AccountingSessionSource = readonly unknown[] | (() => readonly unknown[]);

async function withAccountingServer(
  options: { claimableBalance?: bigint; session?: AccountingSessionSource },
  fn: (input: { baseUrl: string; manifestUrl: string; manifestSigner: string; rpcMethods: string[] }) => Promise<void>
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
    await fn({ baseUrl, manifestUrl: `${baseUrl}/v1/network-manifest`, manifestSigner, rpcMethods });
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
  options: { claimableBalance?: bigint; session?: AccountingSessionSource },
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
      const session = typeof options.session === "function" ? options.session() : options.session;
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: accountingInterface.encodeFunctionResult("getSession", [session ?? refundableSession()])
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

function registrationSession(input: { registered?: boolean; expectedJobSigner?: string } = {}): readonly unknown[] {
  const session = [...refundableSession()];
  session[11] = `0x${"22".repeat(32)}`;
  session[12] = input.expectedJobSigner ?? new ethers.Wallet(registrationJobSignerPrivateKey).address;
  session[13] = `0x${"33".repeat(32)}`;
  session[14] = `0x${"44".repeat(32)}`;
  session[15] = `0x${"55".repeat(32)}`;
  session[16] = `0x${"66".repeat(32)}`;
  session[23] = input.registered ?? false;
  session[24] = 7n;
  return session;
}

function missingFundedSession(): readonly unknown[] {
  const session = [...registrationSession()];
  session[0] = ethers.ZeroAddress;
  return session;
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

async function withCleanRelayWhoamiEnv(fn: () => Promise<void>): Promise<void> {
  const names = [
    "ACURAST_MAINNET_SEED",
    "ACURAST_MAINNET_ADDRESS",
    "ACURAST_CANARY_SEED",
    "ACURAST_CANARY_ADDRESS",
    "ACURAST_SEED",
    "ACURAST_ADDRESS",
    "RELAY_D_SEED"
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

async function withCleanRelayLogsEnv(fn: () => Promise<void>): Promise<void> {
  const names = [
    "PROOF_LOG_READ_URL",
    "PROOF_LOG_READ_TOKEN",
    "SWITCHBOARD_LOG_ENCRYPTION_KEY",
    "CUSTOM_LOG_TOKEN",
    "CUSTOM_LOG_KEY"
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

async function withCleanSessionRegisterEnv(fn: () => Promise<void>): Promise<void> {
  const names = [
    "SWITCHBOARD_ASSUME_YES",
    "SESSION_ID",
    "JOB_SIGNER_PRIVATE_KEY",
    "RELAY_URL",
    "DEADLINE",
    "CONTRACT_CALL_TIMEOUT_MS",
    "INGRESS_REGISTRY_ADDRESS",
    "HUB_ETH_RPC_URL",
    "ETH_RPC_URL"
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

async function withCleanValidatorScriptEnv(fn: () => Promise<void>): Promise<void> {
  const names = [
    "SWITCHBOARD_VALIDATOR_SCRIPT_MANIFEST_JSON",
    "PROOF_VALIDATOR_SCRIPT_MANIFEST_JSON",
    "SWITCHBOARD_VALIDATOR_SCRIPT_MANIFEST_FILE",
    "PROOF_VALIDATOR_SCRIPT_MANIFEST_FILE",
    "SWITCHBOARD_VALIDATOR_SCRIPT_MANIFEST_URL",
    "PROOF_VALIDATOR_SCRIPT_MANIFEST_URL"
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

async function withCleanCatalogVerifyEnv(fn: () => Promise<void>): Promise<void> {
  const names = [
    "PROOF_NETWORK_MANIFEST_URL",
    "PROOF_NETWORK_MANIFEST_SIGNER",
    "PROOF_REQUIRED_CATALOGS"
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

async function withCleanCatalogBuildEnv(fn: () => Promise<void>): Promise<void> {
  const names = [
    "PROOF_SERVICE_CATALOG_SPEC_FILE",
    "PROOF_SERVICE_CATALOG_SIGNING_KEY",
    "PROOF_MAINNET_MANIFEST_SIGNING_KEY",
    "PROOF_SERVICE_CATALOG_SIGNING_SCHEME",
    "PROOF_NETWORK_MANIFEST_SIGNING_SCHEME",
    "PROOF_SERVICE_CATALOGS_OUTPUT_FILE",
    "PROOF_CONTROL_PLANE_URL",
    "PROOF_CONTROL_API_SERVICE_ID",
    "PROOF_CONTROL_API_CAPABILITIES",
    "PROOF_SERVICE_CATALOG_RELAYS_JSON",
    "PROOF_NETWORK_MANIFEST_RELAYS_JSON",
    "PROOF_RELAY_SERVICE_CAPABILITIES"
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
