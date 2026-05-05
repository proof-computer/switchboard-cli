/**
 * Parse a human-readable duration string into milliseconds.
 *
 * Accepted units: ms, s, m, h, d, w. Examples: "500ms", "30s",
 * "15m", "1h", "7d", "2w". Integer values only; compound forms
 * like "1h30m" are not supported in v1.
 */
export function parseDuration(value: string): number {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)(ms|s|m|h|d|w)$/);
  if (!match) {
    throw new Error(
      `Invalid duration ${JSON.stringify(value)}. Expected formats: 500ms, 30s, 15m, 1h, 7d, 2w.`
    );
  }
  const amount = Number(match[1]);
  const unit = match[2];
  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1_000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 60 * 60_000;
    case "d":
      return amount * 24 * 60 * 60_000;
    case "w":
      return amount * 7 * 24 * 60 * 60_000;
  }
  throw new Error(`unreachable: unit=${unit as string}`);
}

/** Pretty-print ms back to a human-readable form for logs. */
export function formatDuration(ms: number): string {
  if (ms % (7 * 24 * 60 * 60_000) === 0) return `${ms / (7 * 24 * 60 * 60_000)}w`;
  if (ms % (24 * 60 * 60_000) === 0) return `${ms / (24 * 60 * 60_000)}d`;
  if (ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}
