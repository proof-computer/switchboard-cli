import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const SWITCHBOARD_CLI = "switchboard";
export const SWITCHBOARD_NAME = "Switchboard";
export const SWITCHBOARD_LOCKUP = "Switchboard, a PROOF project";

export const SWITCHBOARD_PROJECT_CONFIG_FILE = "switchboard.json";
export const SWITCHBOARD_PROJECT_STATE_DIR = ".switchboard";
export const PROJECT_STATE_FILE = "state.json";

export const SWITCHBOARD_HOME_ENV = "SWITCHBOARD_HOME";
export const SWITCHBOARD_CONTEXT_ENV = "SWITCHBOARD_CONTEXT";

export interface ProjectRootMatch {
  root: string;
  configFile: string;
  configPath: string;
  stateDir: string;
  statePath: string;
}

export function defaultSwitchboardHome(): string {
  return path.join(homedir(), ".switchboard");
}

export function switchboardHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env[SWITCHBOARD_HOME_ENV] ?? defaultSwitchboardHome());
}

export function contextStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(switchboardHome(env), "contexts.json");
}

export function switchboardContextName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[SWITCHBOARD_CONTEXT_ENV];
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, SWITCHBOARD_PROJECT_CONFIG_FILE);
}

export function projectStateDir(projectRoot: string): string {
  return path.join(projectRoot, SWITCHBOARD_PROJECT_STATE_DIR);
}

export function projectStatePath(projectRoot: string): string {
  return path.join(projectStateDir(projectRoot), PROJECT_STATE_FILE);
}

export function relayStateDir(cwd: string = process.cwd()): string {
  return path.join(cwd, SWITCHBOARD_PROJECT_STATE_DIR, "relays");
}

export function relayStatePath(cwd: string, fileName: string): string {
  return path.join(relayStateDir(cwd), fileName);
}

export async function fileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

export async function findProjectRoot(start: string): Promise<ProjectRootMatch | undefined> {
  let current = path.resolve(start);
  while (true) {
    const modernConfigPath = projectConfigPath(current);
    if (await fileExists(modernConfigPath)) {
      return {
        root: current,
        configFile: SWITCHBOARD_PROJECT_CONFIG_FILE,
        configPath: modernConfigPath,
        stateDir: projectStateDir(current),
        statePath: projectStatePath(current)
      };
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export async function projectStateReadCandidates(projectRoot: string): Promise<string[]> {
  return [projectStatePath(projectRoot)];
}

export function projectConfigNamesForMessage(): string {
  return SWITCHBOARD_PROJECT_CONFIG_FILE;
}
