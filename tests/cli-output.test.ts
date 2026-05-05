import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deployFailureSummary } from "../cli/src/index.js";
import {
  compactId,
  formatAcuUnits,
  formatRows,
  createGroupedDeployTranscriptWriter,
  createWaitLogCoalescer,
  switchboardColorEnabled
} from "../cli/src/output.js";

describe("switchboard CLI output helpers", () => {
  it("compacts long identifiers while leaving short values intact", () => {
    assert.equal(compactId("short"), "short");
    assert.equal(compactId("0xd919a5260e31fdcf931bb5d80aeb1a4e287111efcf07702de81a61e9334af45e"), "0xd919a5...f45e");
    assert.equal(compactId("5DtHHZiofGKEYJUC5v5rVQAwAEhNh5BPQ8tP4qm92xomHVv5"), "5DtHH...HVv5");
  });

  it("formats ACU base units for public cost rows", () => {
    assert.equal(formatAcuUnits("40000000000"), "0.04 ACU");
    assert.equal(formatAcuUnits("1000000000000"), "1 ACU");
    assert.equal(formatAcuUnits("not-a-number"), "not-a-number");
  });

  it("aligns non-empty key value rows", () => {
    assert.deepEqual(
      formatRows([
        { label: "URL", value: "https://example.test" },
        { label: "Runtime", value: "20m" },
        { label: "Empty", value: undefined }
      ]),
      ["URL      https://example.test", "Runtime  20m"]
    );
  });

  it("honors color environment controls", () => {
    const tty = { isTTY: true } as NodeJS.WriteStream;
    const pipe = { isTTY: false } as NodeJS.WriteStream;
    assert.equal(switchboardColorEnabled(pipe, {}), false);
    assert.equal(switchboardColorEnabled(tty, {}), true);
    assert.equal(switchboardColorEnabled(tty, { NO_COLOR: "1" }), false);
    assert.equal(switchboardColorEnabled(pipe, { FORCE_COLOR: "1" }), true);
    assert.equal(switchboardColorEnabled(tty, { SWITCHBOARD_COLOR: "0" }), false);
  });

  it("groups deploy runner transcript lines by owner without changing line content", () => {
    let output = "";
    const stream = {
      isTTY: false,
      write(chunk: string) {
        output += chunk;
        return true;
      }
    } as NodeJS.WriteStream;
    const writer = createGroupedDeployTranscriptWriter();

    writer.write("[switchboard-deploy] [info] Run context run=1\n[switchboard-deploy] [ok] Submitted\n", stream);
    writer.write('Deploying project "switchboard-express"\n\nDirect deploy tx status: Ready 0xabc\n', stream);
    writer.write("[switchboard-deploy] report=/tmp/report.json", stream);
    writer.flush();

    assert.equal(
      output,
      [
        "Switchboard runner",
        "  [info] Run context run=1",
        "  [ok] Submitted",
        "",
        "Acurast deployer",
        '  Deploying project "switchboard-express"',
        "",
        "  Direct deploy tx status: Ready 0xabc",
        "",
        "Switchboard runner",
        "  report=/tmp/report.json",
        ""
      ].join("\n")
    );
  });

  it("strips colored switchboard deploy prefixes while preserving the status body", () => {
    let output = "";
    const stream = {
      isTTY: false,
      write(chunk: string) {
        output += chunk;
        return true;
      }
    } as NodeJS.WriteStream;
    const writer = createGroupedDeployTranscriptWriter();

    writer.write("\u001b[38;2;255;106;44m[switchboard-deploy]\u001b[0m \u001b[2m[info]\u001b[0m Run context\n", stream);

    assert.equal(output, "Switchboard runner\n  \u001b[2m[info]\u001b[0m Run context\n");
  });

  it("coalesces repeated wait logs until state or interval changes", () => {
    const coalescer = createWaitLogCoalescer(1_000);
    assert.equal(coalescer.shouldEmit({ key: "runtime", state: "pending", nowMs: 0 }), true);
    assert.equal(coalescer.shouldEmit({ key: "runtime", state: "pending", nowMs: 500 }), false);
    assert.equal(coalescer.shouldEmit({ key: "runtime", state: "claimed", nowMs: 500 }), true);
    assert.equal(coalescer.shouldEmit({ key: "runtime", state: "claimed", nowMs: 1_000 }), false);
    assert.equal(coalescer.shouldEmit({ key: "runtime", state: "claimed", nowMs: 1_501 }), true);
  });

  it("reports public route verification as the failing stage when DNS already published", () => {
    const summary = deployFailureSummary(
      "waiting for canonical dns e.example status=written\npublished dns e.example -> 2.122.7.112\ntimed out waiting for public route after 180000ms"
    );
    assert.equal(summary.stage, "Verifying the public HTTPS route");
  });
});
