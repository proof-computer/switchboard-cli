import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { runOpsSubcommand } from "../cli/src/ops.js";
import {
  isBuilderContextSecretEnvAllowed,
  loadContextSecretFile,
  loadSwitchboardOpsProfile,
  switchboardHomePaths
} from "../cli/src/switchboard-home.js";

describe("switchboard home config", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  before(async () => {
    home = await mkdtemp(path.join(tmpdir(), "switchboard-home-"));
    env = { SWITCHBOARD_HOME: home };
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("initializes ops config and secrets under ~/.switchboard/ops/<profile>", async () => {
    const output: string[] = [];
    await runOpsSubcommand({
      flags: new Map<string, string | boolean>(),
      positionals: ["ops", "init", "mainnet"],
      env,
      io: {
        log: (line) => output.push(line),
        warn: (line) => output.push(line),
        error: (line) => output.push(line)
      }
    });

    const paths = switchboardHomePaths({ opsProfile: "mainnet", env });
    const config = JSON.parse(await readFile(paths.opsConfigFile, "utf8")) as Record<string, any>;
    const secrets = await readFile(paths.opsSecretFile, "utf8");

    assert.equal(config.target, "polkadot-hub");
    assert.equal(config.controlPlaneUrl, "https://control.switchboard.proof.computer");
    assert.equal(config.services.domain, "switchboard.proof.computer");
    assert.match(secrets, /PROOF_MAINNET_QUOTE_SIGNER_PRIVATE_KEY=/);
    assert.ok(output.some((line) => line.includes(paths.opsConfigFile)));
  });

  it("loads ops config and secrets without overriding existing env values", async () => {
    const profileHome = switchboardHomePaths({ opsProfile: "custom", env });
    await mkdir(profileHome.opsDir, { recursive: true });
    await writeFile(
      profileHome.opsConfigFile,
      JSON.stringify(
        {
          version: 1,
          profile: "custom",
          target: "polkadot-hub",
          manifestUrl: "https://control.example.test/v1/network-manifest",
          controlPlaneUrl: "https://control.example.test",
          chainId: "420420419",
          hubEthRpcUrl: "https://rpc.example.test/mainnet",
          registryAddress: "0x9999999999999999999999999999999999999999",
          quoteSignerAddress: "0x1111111111111111111111111111111111111111",
          quoteSetupFee: "10000",
          quoteValidationFeeCap: "20000",
          operatorRecipient: "0x2222222222222222222222222222222222222222",
          validatorRecipient: "0x3333333333333333333333333333333333333333",
          treasuryRecipient: "0x4444444444444444444444444444444444444444",
          validationAllowedSigners: "5AllowedValidator",
          operatorCapabilityAllowedSigners: "5AllowedOperator",
          relayRecorderAddresses: {
            "relay-a": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          acurastRpc: "wss://acurast.example.test",
          services: {
            domain: "example.test",
            relayHostnamePattern: "${relayId}.example.test"
          }
        },
        null,
        2
      )
    );
    await writeFile(profileHome.opsSecretFile, "PROOF_CONTROL_PLANE_TOKEN=secret-token\nHUB_ETH_RPC_URL=https://secret-rpc.example.test\n");

    const scopedEnv: NodeJS.ProcessEnv = {
      SWITCHBOARD_HOME: home,
      HUB_ETH_RPC_URL: "https://existing-rpc.example.test"
    };
    const loaded = await loadSwitchboardOpsProfile({ profile: "custom", env: scopedEnv });

    assert.equal(loaded.loadedEnv.loaded.includes("PROOF_CONTROL_PLANE_TOKEN"), true);
    assert.equal(loaded.loadedEnv.skipped.includes("HUB_ETH_RPC_URL"), true);
    assert.equal(scopedEnv.PROOF_CONTROL_PLANE_URL, "https://control.example.test");
    assert.equal(scopedEnv.RELAY_URL, "https://control.example.test");
    assert.equal(scopedEnv.SWITCHBOARD_SERVICE_DOMAIN, "example.test");
    assert.equal(scopedEnv.SWITCHBOARD_RELAY_HOSTNAME_PATTERN, "${relayId}.example.test");
    assert.equal(
      scopedEnv.CLOUDFLARE_ZONE_NAMES,
      "example.test,ingress.digital,ingress.directory,ingress.guru,ingress.team,ingress.works"
    );
    assert.equal(
      scopedEnv.SWITCHBOARD_DOMAIN_POOL,
      "ingress.digital,ingress.directory,ingress.guru,ingress.team,ingress.works"
    );
    assert.equal(scopedEnv.QUOTE_SIGNER_ADDRESS, "0x1111111111111111111111111111111111111111");
    assert.equal(scopedEnv.PROOF_EXPLORER_REGISTRY_ADDRESS, "0x9999999999999999999999999999999999999999");
    assert.equal(scopedEnv.PROOF_QUOTE_SETUP_FEE, "10000");
    assert.equal(scopedEnv.PROOF_QUOTE_VALIDATION_FEE_CAP, "20000");
    assert.equal(scopedEnv.PROOF_MAINNET_OPERATOR_RECIPIENT, "0x2222222222222222222222222222222222222222");
    assert.equal(scopedEnv.PROOF_MAINNET_VALIDATOR_RECIPIENT, "0x3333333333333333333333333333333333333333");
    assert.equal(scopedEnv.PROOF_MAINNET_TREASURY_RECIPIENT, "0x4444444444444444444444444444444444444444");
    assert.equal(scopedEnv.PROOF_VALIDATION_ALLOWED_SIGNERS, "5AllowedValidator");
    assert.equal(scopedEnv.PROOF_OPERATOR_CAPABILITY_ALLOWED_SIGNERS, "5AllowedOperator");
    assert.equal(scopedEnv.PROOF_RELAY_A_RECORDER_ADDRESS, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(scopedEnv.ACURAST_RPC, "wss://acurast.example.test");
    assert.equal(scopedEnv.ACURAST_RPC_NODE, "wss://acurast.example.test");
    assert.equal(scopedEnv.PROOF_EXPLORER_ACURAST_RPC_URL, "wss://acurast.example.test");
    assert.equal(scopedEnv.PROOF_CONTROL_PLANE_TOKEN, "secret-token");
    assert.equal(scopedEnv.HUB_ETH_RPC_URL, "https://existing-rpc.example.test");
  });

  it("can make ops config authoritative without wiping shell-provided secrets", async () => {
    const profileHome = switchboardHomePaths({ opsProfile: "authoritative", env });
    await mkdir(profileHome.opsDir, { recursive: true });
    await writeFile(
      profileHome.opsConfigFile,
      JSON.stringify(
        {
          version: 1,
          profile: "authoritative",
          target: "polkadot-hub",
          hubEthRpcUrl: "https://profile-rpc.example.test/mainnet",
          services: {
            domain: "profile.example.test"
          }
        },
        null,
        2
      )
    );
    await writeFile(
      profileHome.opsSecretFile,
      "CLOUDFLARE_API_TOKEN=\nPROOF_CONTROL_PLANE_TOKEN=profile-control-token\n"
    );

    const scopedEnv: NodeJS.ProcessEnv = {
      SWITCHBOARD_HOME: home,
      HUB_ETH_RPC_URL: "https://stale-rpc.example.test",
      CLOUDFLARE_ZONE_NAMES: "stale.example.test",
      CLOUDFLARE_API_TOKEN: "shell-token"
    };
    const loaded = await loadSwitchboardOpsProfile({
      profile: "authoritative",
      env: scopedEnv,
      overrideConfigEnv: true
    });

    assert.equal(scopedEnv.HUB_ETH_RPC_URL, "https://profile-rpc.example.test/mainnet");
    assert.equal(
      scopedEnv.CLOUDFLARE_ZONE_NAMES,
      "example.test,ingress.digital,ingress.directory,ingress.guru,ingress.team,ingress.works"
    );
    assert.equal(scopedEnv.CLOUDFLARE_API_TOKEN, "shell-token");
    assert.equal(scopedEnv.PROOF_CONTROL_PLANE_TOKEN, "profile-control-token");
    assert.equal(loaded.loadedEnv.skipped.includes("CLOUDFLARE_API_TOKEN"), true);
  });

  it("keeps builder context secrets separate from ops secrets", async () => {
    const paths = switchboardHomePaths({ contextName: "builder-mainnet", env });
    await mkdir(paths.builderSecretsDir, { recursive: true });
    await writeFile(
      paths.builderSecretFile,
      "SWITCHBOARD_BUILDER_TOKEN=builder-token\nPROOF_CONTROL_PLANE_TOKEN=builder-control\nSWITCHBOARD_CONTROL_TOKEN=builder-control-2\n"
    );

    const scopedEnv: NodeJS.ProcessEnv = { SWITCHBOARD_HOME: home };
    const loaded = await loadContextSecretFile("builder-mainnet", { env: scopedEnv });

    assert.equal(loaded?.missing, false);
    assert.equal(loaded?.loaded.includes("SWITCHBOARD_BUILDER_TOKEN"), true);
    assert.equal(loaded?.skipped.includes("PROOF_CONTROL_PLANE_TOKEN"), true);
    assert.equal(loaded?.skipped.includes("SWITCHBOARD_CONTROL_TOKEN"), true);
    assert.equal(scopedEnv.SWITCHBOARD_BUILDER_TOKEN, "builder-token");
    assert.equal(scopedEnv.PROOF_CONTROL_PLANE_TOKEN, undefined);
    assert.equal(scopedEnv.SWITCHBOARD_CONTROL_TOKEN, undefined);
  });

  it("rejects admin-only secrets from builder context secret files", () => {
    assert.equal(isBuilderContextSecretEnvAllowed("POLKADOT_SEED"), true);
    assert.equal(isBuilderContextSecretEnvAllowed("ACURAST_SEED"), true);
    assert.equal(isBuilderContextSecretEnvAllowed("PROOF_CONTROL_PLANE_TOKEN"), false);
    assert.equal(isBuilderContextSecretEnvAllowed("SWITCHBOARD_CONTROL_TOKEN"), false);
    assert.equal(isBuilderContextSecretEnvAllowed("GATEWAY_AGENT_ROUTE_INTENT_TOKEN"), false);
    assert.equal(isBuilderContextSecretEnvAllowed("ACME_EAB_HMAC_KEY"), false);
  });

  it("prints only non-secret ops env", async () => {
    const output: string[] = [];
    await runOpsSubcommand({
      flags: new Map<string, string | boolean>(),
      positionals: ["ops", "env", "mainnet"],
      env,
      io: {
        log: (line) => output.push(line),
        warn: (line) => output.push(line),
        error: (line) => output.push(line)
      }
    });

    assert.ok(output.includes("SWITCHBOARD_SERVICE_DOMAIN=switchboard.proof.computer"));
    assert.ok(output.includes("PROOF_CONTROL_PLANE_URL=https://control.switchboard.proof.computer"));
    assert.ok(
      output.includes(
        "CLOUDFLARE_ZONE_NAMES=proof.computer,ingress.digital,ingress.directory,ingress.guru,ingress.team,ingress.works"
      )
    );
    assert.ok(output.includes("SWITCHBOARD_DOMAIN_POOL=ingress.digital,ingress.directory,ingress.guru,ingress.team,ingress.works"));
    assert.equal(output.some((line) => line.includes("PROOF_MAINNET_QUOTE_SIGNER_PRIVATE_KEY")), false);
    assert.equal(output.some((line) => line.includes("PROOF_CONTROL_PLANE_TOKEN")), false);
  });
});
