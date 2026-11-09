import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  LOGIN_SHELL_PROBE_BUDGET_MS,
  listLoginShellCandidates,
  mergePathEntries,
  readEnvironmentFromLoginShell,
  readEnvironmentFromLoginShellCandidates,
  readPathFromLaunchctl,
  ShellEnvironmentReader,
} from "@piedpiper/shared/shell";

const LOCALE_ENV_NAMES = ["LANG", "LC_ALL", "LC_CTYPE"] as const;
// Older macOS releases lack C.UTF-8; en_US.UTF-8 exists on all of them.
const FALLBACK_LC_CTYPE = "en_US.UTF-8";
const CA_TRUST_ENV_NAMES = ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"] as const;
// The telemetry opt-out is documented as a shell variable; Finder/Dock launches never see it.
const FILL_IF_UNSET_ENV_NAMES = [
  ...CA_TRUST_ENV_NAMES,
  "JAVA_HOME",
  "PIEDPIPER_TELEMETRY_ENABLED",
] as const;
const LOGIN_SHELL_PROBE_TIMEOUT_MS = 5000;
const SHELL_ENVIRONMENT_CACHE_VERSION = 1;

export const LOGIN_SHELL_ENV_NAMES = [
  "PATH",
  "SSH_AUTH_SOCK",
  ...LOCALE_ENV_NAMES,
  ...FILL_IF_UNSET_ENV_NAMES,
  "__MISE_DIFF",
] as const;

function logShellEnvironmentWarning(message: string, error?: unknown): void {
  console.warn(`[desktop] ${message}`, error instanceof Error ? error.message : (error ?? ""));
}

function hasValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

type ShellEnvironment = Partial<Record<string, string>>;

function applyLoginShellEnvironment(
  env: NodeJS.ProcessEnv,
  shellEnvironment: ShellEnvironment,
  options: {
    platform: NodeJS.Platform;
    readLaunchctlPath: typeof readPathFromLaunchctl;
    logWarning: (message: string, error?: unknown) => void;
  },
): void {
  const { platform, logWarning } = options;
  const shellPath = shellEnvironment.PATH;
  const launchctlPath =
    platform === "darwin" && !shellPath ? options.readLaunchctlPath() : undefined;
  if (!shellPath && !launchctlPath) {
    logWarning("No login shell or launchctl PATH was found; keeping the inherited PATH.");
  }

  const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
  }

  if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
    env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
  }

  // mise's PATH delta must travel with the shell PATH or `mise x` wrappers re-exec forever.
  if (shellPath && shellEnvironment.__MISE_DIFF) {
    env.__MISE_DIFF = shellEnvironment.__MISE_DIFF;
  }

  for (const name of FILL_IF_UNSET_ENV_NAMES) {
    if (!env[name] && shellEnvironment[name]) {
      env[name] = shellEnvironment[name];
    }
  }

  // Locale vars are one precedence group (LC_ALL overrides the rest), so only fill when all are unset.
  if (platform === "darwin" && !LOCALE_ENV_NAMES.some((name) => hasValue(env[name]))) {
    for (const name of LOCALE_ENV_NAMES) {
      if (hasValue(shellEnvironment[name])) {
        env[name] = shellEnvironment[name];
      }
    }
    if (!LOCALE_ENV_NAMES.some((name) => hasValue(env[name]))) {
      env.LC_CTYPE = FALLBACK_LC_CTYPE;
    }
  }
}

/**
 * Blocking variant: probes the login shell synchronously and hydrates `env`.
 * @deprecated The desktop app uses `createShellEnvironmentSync` so startup never waits on the shell.
 */
export function syncShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReader;
    readLaunchctlPath?: typeof readPathFromLaunchctl;
    userShell?: string;
    probeBudgetMs?: number;
    now?: () => number;
    logWarning?: (message: string, error?: unknown) => void;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return;

  const logWarning = options.logWarning ?? logShellEnvironmentWarning;
  const readEnvironment = options.readEnvironment ?? readEnvironmentFromLoginShell;

  try {
    const shellEnvironment = readEnvironmentFromLoginShellCandidates(
      listLoginShellCandidates(platform, env.SHELL, options.userShell),
      LOGIN_SHELL_ENV_NAMES,
      {
        readEnvironment,
        budgetMs: options.probeBudgetMs,
        now: options.now,
        onProbeError: (shell, error) =>
          logWarning(`Failed to read login shell environment from ${shell}.`, error),
      },
    );
    applyLoginShellEnvironment(env, shellEnvironment, {
      platform,
      readLaunchctlPath: options.readLaunchctlPath ?? readPathFromLaunchctl,
      logWarning,
    });
  } catch (error) {
    logWarning("Failed to synchronize the desktop shell environment.", error);
  }
}

