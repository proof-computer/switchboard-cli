export const SWITCHBOARD_CHALLENGE_PATH = "/.well-known/proofcomputer/challenge";

export interface SwitchboardChallengeConfig {
  sessionId: string | (() => string);
  deploymentId?: string;
  jobId?: string | (() => string | undefined);
  onChallenge?: (event: SwitchboardChallengeEvent) => void | Promise<void>;
}

export interface SwitchboardChallengeEvent {
  nonce: string;
  timestamp: number;
  path: string;
  userAgent?: string;
  remoteAddress?: string;
}

export interface SwitchboardChallengeRequest {
  nonce: unknown;
  path: string;
  userAgent?: string;
  remoteAddress?: string;
}

export interface SwitchboardChallengeResponse {
  sessionId: string;
  nonce: string;
  deploymentId?: string;
  jobId?: string;
  timestamp: number;
}

export interface SwitchboardChallengeError {
  error: "missing_nonce";
}

export interface SwitchboardChallengeResult {
  statusCode: number;
  headers: Record<string, string>;
  body: SwitchboardChallengeResponse | SwitchboardChallengeError;
}

export function buildSwitchboardChallengeResult(
  config: SwitchboardChallengeConfig,
  request: SwitchboardChallengeRequest
): SwitchboardChallengeResult {
  if (typeof request.nonce !== "string" || request.nonce.length === 0) {
    return {
      statusCode: 400,
      headers: {
        "cache-control": "no-store"
      },
      body: {
        error: "missing_nonce"
      }
    };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  if (config.onChallenge) {
    void Promise.resolve(
      config.onChallenge({
        nonce: request.nonce,
        timestamp,
        path: request.path,
        userAgent: request.userAgent,
        remoteAddress: request.remoteAddress
      })
    ).catch(() => undefined);
  }

  return {
    statusCode: 200,
    headers: {
      "cache-control": "no-store"
    },
    body: {
      sessionId: dynamicString(config.sessionId),
      nonce: request.nonce,
      deploymentId: config.deploymentId,
      jobId: dynamicOptionalString(config.jobId),
      timestamp
    }
  };
}

function dynamicString(value: string | (() => string)): string {
  return typeof value === "function" ? value() : value;
}

function dynamicOptionalString(value: string | (() => string | undefined) | undefined): string | undefined {
  return typeof value === "function" ? value() : value;
}
