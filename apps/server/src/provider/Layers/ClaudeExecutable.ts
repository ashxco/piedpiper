import { statSync } from "node:fs";
import * as Path from "node:path";

import { resolveWindowsExecutable } from "@piedpiper/shared/windowsCommand";

import { expandCodexHomePath } from "../../codex/homePath";

/**
 * Windows launcher-script extensions Node cannot spawn without a shell
 * (`spawn EINVAL` since Node 20.12), so the Claude Agent SDK cannot use them.
 */
const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"]);

/**
 * Entry points of the npm `@anthropic-ai/claude-code` package relative to the
 * global npm directory holding the launcher shim. Newer versions ship a native
 * `bin/claude.exe`; older ones only `cli.js`, which the SDK runs with node.
 */
const NPM_PACKAGE_ENTRY_CANDIDATES = [
  ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
] as const;

export interface ResolveClaudeSdkExecutableOptions {
  readonly platform?: NodeJS.Platform | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** File probe; replaced in tests. */
  readonly isFile?: ((filePath: string) => boolean) | undefined;
  /** Called when a launcher shim was found but no package entry point sits next to it. */
  readonly onUnresolvedShim?: ((shimPath: string) => void) | undefined;
}

function defaultIsFile(filePath: string): boolean {
  try {
    return statSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/**
 * Resolves the configured Claude binary into a path the Claude Agent SDK can
 * spawn directly as `pathToClaudeCodeExecutable`.
 *
 * The SDK spawns without a shell and without PATH/PATHEXT lookup, so on
 * Windows a bare `claude` is "not found" and an npm `claude.cmd` shim fails
 * with `spawn EINVAL`. This walks PATH/PATHEXT and follows an npm shim to the
 * packaged entry point. Elsewhere, or when nothing better is found, the
 * configured value is returned unchanged.
 */
export function resolveClaudeSdkExecutablePath(
  binaryPath: string,
  options: ResolveClaudeSdkExecutableOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return binaryPath;

  const isFile = options.isFile ?? defaultIsFile;
  const resolved = resolveWindowsExecutable(binaryPath, options.env ?? process.env, isFile);
  if (!resolved) return binaryPath;

  const extension = Path.win32.extname(resolved).toLowerCase();
  if (!WINDOWS_SHIM_EXTENSIONS.has(extension)) return resolved;

  const shimDirectory = Path.win32.dirname(resolved);
  for (const segments of NPM_PACKAGE_ENTRY_CANDIDATES) {
    const candidate = Path.win32.join(shimDirectory, ...segments);
    if (isFile(candidate)) return candidate;
  }
  options.onUnresolvedShim?.(resolved);
  return binaryPath;
}

/**
 * Env vars never forwarded to the Claude child process (alongside every PIEDPIPER_* setting).
 * The CLAUDE* ones identify a Claude Code session that launched Pied Piper; a child spawned
 * with them acts as part of that session (its id, messaging socket and token, effort, PID).
 */
const CLAUDE_CHILD_ENV_BLOCKED_NAMES: ReadonlySet<string> = new Set([
  "ELECTRON_RUN_AS_NODE",
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
]);

/**
 * Absolute `CLAUDE_CONFIG_DIR` for the configured config directory, or undefined when unset.
 * Only this variable changes: moving HOME would hide the macOS keychain credentials.
 */
export function resolveClaudeConfigDir(
  homePath: string | undefined,
  homeDir?: string,
): string | undefined {
  const expanded = homePath ? expandCodexHomePath(homePath, homeDir) : "";
  return expanded ? Path.resolve(expanded) : undefined;
}

/** Copy of the host env safe to hand to the Claude child process. */
export function buildClaudeChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  options?: { readonly homePath?: string | undefined },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    // Windows env names are case-insensitive, so compare upper-cased.
    const upper = name.toUpperCase();
    if (CLAUDE_CHILD_ENV_BLOCKED_NAMES.has(upper) || upper.startsWith("PIEDPIPER_")) continue;
    env[name] = value;
  }
  const configDir = resolveClaudeConfigDir(options?.homePath);
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}
