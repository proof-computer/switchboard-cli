import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { renderDemoPage } from "../src/jobs/express-demo-page.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(repoRoot, "tests/fixtures/express-webserver-live-status.json");

describe("express demo page renderer", () => {
  it("renders the live paid-ingress status fixture as readable proof data", async () => {
    const status = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
    const html = renderDemoPage(status);

    assert.match(html, /Running on <span class="acurast-accent">Acurast,/);
    assert.match(html, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
    assert.match(html, /ZeroSSL RSA DV SSL CA 2/);
    assert.match(html, /expires 2026-08-04 23:59:59 UTC/);
    assert.match(html, /Acurast deployment <a href="https:\/\/hub\.acurast\.com\/explorer\/deployment\/54098" title="https:\/\/hub\.acurast\.com\/explorer\/deployment\/54098" target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /0xffc044d4\.\.\.ac5a8227/);
    assert.match(html, /block <a href="https:\/\/assethub-polkadot\.subscan\.io\/block\/15429604" title="https:\/\/assethub-polkadot\.subscan\.io\/block\/15429604" target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /td \{ font-size: 14px; font-weight: 560; \}/);
    assert.match(html, /android arm64 \/ v24\.5\.0/);
    assert.match(html, /Diagnostic Data/);
    assert.match(html, /Environment presence/);
    assert.doesNotMatch(html, /Live proof/);
    assert.doesNotMatch(html, /Job-owned TLS/);
    assert.doesNotMatch(html, /Hub registered/);
    assert.doesNotMatch(html, /Challenge served/);
    assert.doesNotMatch(html, /Runtime signer/);
    assert.doesNotMatch(html, /Route live/);
    assert.doesNotMatch(html, /Public URL/);
    assert.doesNotMatch(html, /Quick links/);
    assert.doesNotMatch(html, /class="proof-item/);
    assert.doesNotMatch(html, /class="badge/);
    assert.doesNotMatch(html, /max-height: 360px/);
    assert.doesNotMatch(html, /overflow: auto/);
    assert.doesNotMatch(html, /<th>Gateway ID<\/th>/);
    assert.doesNotMatch(html, /<th>Job ends<\/th>/);
  });

  it("keeps full long identifiers available in title attributes while shortening display text", async () => {
    const status = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, any>;
    const html = renderDemoPage(status);

    assert.match(html, /class="mono" title="0xc622b41bbdc550f7d27675e66fdf324e95dcb5a88d053fd211a420a924c42d13">0xc622b4/);
    assert.match(html, /title="0xfbd6883ba5e4a7fd98ea7e0ba9f4c40c129eb22f995b38b0df78a419f6db1eca">0xfbd6883/);
    assert.match(html, /title="\{&quot;origin&quot;:\{&quot;kind&quot;:&quot;Acurast&quot;/);
  });

  it("renders optional gateway and job end rows when the static status knows them", async () => {
    const status = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, any>;
    status.routing.gatewayId = "switchboard-az-01";
    status.acurast = {
      scheduleEndMs: Date.parse("2026-05-07T04:56:38.538Z")
    };

    const html = renderDemoPage(status);

    assert.match(html, /<th>Gateway ID<\/th><td>switchboard-az-01<\/td>/);
    assert.match(html, /<th>Job ends<\/th><td>2026-05-07 04:56:38\.538 UTC<\/td>/);
  });
});
