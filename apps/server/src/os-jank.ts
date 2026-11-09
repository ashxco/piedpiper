import * as OS from "node:os";
import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import { Effect, Path } from "effect";
import {
  listLoginShellCandidates,
  mergePathEntries,
  readEnvironmentFromLoginShell,
  readEnvironmentFromLoginShellCandidates,
  readPathFromLaunchctl,
  readPathFromLoginShell,
  ShellEnvironmentReader,
} from "@piedpiper/shared/shell";

function logPathHydrationWarning(message: string, error?: unknown): void {
  console.warn(`[server] ${message}`, error instanceof Error ? error.message : (error ?? ""));
}

/** Sets an empty HOME from the user account so spawned gh/git/provider CLIs can find their config. */
export function hydratePosixHome(
  env: NodeJS.ProcessEnv,
  resolveHomeDir: () => string = () => OS.userInfo().homedir,
): void {
  if ((env.HOME?.trim() ?? "").length > 0) return;
  const homeDir = resolveHomeDir();
  if (homeDir.length > 0) {
    env.HOME = homeDir;
  }
}

export function fixPath(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    readPath?: typeof readPathFromLoginShell;
    readEnvironment?: ShellEnvironmentReader;
    readLaunchctlPath?: typeof readPathFromLaunchctl;
    userShell?: string;
    probeBudgetMs?: number;
    now?: () => number;
    logWarning?: (message: string, error?: unknown) => void;
    resolveHomeDir?: () => string;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return;

  const env = options.env ?? process.env;
  const logWarning = options.logWarning ?? logPathHydrationWarning;
  const readPath = options.readPath;
  const readEnvironment: ShellEnvironmentReader =
    options.readEnvironment ??
    (readPath ? (shell) => ({ PATH: readPath(shell) }) : readEnvironmentFromLoginShell);

  try {
    hydratePosixHome(env, options.resolveHomeDir);
  } catch (error) {
    logWarning("Failed to hydrate HOME from the user account.", error);
  }

  try {
    const shellEnvironment = readEnvironmentFromLoginShellCandidates(
      listLoginShellCandidates(platform, env.SHELL, options.userShell),
      ["PATH", "__MISE_DIFF", "JAVA_HOME"],
      {
        readEnvironment,
        budgetMs: options.probeBudgetMs,
        now: options.now,
        onProbeError: (shell, error) =>
          logWarning(`Failed to read PATH from login shell ${shell}.`, error),
      },
    );

    const shellPath = shellEnvironment.PATH;
    const launchctlPath =
      platform === "darwin" && !shellPath
        ? (options.readLaunchctlPath ?? readPathFromLaunchctl)()
        : undefined;
    if (!shellPath && !launchctlPath) {
      logWarning("No login shell or launchctl PATH was found; keeping the inherited PATH.");
    }

    const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
    if (mergedPath) {
      env.PATH = mergedPath;
    }
    // mise's PATH delta must travel with the shell PATH or `mise x` wrappers re-exec forever.
    if (shellPath && shellEnvironment.__MISE_DIFF) {
      env.__MISE_DIFF = shellEnvironment.__MISE_DIFF;
    }
    if (shellPath && !env.JAVA_HOME && shellEnvironment.JAVA_HOME) {
      env.JAVA_HOME = shellEnvironment.JAVA_HOME;
    }
  } catch (error) {
    logWarning("Failed to hydrate PATH from the user environment.", error);
  }
}

/** os.homedir() returns "" for a set-but-blank HOME, so fall back to the account's home. */
export function resolveUserHomeDir(
  homedir: () => string = OS.homedir,
  accountHomeDir: () => string = () => OS.userInfo().homedir,
): string {
  const home = homedir();
  if (home.trim().length > 0) return home;
  try {
    return accountHomeDir();
  } catch {
    return home;
  }
}

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return resolveUserHomeDir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(resolveUserHomeDir(), input.slice(2));
  }
  return input;
});

/** Expands a leading `~` in a launch target for `platform`; `~\\` is a home path only on Windows. */
export function expandHomePathForPlatform(
  input: string,
  platform: NodeJS.Platform = process.platform,
  homeDir: string | (() => string) = resolveUserHomeDir,
): string {
  const isWindows = platform === "win32";
  const hasHomePrefix = input.startsWith("~/") || (isWindows && input.startsWith("~\\"));
  if (input !== "~" && !hasHomePrefix) return input;
  let home: string;
  try {
    // os.homedir() throws with no HOME and no passwd entry; only a tilde path may depend on it.
    home = typeof homeDir === "function" ? homeDir() : homeDir;
  } catch {
    return input;
  }
  if (home.trim().length === 0) return input;
  return hasHomePrefix ? (isWindows ? pathWin32 : pathPosix).join(home, input.slice(2)) : home;
}

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(resolveUserHomeDir(), ".piedpiper");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
