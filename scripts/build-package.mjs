import { chmod, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist");
const internalDir = path.join(distDir, "internal");
const jobAssetsDir = path.join(repoRoot, "assets", "jobs");
const cliOutfile = path.join(distDir, "index.js");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await mkdir(internalDir, { recursive: true });
await rm(jobAssetsDir, { recursive: true, force: true });
await mkdir(jobAssetsDir, { recursive: true });

const nodeBundle = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  banner: {
    js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);'
  },
  external: [
    "esbuild",
    "@ledgerhq/hw-transport-node-hid-singleton",
    "@zondax/ledger-substrate"
  ],
  logLevel: "info"
};

await build({
  entryPoints: [path.join(repoRoot, "cli", "src", "index.ts")],
  outfile: cliOutfile,
  ...nodeBundle
});

await chmod(cliOutfile, 0o755);
console.log(`Built ${cliOutfile}`);

const internalEntrypoints = {
  "switchboard-deploy": "scripts/acurast/switchboard-deploy.ts",
  "acurast-express": "scripts/acurast/express-harness.ts",
  "acurast-list-processors": "scripts/acurast/list-manager-processors.ts",
  "hub-fund-evm-session": "scripts/hub/fund-evm-session.ts",
  "hub-fund-native-asset-quote": "scripts/hub/fund-asset-quote-native.ts",
  "hub-read-session": "scripts/hub/read-session.ts",
  "route-validator": "scripts/validation/route-validator.ts"
};

for (const [name, entrypoint] of Object.entries(internalEntrypoints)) {
  const outfile = path.join(internalDir, `${name}.js`);
  await build({
    entryPoints: [path.join(repoRoot, entrypoint)],
    outfile,
    ...nodeBundle
  });
  await chmod(outfile, 0o755);
  console.log(`Built ${outfile}`);
}

const jobBundles = {
  "express-webserver": "src/jobs/express-webserver.ts",
  "validator-job": "src/jobs/validator-job.ts"
};

for (const [name, entrypoint] of Object.entries(jobBundles)) {
  const outfile = path.join(jobAssetsDir, name, "bundle.cjs");
  await mkdir(path.dirname(outfile), { recursive: true });
  await build({
    entryPoints: [path.join(repoRoot, entrypoint)],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: false,
    minify: true,
    legalComments: "none",
    define: {
      __SWITCHBOARD_BUILD_CONFIG__: "process.env.SWITCHBOARD_BUILD_CONFIG"
    },
    logLevel: "info"
  });
  await chmod(outfile, 0o644);
  console.log(`Built ${outfile}`);
}