export type AsyncShellEnvironmentReader = (
  shell: string,
  names: ReadonlyArray<string>,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
) => Promise<ShellEnvironment>;

/** Non-blocking login-shell probe; reuses the shared reader to build the command and parse output. */
export const readEnvironmentFromLoginShellAsync: AsyncShellEnvironmentReader = (
  shell,
  names,
  timeoutMs,
  env,
) => {
  if (names.length === 0) return Promise.resolve({});
  let args: ReadonlyArray<string> = [];
  readEnvironmentFromLoginShell(shell, names, (_file, probeArgs) => {
    args = probeArgs;
    return "";
  });

  return new Promise((resolve, reject) => {
    // Detached with stdin ignored, as in the sync probe, so job control cannot stop the shell.
    const child = ChildProcess.spawn(shell, [...args], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      ...(env ? { env } : {}),
    });
    let output = "";
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve(readEnvironmentFromLoginShell(shell, names, () => output));
    };
    // Interactive shells ignore SIGTERM, so a hung probe needs SIGKILL; the detached shell leads its
    // own process group, so killing the group also stops rc-file children holding stdout open.
    const timer = setTimeout(() => {
      try {
        if (child.pid === undefined) throw new Error("no pid");
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      child.stdout?.destroy();
      finish(new Error(`${shell} login shell probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", (error) => finish(error));
    child.once("close", () => finish(null));
  });
};

/** Async counterpart of `readEnvironmentFromLoginShellCandidates`, with the same shared budget. */
export async function readEnvironmentFromLoginShellCandidatesAsync(
  candidates: ReadonlyArray<string>,
  names: ReadonlyArray<string>,
  options: {
    readEnvironment?: AsyncShellEnvironmentReader | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    budgetMs?: number | undefined;
    now?: (() => number) | undefined;
    onProbeError?: ((shell: string, error: unknown) => void) | undefined;
  } = {},
): Promise<ShellEnvironment> {
  const readEnvironment = options.readEnvironment ?? readEnvironmentFromLoginShellAsync;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? LOGIN_SHELL_PROBE_BUDGET_MS);
  let lastEnvironment: ShellEnvironment = {};

  for (const shell of candidates) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    try {
      lastEnvironment = await readEnvironment(
        shell,
        names,
        Math.min(remainingMs, LOGIN_SHELL_PROBE_TIMEOUT_MS),
        options.env,
      );
    } catch (error) {
      options.onProbeError?.(shell, error);
      continue;
    }
    if (lastEnvironment.PATH) break;
  }

  return lastEnvironment;
}

/** The cache is only valid for the same platform, home, login shell and zsh config dir. */
export function shellEnvironmentCacheKey(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string {
  return JSON.stringify([platform, home, env.SHELL ?? "", env.ZDOTDIR ?? ""]);
}

export function readShellEnvironmentCache(filePath: string, key: string): ShellEnvironment | null {
  try {
    const parsed: unknown = JSON.parse(FS.readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== SHELL_ENVIRONMENT_CACHE_VERSION || record.key !== key) return null;
    const rawEnvironment = record.environment;
    if (typeof rawEnvironment !== "object" || rawEnvironment === null) return null;
    const environment: ShellEnvironment = {};
    for (const name of LOGIN_SHELL_ENV_NAMES) {
      const value = (rawEnvironment as Record<string, unknown>)[name];
      if (typeof value === "string" && value.length > 0) environment[name] = value;
    }
    // An agent socket from an earlier session is dead once it is gone; the live probe refills it.
    if (environment.SSH_AUTH_SOCK !== undefined && !FS.existsSync(environment.SSH_AUTH_SOCK)) {
      delete environment.SSH_AUTH_SOCK;
    }
    return environment.PATH ? environment : null;
  } catch {
    return null;
  }
}

export function writeShellEnvironmentCache(
  filePath: string,
  key: string,
  environment: ShellEnvironment,
): void {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const payload = { version: SHELL_ENVIRONMENT_CACHE_VERSION, key, environment };
  try {
    FS.writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
    FS.renameSync(tempPath, filePath);
  } finally {
    try {
      FS.rmSync(tempPath, { force: true });
    } catch {}
  }
}

/** PATH entries by the directory they resolve to, so per-shell symlinks (fnm multishells) compare equal. */
function resolvePathEntries(value: string | undefined): string {
  if (!value) return "";
  const entries = new Set<string>();
  for (const entry of value.split(":")) {
    if (!entry) continue;
    try {
      entries.add(FS.realpathSync(entry));
    } catch {
      entries.add(entry);
    }
  }
  return [...entries].join(":");
}

function sameEnvValue(name: string, left: string | undefined, right: string | undefined): boolean {
  if (left === right) return true;
  return name === "PATH" && resolvePathEntries(left) === resolvePathEntries(right);
}

function sameEnvironment(left: ShellEnvironment, right: ShellEnvironment): boolean {
  return LOGIN_SHELL_ENV_NAMES.every((name) => sameEnvValue(name, left[name], right[name]));
}

interface ShellEnvironmentRefreshResult {
  /** `env` now differs in a way a running backend would notice. */
  readonly changed: boolean;
  /** `env` holds a login-shell (or cached) environment rather than only the inherited GUI one. */
  readonly hydrated: boolean;
}

export interface ShellEnvironmentSync {
  /** Applies the cached login-shell environment; true when the env is ready without probing. */
  readonly applyCached: () => boolean;
  /** Probes the login shell in the background, updates the cache and re-applies it. */
  readonly refresh: () => Promise<ShellEnvironmentRefreshResult>;
}

/**
 * Cached login-shell hydration: apply last launch's result synchronously, then refresh it with an
 * async probe. Every apply starts from the inherited values so stale cache entries never linger.
 */
export function createShellEnvironmentSync(options: {
  readonly cachePath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly userShell?: string;
  readonly readEnvironment?: AsyncShellEnvironmentReader;
  readonly readLaunchctlPath?: typeof readPathFromLaunchctl;
  readonly probeBudgetMs?: number;
  readonly now?: () => number;
  readonly logWarning?: (message: string, error?: unknown) => void;
}): ShellEnvironmentSync {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const supported = platform === "darwin" || platform === "linux";
  const logWarning = options.logWarning ?? logShellEnvironmentWarning;
  const readLaunchctlPath = options.readLaunchctlPath ?? readPathFromLaunchctl;
  const cacheKey = shellEnvironmentCacheKey(env, platform, options.home ?? OS.homedir());
  const inherited: ShellEnvironment = {};
  for (const name of LOGIN_SHELL_ENV_NAMES) inherited[name] = env[name];
  let appliedFromCache = false;

  const apply = (shellEnvironment: ShellEnvironment): boolean => {
    const next: NodeJS.ProcessEnv = { ...inherited };
    applyLoginShellEnvironment(next, shellEnvironment, { platform, readLaunchctlPath, logWarning });
    let changed = false;
    for (const name of LOGIN_SHELL_ENV_NAMES) {
      if (env[name] === next[name]) continue;
      if (!sameEnvValue(name, env[name], next[name])) changed = true;
      if (next[name] === undefined) delete env[name];
      else env[name] = next[name];
    }
    return changed;
  };

  return {
    applyCached: () => {
      if (!supported) return true;
      const cached = readShellEnvironmentCache(options.cachePath, cacheKey);
      if (cached === null) return false;
      try {
        apply(cached);
        appliedFromCache = true;
      } catch (error) {
        logWarning("Failed to apply the cached shell environment.", error);
      }
      return appliedFromCache;
    },
    refresh: async () => {
      // The desktop spawns only the backend, which repairs its own Windows PATH at startup.
      if (!supported) return { changed: false, hydrated: true };
      // Probe from the inherited baseline so removed cached entries and values cannot survive.
      const probeEnv: NodeJS.ProcessEnv = { ...env };
      for (const name of LOGIN_SHELL_ENV_NAMES) {
        if (inherited[name] === undefined) delete probeEnv[name];
        else probeEnv[name] = inherited[name];
      }
      try {
        const shellEnvironment = await readEnvironmentFromLoginShellCandidatesAsync(
          listLoginShellCandidates(platform, env.SHELL, options.userShell),
          LOGIN_SHELL_ENV_NAMES,
          {
            readEnvironment: options.readEnvironment,
            env: probeEnv,
            budgetMs: options.probeBudgetMs,
            now: options.now,
            onProbeError: (shell, error) =>
              logWarning(`Failed to read login shell environment from ${shell}.`, error),
          },
        );
        if (!shellEnvironment.PATH) {
          // A failed probe must not replace a good cached environment with a launchctl fallback.
          if (appliedFromCache) {
            logWarning("Login shell probe returned no PATH; keeping the cached environment.");
            return { changed: false, hydrated: true };
          }
          return { changed: apply(shellEnvironment), hydrated: false };
        }
        const cached = readShellEnvironmentCache(options.cachePath, cacheKey);
        if (cached === null || !sameEnvironment(cached, shellEnvironment)) {
          try {
            writeShellEnvironmentCache(options.cachePath, cacheKey, shellEnvironment);
          } catch (error) {
            logWarning("Failed to write the shell environment cache.", error);
          }
        }
        appliedFromCache = false;
        return { changed: apply(shellEnvironment), hydrated: true };
      } catch (error) {
        logWarning("Failed to synchronize the desktop shell environment.", error);
        return { changed: false, hydrated: appliedFromCache };
      }
    },
  };
}
