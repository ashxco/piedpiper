/**
 * Shell discovery and spawn-retry helpers for the terminal manager.
 *
 * Builds an ordered candidate list of shells to try when spawning a PTY:
 * the explicitly requested shell first, then the user's $SHELL, then a
 * platform-appropriate fallback chain. `isRetryableShellSpawnError` walks
 * the error cause chain to detect ENOENT-style failures so the manager
 * can fall through to the next candidate.
 */
import { statSync } from "node:fs";
import path from "node:path";

import type { PtySpawnError } from "../Services/PTY";

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export function defaultShellResolver(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    return "pwsh.exe";
  }
  return env.SHELL ?? "bash";
}

export type ShellPathIsFile = (candidate: string) => boolean;

function defaultShellPathIsFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
  isFile: ShellPathIsFile = defaultShellPathIsFile,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  // A quoted path is kept whole, even when it contains " -".
  const quoted = /^(['"])(.*?)\1(?:\s|$)/.exec(trimmed);
  if (quoted) return quoted[2] || null;

  // A shell path can contain spaces, so an unquoted absolute path is ambiguous with
  // `shell -flag`; prefer the longest prefix that is an existing file.
  if (trimmed.startsWith("/") && /\s/.test(trimmed)) {
    const ends = [...trimmed.matchAll(/\s+/g)].map((match) => match.index);
    for (const end of [trimmed.length, ...ends.reverse()]) {
      const candidate = trimmed.slice(0, end);
      if (isFile(candidate)) return candidate;
    }
  }

  // Otherwise only text from the first flag (`bash -l`) is dropped.
  return trimmed.split(/\s+(?=-)/)[0]?.replace(/^['"]|['"]$/g, "") || null;
}

// PowerShell decodes native output with the console code page (often OEM 437), mangling UTF-8.
const POWERSHELL_UTF8_SETUP =
  "[Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new()";
const POWERSHELL_ARGS = ["-NoLogo", "-NoExit", "-Command", POWERSHELL_UTF8_SETUP];

export function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform = process.platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = (
    platform === "win32" ? path.win32.basename(command) : path.basename(command)
  ).toLowerCase();
  if (platform === "win32" && (shellName === "pwsh.exe" || shellName === "powershell.exe")) {
    return { shell: command, args: [...POWERSHELL_ARGS] };
  }
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  if (platform === "darwin" && shellName === "bash") {
    return { shell: command, args: ["-l"] };
  }
  return { shell: command };
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

export function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

export function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

export function resolveShellCandidates(
  shellResolver: () => string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  isFile: ShellPathIsFile = defaultShellPathIsFile,
): ShellCandidate[] {
  const candidate = (command: string | null) => shellCandidateFromCommand(command, platform);
  const requested = candidate(normalizeShellCommand(shellResolver(), platform, isFile));

  if (platform === "win32") {
    const system32 = path.win32.join(windowsSystemRoot(env), "System32");
    // cmd stays ahead of PowerShell 5.1: scripts are typed raw and 5.1 rejects `a && b`.
    return uniqueShellCandidates([
      requested,
      candidate("pwsh.exe"),
      candidate(env.ComSpec ?? null),
      candidate(path.win32.join(system32, "cmd.exe")),
      candidate("cmd.exe"),
      candidate(path.win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe")),
      candidate("powershell.exe"),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    candidate(normalizeShellCommand(env.SHELL, platform, isFile)),
    candidate("/bin/zsh"),
    candidate("/bin/bash"),
    candidate("/bin/sh"),
    candidate("zsh"),
    candidate("bash"),
    candidate("sh"),
  ]);
}

export function isRetryableShellSpawnError(error: PtySpawnError): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      const cause = (current as { cause?: unknown }).cause;
      if (cause) {
        queue.push(cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file") ||
    message.includes("cannot create process")
  );
}
