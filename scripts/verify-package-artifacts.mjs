import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const requiredArtifacts = [
  "dist/index.js",
  "dist/internal/switchboard-deploy.js",
  "dist/internal/acurast-express.js",
  "dist/internal/acurast-list-processors.js",
  "dist/internal/hub-fund-evm-session.js",
  "dist/internal/hub-fund-native-asset-quote.js",
  "dist/internal/hub-read-session.js",
  "dist/internal/route-validator.js",
  "assets/jobs/validator-job/bundle.cjs"
];
const broadPackageEntries = new Set(["dist", "dist/", "dist/**"]);
const requiredBundleMarkers = [
  {
    artifact: "dist/index.js",
    markers: [
      "must declare signer or digest",
      "digest mismatch",
      "Quote expectedJobSigner",
      "Active operator profiles require at least one report signer"
    ]
  },
  {
    artifact: "dist/internal/route-validator.js",
    markers: ["must declare signer or digest", "digest mismatch"]
  }
];
const forbiddenBundleMarkers = [
  {
    artifact: "dist/internal/hub-fund-native-asset-quote.js",
    markers: ["Public beta deployer commands:"]
  },
  {
    artifact: "dist/internal/hub-fund-evm-session.js",
    markers: ["Public beta deployer commands:"]
  },
  {
    artifact: "dist/internal/hub-read-session.js",
    markers: ["Public beta deployer commands:"]
  },
  {
    artifact: "dist/internal/acurast-list-processors.js",
    markers: ["Public beta deployer commands:"]
  }
];
const forbiddenBundlePatterns = [
  {
    artifact: "dist/index.js",
    checks: [
      { label: "direct pnpm spawn", pattern: /spawn\d*\("pnpm"/ },
      { label: "user-facing pnpm relay command", pattern: /> pnpm|pnpm acurast/ },
      { label: "old private operator image default", pattern: /ghcr\.io\/(?:proof-computer|mooselabs)\/switchboard\/operator:/ }
    ]
  },
  {
    artifact: "assets/operator/docker-compose.yaml",
    checks: [
      { label: "old private operator image default", pattern: /ghcr\.io\/(?:proof-computer|mooselabs)\/switchboard\/operator:/ }
    ]
  },
  {
    artifact: "assets/operator/operator.env.example",
    checks: [
      { label: "old private operator image default", pattern: /ghcr\.io\/(?:proof-computer|mooselabs)\/switchboard\/operator:/ }
    ]
  }
];

const missing = [];
for (const artifact of requiredArtifacts) {
  try {
    await access(path.join(repoRoot, artifact));
  } catch {
    missing.push(artifact);
  }
}

const staleBundles = [];
for (const { artifact, markers } of requiredBundleMarkers) {
  try {
    const contents = await readFile(path.join(repoRoot, artifact), "utf8");
    const missingMarkers = markers.filter((marker) => !contents.includes(marker));
    if (missingMarkers.length > 0) {
      staleBundles.push({ artifact, missingMarkers });
    }
  } catch {
    // Missing artifacts are reported by the required artifact check above.
  }
}

const contaminatedBundles = [];
for (const { artifact, markers } of forbiddenBundleMarkers) {
  try {
    const contents = await readFile(path.join(repoRoot, artifact), "utf8");
    const presentMarkers = markers.filter((marker) => contents.includes(marker));
    if (presentMarkers.length > 0) {
      contaminatedBundles.push({ artifact, presentMarkers });
    }
  } catch {
    // Missing artifacts are reported by the required artifact check above.
  }
}

const forbiddenRuntimePatterns = [];
for (const { artifact, checks } of forbiddenBundlePatterns) {
  try {
    const contents = await readFile(path.join(repoRoot, artifact), "utf8");
    const presentChecks = checks.filter(({ pattern }) => pattern.test(contents));
    if (presentChecks.length > 0) {
      forbiddenRuntimePatterns.push({ artifact, presentChecks });
    }
  } catch {
    // Missing artifacts are reported by the required artifact check above.
  }
}

const broadEntries = (packageJson.files ?? []).filter((entry) => broadPackageEntries.has(entry));

if (
  missing.length > 0 ||
  staleBundles.length > 0 ||
  contaminatedBundles.length > 0 ||
  forbiddenRuntimePatterns.length > 0 ||
  broadEntries.length > 0
) {
  const details = [];
  if (missing.length > 0) {
    details.push(
      "Missing generated package artifacts required for GitHub npm install:",
      ...missing.map((artifact) => `  - ${artifact}`),
      "Run `npm run build` before packing or installing from GitHub."
    );
  }
  if (staleBundles.length > 0) {
    if (details.length > 0) details.push("");
    details.push(
      "Generated package bundles are stale and do not contain required package guards.",
      ...staleBundles.flatMap(({ artifact, missingMarkers }) => [
        `  - ${artifact}`,
        ...missingMarkers.map((marker) => `    missing marker: ${marker}`)
      ]),
      "Run `npm run build` before packing or installing from GitHub."
    );
  }
  if (contaminatedBundles.length > 0) {
    if (details.length > 0) details.push("");
    details.push(
      "Generated internal helper bundles must not include the top-level CLI help entrypoint.",
      ...contaminatedBundles.flatMap(({ artifact, presentMarkers }) => [
        `  - ${artifact}`,
        ...presentMarkers.map((marker) => `    forbidden marker: ${marker}`)
      ]),
      "Avoid importing cli/src/index.ts from internal helper dependencies; use side-effect-free shared modules instead."
    );
  }
  if (forbiddenRuntimePatterns.length > 0) {
    if (details.length > 0) details.push("");
    details.push(
      "Packaged CLI bundles must not require pnpm at runtime.",
      ...forbiddenRuntimePatterns.flatMap(({ artifact, presentChecks }) => [
        `  - ${artifact}`,
        ...presentChecks.map(({ label }) => `    forbidden pattern: ${label}`)
      ]),
      "Installed CLI paths should dispatch to bundled dist/internal/*.js helpers with node."
    );
  }
  if (broadEntries.length > 0) {
    if (details.length > 0) details.push("");
    details.push(
      "package.json must not publish the whole dist tree; local Acurast stage directories under dist/acurast can contain credentials.",
      ...broadEntries.map((entry) => `  - files entry: ${entry}`),
      "List only the committed CLI bundles, for example dist/index.js and dist/internal."
    );
  }
  throw new Error(
    details.join("\n")
  );
}
