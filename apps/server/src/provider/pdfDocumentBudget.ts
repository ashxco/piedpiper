import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@piedpiper/contracts";

// Leaves room below Anthropic's 32 MB request limit for instructions and SDK framing.
export const CLAUDE_SESSION_ATTACHMENT_MAX_BYTES = 28 * 1024 * 1024;
// The SDK does not expose document capabilities, so use the limit of smaller context windows.
export const CLAUDE_SESSION_ATTACHMENT_MAX_PAGES = 100;

const PDF_PREFIX = Buffer.from("%PDF-", "latin1");
const PDF_DELIMITER_BYTES = new Set(Array.from("()<>[]{}/%", (char) => char.charCodeAt(0)));
const REJECTED_PDF_TOKENS = new Set(["/ObjStm", "/XRef", "/Encrypt", "/Prev"]);

const isPdfDelimiter = (byte: number) => byte <= 32 || PDF_DELIMITER_BYTES.has(byte);

/**
 * Page count of a PDF, or null when unknown. Never decodes streams: only an explicit, uncompressed
 * page tree whose /Count agrees with the visible page objects counts, so anything else stays path-only.
 */
export function estimateClaudePdfPages(input: Uint8Array): number | null {
  const bytes = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length > PROVIDER_SEND_TURN_MAX_FILE_BYTES) return null;
  if (!bytes.subarray(0, PDF_PREFIX.length).equals(PDF_PREFIX)) return null;
  if (!bytes.subarray(-1024).includes("%%EOF")) return null;
  let pages = 0;
  let count = 0;
  let catalog = false;
  let pageTree = false;
  let previous = "";
  for (let i = 0; i < bytes.length; ) {
    const byte = bytes[i]!;
    if (byte === 37) {
      while (i < bytes.length && bytes[i] !== 10 && bytes[i] !== 13) i++;
      continue;
    }
    if (byte <= 32) {
      i++;
      continue;
    }
    if (previous === "/Type" && byte !== 47) return null;
    if (previous === "/Kids") {
      if (byte !== 91) return null;
      previous = "";
    }
    if (byte === 40) {
      let depth = 1;
      for (i++; i < bytes.length && depth > 0; i++) {
        if (bytes[i] === 92) i++;
        else if (bytes[i] === 40) depth++;
        else if (bytes[i] === 41) depth--;
      }
      if (depth !== 0) return null;
      previous = "";
      continue;
    }
    if (byte === 60 && bytes[i + 1] !== 60) {
      i = bytes.indexOf(62, i + 1);
      if (i < 0) return null;
      i++;
      previous = "";
      continue;
    }
    if (byte === 60 && bytes[i + 1] === 60) {
      i += 2;
      previous = "";
      continue;
    }
    if (isPdfDelimiter(byte) && byte !== 47) {
      i++;
      continue;
    }
    const start = i++;
    while (i < bytes.length && !isPdfDelimiter(bytes[i]!)) i++;
    if (i - start > 64) return null;
    const token = bytes.toString("latin1", start, i);
    if (token.includes("#") || REJECTED_PDF_TOKENS.has(token)) return null;
    if (token === "stream") {
      i = bytes.indexOf("endstream", i);
      if (i < 0) return null;
      i += 9;
      previous = "";
      continue;
    }
    if (previous === "/Type") {
      if (token === "/Page") pages++;
      if (token === "/Catalog") catalog = true;
      if (token === "/Pages") pageTree = true;
    }
    if (previous === "/Count") {
      if (!/^[1-9]\d{0,8}$/.test(token)) return null;
      let next = i;
      while (next < bytes.length) {
        if (bytes[next]! <= 32) next++;
        else if (bytes[next] === 37) {
          while (next < bytes.length && bytes[next] !== 10 && bytes[next] !== 13) next++;
        } else break;
      }
      // A second scalar is an indirect reference, not a direct page count.
      if (next < bytes.length && !isPdfDelimiter(bytes[next]!)) return null;
      count = Math.max(count, Number(token));
    }
    previous = token;
  }
  return catalog && pageTree && pages > 0 && count === pages ? pages : null;
}

