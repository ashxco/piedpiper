/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser and workspace
 * paths in a configured editor.
 *
 * @module Open
 */
import { spawn, type ChildProcessByStdio, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { access as fsAccess, constants, readdir, realpath, stat as fsStat } from "node:fs/promises";
import { extname, join, posix as pathPosix, win32 as pathWin32 } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { EDITORS, OpenError, type EditorId } from "@piedpiper/contracts";
import {
  hasWindowsShimUnsafeChars,
  resolveSpawnCommand,
  type ResolvedSpawnCommand,
} from "@piedpiper/shared/windowsCommand";
import { ServiceMap, Effect, Layer, Option } from "effect";

import { expandHomePathForPlatform } from "./os-jank";

// ==============================
// Definitions
// ==============================

export { OpenError };

export interface OpenInEditorInput {
  readonly cwd: string;
  readonly editor: EditorId;
  /** File manager only: show the target selected in its folder. */
  readonly reveal?: boolean | undefined;
}

export interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Windows only: pass args to the child unquoted (Explorer's `/select,"<path>"`). */
  readonly windowsVerbatimArguments?: boolean;
  /** False keeps the child attached (still unref'd); defaults to a detached launch. */
  readonly detached?: boolean;
  /** Started instead when `command` is missing or cannot be spawned. */
  readonly fallback?: EditorLaunch;
  /** Variables removed from this launch's environment, matched case-insensitively. */
  readonly unsetEnv?: ReadonlyArray<string>;
}

type EditorDefinition = (typeof EDITORS)[number];

/** Per-scan cache of lowercase directory listings; null marks a directory that could not be read. */
export type DirectoryListings = Map<string, Promise<ReadonlySet<string> | null>>;

/** Per-scan cache of raw directory entries (original casing); empty for an unreadable directory. */
export type DirectoryEntries = Map<string, Promise<ReadonlyArray<string>>>;

interface CommandAvailabilityOptions {
  readonly platform?: NodeJS.Platform | undefined;
  readonly env?: NodeJS.ProcessEnv;
  /** Skips stat probes for names missing from a PATH directory's listing. */
  readonly listings?: DirectoryListings | undefined;
  /** Rejects a found executable so the search continues with the next location. */
  readonly accept?: ((filePath: string) => Promise<boolean>) | undefined;
}

const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;

/** `\\host`, `//host` or `/\host`: opening one makes Windows send NTLM credentials to that host. */
export function isNetworkPath(target: string): boolean {
  return /^[\\/]{2}/.test(target);
}

/** True when `target` equals or sits inside one of `roots`, compared as case-insensitive Windows paths. */
export function isPathInsideAnyRoot(target: string, roots: Iterable<string>): boolean {
  const normalizedTarget = pathWin32.normalize(target).toLowerCase();
  for (const root of roots) {
    const normalizedRoot = pathWin32.normalize(root).replace(/\\+$/, "").toLowerCase();
    if (normalizedRoot.length === 0) continue;
    if (
      normalizedTarget === normalizedRoot ||
      normalizedTarget.startsWith(`${normalizedRoot}\\`) ||
      // Editor targets may carry a `:line[:column]` suffix.
      TARGET_WITH_POSITION_PATTERN.exec(normalizedTarget)?.[1] === normalizedRoot
    ) {
      return true;
    }
  }
  return false;
}

function parseTargetPathAndPosition(target: string): {
  path: string;
  line: string | undefined;
  column: string | undefined;
} | null {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    path: match[1],
    line: match[2],
    column: match[3],
  };
}

function resolveCommandEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const parsedTarget = parseTargetPathAndPosition(target);

  switch (editor.launchStyle) {
    case "direct-path":
      return [target];
    case "goto":
      return parsedTarget ? ["--goto", target] : [target];
    case "line-column": {
      if (!parsedTarget) {
        return [target];
      }

      const { path, line, column } = parsedTarget;
      // JetBrains IDEs count `--column` from 0; targets count columns from 1.
      const zeroBasedColumn = column ? String(Math.max(0, Number(column) - 1)) : undefined;
      return [
        ...(line ? ["--line", line] : []),
        ...(zeroBasedColumn ? ["--column", zeroBasedColumn] : []),
        path,
      ];
    }
  }
}

function fileManagerCommandForPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      return "xdg-open";
  }
}

function hasGraphicalLinuxSession(env: NodeJS.ProcessEnv): boolean {
  return [env.DISPLAY, env.WAYLAND_DISPLAY].some((value) => (value?.trim().length ?? 0) > 0);
}

function isWslSession(env: NodeJS.ProcessEnv): boolean {
  return [env.WSL_DISTRO_NAME, env.WSL_INTEROP].some((value) => (value?.trim().length ?? 0) > 0);
}

export interface LinuxProbeResult {
  /** Null when the helper timed out or could not run. */
  readonly exitCode: number | null;
  readonly stdout: string;
}

