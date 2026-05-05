export const SWITCHBOARD_ORANGE_HEX = "#FF6A2C";

const ANSI_ORANGE = "\u001b[38;2;255;106;44m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_RED = "\u001b[31m";
const ANSI_DIM = "\u001b[2m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_RESET = "\u001b[0m";

export type OutputStatus = "info" | "ok" | "wait" | "warn" | "error";

export interface OutputRow {
  label: string;
  value: unknown;
}

export interface GroupedDeployTranscriptWriter {
  write(chunk: Buffer | string, stream?: NodeJS.WriteStream): void;
  flush(): void;
}

export interface WaitLogCoalescer {
  shouldEmit(input: { key: string; state?: string; nowMs?: number; intervalMs?: number }): boolean;
}

const SWITCHBOARD_DEPLOY_PREFIX = "[switchboard-deploy]";
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g;

export function switchboardColorEnabled(stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv = process.env): boolean {
  if (
    envColorDisabled(env.SWITCHBOARD_COLOR) ||
    envColorDisabled(env.SWITCHBOARD_DEPLOY_COLOR) ||
    envColorDisabled(env.FORCE_COLOR) ||
    env.NO_COLOR ||
    env.TERM === "dumb"
  ) {
    return false;
  }
  if (envColorEnabled(env.SWITCHBOARD_COLOR) || envColorEnabled(env.SWITCHBOARD_DEPLOY_COLOR) || envColorEnabled(env.FORCE_COLOR)) {
    return true;
  }
  return Boolean(stream.isTTY);
}

export function orange(value: string, stream: NodeJS.WriteStream = process.stdout): string {
  return color(value, ANSI_ORANGE, stream);
}

export function bold(value: string, stream: NodeJS.WriteStream = process.stdout): string {
  return color(value, ANSI_BOLD, stream);
}

export function dim(value: string, stream: NodeJS.WriteStream = process.stdout): string {
  return color(value, ANSI_DIM, stream);
}

export function statusMarker(status: OutputStatus, stream: NodeJS.WriteStream = process.stdout): string {
  const marker =
    status === "ok"
      ? "[ok]"
      : status === "wait"
        ? "[..]"
        : status === "warn"
          ? "[warn]"
          : status === "error"
            ? "[err]"
            : "[info]";
  const code =
    status === "ok"
      ? ANSI_GREEN
      : status === "warn"
        ? ANSI_YELLOW
        : status === "error"
          ? ANSI_RED
          : status === "wait"
            ? ANSI_ORANGE
            : ANSI_DIM;
  return color(marker, code, stream);
}

export function sectionTitle(title: string, stream: NodeJS.WriteStream = process.stdout): string {
  return orange(bold(title, stream), stream);
}

export function statusLine(status: OutputStatus, label: string, detail?: string, stream: NodeJS.WriteStream = process.stdout): string {
  return `${statusMarker(status, stream)} ${label}${detail ? ` ${dim(detail, stream)}` : ""}`;
}

export function formatRows(rows: OutputRow[]): string[] {
  const visible = rows
    .map((row) => ({ label: row.label, value: stringifyRowValue(row.value) }))
    .filter((row) => row.value.length > 0);
  const width = Math.max(0, ...visible.map((row) => row.label.length));
  return visible.map((row) => `${row.label.padEnd(width)}  ${row.value}`);
}

export function createGroupedDeployTranscriptWriter(): GroupedDeployTranscriptWriter {
  const buffers = new Map<NodeJS.WriteStream, string>();
  let currentGroup: "switchboard" | "acurast" | undefined;

  const emitLine = (rawLine: string, stream: NodeJS.WriteStream) => {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) {
      stream.write("\n");
      return;
    }

    const group = deployTranscriptLineGroup(line);
    if (group !== currentGroup) {
      if (currentGroup) {
        stream.write("\n");
      }
      stream.write(`${sectionTitle(group === "switchboard" ? "Switchboard runner" : "Acurast deployer", stream)}\n`);
      currentGroup = group;
    }

    const rendered = group === "switchboard" ? stripSwitchboardDeployPrefix(line) : line;
    stream.write(`  ${rendered}\n`);
  };

  return {
    write(chunk: Buffer | string, stream: NodeJS.WriteStream = process.stdout) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const combined = `${buffers.get(stream) ?? ""}${text}`;
      const parts = combined.split(/\n/);
      buffers.set(stream, parts.pop() ?? "");
      for (const line of parts) {
        emitLine(line, stream);
      }
    },
    flush() {
      for (const [stream, buffered] of buffers.entries()) {
        if (buffered.length > 0) {
          emitLine(buffered, stream);
          buffers.set(stream, "");
        }
      }
    }
  };
}

export function createWaitLogCoalescer(defaultIntervalMs = 60_000): WaitLogCoalescer {
  const emitted = new Map<string, { state: string; emittedAt: number }>();
  return {
    shouldEmit(input: { key: string; state?: string; nowMs?: number; intervalMs?: number }): boolean {
      const nowMs = input.nowMs ?? Date.now();
      const intervalMs = input.intervalMs ?? defaultIntervalMs;
      const state = input.state ?? "";
      const previous = emitted.get(input.key);
      if (!previous || previous.state !== state || nowMs - previous.emittedAt >= intervalMs) {
        emitted.set(input.key, { state, emittedAt: nowMs });
        return true;
      }
      return false;
    }
  };
}

export function compactId(value: unknown, options: { start?: number; end?: number; max?: number } = {}): string {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }
  const start = options.start ?? (value.startsWith("0x") ? 8 : 5);
  const end = options.end ?? 4;
  const max = options.max ?? start + end + 3;
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

export function formatAcuUnits(raw: unknown): string {
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) {
    return stringifyRowValue(raw);
  }
  const units = BigInt(raw);
  const scale = 1_000_000_000_000n;
  const whole = units / scale;
  const fraction = units % scale;
  if (fraction === 0n) {
    return `${whole.toString()} ACU`;
  }
  const padded = fraction.toString().padStart(12, "0").replace(/0+$/, "");
  return `${whole.toString()}.${padded} ACU`;
}

function deployTranscriptLineGroup(line: string): "switchboard" | "acurast" {
  return stripAnsi(line).startsWith(SWITCHBOARD_DEPLOY_PREFIX) ? "switchboard" : "acurast";
}

function stripSwitchboardDeployPrefix(line: string): string {
  const prefixPattern = new RegExp(`^(?:${ANSI_ESCAPE_PATTERN.source})*\\[switchboard-deploy\\](?:${ANSI_ESCAPE_PATTERN.source})*\\s?`);
  return line.replace(prefixPattern, "");
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function color(value: string, code: string, stream: NodeJS.WriteStream): string {
  return switchboardColorEnabled(stream) ? `${code}${value}${ANSI_RESET}` : value;
}

function stringifyRowValue(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function envColorEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function envColorDisabled(value: string | undefined): boolean {
  return value === "0" || value?.toLowerCase() === "false";
}