/** Bytes a base64 block keeps in the request, framing included. */
export const claudeBase64RetainedBytes = (byteLength: number): number =>
  4 * Math.ceil(byteLength / 3) + 128;

export function buildClaudePdfDocumentBlock(bytes: Uint8Array): Record<string, unknown> {
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: Buffer.from(bytes).toString("base64"),
    },
  };
}

export interface ClaudePdfReservation {
  /** Positions in the `pdfs` input to send as document blocks; the rest stay path-only. */
  readonly documentIndexes: ReadonlySet<number>;
  /** Call once the message is queued; retained history now holds these bytes. */
  readonly commit: () => void;
  /** Call when the message was not queued. A no-op after commit. */
  readonly rollback: () => void;
}

export interface ClaudeAttachmentBudget {
  readonly remainingBytes: () => number;
  readonly remainingPages: () => number;
  /** Text and images always count first, wherever they sit in the message; PDFs get what is left. */
  readonly reserve: (input: {
    readonly textBytes: number;
    readonly imageBytes: ReadonlyArray<number>;
    readonly pdfs: ReadonlyArray<Uint8Array>;
  }) => ClaudePdfReservation;
  readonly compactionStarted: () => void;
  readonly compactionAborted: () => void;
  /** Only a full compaction frees budget: a partial one may keep any attachment it preserved. */
  readonly compactionFinished: (input: { readonly full: boolean }) => void;
}

/** A resumed session's history is unknown, so its PDFs stay path-only until a full compaction. */
export function makeClaudeAttachmentBudget(options?: {
  readonly resumed?: boolean;
  readonly estimatePages?: (input: Uint8Array) => number | null;
}): ClaudeAttachmentBudget {
  const estimatePages = options?.estimatePages ?? estimateClaudePdfPages;
  const committed = options?.resumed
    ? { pages: CLAUDE_SESSION_ATTACHMENT_MAX_PAGES, bytes: CLAUDE_SESSION_ATTACHMENT_MAX_BYTES }
    : { pages: 0, bytes: 0 };
  const pending = { pages: 0, bytes: 0 };
  // Committed when compaction started: messages queued while it runs are not in what it removes.
  let compacting: { readonly pages: number; readonly bytes: number } | null = null;

  const remainingBytes = () =>
    CLAUDE_SESSION_ATTACHMENT_MAX_BYTES - committed.bytes - pending.bytes;
  const remainingPages = () =>
    CLAUDE_SESSION_ATTACHMENT_MAX_PAGES - committed.pages - pending.pages;

  return {
    remainingBytes,
    remainingPages,
    reserve: ({ textBytes, imageBytes, pdfs }) => {
      let reservedBytes = textBytes;
      for (const size of imageBytes) reservedBytes += claudeBase64RetainedBytes(size);
      pending.bytes += reservedBytes;
      let reservedPages = 0;
      const documentIndexes = new Set<number>();
      pdfs.forEach((bytes, index) => {
        const retained = claudeBase64RetainedBytes(bytes.byteLength);
        // The scan blocks the event loop, so skip it for a PDF that cannot fit anyway.
        if (retained > remainingBytes() || remainingPages() <= 0) return;
        const pages = estimatePages(bytes);
        if (pages === null || pages > remainingPages()) return;
        pending.pages += pages;
        pending.bytes += retained;
        reservedPages += pages;
        reservedBytes += retained;
        documentIndexes.add(index);
      });
      let settled = false;
      const release = () => {
        pending.pages -= reservedPages;
        pending.bytes -= reservedBytes;
      };
      return {
        documentIndexes,
        commit: () => {
          if (settled) return;
          settled = true;
          release();
          committed.pages += reservedPages;
          committed.bytes += reservedBytes;
        },
        rollback: () => {
          if (settled) return;
          settled = true;
          release();
        },
      };
    },
    compactionStarted: () => {
      compacting = { ...committed };
    },
    compactionAborted: () => {
      compacting = null;
    },
    compactionFinished: ({ full }) => {
      if (full) {
        const compacted = compacting ?? { ...committed };
        committed.pages = Math.max(0, committed.pages - compacted.pages);
        committed.bytes = Math.max(0, committed.bytes - compacted.bytes);
      }
      compacting = null;
    },
  };
}