/** Runs a short-lived desktop helper (gdbus, xdg-mime); replaced in tests. */
export type LinuxProbeRunner = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
) => Promise<LinuxProbeResult>;

// Well inside the discovery timeout, so a hung helper costs only the file manager.
const LINUX_PROBE_TIMEOUT_MS = 2_000;
const LINUX_PROBE_KILL_GRACE_MS = 1_000;
const LINUX_PROBE_MAX_STDOUT_CHARS = 4_096;

export const runLinuxProbe: LinuxProbeRunner = (command, args, { env, timeoutMs }) =>
  new Promise((resolve) => {
    let child: ChildProcessByStdio<null, Readable, null>;
    try {
      child = spawn(command, [...args], { env, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve({ exitCode: null, stdout: "" });
      return;
    }
    let stdout = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), LINUX_PROBE_KILL_GRACE_MS);
      killTimer.unref();
      resolve({ exitCode: null, stdout });
    }, timeoutMs);
    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < LINUX_PROBE_MAX_STDOUT_CHARS) stdout += chunk;
    });
    child.once("error", () => {
      clearTimers();
      resolve({ exitCode: null, stdout });
    });
    child.once("close", (exitCode) => {
      clearTimers();
      resolve({ exitCode, stdout });
    });
  });

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [];
  for (const extension of windowsPathExtensions) {
    candidates.push(`${command}${extension}`);
    candidates.push(`${command}${extension.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

async function isExecutableFile(
  filePath: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): Promise<boolean> {
  try {
    const stat = await fsStat(filePath);
    if (!stat.isFile()) return false;
    if (platform === "win32") {
      const extension = extname(filePath);
      if (extension.length === 0) return false;
      return windowsPathExtensions.includes(extension.toUpperCase());
    }
    await fsAccess(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

/** Drops repeated directories, compared case-insensitively on Windows. */
function uniquePaths(paths: Iterable<string>, platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const key =
      platform === "win32"
        ? pathWin32.normalize(path).replace(/\\+$/, "").toLowerCase()
        : path.replace(/\/+$/, "") || path;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
}

function readDirectoryListing(
  listings: DirectoryListings,
  directory: string,
): Promise<ReadonlySet<string> | null> {
  let pending = listings.get(directory);
  if (!pending) {
    pending = readdir(directory).then(
      (entries) => new Set(entries.map((entry) => entry.toLowerCase())),
      () => null,
    );
    listings.set(directory, pending);
  }
  return pending;
}

export async function isCommandAvailable(
  command: string,
  options: CommandAvailabilityOptions = {},
): Promise<boolean> {
  return (await findCommandPath(command, options)) !== null;
}

/** Like isCommandAvailable, but returns the executable's path (PATH entry joined with the name). */
async function findCommandPath(
  command: string,
  options: CommandAvailabilityOptions = {},
): Promise<string | null> {
  const accept = options.accept ?? (async () => true);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const commandCandidates = resolveCommandCandidates(command, platform, windowsPathExtensions);

  if (command.includes("/") || command.includes("\\")) {
    for (const candidate of commandCandidates) {
      if (
        (await isExecutableFile(candidate, platform, windowsPathExtensions)) &&
        (await accept(candidate))
      ) {
        return candidate;
      }
    }
    return null;
  }

  const pathValue = resolvePathEnvironmentVariable(env);
  if (pathValue.length === 0) return null;
  // Repeated PATH entries are common on Windows; probe each directory once.
  const pathEntries = uniquePaths(
    pathValue
      .split(resolvePathDelimiter(platform))
      .map((entry) => stripWrappingQuotes(entry.trim()))
      .filter((entry) => entry.length > 0),
    platform,
  );

  for (const pathEntry of pathEntries) {
    // An unreadable directory falls back to probing each candidate directly.
    const listing = options.listings
      ? await readDirectoryListing(options.listings, pathEntry)
      : null;
    for (const candidate of commandCandidates) {
      if (listing && !listing.has(candidate.toLowerCase())) continue;
      const filePath = join(pathEntry, candidate);
      if (
        (await isExecutableFile(filePath, platform, windowsPathExtensions)) &&
        (await accept(filePath))
      ) {
        return filePath;
      }
    }
  }
  return null;
}

export interface ResolvedEditorCommand {
  readonly command: string;
  readonly baseArgs: ReadonlyArray<string>;
}

export interface EditorCommandLookupOptions {
  readonly platform?: NodeJS.Platform | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly listings?: DirectoryListings | undefined;
  readonly entries?: DirectoryEntries | undefined;
  /** Prefix for system install locations such as /Applications and /usr/local/bin; a test seam. */
  readonly systemRoot?: string | undefined;
}

const MAC_APP_NAMES: Partial<Record<EditorId, ReadonlyArray<string>>> = {
  cursor: ["Cursor"],
  trae: ["Trae"],
  vscode: ["Visual Studio Code"],
  "vscode-insiders": ["Visual Studio Code - Insiders"],
  vscodium: ["VSCodium"],
  zed: ["Zed", "Zed Preview"],
  // `Antigravity.app` is the separate Hub, not the IDE.
  antigravity: ["Antigravity IDE"],
  kiro: ["Kiro"],
};

const WINDOWS_INSTALL_DIRS: Partial<Record<EditorId, ReadonlyArray<string>>> = {
  cursor: ["cursor"],
  trae: ["Trae"],
  vscode: ["Microsoft VS Code"],
  "vscode-insiders": ["Microsoft VS Code Insiders"],
  vscodium: ["VSCodium"],
  zed: ["Zed"],
  // Unverified Windows folder, mirrored from the macOS IDE app name; PATH lookup still applies.
  antigravity: ["Antigravity IDE"],
  kiro: ["Kiro"],
};

/** JetBrains installs carry the edition or version after the name, e.g. "IntelliJ IDEA CE". */
const JETBRAINS_INSTALL_PREFIXES: Partial<Record<EditorId, ReadonlyArray<string>>> = {
  idea: ["IntelliJ IDEA"],
  aqua: ["Aqua"],
  clion: ["CLion"],
  datagrip: ["DataGrip"],
  dataspell: ["DataSpell"],
  goland: ["GoLand"],
  phpstorm: ["PhpStorm"],
  pycharm: ["PyCharm"],
  rider: ["Rider", "JetBrains Rider"],
  rubymine: ["RubyMine"],
  rustrover: ["RustRover"],
  webstorm: ["WebStorm"],
};

function editorCommandNames(
  editor: EditorDefinition,
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  if (!editor.commands) return [];
  // On Linux `zed` is usually the OpenZFS event daemon, so Zed's own `zeditor` goes first.
  if (editor.id === "zed" && platform === "linux") {
    return [...editor.commands].toSorted(
      (a, b) => Number(b === "zeditor") - Number(a === "zeditor"),
    );
  }
  return editor.commands;
}

function editorBaseArgs(editor: EditorDefinition): ReadonlyArray<string> {
  return "baseArgs" in editor ? editor.baseArgs : [];
}

function readDirectoryEntries(
  entries: DirectoryEntries,
  directory: string,
): Promise<ReadonlyArray<string>> {
  let pending = entries.get(directory);
  if (!pending) {
    pending = readdir(directory).catch(() => []);
    entries.set(directory, pending);
  }
  return pending;
}

/** Matching install folders, exact name first, then newest version (highest name) first. */
async function listMatchingEntries(
  entries: DirectoryEntries,
  directory: string,
  prefixes: ReadonlyArray<string>,
  suffix: string,
): Promise<ReadonlyArray<string>> {
  const matches: Array<{ readonly entry: string; readonly exact: boolean }> = [];
  for (const entry of await readDirectoryEntries(entries, directory)) {
    if (!entry.endsWith(suffix)) continue;
    const stem = entry.slice(0, entry.length - suffix.length);
    const exact = prefixes.includes(stem);
    if (exact || prefixes.some((prefix) => stem.startsWith(`${prefix} `))) {
      matches.push({ entry, exact });
    }
  }
  return matches
    .toSorted(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.entry.localeCompare(a.entry, "en", { numeric: true }),
    )
    .map((match) => match.entry);
}

/** Where the official zed.dev installer links Zed's CLI on Linux. */
function linuxZedInstallerPath(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME?.trim();
  return home ? join(home, ".local", "bin", "zed") : undefined;
}

function parentDirectorySegments(path: string): string[] {
  return path.split(/[\\/]+/).slice(0, -1);
}

/** On Linux `zed` is often the OpenZFS daemon; Zed's own CLI resolves into a zed-named install tree. */
async function isZedEditorExecutable(filePath: string): Promise<boolean> {
  let resolved: string;
  try {
    resolved = await realpath(filePath);
  } catch {
    return false;
  }
  if ([...parentDirectorySegments(filePath), ...parentDirectorySegments(resolved)].includes("sbin"))
    return false;
  return parentDirectorySegments(resolved).some((segment) => segment.toLowerCase().includes("zed"));
}

/** A macOS PATH entry linked into a Zed bundle, as `cli: install` and Homebrew's cask create. */
async function isZedBundleExecutable(filePath: string): Promise<boolean> {
  try {
    const segments = parentDirectorySegments(await realpath(filePath));
    return segments.some((segment) => /^zed.*\.app$/i.test(segment));
  } catch {
    return false;
  }
}

async function editorInstallCandidates(
  editor: EditorDefinition,
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  systemRoot: string,
  entries: DirectoryEntries,
): Promise<ReadonlyArray<string>> {
  const home = env.HOME?.trim() || undefined;
  const jetbrainsPrefixes = JETBRAINS_INSTALL_PREFIXES[editor.id];
  const candidates: string[] = [];

  if (platform === "darwin") {
    const roots = uniquePaths(
      [...(home ? [join(home, "Applications")] : []), join(systemRoot, "Applications")],
      platform,
    );
    for (const root of roots) {
      if (jetbrainsPrefixes) {
        for (const app of await listMatchingEntries(entries, root, jetbrainsPrefixes, ".app")) {
          candidates.push(join(root, app, "Contents", "MacOS", command));
        }
        continue;
      }
      for (const name of MAC_APP_NAMES[editor.id] ?? []) {
        const contents = join(root, `${name}.app`, "Contents");
        if (editor.id === "zed") {
          candidates.push(join(contents, "MacOS", "cli"));
        } else {
          const bin = join(contents, "Resources", "app", "bin");
          candidates.push(join(bin, command), join(bin, "code"));
        }
      }
    }
    if (home && jetbrainsPrefixes) {
      candidates.push(
        join(home, "Library", "Application Support", "JetBrains", "Toolbox", "scripts", command),
      );
    }
  } else if (platform === "win32") {
    // ProgramW6432 is usually the same folder as ProgramFiles.
    const roots = uniquePaths(
      [
        ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "Programs")] : []),
        ...[env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432].filter(
          (root): root is string => !!root,
        ),
      ],
      platform,
    );
    if (jetbrainsPrefixes) {
      if (env.LOCALAPPDATA) {
        candidates.push(
          join(env.LOCALAPPDATA, "JetBrains", "Toolbox", "scripts", `${command}.cmd`),
        );
      }
      for (const directory of roots.flatMap((root) => [root, join(root, "JetBrains")])) {
        for (const entry of await listMatchingEntries(entries, directory, jetbrainsPrefixes, "")) {
          candidates.push(
            join(directory, entry, "bin", `${command}64.exe`),
            join(directory, entry, "bin", `${command}.exe`),
          );
        }
      }
    } else {
      for (const root of roots) {
        for (const name of WINDOWS_INSTALL_DIRS[editor.id] ?? []) {
          const installDir = join(root, name);
          candidates.push(
            join(installDir, "resources", "app", "bin", `${command}.cmd`),
            join(installDir, "resources", "app", "bin", "code.cmd"),
            join(installDir, "bin", `${command}.cmd`),
            join(installDir, "bin", "code.cmd"),
          );
          if (editor.id === "zed") {
            candidates.push(join(installDir, "bin", "zed.exe"), join(installDir, "zed.exe"));
          }
        }
      }
    }
  } else {
    const dirs = [
      ...(home ? [join(home, ".local", "bin")] : []),
      join(systemRoot, "usr", "local", "bin"),
      join(systemRoot, "usr", "bin"),
      join(systemRoot, "snap", "bin"),
    ];
    if (jetbrainsPrefixes) {
      const dataHome = env.XDG_DATA_HOME || (home ? join(home, ".local", "share") : undefined);
      if (dataHome) dirs.push(join(dataHome, "JetBrains", "Toolbox", "scripts"));
    }
    candidates.push(...dirs.map((dir) => join(dir, command)));
  }

  return Array.from(new Set(candidates));
}

/**
 * Finds the CLI to launch an editor with: its command names on PATH first, then
 * well-known install locations (app bundles, JetBrains Toolbox scripts, Program
 * Files, ~/.local/bin). Zed on macOS takes a PATH entry linked into a Zed bundle,
 * then its app bundles, then any PATH entry. Returns null when none is installed.
 */
export async function resolveEditorCommand(
  editor: EditorDefinition,
  options: EditorCommandLookupOptions = {},
): Promise<ResolvedEditorCommand | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const systemRoot = options.systemRoot ?? "/";
  const entries = options.entries ?? new Map();
  const lookup = { platform, env, listings: options.listings };
  const baseArgs = editorBaseArgs(editor);
  // Kiro's app-bundled CLI is the IDE itself and takes no `ide` subcommand.
  const installBaseArgs =
    editor.id === "kiro" && (platform === "darwin" || platform === "win32") ? [] : baseArgs;
  const names = editorCommandNames(editor, platform);
  const isZfsAmbiguous = (name: string) =>
    platform === "linux" && editor.id === "zed" && name === "zed";

  // OpenZFS also ships a `zed`, so on macOS Zed's own bundle outranks a PATH entry.
  const prefersInstallLocation = platform === "darwin" && editor.id === "zed";

  const findOnPath = async (
    group: ReadonlyArray<string>,
  ): Promise<ResolvedEditorCommand | null> => {
    for (const name of group) {
      if (isZfsAmbiguous(name)) {
        const installed = linuxZedInstallerPath(env);
        if (installed && (await isCommandAvailable(installed, lookup))) {
          return { command: installed, baseArgs };
        }
        const found = await findCommandPath(name, { ...lookup, accept: isZedEditorExecutable });
        if (found) return { command: found, baseArgs };
      } else if (await isCommandAvailable(name, lookup)) {
        return { command: name, baseArgs };
      }
    }
    return null;
  };

  const findBundleLinkOnPath = async (
    group: ReadonlyArray<string>,
  ): Promise<ResolvedEditorCommand | null> => {
    for (const name of group) {
      const found = await findCommandPath(name, { ...lookup, accept: isZedBundleExecutable });
      if (found) return { command: found, baseArgs };
    }
    return null;
  };

  const findInstalled = async (
    group: ReadonlyArray<string>,
  ): Promise<ResolvedEditorCommand | null> => {
    for (const name of group) {
      for (const candidate of await editorInstallCandidates(
        editor,
        name,
        platform,
        env,
        systemRoot,
        entries,
      )) {
        if (!(await isCommandAvailable(candidate, lookup))) continue;
        if (isZfsAmbiguous(name) && !(await isZedEditorExecutable(candidate))) continue;
        return { command: candidate, baseArgs: installBaseArgs };
      }
    }
    return null;
  };

  // Linux checks each name everywhere before the next, so ~/.local/bin/zeditor beats the ZFS zed.
  const groups = platform === "linux" ? names.map((name) => [name]) : [names];
  for (const group of groups) {
    const found = prefersInstallLocation
      ? ((await findBundleLinkOnPath(group)) ??
        (await findInstalled(group)) ??
        (await findOnPath(group)))
      : ((await findOnPath(group)) ?? (await findInstalled(group)));
    if (found) return found;
  }
  return null;
}

/** On Linux an executable `xdg-open` proves nothing: without a directory handler it silently fails. */
async function isFileManagerAvailable(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  listings: DirectoryListings,
  runProbe: LinuxProbeRunner,
): Promise<boolean> {
  const command = fileManagerCommandForPlatform(platform);
  if (command !== "xdg-open") {
    return isCommandAvailable(command, { platform, env, listings });
  }
  if (!(await isCommandAvailable(command, { platform, env, listings }))) return false;
  // WSL's xdg-open usually hands off to Windows, needing neither a Linux display nor a handler.
  if (isWslSession(env)) return true;
  if (
    !hasGraphicalLinuxSession(env) ||
    !(await isCommandAvailable("xdg-mime", { platform, env, listings }))
  ) {
    return false;
  }
  try {
    const { exitCode, stdout } = await runProbe(
      "xdg-mime",
      ["query", "default", "inode/directory"],
      { env: resolveLaunchEnv(env), timeoutMs: LINUX_PROBE_TIMEOUT_MS },
    );
    return exitCode === 0 && stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function resolveAvailableEditors(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    readonly systemRoot?: string | undefined;
    readonly runProbe?: LinuxProbeRunner | undefined;
  } = {},
): Promise<ReadonlyArray<EditorId>> {
  const available: EditorId[] = [];
  const listings: DirectoryListings = new Map();
  const entries: DirectoryEntries = new Map();

  for (const editor of EDITORS) {
    const found = editor.commands
      ? (await resolveEditorCommand(editor, {
          platform,
          env,
          listings,
          entries,
          systemRoot: options.systemRoot,
        })) !== null
      : await isFileManagerAvailable(platform, env, listings, options.runProbe ?? runLinuxProbe);
    if (found) {
      available.push(editor.id);
    }
  }

  return available;
}

const EDITOR_DISCOVERY_TTL_MS = 60_000;
const EDITOR_DISCOVERY_TIMEOUT_MS = 5_000;
const EDITOR_DISCOVERY_REFRESH_TIMEOUT_MS = 30_000;

/**
 * Memoizes editor discovery with stale-while-revalidate: a fresh result is
 * reused, a stale one is returned while a single background refresh runs, and
 * concurrent cold callers share one in-flight scan.
 */
export function makeCachedEditorDiscovery(
  discover: () => Promise<ReadonlyArray<EditorId>> = () => resolveAvailableEditors(),
  options: {
    readonly ttlMs?: number;
    readonly now?: () => number;
    readonly refreshTimeoutMs?: number;
  } = {},
): () => Promise<ReadonlyArray<EditorId>> {
  const ttlMs = options.ttlMs ?? EDITOR_DISCOVERY_TTL_MS;
  // Monotonic so a wall-clock rollback cannot keep a stale list alive.
  const now = options.now ?? (() => performance.now());
  const refreshTimeoutMs = options.refreshTimeoutMs ?? EDITOR_DISCOVERY_REFRESH_TIMEOUT_MS;
  let cached: { readonly value: ReadonlyArray<EditorId>; readonly at: number } | undefined;
  let inFlight: Promise<ReadonlyArray<EditorId>> | undefined;

  const scan = () => {
    if (!inFlight) {
      // A scan that never settles stops counting as in flight so a later call can retry.
      const timer = setTimeout(() => {
        if (inFlight === pending) inFlight = undefined;
      }, refreshTimeoutMs);
      timer.unref?.();
      const pending: Promise<ReadonlyArray<EditorId>> = Promise.resolve()
        .then(discover)
        .then((value) => {
          cached = { value, at: now() };
          return value;
        })
        .finally(() => {
          clearTimeout(timer);
          if (inFlight === pending) inFlight = undefined;
        });
      inFlight = pending;
    }
    return inFlight;
  };

  return () => {
    if (!cached) return scan();
    if (now() - cached.at >= ttlMs) {
      // Background refresh failures keep serving the last known list.
      scan().catch(() => {});
    }
    return Promise.resolve(cached.value);
  };
}

/**
 * Bounds editor discovery for the server config snapshot: a stalled PATH entry
 * (e.g. a hung network mount) degrades to an empty list instead of hanging.
 */
export const resolveAvailableEditorsForConfig = (
  discover: () => Promise<ReadonlyArray<EditorId>>,
  timeoutMs: number = EDITOR_DISCOVERY_TIMEOUT_MS,
): Effect.Effect<ReadonlyArray<EditorId>> =>
  Effect.tryPromise(discover).pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.map(Option.getOrElse((): ReadonlyArray<EditorId> => [])),
    Effect.catch(() => Effect.succeed<ReadonlyArray<EditorId>>([])),
  );

/**
 * OpenShape - Service API for browser and editor launch actions.
 */
export interface OpenShape {
  /**
   * Open a URL target in the default browser.
   */
  readonly openBrowser: (target: string) => Effect.Effect<void, OpenError>;

  /**
   * Open a workspace path in a selected editor integration.
   *
   * Launches the editor as a detached process so server startup is not blocked.
   */
  readonly openInEditor: (input: OpenInEditorInput) => Effect.Effect<void, OpenError>;
}

/**
 * Open - Service tag for browser/editor launch operations.
 */
export class Open extends ServiceMap.Service<Open, OpenShape>()("piedpiper/open") {}

// ==============================
// Implementations
// ==============================

export const resolveEditorLaunch = Effect.fn("resolveEditorLaunch")(function* (
  input: OpenInEditorInput,
  platform: NodeJS.Platform = process.platform,
  lookup: Pick<EditorCommandLookupOptions, "env" | "systemRoot"> & {
    /** Test seam; defaults to the user's home directory. */
    readonly homeDir?: string | undefined;
  } = {},
): Effect.fn.Return<EditorLaunch, OpenError> {
  yield* Effect.annotateCurrentSpan({
    "open.editor": input.editor,
    "open.cwd": input.cwd,
    "open.platform": platform,
  });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new OpenError({ message: `Unknown editor: ${input.editor}` });
  }
  const cwd = expandHomePathForPlatform(input.cwd, platform, lookup.homeDir);

  if (editorDef.commands) {
    const resolved = yield* Effect.tryPromise(() =>
      resolveEditorCommand(editorDef, { ...lookup, platform }),
    ).pipe(Effect.catch(() => Effect.succeed(null)));
    // Unresolved launches keep the primary name so launchDetached reports it as not found.
    const { command, baseArgs } = resolved ?? {
      // On Linux that is `zeditor`, so a missing Zed never spawns the OpenZFS `zed` daemon.
      command: editorCommandNames(editorDef, platform)[0] ?? editorDef.commands[0],
      baseArgs: editorBaseArgs(editorDef),
    };
    return {
      command,
      args: [...baseArgs, ...resolveCommandEditorArgs(editorDef, cwd)],
    };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new OpenError({ message: `Unsupported editor: ${input.editor}` });
  }

  const command = fileManagerCommandForPlatform(platform);
  // Explorer ignores forward-slash paths and opens a default folder instead.
  const target = platform === "win32" ? cwd.replaceAll("/", "\\") : cwd;
  if (input.reveal === true) {
    return yield* resolveFileManagerRevealLaunch(command, target, platform, lookup.env);
  }
  return { command, args: [target] };
});

/**
 * `open` and `xdg-open` resolve on the child's spawn, so a deleted, moved or unmounted folder would
 * give no feedback. A reveal has its own errors, and an editor can create what it opens.
 */
export const requireFileManagerFolder = (
  input: OpenInEditorInput,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly homeDir?: string | undefined;
    readonly exists?: (path: string) => boolean;
  } = {},
): Effect.Effect<void, OpenError> =>
  Effect.suspend(() => {
    if (input.editor !== "file-manager" || input.reveal === true) return Effect.void;
    const cwd = expandHomePathForPlatform(
      input.cwd,
      options.platform ?? process.platform,
      options.homeDir,
    );
    return (options.exists ?? existsSync)(cwd)
      ? Effect.void
      : Effect.fail(new OpenError({ message: `Project folder not found: ${cwd}` }));
  });

const POWERSHELL_ARGUMENTS_PREFIX = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
] as const;

function resolvePowerShellPath(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SYSTEMROOT || env.SystemRoot || env.windir || "C:\\Windows";
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

// PowerShell also closes a single-quoted string on the typographic quotes, so double those too.
function escapePowerShellStringLiteral(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;
}

/**
 * Stock Windows sets the Directory shell verb to "none"; a replacement manager registers its own
 * and gets the parent folder, since only Explorer has a way to select the item.
 */
function buildWindowsRevealScript(path: string): string {
  const parent = escapePowerShellStringLiteral(pathWin32.dirname(path));
  const item = escapePowerShellStringLiteral(path);
  return `$ProgressPreference = 'SilentlyContinue'; $folderVerb = (Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\Directory\\shell' -ErrorAction SilentlyContinue).'(default)'; if ($folderVerb -and $folderVerb -ne 'none') { Invoke-Item -LiteralPath ${parent} } else { Start-Process 'explorer.exe' -ArgumentList ('/select,"' + ${item} + '"') }`;
}

function stripTargetPosition(target: string): string {
  return parseTargetPathAndPosition(target)?.path ?? target;
}

/** Launch that shows `target` selected in the platform file manager; Linux opens its folder. */
const resolveFileManagerRevealLaunch = Effect.fn("resolveFileManagerRevealLaunch")(function* (
  command: string,
  target: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<EditorLaunch, OpenError> {
  const path = stripTargetPosition(target);
  switch (platform) {
    case "darwin":
      return { command, args: ["-R", path] };
    case "win32":
      // Passed verbatim, so a quote could break out of the quoted path; Windows paths never hold one.
      if (hasWindowsShimUnsafeChars(path)) {
        return yield* new OpenError({
          message: "Cannot reveal a path containing line breaks or double quotes",
        });
      }
      return {
        command: resolvePowerShellPath(env),
        args: [
          ...POWERSHELL_ARGUMENTS_PREFIX,
          Buffer.from(buildWindowsRevealScript(path), "utf16le").toString("base64"),
        ],
        // Windows PowerShell started detached exits 0 without running its command.
        detached: false,
        fallback: { command, args: [`/select,"${path}"`], windowsVerbatimArguments: true },
        // A PowerShell 7 parent's module path stops 5.1 loading the cmdlets this script calls.
        unsetEnv: ["PSModulePath"],
      };
    default:
      return { command, args: [pathPosix.dirname(path)] };
  }
});

/**
 * Build the environment for a launched editor or file manager. The desktop app
 * runs this server with ELECTRON_RUN_AS_NODE, which an Electron-based editor
 * (VS Code's CLI, Cursor) would inherit and start as plain Node. Server-only
 * PIEDPIPER_* settings are dropped for the same reason.
 */
export function resolveLaunchEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === "ELECTRON_RUN_AS_NODE" || normalizedKey.startsWith("PIEDPIPER_")) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * Resolves how an editor launch is spawned. A Windows .cmd shim re-parses its
 * arguments through cmd.exe, so a path with a quote or line break could run
 * commands; returns null for such a launch since it cannot be opened safely.
 */
export function resolveEditorSpawnCommand(
  launch: EditorLaunch,
  options: {
    env?: NodeJS.ProcessEnv | undefined;
    platform?: NodeJS.Platform | undefined;
    isFile?: ((filePath: string) => boolean) | undefined;
  } = {},
): ResolvedSpawnCommand | null {
  let spawnCommand: ResolvedSpawnCommand;
  try {
    spawnCommand = resolveSpawnCommand(launch.command, launch.args, options);
  } catch {
    return null;
  }
  if (spawnCommand.shell && launch.args.some(hasWindowsShimUnsafeChars)) {
    return null;
  }
  return spawnCommand;
}

/** Spawn options for a detached launch; Explorer's `/select,"<path>"` must reach it unquoted. */
export function editorSpawnOptions(
  launch: EditorLaunch,
  spawnCommand: ResolvedSpawnCommand,
  env: NodeJS.ProcessEnv,
): SpawnOptions {
  const detached = launch.detached ?? true;
  return {
    detached,
    stdio: "ignore",
    shell: spawnCommand.shell,
    env,
    // An attached child of a console-less server would otherwise flash a console window.
    ...(detached ? {} : { windowsHide: true }),
    ...(launch.windowsVerbatimArguments && !spawnCommand.shell
      ? { windowsVerbatimArguments: true }
      : {}),
  };
}

// platform/isFile are test seams for the Windows shim resolution.
interface LaunchDetachedOptions {
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  isFile?: ((filePath: string) => boolean) | undefined;
}

function withoutEnvVariables(
  env: NodeJS.ProcessEnv,
  names: ReadonlyArray<string>,
): NodeJS.ProcessEnv {
  const unset = new Set(names.map((name) => name.toUpperCase()));
  return Object.fromEntries(Object.entries(env).filter(([key]) => !unset.has(key.toUpperCase())));
}

const spawnDetachedLaunch = (launch: EditorLaunch, options: LaunchDetachedOptions) =>
  Effect.gen(function* () {
    const env = withoutEnvVariables(
      resolveLaunchEnv(options.env ?? process.env),
      launch.unsetEnv ?? [],
    );
    const commandAvailable = yield* Effect.tryPromise(() =>
      isCommandAvailable(launch.command, { env, platform: options.platform }),
    ).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!commandAvailable) {
      return yield* new OpenError({ message: `Editor command not found: ${launch.command}` });
    }

    const spawnCommand = resolveEditorSpawnCommand(launch, {
      env,
      platform: options.platform,
      isFile: options.isFile,
    });
    if (spawnCommand === null) {
      return yield* new OpenError({
        message: `${launch.command} cannot open a path containing line breaks or double quotes`,
      });
    }

    yield* Effect.callback<void, OpenError>((resume) => {
      let child;
      try {
        child = spawn(
          spawnCommand.command,
          [...spawnCommand.args],
          editorSpawnOptions(launch, spawnCommand, env),
        );
      } catch (error) {
        return resume(
          Effect.fail(new OpenError({ message: "failed to spawn detached process", cause: error })),
        );
      }

      const handleSpawn = () => {
        child.unref();
        resume(Effect.void);
      };

      child.once("spawn", handleSpawn);
      child.once("error", (cause) =>
        resume(Effect.fail(new OpenError({ message: "failed to spawn detached process", cause }))),
      );
    });
  });

export const launchDetached = (
  launch: EditorLaunch,
  options: LaunchDetachedOptions = {},
): Effect.Effect<void, OpenError> => {
  const { fallback } = launch;
  const attempt = spawnDetachedLaunch(launch, options);
  return fallback ? attempt.pipe(Effect.catch(() => launchDetached(fallback, options))) : attempt;
};

/** Asks the desktop's file manager to select `target`; false means the caller should open its folder. */
export async function tryRevealLinuxItem(
  target: string,
  options: {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly runProbe?: LinuxProbeRunner | undefined;
  } = {},
): Promise<boolean> {
  if (!pathPosix.isAbsolute(target)) return false;
  const env = resolveLaunchEnv(options.env ?? process.env);
  if (!(await isCommandAvailable("gdbus", { platform: "linux", env }))) return false;
  const runProbe = options.runProbe ?? runLinuxProbe;
  try {
    // A timeout also falls back, so a cold file manager can show a second window; accepted trade-off.
    const { exitCode } = await runProbe(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.FileManager1",
        "--object-path",
        "/org/freedesktop/FileManager1",
        "--method",
        "org.freedesktop.FileManager1.ShowItems",
        // File URLs percent-encode the double quotes and backslashes GVariant would interpret.
        `["${pathToFileURL(target).href}"]`,
        "",
      ],
      { env, timeoutMs: LINUX_PROBE_TIMEOUT_MS },
    );
    return exitCode === 0;
  } catch {
    return false;
  }
}

