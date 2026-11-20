// Byte hashes by file, so two different images that share a name, type and size (every clipboard
// paste is named image.png) are told apart. Files whose bytes were never read share one key, so
// a producer that does not read bytes keeps the old name, type and size dedupe.
const composerImageFingerprints = new WeakMap<File, string>();
const UNREAD_FINGERPRINT = "unread";

/** Records the bytes behind an image file, so a draft drops it only as a byte-for-byte repeat. */
export function rememberComposerImageBytes(file: File, bytes: Uint8Array): void {
  // cyrb53, synchronous: crypto.subtle is missing on plain-http remote origins.
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!;
    first = Math.imul(first ^ byte, 2654435761);
    second = Math.imul(second ^ byte, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507);
  first ^= Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507);
  second ^= Math.imul(first ^ (first >>> 13), 3266489909);
  composerImageFingerprints.set(file, `${second >>> 0}:${first >>> 0}`);
}

/** Reads and records a file's bytes; an unreadable file keeps the shared unread key. */
export async function readComposerImageBytes(file: File): Promise<void> {
  if (composerImageFingerprints.has(file)) return;
  const bytes = await file.arrayBuffer().catch(() => null);
  if (bytes) rememberComposerImageBytes(file, new Uint8Array(bytes));
}

export function composerImageFingerprint(file: File | undefined): string {
  return (file && composerImageFingerprints.get(file)) ?? UNREAD_FINGERPRINT;
}
