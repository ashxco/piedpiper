/**
 * Pure helpers for terminal subprocess polling: one process-table snapshot per
 * poll tick is parsed here and shared by every running terminal.
 */

import { TERMINAL_LABEL_MAX_LENGTH } from "@piedpiper/contracts";

export interface TerminalProcessTableEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly name?: string;
  readonly pgid?: number;
  /** Foreground process group of the entry's controlling terminal, as `ps` reports it. */
  readonly tpgid?: number;
}

export interface TerminalProcessTableIndex {
  readonly namesByPid: ReadonlyMap<number, string>;
  readonly childrenByPid: ReadonlyMap<number, ReadonlyArray<number>>;
  readonly processGroupsByPid: ReadonlyMap<
    number,
    { readonly pgid: number; readonly tpgid: number }
  >;
}

export interface TerminalSubprocessState {
  readonly hasRunningSubprocess: boolean;
  readonly childCommand: string | null;
}

export const MAX_SUBPROCESS_POLL_INTERVAL_MS = 60_000;

/** Parses `ps -eo pid=,ppid=,comm=` output; `comm` can contain spaces. */
export function parsePosixProcessTable(stdout: string): Array<TerminalProcessTableEntry> {
  const entries: Array<TerminalProcessTableEntry> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const match = /^\s*(\d+)\s+(\d+)(?:\s+(.*?))?\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue;
    entries.push({ pid, ppid, ...(match[3] ? { name: match[3] } : {}) });
  }
  return entries;
}

/** Parses `ps -eo pid=,ppid=,pgid=,tpgid=,comm=` output; `tpgid` is -1 or 0 with no terminal. */
export function parsePosixProcessGroupTable(stdout: string): Array<TerminalProcessTableEntry> {
  const entries: Array<TerminalProcessTableEntry> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)(?:\s+(.*?))?\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid <= 0) continue;
    entries.push({
      pid,
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      tpgid: Number(match[4]),
      ...(match[5] ? { name: match[5] } : {}),
    });
  }
  return entries;
}

/** Parses `pid|ppid|name` lines written by the Windows CIM query. */
export function parseWindowsProcessTable(stdout: string): Array<TerminalProcessTableEntry> {
  const entries: Array<TerminalProcessTableEntry> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const [pidRaw, ppidRaw, name] = line.trim().split("|", 3);
    if (!pidRaw || !ppidRaw) continue;
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue;
    entries.push({ pid, ppid, ...(name ? { name } : {}) });
  }
  return entries;
}

/** Builds the PowerShell command listing the direct children of the given terminal pids. */
export function windowsChildProcessQuery(terminalPids: ReadonlyArray<number>): string {
  const filter = terminalPids
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .map((pid) => `ParentProcessId = ${pid}`)
    .join(" OR ");
  return [
    `Get-CimInstance Win32_Process -Filter "${filter}" -Property ProcessId,ParentProcessId,Name -ErrorAction Stop`,
    'ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }',
  ].join(" | ");
}

/** Reduces a raw process name to the command name: no path, login-shell dash or `.exe`. */
export function normalizeChildCommandName(raw: string, platform: NodeJS.Platform): string | null {
  let name = raw.trim().replace(/\s*<defunct>$/, "");
  // ps wraps kernel threads and macOS zombies: "[kworker]", "(sleep)".
  if (
    (name.startsWith("[") && name.endsWith("]")) ||
    (name.startsWith("(") && name.endsWith(")"))
  ) {
    name = name.slice(1, -1).trim();
  }
  const separators = platform === "win32" ? /[\\/]/ : /\//;
  const base = (name.split(separators).at(-1) ?? name).trim().replace(/^-+/, "");
  const command =
    platform === "win32" && base.toLowerCase().endsWith(".exe") ? base.slice(0, -4) : base;
  return command.length > 0 ? command.slice(0, TERMINAL_LABEL_MAX_LENGTH) : null;
}

export function indexProcessTable(
  entries: ReadonlyArray<TerminalProcessTableEntry>,
): TerminalProcessTableIndex {
  const namesByPid = new Map<number, string>();
  const childrenByPid = new Map<number, Array<number>>();
  const processGroupsByPid = new Map<number, { pgid: number; tpgid: number }>();
  for (const entry of entries) {
    if (entry.name !== undefined) namesByPid.set(entry.pid, entry.name);
    if (entry.pgid !== undefined && entry.tpgid !== undefined) {
      processGroupsByPid.set(entry.pid, { pgid: entry.pgid, tpgid: entry.tpgid });
    }
    if (entry.pid === entry.ppid) continue;
    const siblings = childrenByPid.get(entry.ppid);
    if (siblings) siblings.push(entry.pid);
    else childrenByPid.set(entry.ppid, [entry.pid]);
  }
  return { namesByPid, childrenByPid, processGroupsByPid };
}

/**
 * Finds the command running under a terminal's shell. Async prompt themes fork the shell into a
 * helper that waits with no children, so a childless copy of the shell does not count unless it
 * holds the shell's terminal, as `bash script.sh` does at a `read` prompt. The shell's own tpgid is
 * the one to compare: a zsh-async worker leads the foreground group of its own zpty. The Windows
 * query lists only children, so the shell name is unknown there and every child counts.
 */
export function terminalSubprocessState(
  table: TerminalProcessTableIndex,
  terminalPid: number,
  platform: NodeJS.Platform,
): TerminalSubprocessState {
  const commandName = (pid: number) => {
    const raw = table.namesByPid.get(pid);
    return raw === undefined ? null : normalizeChildCommandName(raw, platform);
  };
  const shellName = commandName(terminalPid);
  const shellGroups = table.processGroupsByPid.get(terminalPid);
  const holdsShellTerminal = (pid: number) =>
    shellGroups !== undefined &&
    shellGroups.tpgid !== shellGroups.pgid &&
    table.processGroupsByPid.get(pid)?.pgid === shellGroups.tpgid;
  const childPid = (table.childrenByPid.get(terminalPid) ?? []).find(
    (pid) =>
      shellName === null ||
      commandName(pid) !== shellName ||
      (table.childrenByPid.get(pid)?.length ?? 0) > 0 ||
      holdsShellTerminal(pid),
  );
  return childPid === undefined
    ? { hasRunningSubprocess: false, childCommand: null }
    : { hasRunningSubprocess: true, childCommand: commandName(childPid) };
}

/**
 * Poll delay after `failureCount` consecutive failed snapshots: doubles per failure, capped at 60 s.
 * Also idles four times the last query's duration, so a slow table never keeps the loop busy.
 */
export function subprocessSnapshotPollDelayMs(
  pollIntervalMs: number,
  failureCount: number,
  queryElapsedMs = 0,
): number {
  return Math.min(
    Math.max(pollIntervalMs * 2 ** Math.max(0, failureCount), queryElapsedMs * 4),
    Math.max(pollIntervalMs, MAX_SUBPROCESS_POLL_INTERVAL_MS),
  );
}
