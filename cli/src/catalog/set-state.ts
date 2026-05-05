import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { serviceStateSchema, type ServiceState } from "../../../src/service-catalog.js";
import {
  catalogBuildSpecSchema,
  runCatalogBuild,
  type CatalogBuildSpec
} from "./build.js";
import type { CatalogIo } from "./io.js";
import { defaultCatalogIo } from "./io.js";

export interface RunCatalogSetStateOptions {
  flags: Map<string, string | boolean>;
  positionals?: string[];
  env?: NodeJS.ProcessEnv;
  io?: CatalogIo;
}

export interface CatalogSetStateResult {
  specFile: string;
  role: "control-api" | "relay";
  serviceId: string;
  previousState: ServiceState | undefined;
  nextState: ServiceState;
  rebuilt: boolean;
}

export async function runCatalogSetState(options: RunCatalogSetStateOptions): Promise<CatalogSetStateResult> {
  const io = options.io ?? defaultCatalogIo();
  const positionals = options.positionals ?? [];

  // positionals shape: ["catalog", "set-state", "<role>", "<service-id>", "<state>"]
  // Allow short form: ["catalog", "set-state", "<service-id>", "<state>"] -> assumes role=relay.
  const { role, serviceId, stateInput } = parseSetStateArgs(positionals, options.flags);
  const stateResult = serviceStateSchema.safeParse(stateInput);
  if (!stateResult.success) {
    throw new Error(
      `Invalid catalog state ${JSON.stringify(stateInput)}: must be candidate|active|degraded|draining|disabled`
    );
  }
  const nextState = stateResult.data;

  const specFile = stringFlag(options.flags, "spec") ?? stringFlag(options.flags, "spec-file");
  if (!specFile) {
    throw new Error(
      "switchboard catalog set-state requires --spec <file> pointing at the catalog build spec JSON"
    );
  }
  const resolved = path.resolve(specFile);
  const raw = await readFile(resolved, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const spec = catalogBuildSpecSchema.parse(parsed);

  const { spec: nextSpec, previousState } = applySetState(spec, role, serviceId, nextState);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(nextSpec, null, 2)}\n`, "utf8");
  io.log(`Updated ${resolved}: ${role}/${serviceId} state ${previousState ?? "(unset)"} -> ${nextState}`);

  const rebuild = !boolFlag(options.flags, "no-rebuild");
  if (rebuild) {
    await runCatalogBuild({
      flags: withSpecFlag(options.flags, resolved),
      env: options.env,
      io
    });
  } else {
    io.log("Skipped catalog rebuild because --no-rebuild was passed.");
  }

  return {
    specFile: resolved,
    role,
    serviceId,
    previousState,
    nextState,
    rebuilt: rebuild
  };
}

export function applySetState(
  spec: CatalogBuildSpec,
  role: "control-api" | "relay",
  serviceId: string,
  nextState: ServiceState
): { spec: CatalogBuildSpec; previousState: ServiceState | undefined } {
  if (role === "control-api") {
    let previousState: ServiceState | undefined;
    let found = false;
    const controlApi = spec.controlApi.map((entry) => {
      if (entry.serviceId !== serviceId) return entry;
      found = true;
      previousState = entry.state;
      return { ...entry, state: nextState };
    });
    if (!found) {
      throw new Error(`control-api/${serviceId} is not present in the catalog spec`);
    }
    return { spec: { ...spec, controlApi }, previousState };
  }

  let previousState: ServiceState | undefined;
  let found = false;
  const relays = spec.relays.map((entry) => {
    if (entry.relayId !== serviceId) return entry;
    found = true;
    previousState = entry.state;
    const { active: _legacyActive, ...rest } = entry;
    return { ...rest, state: nextState };
  });
  if (!found) {
    throw new Error(`relay/${serviceId} is not present in the catalog spec`);
  }
  return { spec: { ...spec, relays }, previousState };
}

function parseSetStateArgs(
  positionals: string[],
  flags: Map<string, string | boolean>
): { role: "control-api" | "relay"; serviceId: string; stateInput: string } {
  const explicitRole = stringFlag(flags, "role");
  const tail = positionals.slice(2); // drop ["catalog", "set-state"]

  if (tail.length === 3) {
    const [roleArg, serviceId, stateInput] = tail;
    return { role: validateRole(roleArg), serviceId, stateInput };
  }
  if (tail.length === 2) {
    const [serviceId, stateInput] = tail;
    const role = validateRole(explicitRole ?? "relay");
    return { role, serviceId, stateInput };
  }
  throw new Error(
    "Usage: switchboard catalog set-state <role> <service-id> <state>  (role is control-api or relay)"
  );
}

function validateRole(role: string | undefined): "control-api" | "relay" {
  if (role === "control-api" || role === "relay") return role;
  throw new Error(`role must be control-api or relay (got ${JSON.stringify(role)})`);
}

function withSpecFlag(flags: Map<string, string | boolean>, specFile: string): Map<string, string | boolean> {
  const next = new Map(flags);
  next.set("spec", specFile);
  return next;
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}