/** Starts the launch for `input`; a Linux reveal first asks the file manager to select the item. */
export const launchEditor = Effect.fn("launchEditor")(function* (
  input: OpenInEditorInput,
  // Test seams; default to this host.
  options: {
    readonly platform?: NodeJS.Platform | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly homeDir?: string | undefined;
    readonly runProbe?: LinuxProbeRunner | undefined;
  } = {},
): Effect.fn.Return<void, OpenError> {
  const platform = options.platform ?? process.platform;
  const { env, runProbe } = options;
  const launch = yield* resolveEditorLaunch(input, platform, { env, homeDir: options.homeDir });
  if (input.editor === "file-manager" && input.reveal === true && platform === "linux") {
    const target = stripTargetPosition(
      expandHomePathForPlatform(input.cwd, platform, options.homeDir),
    );
    const revealed = yield* Effect.promise(() => tryRevealLinuxItem(target, { env, runProbe }));
    if (revealed) return;
  }
  yield* launchDetached(launch, { env, platform });
});

const make = Effect.gen(function* () {
  const open = yield* Effect.tryPromise({
    try: () => import("open"),
    catch: (cause) => new OpenError({ message: "failed to load browser opener", cause }),
  });

  return {
    openBrowser: (target) =>
      Effect.tryPromise({
        try: () => open.default(target),
        catch: (cause) => new OpenError({ message: "Browser auto-open failed", cause }),
      }),
    openInEditor: (input) =>
      requireFileManagerFolder(input).pipe(Effect.andThen(launchEditor(input))),
  } satisfies OpenShape;
});

export const OpenLive = Layer.effect(Open, make);
