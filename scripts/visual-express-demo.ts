import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { renderDemoPage } from "../src/jobs/express-demo-page.js";

const fixturePath = path.resolve(process.argv[2] ?? "tests/fixtures/express-webserver-live-status.json");
const status = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
const html = renderDemoPage(status);
const htmlPath = path.join(tmpdir(), "switchboard-express-demo.html");
await writeFile(htmlPath, html);

const chrome = process.env.CHROME_BIN ?? findChrome();
if (!chrome) {
  console.log(`Rendered ${htmlPath}`);
  console.log("Chrome not found; set CHROME_BIN or install google-chrome to capture screenshots.");
  process.exit(0);
}

const profileDir = await mkdtemp(path.join(tmpdir(), "switchboard-chrome-"));
const captures = [
  { name: "desktop", size: "1440,1600" },
  { name: "mobile", size: "390,1200" }
];

for (const capture of captures) {
  const screenshotPath = path.join(tmpdir(), `switchboard-express-demo-${capture.name}.png`);
  const result = spawnSync(chrome, [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--user-data-dir=${profileDir}`,
    `--window-size=${capture.size}`,
    `--screenshot=${screenshotPath}`,
    pathToFileURL(htmlPath).href
  ], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`Chrome screenshot failed for ${capture.name}\n${result.stdout}\n${result.stderr}`);
  }
  console.log(`Wrote ${screenshotPath}`);
}

console.log(`Rendered ${htmlPath}`);

function findChrome(): string | undefined {
  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const result = spawnSync("which", ["google-chrome"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
