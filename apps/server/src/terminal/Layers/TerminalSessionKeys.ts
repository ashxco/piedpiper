/**
 * Stable id encoding helpers for terminal session lookup.
 *
 * Terminal session keys live on disk (history files, log files) and in
 * in-memory maps. The on-disk encoding uses a base64url-prefixed thread id
 * to keep filenames safe across platforms; the legacy variant kept the
 * thread id mostly readable but allowed unsafe characters through. The
 * memory keys use a NUL-delimited (threadId, terminalId) pair so that
 * thread ids and terminal ids cannot collide.
 */
import { Encoding } from "effect";

export function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function toSafeThreadId(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}`;
}

export function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

export function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}
