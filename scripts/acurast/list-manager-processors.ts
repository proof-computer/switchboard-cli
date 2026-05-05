#!/usr/bin/env node
import "dotenv/config";
import {
  acurastNetworkFrom,
  createAcurastApi,
  discoverManagerProcessorsWithApi,
  selectReadyProcessors,
  type AcurastNetwork,
  type ProcessorInfo
} from "../../src/acurast-manager.js";

interface ParsedArgs {
  flags: Map<string, string | boolean>;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const network = networkFlag(parsed.flags);
  const managerId = stringFlag(parsed.flags, "manager-id") ?? process.env.ACURAST_MANAGER_ID;
  if (!managerId) {
    throw new Error("Set ACURAST_MANAGER_ID or pass --manager-id <id>");
  }

  const limit = numberFlag(parsed.flags, "limit", 20);
  const maxAgeSeconds = numberFlag(parsed.flags, "max-age-seconds", 900);
  const maxChainLagSeconds = numberFlag(parsed.flags, "max-chain-lag-seconds", 300);
  const rpcUrl = rpcForNetwork(network);
  const api = await createAcurastApi({ network, rpcUrl });

  try {
    const availabilityDurationMs = optionalNumberFlag(parsed.flags, "available-for-ms");
    const checkAvailability = boolFlag(parsed.flags, "available") || availabilityDurationMs !== undefined;
    const inventory = await discoverManagerProcessorsWithApi(api, {
      network,
      managerId,
      rpcUrl,
      maxAgeSeconds,
      checkAvailability,
      startDelayMs: numberFlag(parsed.flags, "start-delay-ms", 120_000),
      durationMs: availabilityDurationMs ?? numberFlag(parsed.flags, "duration-ms", 300_000)
    });
    const chainTimestampIso = inventory.chainTimestampIso;
    const chainLagSeconds = inventory.chainLagSeconds;
    if (chainLagSeconds > maxChainLagSeconds && !boolFlag(parsed.flags, "json")) {
      console.error(
        `[acurast:processors] warning: RPC chain timestamp is ${chainLagSeconds}s behind local time (${chainTimestampIso})`
      );
    }

    const details = inventory.processors;
    const recent = details.filter(
      (processor) => processor.heartbeatAgeSeconds !== null && processor.heartbeatAgeSeconds <= maxAgeSeconds
    );
    const available = checkAvailability ? details.filter((processor) => processor.availability?.conflicts === 0) : details;
    const recentAvailable = checkAvailability
      ? recent.filter((processor) => processor.availability?.conflicts === 0)
      : recent;
    const selected = checkAvailability
      ? selectReadyProcessors(details, {
          maxAgeSeconds,
          requireAvailability: true,
          limit
        })
      : (recent.length > 0 ? recent : details).slice(0, limit);

    if (checkAvailability && selected.length === 0) {
      throw new Error("No manager processors are available for the requested schedule window");
    }

    if (boolFlag(parsed.flags, "json")) {
      console.log(
        JSON.stringify(
          {
            network,
            managerId,
            rpcUrl,
            chainTimestampIso,
            chainLagSeconds,
            maxChainLagSeconds,
            totalProcessors: inventory.totalProcessors,
            recentProcessors: recent.length,
            availableProcessors: checkAvailability ? available.length : undefined,
            recentAvailableProcessors: checkAvailability ? recentAvailable.length : undefined,
            maxAgeSeconds,
            availabilityWindow: inventory.availabilityWindow,
            selected
          },
          null,
          2
        )
      );
      return;
    }

    if (boolFlag(parsed.flags, "env")) {
      console.log(`ACURAST_INSTANT_MATCH_PROCESSORS=${selected.map((processor) => processor.processor).join(",")}`);
      return;
    }

    console.log(`Network: ${network}`);
    console.log(`Manager ID: ${managerId}`);
    console.log(`Chain timestamp: ${chainTimestampIso} (${chainLagSeconds}s behind local time)`);
    console.log(`Processors: ${inventory.totalProcessors} total, ${recent.length} seen within ${maxAgeSeconds}s`);
    if (checkAvailability) {
      console.log(
        `Availability: ${available.length} available, ${recentAvailable.length} recent for ${inventory.availabilityWindow?.proposedStartIso} to ${inventory.availabilityWindow?.proposedEndIso}`
      );
    }
    console.log("");
    for (const processor of selected) {
      console.log(
        [
          processor.processor,
          processor.heartbeatIso ? `heartbeat=${processor.heartbeatIso}` : "heartbeat=unknown",
          processor.heartbeatAgeSeconds !== null ? `age=${processor.heartbeatAgeSeconds}s` : "age=unknown",
          `version=${formatVersion(processor.version)}`,
          processor.availability
            ? `matches=${processor.availability.matches} conflicts=${processor.availability.conflicts}`
            : undefined
        ]
          .filter(Boolean)
          .join(" ")
      );
    }
    if (checkAvailability) {
      const conflicted = details.filter((processor) => processor.availability && processor.availability.conflicts > 0).slice(0, 5);
      if (conflicted.length > 0) {
        console.log("");
        console.log("First conflicting processors:");
        for (const processor of conflicted) {
          console.log(
            [
              processor.processor,
              `conflicts=${processor.availability?.conflicts ?? 0}`,
              processor.availability?.conflictingJobs[0]?.endIso
                ? `firstConflictEnds=${processor.availability.conflictingJobs[0].endIso}`
                : undefined
            ]
              .filter(Boolean)
              .join(" ")
          );
        }
      }
    }
    console.log("");
    console.log(`ACURAST_INSTANT_MATCH_PROCESSORS=${selected.map((processor) => processor.processor).join(",")}`);
  } finally {
    await api.disconnect();
  }
}

function rpcForNetwork(network: AcurastNetwork): string {
  if (network === "mainnet") {
    return process.env.ACURAST_RPC ?? "wss://archive.mainnet.acurast.com";
  }

  return process.env.ACURAST_CANARY_RPC ?? "wss://canarynet-ws-1.acurast-h-server-2.papers.tech";
}

function networkFlag(flags: Map<string, string | boolean>): AcurastNetwork {
  return acurastNetworkFrom(stringFlag(flags, "network") ?? process.env.ACURAST_NETWORK);
}

function parseArgs(args: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const withoutPrefix = arg.slice(2);
    const [name, inlineValue] = withoutPrefix.split("=", 2);
    if (inlineValue !== undefined) {
      flags.set(name, inlineValue);
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }

  return { flags };
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function numberFlag(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  const value = stringFlag(flags, name);
  if (!value) {
    return fallback;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return Number(value);
}

function optionalNumberFlag(flags: Map<string, string | boolean>, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (!value) {
    return undefined;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return Number(value);
}

function formatVersion(version: unknown): string {
  if (!version || typeof version !== "object") {
    return JSON.stringify(version);
  }

  const record = version as { platform?: unknown; buildNumber?: unknown };
  return `platform:${String(record.platform ?? "?")},build:${String(record.buildNumber ?? "?")}`;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[acurast:processors] ${message}`);
  process.exitCode = 1;
});
