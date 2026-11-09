import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as NodePath from "node:path";

const PATH_CAPTURE_START = "__PIEDPIPER_PATH_START__";
const PATH_CAPTURE_END = "__PIEDPIPER_PATH_END__";
const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/;
const LOGIN_SHELL_PROBE_TIMEOUT_MS = 5000;
const LAUNCHCTL_TIMEOUT_MS = 2000;
/** Total time all login-shell probes may block startup before falling back to launchctl/inherited PATH. */
export const LOGIN_SHELL_PROBE_BUDGET_MS = 8000;

export type ExecFileSyncLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    encoding: "utf8";
    timeout: number;
    killSignal?: NodeJS.Signals | number;
    detached?: true;
    stdio?: ["ignore", "pipe", "ignore"];
  },
) => string;

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readUserLoginShell(): string | undefined {
  try {
    return trimNonEmpty(OS.userInfo().shell);
  } catch {
    return undefined;
  }
}

function fallbackLoginShells(platform: NodeJS.Platform): ReadonlyArray<string> {
  if (platform === "darwin") return ["/bin/zsh", "/bin/bash"];
  if (platform === "linux") return ["/bin/bash", "/bin/zsh"];
  return [];
}

export function resolveLoginShell(
  platform: NodeJS.Platform,
  shell: string | undefined,
): string | undefined {
  return trimNonEmpty(shell) ?? fallbackLoginShells(platform)[0];
}

