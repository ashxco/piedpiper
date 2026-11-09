// Keep memory keys collision-free and history filenames safe across supported filesystems.
import { createHash } from "node:crypto";
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

// eCryptfs has a 143-byte filename limit; ASCII encoded names also fit other filesystems.
export const MAX_HISTORY_FILENAME_BYTES = 143;
const hashId = (id: string) => createHash("sha256").update(id).digest("base64url");
export const hashedHistoryThreadPart = (threadId: string) => `terminal_sha256.${hashId(threadId)}`;
export function encodedHistoryName(threadId: string, terminalId: string): string {
  return `${toSafeThreadId(threadId)}${terminalId === "default" ? "" : `_${toSafeTerminalId(terminalId)}`}.log`;
}
export function historyName(threadId: string, terminalId: string): string {
  const encoded = encodedHistoryName(threadId, terminalId);
  return encoded.length <= MAX_HISTORY_FILENAME_BYTES
    ? encoded
    : `${hashedHistoryThreadPart(threadId)}${terminalId === "default" ? "" : `_${hashId(terminalId)}`}.log`;
}
