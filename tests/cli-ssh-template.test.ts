import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(cliRoot, "cli/src/index.ts");
const ubuntuImageUrl = "https://github.com/termux/proot-distro/releases/download/v4.30.1/ubuntu-questing-aarch64-pd-v4.30.1.tar.xz";
const ubuntuImageSha256 = "5ab35b90cd9a9f180656261ba400a135c4c01c2da4b74522118342f985c2d328";

describe("switchboard init --template ssh", () => {
  it("generates an inspectable SSH Script project", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-ssh-template-"));
    try {
      const result = await runCli([
        "init",
        "--project-dir",
        cwd,
        "--template",
        "ssh",
        "--distro",
        "ubuntu",
        "--project",
        "ssh-demo",
        "--context",
        "mainnet",
        "--json"
      ]);

      assert.equal(result.code, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.template, "ssh");
      assert.equal(output.distro, "ubuntu");

      const config = JSON.parse(await readFile(path.join(cwd, "switchboard.json"), "utf8"));
      assert.equal(config.project, "ssh-demo");
      assert.equal(config.context, "mainnet");
      assert.equal(config.acurast.runtime, "script");
      assert.equal(config.acurast.entrypoint, "acurast.sh");
      assert.equal(config.acurast.scriptImage.url, ubuntuImageUrl);
      assert.equal(config.acurast.scriptImage.sha256, ubuntuImageSha256);
      assert.deepEqual(config.acurast.scriptFiles, [
        "acurast.sh",
        "switchboard-cargo-bootstrap.sh",
        "switchboard-cargo-bootstrap.py",
        "stunnel.conf",
        "getifaddrs_override.c"
      ]);
      assert.equal(config.ssh.authorizedKeysFile, "authorized_keys");
      assert.equal(config.ssh.user, "root");

      const entrypoint = await readFile(path.join(cwd, "acurast.sh"), "utf8");
      assert.match(entrypoint, /^#!\/bin\/sh/);
      assert.match(entrypoint, /set -eu/);
      assert.doesNotMatch(entrypoint, /pipefail|local /);
      assert.match(entrypoint, /bootstrap_log entrypoint_start/);
      assert.match(entrypoint, /bootstrap_log dropbear_start/);
      assert.match(entrypoint, /bootstrap_log stunnel_start/);
      assert.match(entrypoint, /bootstrap_log ready_start/);
      assert.match(entrypoint, /bootstrap_log exit/);
      assert.match(entrypoint, /dropbear -F -E -s -g -p 127\.0\.0\.1:22/);
      assert.match(entrypoint, /dropbearkey -t rsa/);
      assert.doesNotMatch(entrypoint, /sshd|ssh-keygen|useradd/);
      assert.match(entrypoint, /SCRIPT_DIR/);
      assert.match(entrypoint, /BOOTSTRAP_SCRIPT=/);
      assert.match(entrypoint, /LD_PRELOAD/);
      assertBefore(entrypoint, "/bin/sh \"${BOOTSTRAP_SCRIPT}\"", "require_command dropbear");
      assertBefore(entrypoint, "/bin/sh \"${BOOTSTRAP_SCRIPT}\"", "STUNNEL_BIN=");
      assertBefore(entrypoint, "dropbearkey -t rsa", "bootstrap_log dropbear_start");

      const shellBootstrap = await readFile(path.join(cwd, "switchboard-cargo-bootstrap.sh"), "utf8");
      assert.match(shellBootstrap, /^#!\/bin\/sh/);
      assert.doesNotMatch(shellBootstrap, /pipefail|local /);
      assert.match(shellBootstrap, /ensure_curl\(\)/);
      assert.match(shellBootstrap, /ensure_getifaddrs_override\(\)/);
      assert.match(shellBootstrap, /curl/);
      assert.match(shellBootstrap, /gcc/);
      assert.match(shellBootstrap, /libc6-dev/);
      assert.match(shellBootstrap, /dropbear/);
      assert.match(shellBootstrap, /stunnel4/);
      assert.match(shellBootstrap, /bootstrap_log curl_ready/);
      assert.match(shellBootstrap, /bootstrap_log apt_deps_start/);
      assert.match(shellBootstrap, /bootstrap_log apt_deps_done/);
      assert.match(shellBootstrap, /bootstrap_log dropbear_deps_done/);
      assert.match(shellBootstrap, /bootstrap_log stunnel_deps_done/);
      assert.match(shellBootstrap, /bootstrap_log shim_ready/);
      assert.match(shellBootstrap, /bootstrap_log python_runtime_done/);
      assert.match(shellBootstrap, /SWITCHBOARD_PYTHON_BIN/);
      assert.match(shellBootstrap, /command -v python3/);
      assert.doesNotMatch(shellBootstrap, /openssh-server|python3-pip|python3-venv|pip install|eth-keys|cryptography/);
      const pythonBootstrap = await readFile(path.join(cwd, "switchboard-cargo-bootstrap.py"), "utf8");
      assert.match(pythonBootstrap, /BRIDGE_SOCKET/);
      assert.match(pythonBootstrap, /signer_publicKey/);
      assert.match(pythonBootstrap, /signer_sign/);
      assert.match(pythonBootstrap, /network_whitelist/);
      assert.match(pythonBootstrap, /discover_upstream_ips/);
      assert.match(pythonBootstrap, /hostname", "-I"/);
      assert.match(pythonBootstrap, /"ip", "-4", "-o", "addr", "show", "scope", "global"/);
      assert.match(pythonBootstrap, /https:\/\/ifconfig\.me\/ip/);
      assert.match(pythonBootstrap, /\/runtime-signing\/claim/);
      assert.match(pythonBootstrap, /\/runtime-signing\/registration-challenge/);
      assert.match(pythonBootstrap, /\/runtime-signing\/registration/);
      assert.match(pythonBootstrap, /\/runtime-signing\/certificate-challenge/);
      assert.match(pythonBootstrap, /\/runtime-signing\/certificate/);
      assert.match(pythonBootstrap, /"signerMode": "cargo-bridge-secp256k1"/);
      assert.match(pythonBootstrap, /"upstreamIps": upstream_ips/);
      assert.doesNotMatch(pythonBootstrap, /\/cargo\//);
      assert.match(pythonBootstrap, /python_start/);
      assert.match(pythonBootstrap, /bridge_connect_start/);
      assert.match(pythonBootstrap, /bridge_connected/);
      assert.match(pythonBootstrap, /claim_start/);
      assert.match(pythonBootstrap, /claim_done/);
      assert.match(pythonBootstrap, /registration_start/);
      assert.match(pythonBootstrap, /registration_done/);
      assert.match(pythonBootstrap, /certificate_start/);
      assert.match(pythonBootstrap, /certificate_written/);
      assert.match(pythonBootstrap, /health_ready/);
      assert.doesNotMatch(pythonBootstrap, /JOB_SIGNER_PRIVATE_KEY/);
      assert.doesNotMatch(pythonBootstrap, /cryptography|eth_abi|eth_keys|eth_utils/);
      assert.match(await readFile(path.join(cwd, "stunnel.conf"), "utf8"), /accept = 0\.0\.0\.0:@PORT@/);
      const getifaddrsOverride = await readFile(path.join(cwd, "getifaddrs_override.c"), "utf8");
      assert.match(getifaddrsOverride, /getifaddrs/);
      assert.match(getifaddrsOverride, /IFF_LOOPBACK/);
      const cSyntax = await runCommand("gcc", ["-fsyntax-only", path.join(cwd, "getifaddrs_override.c")], { cwd });
      if (cSyntax.code !== null || cSyntax.errorCode !== "ENOENT") {
        assert.equal(cSyntax.code, 0, cSyntax.stderr);
      }
      assert.match(await readFile(path.join(cwd, "authorized_keys.example"), "utf8"), /ssh-ed25519/);
      for (const file of ["acurast.sh", "switchboard-cargo-bootstrap.sh", "switchboard-cargo-bootstrap.py", "stunnel.conf", "getifaddrs_override.c"]) {
        assert.doesNotMatch(await readFile(path.join(cwd, file), "utf8"), /webhook\.site/);
      }

      assert.equal((await stat(path.join(cwd, "acurast.sh"))).mode & 0o111, 0o111);
      assert.equal((await stat(path.join(cwd, "switchboard-cargo-bootstrap.sh"))).mode & 0o111, 0o111);
      assert.equal((await stat(path.join(cwd, "switchboard-cargo-bootstrap.py"))).mode & 0o111, 0o111);
      assert.equal((await runShell(["-n", path.join(cwd, "acurast.sh")], { cwd })).code, 0);
      assert.equal((await runShell(["-n", path.join(cwd, "switchboard-cargo-bootstrap.sh")], { cwd })).code, 0);
      const compile = await runPython(["-m", "py_compile", path.join(cwd, "switchboard-cargo-bootstrap.py")], { cwd });
      if (compile.code !== null || compile.errorCode !== "ENOENT") {
        assert.equal(compile.code, 0, compile.stderr);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("runs the entrypoint under sh from outside the staged directory before dependency checks", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-ssh-template-proot-"));
    try {
      const init = await runCli([
        "init",
        "--project-dir",
        cwd,
        "--template",
        "ssh",
        "--distro",
        "ubuntu",
        "--json"
      ]);
      assert.equal(init.code, 0, init.stderr);

      const markerPath = path.join(cwd, "bootstrap-modes.log");
      const markerLiteral = markerPath.replaceAll("'", "'\\''");
      const bootstrapStub = `printf '%s\\n' "\${1:-prepare}" >> '${markerLiteral}'
exit 42
`;
      await writeFile(path.join(cwd, "switchboard-cargo-bootstrap.sh"), bootstrapStub, "utf8");

      const result = await runGeneratedShellScript(path.join(cwd, "acurast.sh"), {
        cwd: tmpdir(),
        env: {
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          SSH_AUTH_KEYS: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeSwitchboardTestKey",
          SWITCHBOARD_RUN_DIR: path.join(cwd, "run")
        }
      });

      assert.equal(result.code, 42, result.stderr);
      assert.equal(await readFile(markerPath, "utf8"), "prepare\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("uses prebaked system dependencies without invoking apt or pip", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-ssh-template-prebaked-"));
    try {
      const init = await runCli([
        "init",
        "--project-dir",
        cwd,
        "--template",
        "ssh",
        "--distro",
        "ubuntu",
        "--json"
      ]);
      assert.equal(init.code, 0, init.stderr);

      const binDir = path.join(cwd, "bin");
      await mkdir(binDir);
      const aptMarker = path.join(cwd, "apt-called");
      await writeExecutable(path.join(binDir, "apt-get"), `#!/bin/sh
printf called > '${aptMarker.replaceAll("'", "'\\''")}'
exit 99
`);
      for (const commandName of ["curl", "openssl", "gcc", "stunnel", "dropbear", "dropbearkey"]) {
        await writeExecutable(path.join(binDir, commandName), "#!/bin/sh\nexit 0\n");
      }
      await writeExecutable(path.join(binDir, "python3"), `#!/bin/sh
if [ "\${1:-}" = "-" ]; then
  cat >/dev/null
  exit 0
fi
PATH='${(process.env.PATH ?? "").replaceAll("'", "'\\''")}' exec python3 "$@"
`);
      const overrideSo = path.join(cwd, "prebaked-getifaddrs.so");
      await writeFile(overrideSo, "prebaked", "utf8");

      const socketPath = path.join(cwd, "bridge.sock");
      const calls: string[] = [];
      const server = createServer((connection) => {
        let data = "";
        connection.on("data", (chunk) => {
          data += chunk.toString("utf8");
          if (!data.includes("\n")) return;
          const request = JSON.parse(data.trim());
          calls.push(request.method);
          const result =
            request.method === "signer_publicKey"
              ? { publicKey: `02${"11".repeat(32)}` }
              : { bytes: "22".repeat(64) };
          connection.end(`${JSON.stringify({ jsonrpc: "2.0", result, id: request.id })}\n`);
        });
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      try {
        const result = await runShell(["switchboard-cargo-bootstrap.sh", "bridge-smoke"], {
          cwd,
          env: {
            BRIDGE_SOCKET: socketPath,
            GETIFADDRS_OVERRIDE_SO: overrideSo,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            SWITCHBOARD_RUN_DIR: path.join(cwd, "run")
          }
        });

        assert.equal(result.code, 0, result.stderr);
        assert.equal(await fileExists(aptMarker), false);
        const output = JSON.parse(result.stdout);
        assert.equal(output.publicKey, `02${"11".repeat(32)}`);
        assert.equal(output.signature, "22".repeat(64));
        assert.deepEqual(calls, ["signer_publicKey", "signer_sign"]);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("can talk to a fake Cargo bridge socket from the generated Python helper", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-ssh-template-bridge-"));
    try {
      const init = await runCli([
        "init",
        "--project-dir",
        cwd,
        "--template",
        "ssh",
        "--distro",
        "ubuntu",
        "--json"
      ]);
      assert.equal(init.code, 0, init.stderr);

      const socketPath = path.join(cwd, "bridge.sock");
      const calls: string[] = [];
      const server = createServer((connection) => {
        let data = "";
        connection.on("data", (chunk) => {
          data += chunk.toString("utf8");
          if (!data.includes("\n")) return;
          const request = JSON.parse(data.trim());
          calls.push(request.method);
          const result =
            request.method === "signer_publicKey"
              ? { publicKey: `02${"11".repeat(32)}` }
              : { bytes: "22".repeat(64) };
          connection.end(`${JSON.stringify({ jsonrpc: "2.0", result, id: request.id })}\n`);
        });
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      try {
        const smoke = await runPython(["switchboard-cargo-bootstrap.py", "bridge-smoke"], {
          cwd,
          env: { BRIDGE_SOCKET: socketPath }
        });
        if (smoke.code !== null || smoke.errorCode !== "ENOENT") {
          assert.equal(smoke.code, 0, smoke.stderr);
          const output = JSON.parse(smoke.stdout);
          assert.equal(output.publicKey, `02${"11".repeat(32)}`);
          assert.equal(output.signature, "22".repeat(64));
          assert.deepEqual(calls, ["signer_publicKey", "signer_sign"]);
        }
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unsupported SSH distros", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "switchboard-ssh-template-bad-"));
    try {
      const result = await runCli([
        "init",
        "--project-dir",
        cwd,
        "--template",
        "ssh",
        "--distro",
        "debian"
      ]);

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Unsupported SSH template distro: debian/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

function assertBefore(contents: string, first: string, second: string): void {
  const firstIndex = contents.indexOf(first);
  const secondIndex = contents.indexOf(second);
  assert.notEqual(firstIndex, -1, `${first} not found`);
  assert.notEqual(secondIndex, -1, `${second} not found`);
  assert.ok(firstIndex < secondIndex, `${first} should appear before ${second}`);
}

async function writeExecutable(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, "utf8");
  await chmod(filePath, 0o755);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: cliRoot,
      env: {
        ...process.env,
        SWITCHBOARD_HOME: path.join(tmpdir(), `switchboard-ssh-template-home-${process.pid}`),
        SWITCHBOARD_CONTEXT: "",
        NO_COLOR: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function runGeneratedShellScript(
  scriptPath: string,
  options: { cwd: string; env?: Record<string, string> }
): Promise<{ code: number | null; stdout: string; stderr: string; errorCode?: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", [scriptPath], {
      cwd: options.cwd,
      env: {
        ...(options.env ?? {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error: NodeJS.ErrnoException) => {
      resolve({
        code: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        errorCode: error.code
      });
    });
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function runShell(
  args: string[],
  options: { cwd: string; env?: Record<string, string> }
): Promise<{ code: number | null; stdout: string; stderr: string; errorCode?: string }> {
  return runCommand("sh", args, options);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> }
): Promise<{ code: number | null; stdout: string; stderr: string; errorCode?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error: NodeJS.ErrnoException) => {
      resolve({
        code: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        errorCode: error.code
      });
    });
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function runPython(
  args: string[],
  options: { cwd: string; env?: Record<string, string> }
): Promise<{ code: number | null; stdout: string; stderr: string; errorCode?: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error: NodeJS.ErrnoException) => {
      resolve({
        code: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        errorCode: error.code
      });
    });
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}