/** Ordered, deduplicated login shells to probe: $SHELL, the passwd shell, then platform defaults. */
export function listLoginShellCandidates(
  platform: NodeJS.Platform,
  shell: string | undefined,
  userShell: string | undefined = readUserLoginShell(),
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const candidate of [
    trimNonEmpty(shell),
    trimNonEmpty(userShell),
    ...fallbackLoginShells(platform),
  ]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

export function extractPathFromShellOutput(output: string): string | null {
  const startIndex = output.indexOf(PATH_CAPTURE_START);
  if (startIndex === -1) return null;

  const valueStartIndex = startIndex + PATH_CAPTURE_START.length;
  const endIndex = output.indexOf(PATH_CAPTURE_END, valueStartIndex);
  if (endIndex === -1) return null;

  const pathValue = output.slice(valueStartIndex, endIndex).trim();
  return pathValue.length > 0 ? pathValue : null;
}

export function readPathFromLoginShell(
  shell: string,
  execFile: ExecFileSyncLike = execFileSync,
): string | undefined {
  return readEnvironmentFromLoginShell(shell, ["PATH"], execFile).PATH;
}

/** macOS GUI launches inherit launchd's PATH; it is the last resort when no login shell answers. */
export function readPathFromLaunchctl(
  execFile: ExecFileSyncLike = execFileSync,
): string | undefined {
  try {
    return trimNonEmpty(
      execFile("/bin/launchctl", ["getenv", "PATH"], {
        encoding: "utf8",
        timeout: LAUNCHCTL_TIMEOUT_MS,
        killSignal: "SIGKILL",
      }),
    );
  } catch {
    return undefined;
  }
}

/**
 * Login-shell entries first, then inherited ones, deduplicated so nothing the parent had is lost.
 * Windows entries compare case-insensitively and without wrapping quotes.
 */
export function mergePathEntries(
  preferredPath: string | undefined,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const delimiter = platform === "win32" ? ";" : ":";
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const pathValue of [preferredPath, inheritedPath]) {
    if (!pathValue) continue;
    for (const entry of pathValue.split(delimiter)) {
      const trimmedEntry = entry.trim();
      const key =
        platform === "win32" ? trimmedEntry.replace(/^"+|"+$/g, "").toLowerCase() : trimmedEntry;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(trimmedEntry);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

function envCaptureStart(name: string): string {
  return `__PIEDPIPER_ENV_${name}_START__`;
}

function envCaptureEnd(name: string): string {
  return `__PIEDPIPER_ENV_${name}_END__`;
}

const NUSHELL_EXECUTABLE_NAMES = new Set(["nu", "nu.exe", "nushell", "nushell.exe"]);

export function isNushell(shell: string): boolean {
  const executableName = shell.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return NUSHELL_EXECUTABLE_NAMES.has(executableName);
}

function buildNushellCaptureValue(name: string): string {
  // Without a configured conversion, Nu expands `~` entries only when PATH is a list.
  const defaultValue =
    name === "PATH"
      ? "if ($env.PATH? | describe | str starts-with 'list') { " +
        "$env.PATH | each {|p| if ($p | str starts-with '~') { " +
        "$p | path expand --no-symlink } else { $p } } | str join (char esep) " +
        "} else { $env.PATH? | default '' }"
      : `$env.${name}? | default ''`;
  return (
    `if $env.${name}? == null { '' } else if ` +
    `$env.ENV_CONVERSIONS?.${name}?.to_string? != null { ` +
    `$env.${name} | do $env.ENV_CONVERSIONS.${name}.to_string $env.${name} ` +
    `} else { ${defaultValue} }`
  );
}

/** The `-ilc` command that prints each variable between markers, in POSIX sh or Nushell syntax. */
export function buildLoginShellEnvironmentCaptureCommand(
  shell: string,
  names: ReadonlyArray<string>,
): string {
  const nushell = isNushell(shell);
  return names
    .map((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }

      if (nushell) {
        return [
          `print '${envCaptureStart(name)}'`,
          `print (${buildNushellCaptureValue(name)})`,
          `print '${envCaptureEnd(name)}'`,
        ].join("; ");
      }

      return [
        `printf '%s\\n' '${envCaptureStart(name)}'`,
        `printenv ${name} || true`,
        `printf '%s\\n' '${envCaptureEnd(name)}'`,
      ].join("; ");
    })
    .join("; ");
}

function extractEnvironmentValue(output: string, name: string): string | undefined {
  const startMarker = envCaptureStart(name);
  const endMarker = envCaptureEnd(name);
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) return undefined;

  const valueStartIndex = startIndex + startMarker.length;
  const endIndex = output.indexOf(endMarker, valueStartIndex);
  if (endIndex === -1) return undefined;

  // PowerShell ends lines with CRLF; POSIX shells with LF.
  const value = output
    .slice(valueStartIndex, endIndex)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");

  return value.length > 0 ? value : undefined;
}

export type ShellEnvironmentReader = (
  shell: string,
  names: ReadonlyArray<string>,
  execFile?: ExecFileSyncLike,
  timeoutMs?: number,
) => Partial<Record<string, string>>;

export const readEnvironmentFromLoginShell: ShellEnvironmentReader = (
  shell,
  names,
  execFile = execFileSync,
  timeoutMs = LOGIN_SHELL_PROBE_TIMEOUT_MS,
) => {
  if (names.length === 0) {
    return {};
  }

  // Interactive zsh/bash ignore SIGTERM, so a hung probe needs SIGKILL; detaching with stdin
  // ignored keeps job control on an inherited TTY from stopping the shell while we wait.
  const output = execFile(shell, ["-ilc", buildLoginShellEnvironmentCaptureCommand(shell, names)], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });

  const environment: Partial<Record<string, string>> = {};
  for (const name of names) {
    const value = extractEnvironmentValue(output, name);
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
};

/**
 * Probes each candidate shell until one reports PATH, within a shared time budget. The result comes
 * from a single shell so variables like __MISE_DIFF always match the PATH they describe.
 */
export function readEnvironmentFromLoginShellCandidates(
  candidates: ReadonlyArray<string>,
  names: ReadonlyArray<string>,
  options: {
    readEnvironment?: ShellEnvironmentReader | undefined;
    budgetMs?: number | undefined;
    now?: (() => number) | undefined;
    onProbeError?: ((shell: string, error: unknown) => void) | undefined;
  } = {},
): Partial<Record<string, string>> {
  const readEnvironment = options.readEnvironment ?? readEnvironmentFromLoginShell;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? LOGIN_SHELL_PROBE_BUDGET_MS);
  let lastEnvironment: Partial<Record<string, string>> = {};

  for (const shell of candidates) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    try {
      lastEnvironment = readEnvironment(
        shell,
        names,
        undefined,
        Math.min(remainingMs, LOGIN_SHELL_PROBE_TIMEOUT_MS),
      );
    } catch (error) {
      options.onProbeError?.(shell, error);
      continue;
    }
    if (lastEnvironment.PATH) break;
  }

  return lastEnvironment;
}

