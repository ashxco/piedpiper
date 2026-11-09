import { readdir, readFile } from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { resolveClaudeConfigDir } from "../Layers/ClaudeExecutable";
import { claudeManagedConfigDir } from "./managedMcpConfig";

async function readClaudeSettingsFileEnv(filePath: string): Promise<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    // Claude ignores a missing or malformed settings file too.
    return {};
  }
  const env = (parsed as { env?: unknown } | null)?.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return {};
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function managedSettingsPaths(managedDir: string): Promise<ReadonlyArray<string>> {
  const dropInDir = Path.join(managedDir, "managed-settings.d");
  const dropIns = await readdir(dropInDir).catch(() => [] as ReadonlyArray<string>);
  return [
    Path.join(managedDir, "managed-settings.json"),
    ...dropIns
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .toSorted()
      .map((name) => Path.join(dropInDir, name)),
  ];
}

/**
 * The `env` Claude Code applies over the process env, from the account's settings then the
 * administrator's, later files winning. Project files are left out: this answers for the machine,
 * and health checks run in the state dir, which is no project.
 */
export async function readClaudeSettingsEnv(
  input: {
    /** The configured Claude config directory; empty falls back to CLAUDE_CONFIG_DIR, then ~/.claude. */
    readonly homePath?: string | undefined;
    readonly environment?: NodeJS.ProcessEnv | undefined;
    readonly homeDir?: string | undefined;
    readonly managedDir?: string | undefined;
  } = {},
): Promise<Readonly<Record<string, string>>> {
  const environment = input.environment ?? process.env;
  const homeDir = input.homeDir ?? OS.homedir();
  const configDir =
    resolveClaudeConfigDir(input.homePath, homeDir) ??
    resolveClaudeConfigDir(environment.CLAUDE_CONFIG_DIR, homeDir) ??
    Path.join(homeDir, ".claude");
  const managedDir = input.managedDir ?? claudeManagedConfigDir(process.platform);
  const paths = [
    Path.join(configDir, "settings.json"),
    ...(await managedSettingsPaths(managedDir)),
  ];
  const envs = await Promise.all(paths.map(readClaudeSettingsFileEnv));
  return Object.assign({}, ...envs);
}
