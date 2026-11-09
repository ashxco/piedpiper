/**
 * windowsCommand – Windows-safe spawn resolution.
 *
 * Node's `spawn(command, args, { shell: true })` joins the arguments unquoted and
 * hands the line to `cmd.exe`, so any argument containing `&`, `|`, `%` or a
 * quote can inject commands. Windows needs a shell only for `.cmd`/`.bat` shims
 * (npm-installed CLIs, VS Code's `code.cmd`); real executables run directly.
 * This module resolves the executable, runs `.exe`/`.com` files without a shell
 * and builds one fully cmd-escaped command line for shims. Off Windows the
 * command is returned unchanged.
 *
 * @module windowsCommand
 */
import { statSync } from "node:fs";
import * as Path from "node:path";

export interface ResolvedSpawnCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
}

export interface ResolveSpawnCommandOptions {
  readonly platform?: NodeJS.Platform | undefined;
  /** Environment the child will run with; its PATH/PATHEXT drive executable lookup. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** File probe used for PATH scanning; replaced in tests. */
  readonly isFile?: ((filePath: string) => boolean) | undefined;
}

/** An argument that cannot be passed through `cmd.exe` intact. */
export class WindowsCommandLineError extends Error {
  override readonly name = "WindowsCommandLineError";
}

const WINDOWS_SHELL_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;
// Control characters end or split a cmd.exe line no matter how they are escaped.
// oxlint-disable-next-line no-control-regex
const WINDOWS_COMMAND_LINE_UNSAFE_PATTERN = /[\u0000-\u001f\u007f]/;
// Shims forward arguments through `%*`, which cmd.exe parses a second time after
// the escaping is gone: a double quote there closes the quoting that keeps `&`
// or `|` literal. Paths never contain one, so path-only launches refuse it.
// oxlint-disable-next-line no-control-regex
const WINDOWS_SHIM_UNSAFE_ARG_PATTERN = /[\u0000-\u001f\u007f"]/;
const DEFAULT_WINDOWS_PATH_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"] as const;
const WINDOWS_SHELL_EXTENSIONS = new Set([".cmd", ".bat"]);

function hasWindowsCommandLineUnsafeChars(value: string): boolean {
  return WINDOWS_COMMAND_LINE_UNSAFE_PATTERN.test(value);
}

export function hasWindowsShimUnsafeChars(value: string): boolean {
  return WINDOWS_SHIM_UNSAFE_ARG_PATTERN.test(value);
}

/**
 * Escapes one argument for `cmd.exe /d /s /c "<line>"` so it survives both the
 * cmd.exe pass and the target program's `CommandLineToArgvW` parsing. Mirrors
 * cross-spawn's argument escaping.
 */
export function escapeWindowsShellArg(arg: string): string {
  // Double backslashes that precede a quote, then escape the quote itself.
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  // Double trailing backslashes so they do not escape the closing quote.
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  return escaped.replace(WINDOWS_SHELL_META_CHARS, "^$1");
}

/**
 * Builds the single command line Node would hand to `cmd.exe` for a shell spawn,
 * with every token escaped. Throws when a token contains a control character.
 */
export function buildWindowsCommandLine(command: string, args: ReadonlyArray<string>): string {
  const tokens = [command, ...args];
  const unsafe = tokens.find(hasWindowsCommandLineUnsafeChars);
  if (unsafe !== undefined) {
    throw new WindowsCommandLineError(
      `Cannot run ${command} through cmd.exe: an argument contains a line break or control character.`,
    );
  }
  return tokens.map(escapeWindowsShellArg).join(" ");
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

export function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  if (!rawValue) return DEFAULT_WINDOWS_PATH_EXTENSIONS;
  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : DEFAULT_WINDOWS_PATH_EXTENSIONS;
}

function defaultIsFile(filePath: string): boolean {
  try {
    return statSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

function candidateFileNames(command: string, extensions: ReadonlyArray<string>): Array<string> {
  const extension = Path.win32.extname(command).toUpperCase();
  if (extension.length > 0 && extensions.includes(extension)) return [command];
  return extensions.map((entry) => `${command}${entry.toLowerCase()}`);
}

/**
 * Locates the file a bare command name (or explicit path) refers to on Windows,
 * following PATH and PATHEXT. Returns undefined when nothing matches.
 */
export function resolveWindowsExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  isFile: (filePath: string) => boolean = defaultIsFile,
): string | undefined {
  const extensions = resolveWindowsPathExtensions(env);
  const candidates = candidateFileNames(command, extensions);

  if (command.includes("/") || command.includes("\\")) {
    return candidates.find(isFile);
  }

  // Repeated PATH entries are common; probe each directory once (exact-case comparison).
  const pathEntries = new Set(
    resolvePathEnvironmentVariable(env)
      .split(";")
      .map((entry) => entry.trim().replace(/^"+|"+$/g, ""))
      .filter((entry) => entry.length > 0),
  );
  for (const pathEntry of pathEntries) {
    for (const candidate of candidates) {
      const filePath = Path.win32.join(pathEntry, candidate);
      if (isFile(filePath)) return filePath;
    }
  }
  return undefined;
}

/**
 * Decides how to spawn `command` with `args`. Off Windows, or for a Windows
 * executable, the pair is returned for a direct `shell: false` spawn. For a
 * `.cmd`/`.bat` shim it returns one escaped cmd.exe line and `shell: true` with
 * no args, which is what Node would build itself, minus the injection.
 * Throws `WindowsCommandLineError` when a shim argument contains a line break.
 */
export function resolveSpawnCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: ResolveSpawnCommandOptions = {},
): ResolvedSpawnCommand {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args: [...args], shell: false };
  }

  const env = options.env ?? process.env;
  const resolved =
    resolveWindowsExecutable(command, env, options.isFile ?? defaultIsFile) ?? command;
  const extension = Path.win32.extname(resolved).toLowerCase();
  if (!WINDOWS_SHELL_EXTENSIONS.has(extension)) {
    return { command: resolved, args: [...args], shell: false };
  }

  return { command: buildWindowsCommandLine(resolved, args), args: [], shell: true };
}