export interface GitExecutableResolutionOptions {
  readonly platform?: NodeJS.Platform | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly isFile?: ((filePath: string) => boolean) | undefined;
  /** Returns the git behind the macOS xcrun shim, or undefined. */
  readonly locateXcodeGit?: ((env: NodeJS.ProcessEnv) => string | undefined) | undefined;
  /** Clock for the resolution cache, in milliseconds; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
}

const MACOS_GIT_SHIM = "/usr/bin/git";
// Git for Windows 2.56+ ships x64 as ucrt64; older x64 builds use mingw64, ARM64 clangarm64, 32-bit mingw32.
const GIT_FOR_WINDOWS_BUILDS = ["ucrt64", "clangarm64", "mingw64", "mingw32"] as const;
const GIT_EXECUTABLE_CACHE_CAPACITY = 64;
// Bounded so an xcode-select switch, a newly installed git or a failed xcrun lookup is picked up.
const GIT_EXECUTABLE_CACHE_TTL_MS = 30_000;
const XCRUN_TIMEOUT_MS = 5000;

function isExecutableFileSync(filePath: string): boolean {
  try {
    if (!FS.statSync(filePath).isFile()) return false;
    if (process.platform !== "win32") FS.accessSync(filePath, FS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readPathVariable(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") return env.PATH ?? "";
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key ? (env[key] ?? "") : "";
}

/** First PATH entry holding `fileName`, mirroring how a shell-less spawn finds the command. */
export function findFileOnPath(
  fileName: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isFile: (filePath: string) => boolean = isExecutableFileSync,
): string | undefined {
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  for (const rawEntry of readPathVariable(env, platform).split(pathApi.delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, "$1");
    if (!entry || !pathApi.isAbsolute(entry)) continue;
    const candidate = pathApi.join(entry, fileName);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

// xcrun honours DEVELOPER_DIR and the `xcode-select` choice, exactly as the shim does.
function locateXcodeGitWithXcrun(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const located = execFileSync("/usr/bin/xcrun", ["--find", "git"], {
      encoding: "utf8",
      env,
      timeout: XCRUN_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return NodePath.posix.isAbsolute(located) ? located : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Swaps Git for Windows' launcher (`<Git>\cmd\git.exe`, or the portable `<Git>\bin\git.exe`)
 * for the git.exe it starts: the launcher costs a second process per command and leaks a kernel
 * token reference on each launch. The real binary only adds its own folders (hooks, ssh,
 * credential helpers) to PATH when MSYSTEM is unset, so the launcher is kept when MSYSTEM is set.
 */
export function preferGitForWindowsBinary(
  executable: string,
  env: NodeJS.ProcessEnv,
  isFile: (filePath: string) => boolean = isExecutableFileSync,
): string {
  if (env.MSYSTEM) return executable;
  const pathApi = NodePath.win32;
  if (pathApi.basename(executable).toLowerCase() !== "git.exe") return executable;
  const launcherDirectory = pathApi.dirname(executable);
  const launcherFolder = pathApi.basename(launcherDirectory).toLowerCase();
  if (launcherFolder !== "cmd" && launcherFolder !== "bin") return executable;
  const installRoot = pathApi.dirname(launcherDirectory);
  for (const build of GIT_FOR_WINDOWS_BUILDS) {
    const candidate = pathApi.join(installRoot, build, "bin", "git.exe");
    if (isFile(candidate)) return candidate;
  }
  return executable;
}

/**
 * The git binary to spawn: the real git behind the macOS `/usr/bin/git` xcrun shim, or the real
 * Git for Windows git.exe behind its launcher. Anything else (including every lookup failure, and
 * a git the user put first on PATH) returns plain `"git"`, leaving resolution to the spawn.
 */
export function resolveGitExecutable(options: GitExecutableResolutionOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? isExecutableFileSync;
  if (platform === "darwin") {
    if (findFileOnPath("git", platform, env, isFile) !== MACOS_GIT_SHIM) return "git";
    const located = (options.locateXcodeGit ?? locateXcodeGitWithXcrun)(env);
    return located && located !== MACOS_GIT_SHIM && isFile(located) ? located : "git";
  }
  if (platform === "win32") {
    const launcher = findFileOnPath("git.exe", platform, env, isFile);
    if (!launcher) return "git";
    const real = preferGitForWindowsBinary(launcher, env, isFile);
    return real === launcher ? "git" : real;
  }
  return "git";
}

const gitExecutableCache = new Map<
  string,
  { readonly resolved: string; readonly expiresAt: number }
>();

/**
 * Cached `resolveGitExecutable`, cheap enough to call before every git spawn. Entries expire after
 * 30 s, and a cached path that disappeared (an Xcode or Git update) is looked up again at once.
 */
export function resolveGitExecutableCached(options: GitExecutableResolutionOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") return "git";
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? isExecutableFileSync;
  const cacheKey = [
    platform,
    readPathVariable(env, platform),
    env.DEVELOPER_DIR ?? "",
    env.MSYSTEM ? "msystem" : "",
  ].join("\0");
  const now = (options.now ?? Date.now)();
  const cached = gitExecutableCache.get(cacheKey);
  if (
    cached !== undefined &&
    now < cached.expiresAt &&
    (cached.resolved === "git" || isFile(cached.resolved))
  ) {
    return cached.resolved;
  }
  const resolved = resolveGitExecutable({ ...options, platform, env, isFile });
  if (gitExecutableCache.size >= GIT_EXECUTABLE_CACHE_CAPACITY) gitExecutableCache.clear();
  gitExecutableCache.set(cacheKey, { resolved, expiresAt: now + GIT_EXECUTABLE_CACHE_TTL_MS });
  return resolved;
}

/** Test hook: forget every cached git executable resolution. */
export function clearGitExecutableCache(): void {
  gitExecutableCache.clear();
}

// ── Windows PATH repair ──

const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe"] as const;
const WINDOWS_PROBE_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const WINDOWS_PROFILE_ENV_NAMES = ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"] as const;

// After PowerShell exits, how long to keep reading stdout that a profile-started child may hold open.
const WINDOWS_PROBE_EXIT_GRACE_MS = 250;

/** Runs a PowerShell probe and resolves with its stdout; rejects on failure or timeout. */
export type WindowsShellProbeRunner = (
  shell: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

// Not execFile: its callback waits for every stdio pipe to close, which a background helper that a
// profile starts can hold open forever. This settles on its own timer and on exit.
export const runWindowsShellProbe: WindowsShellProbeRunner = (shell, args, timeoutMs, env) =>
  new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(shell, [...args], {
        ...(env ? { env } : {}),
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let settled = false;
    let exitCode: number | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      child.stdout?.destroy();
      if (error) reject(error);
      else resolve(stdout);
    };
    const settleWithExit = () =>
      settle(exitCode === 0 ? null : new Error(`${shell} exited with code ${exitCode}`));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(new Error(`${shell} probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > WINDOWS_PROBE_MAX_BUFFER_BYTES) {
        child.kill("SIGKILL");
        settle(new Error(`${shell} probe output exceeded ${WINDOWS_PROBE_MAX_BUFFER_BYTES} bytes`));
      }
    });
    child.on("error", (error) => settle(error));
    child.on("exit", (code) => {
      exitCode = code;
      graceTimer = setTimeout(settleWithExit, WINDOWS_PROBE_EXIT_GRACE_MS);
    });
    child.on("close", () => settleWithExit());
  });

// Also bounds injected runners, so a probe that never settles cannot hold startup.
function withProbeDeadline<T>(promise: Promise<T>, ms: number, shell: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${shell} probe did not finish within ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * `registry` reads the persisted Machine and User values (what a fresh login would get), so a PATH
 * inherited from a stale launcher is repaired; `process` reads the probe's own environment.
 */
export function buildWindowsEnvironmentProbeArgs(
  names: ReadonlyArray<string>,
  options: { readonly scope: "registry" | "process"; readonly loadProfile: boolean },
): ReadonlyArray<string> {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    ...names.flatMap((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }
      const value =
        options.scope === "registry"
          ? `$value = (@([Environment]::GetEnvironmentVariable('${name}', 'Machine'), [Environment]::GetEnvironmentVariable('${name}', 'User')) | Where-Object { $_ }) -join ';'`
          : `$value = [Environment]::GetEnvironmentVariable('${name}')`;
      return [
        `Write-Output '${envCaptureStart(name)}'`,
        value,
        "if ($null -ne $value -and $value.Length -gt 0) { Write-Output $value }",
        `Write-Output '${envCaptureEnd(name)}'`,
      ];
    }),
  ].join("; ");
  return [
    "-NoLogo",
    ...(options.loadProfile ? [] : ["-NoProfile"]),
    "-NonInteractive",
    "-Command",
    command,
  ];
}

/** Well-known per-user CLI install dirs (npm globals, Node installer, Volta, pnpm, bun, scoop, native Claude Code). */
export function resolveKnownWindowsCliDirs(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const join = NodePath.win32.join;
  const appData = trimNonEmpty(env.APPDATA);
  const localAppData = trimNonEmpty(env.LOCALAPPDATA);
  const userProfile = trimNonEmpty(env.USERPROFILE);
  return [
    ...(appData ? [join(appData, "npm")] : []),
    ...(localAppData
      ? [
          join(localAppData, "Programs", "nodejs"),
          join(localAppData, "Volta", "bin"),
          join(localAppData, "pnpm"),
        ]
      : []),
    ...(userProfile
      ? [
          join(userProfile, ".bun", "bin"),
          join(userProfile, "scoop", "shims"),
          join(userProfile, ".local", "bin"),
        ]
      : []),
  ];
}

/** Sets PATH, dropping other spellings (`Path`) so a copied Windows env record keeps one key. */
export function setWindowsPath(env: NodeJS.ProcessEnv, value: string): void {
  for (const key of Object.keys(env)) {
    if (key !== "PATH" && key.toUpperCase() === "PATH") delete env[key];
  }
  env.PATH = value;
}

/** Applies a `resolveWindowsEnvironment` patch; returns true when `env` changed. */
export function applyWindowsEnvironmentPatch(
  env: NodeJS.ProcessEnv,
  patch: Partial<Record<string, string>>,
): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "PATH") {
      if (readPathVariable(env, "win32") === value) continue;
      setWindowsPath(env, value);
    } else {
      if (env[key] === value) continue;
      env[key] = value;
    }
    changed = true;
  }
  return changed;
}

function isWindowsCommandOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  return [".exe", ".cmd"].some(
    (extension) => findFileOnPath(`${command}${extension}`, "win32", env) !== undefined,
  );
}

export interface WindowsEnvironmentResolverOptions {
  readonly runProbe?: WindowsShellProbeRunner | undefined;
  readonly commandAvailable?: ((command: string, env: NodeJS.ProcessEnv) => boolean) | undefined;
  readonly budgetMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly onProbeError?: ((shell: string, error: unknown) => void) | undefined;
}

/**
 * Repairs a stale Windows PATH: adds the persisted Machine/User PATH and known CLI dirs, and when
 * `node` still cannot be found, the PATH and fnm variables a profile-loading PowerShell sets up.
 * Every probe shares `LOGIN_SHELL_PROBE_BUDGET_MS`. Returns only the variables to set.
 */
export async function resolveWindowsEnvironment(
  env: NodeJS.ProcessEnv,
  options: WindowsEnvironmentResolverOptions = {},
): Promise<Partial<Record<string, string>>> {
  const runProbe = options.runProbe ?? runWindowsShellProbe;
  const commandAvailable = options.commandAvailable ?? isWindowsCommandOnPath;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? LOGIN_SHELL_PROBE_BUDGET_MS);
  const missingShells = new Set<string>();

  const probe = async (
    names: ReadonlyArray<string>,
    probeOptions: { readonly scope: "registry" | "process"; readonly loadProfile: boolean },
    probeEnv: NodeJS.ProcessEnv,
  ): Promise<Partial<Record<string, string>>> => {
    const args = buildWindowsEnvironmentProbeArgs(names, probeOptions);
    for (const shell of WINDOWS_SHELL_CANDIDATES) {
      if (missingShells.has(shell)) continue;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      let output: string;
      try {
        output = await withProbeDeadline(
          runProbe(shell, args, Math.min(remainingMs, LOGIN_SHELL_PROBE_TIMEOUT_MS), probeEnv),
          remainingMs,
          shell,
        );
      } catch (error) {
        // A missing shell (no PowerShell 7) is skipped for the rest of this repair.
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") missingShells.add(shell);
        options.onProbeError?.(shell, error);
        continue;
      }
      const environment: Partial<Record<string, string>> = {};
      for (const name of names) {
        const value = extractEnvironmentValue(output, name);
        if (value !== undefined) environment[name] = value;
      }
      return environment;
    }
    return {};
  };

  const inheritedPath = trimNonEmpty(readPathVariable(env, "win32"));
  const registryPath = (await probe(["PATH"], { scope: "registry", loadProfile: false }, env)).PATH;
  // The persisted PATH leads, as in a fresh shell; inherited-only entries are kept after it.
  const baselinePath = mergePathEntries(
    mergePathEntries(registryPath, inheritedPath, "win32"),
    resolveKnownWindowsCliDirs(env).join(";"),
    "win32",
  );
  const baselinePatch: Partial<Record<string, string>> = baselinePath ? { PATH: baselinePath } : {};
  const baselineEnv: NodeJS.ProcessEnv = { ...env };
  if (baselinePath) setWindowsPath(baselineEnv, baselinePath);
  if (commandAvailable("node", baselineEnv)) return baselinePatch;

  // The profile runs with the repaired PATH so tools it calls (fnm, volta) resolve.
  const profiled = await probe(
    WINDOWS_PROFILE_ENV_NAMES,
    { scope: "process", loadProfile: true },
    baselineEnv,
  );
  const profiledPath = mergePathEntries(profiled.PATH, baselinePath, "win32");
  return {
    ...baselinePatch,
    ...(profiledPath ? { PATH: profiledPath } : {}),
    ...(profiled.FNM_DIR ? { FNM_DIR: profiled.FNM_DIR } : {}),
    ...(profiled.FNM_MULTISHELL_PATH ? { FNM_MULTISHELL_PATH: profiled.FNM_MULTISHELL_PATH } : {}),
  };
}
