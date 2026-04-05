/**
 * Shell discovery and spawn-retry helpers for the terminal manager.
 *
 * Builds an ordered candidate list of shells to try when spawning a PTY:
 * the explicitly requested shell first, then the user's $SHELL, then a
 * platform-appropriate fallback chain. `isRetryableShellSpawnError` walks
 * the error cause chain to detect ENOENT-style failures so the manager
 * can fall through to the next candidate.
 */
import path from "node:path";

import type { PtySpawnError } from "../Services/PTY";

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export function defaultShellResolver(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "cmd.exe";
  }
  return process.env.SHELL ?? "bash";
}

export function normalizeShellCommand(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (process.platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

export function shellCandidateFromCommand(command: string | null): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = path.basename(command).toLowerCase();
  if (process.platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
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

export function resolveShellCandidates(shellResolver: () => string): ShellCandidate[] {
  const requested = shellCandidateFromCommand(normalizeShellCommand(shellResolver()));

  if (process.platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand(process.env.ComSpec ?? null),
      shellCandidateFromCommand("powershell.exe"),
      shellCandidateFromCommand("cmd.exe"),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(process.env.SHELL)),
    shellCandidateFromCommand("/bin/zsh"),
    shellCandidateFromCommand("/bin/bash"),
    shellCandidateFromCommand("/bin/sh"),
    shellCandidateFromCommand("zsh"),
    shellCandidateFromCommand("bash"),
    shellCandidateFromCommand("sh"),
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
    message.includes("no such file")
  );
}
