import {
  TERMINAL_SEQUENCE_GROUND,
  terminalSequenceEnd,
  terminalSequenceStateAfter,
} from "./TerminalSequenceState";

export const DEFAULT_HISTORY_BYTE_LIMIT = 8 * 1024 * 1024;
const MAX_HISTORY_CHUNK_LENGTH = 16 * 1024;

interface TerminalHistoryChunk {
  data: string;
  byteLength: number;
  lineBreaks: number;
}

/** Where the on-disk history file stands relative to a `BoundedTerminalHistory`. */
export interface TerminalHistoryPersistenceCursor {
  /** Bumped whenever retained text changes other than by appending. */
  readonly generation: number;
  /** Code units appended since the last clear when the file was written. */
  readonly offset: number;
  /** UTF-8 size of the history file after that write. */
  readonly fileBytes: number;
}

export interface TerminalHistoryPersistenceUpdate {
  readonly data: string;
  /** True to append `data` to the file; false to replace the file with it. */
  readonly append: boolean;
  readonly cursor: TerminalHistoryPersistenceCursor;
}

/**
 * Terminal history capped by line count and by UTF-8 bytes, with O(chunk) appends.
 *
 * Text is kept in small chunks that track their byte and newline counts, so trimming
 * scans only the evicted prefix. The line cap retains exactly what
 * `capHistory(previous + chunk, maxLines)` would; the byte cap then drops the oldest
 * text without splitting a surrogate pair. `value()` is cached until the next mutation.
 */
export class BoundedTerminalHistory {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private chunks: Array<TerminalHistoryChunk | undefined> = [];
  private start = 0;
  private byteLength = 0;
  private lineBreaks = 0;
  // Reading the joined string's tail on each append could force chunk concatenation.
  private lastCodeUnit: number | undefined;
  // The terminal parser's state at the first retained code unit, which is where a replay starts.
  private sequenceState = TERMINAL_SEQUENCE_GROUND;
  private cachedValue: string | null = "";
  private generation = 0;
  private appendedLength = 0;

  constructor(maxLines: number, initial = "", maxBytes = DEFAULT_HISTORY_BYTE_LIMIT) {
    this.maxLines = Math.max(0, maxLines);
    this.maxBytes = Math.max(0, maxBytes);
    this.append(initial);
  }

  /** Retained UTF-8 size in bytes. */
  get bytes(): number {
    return this.byteLength;
  }

  append(text: string): void {
    if (text.length === 0) return;
    this.appendedLength += text.length;
    this.cachedValue = null;
    if (this.maxBytes <= 0 || this.maxLines <= 0) {
      this.clear();
      // A zero-line cap still keeps the trailing newline, like capHistory.
      if (this.maxBytes > 0 && text.endsWith("\n")) this.appendChunk("\n");
      return;
    }

    let offset = 0;
    const previous = this.chunks.at(-1);
    const lastCode = this.lastCodeUnit;
    const firstCode = text.charCodeAt(0);
    if (
      previous &&
      lastCode !== undefined &&
      isHighSurrogate(lastCode) &&
      isLowSurrogate(firstCode)
    ) {
      // Joining a split surrogate changes its UTF-8 size from 3 to 4 bytes.
      // The previous flush may have encoded the lone surrogate as a replacement character.
      this.generation += 1;
      previous.data += text[0];
      previous.byteLength += 1;
      this.byteLength += 1;
      this.lastCodeUnit = firstCode;
      offset = 1;
      this.trim();
    }

    while (offset < text.length) {
      let end = Math.min(offset + MAX_HISTORY_CHUNK_LENGTH, text.length);
      if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
        end -= 1;
      }
      const data = text.slice(offset, end);
      // Detach small chunks from large input strings so evicted prefixes can be collected.
      this.appendChunk(
        text.length > MAX_HISTORY_CHUNK_LENGTH
          ? Buffer.from(data, "utf16le").toString("utf16le")
          : data,
      );
      this.trim();
      offset = end;
    }
  }

  /** Replaces the retained history, capping `text` to the limits. */
  reset(text = ""): void {
    this.clear();
    this.append(text);
  }

  clear(): void {
    this.generation += 1;
    this.appendedLength = 0;
    this.chunks = [];
    this.start = 0;
    this.byteLength = 0;
    this.lineBreaks = 0;
    this.lastCodeUnit = undefined;
    this.sequenceState = TERMINAL_SEQUENCE_GROUND;
    this.cachedValue = "";
  }

  /**
   * What to write so the history file catches up with this history. Given the cursor of the
   * previous successful write, only output appended since then is returned, to be appended to
   * the file; otherwise (first write, a clear, a joined surrogate, or appended output already
   * evicted) the whole retained history replaces the file. Appends stop once the file would
   * exceed twice the byte cap, so compaction is amortized and the file stays bounded; readers
   * cap the file's tail by bytes and lines anyway.
   */
  persistenceUpdate(previous?: TerminalHistoryPersistenceCursor): TerminalHistoryPersistenceUpdate {
    const offset = this.appendedLength;
    let data: string | undefined;
    if (previous !== undefined && previous.generation === this.generation) {
      let remaining = offset - previous.offset;
      const tail: string[] = [];
      for (let index = this.chunks.length - 1; remaining > 0 && index >= this.start; index -= 1) {
        const chunk = this.chunks[index]!.data;
        const suffix = chunk.slice(Math.max(0, chunk.length - remaining));
        tail.push(suffix);
        remaining -= suffix.length;
      }
      if (remaining === 0) data = tail.toReversed().join("");
    }
    const append =
      previous !== undefined &&
      data !== undefined &&
      previous.fileBytes + Buffer.byteLength(data) <= this.maxBytes * 2;
    const output = append ? data! : this.value();
    return {
      data: output,
      append,
      cursor: {
        generation: this.generation,
        offset,
        fileBytes: (append ? previous!.fileBytes : 0) + Buffer.byteLength(output),
      },
    };
  }

  value(): string {
    if (this.cachedValue !== null) return this.cachedValue;
    let joined = "";
    for (let index = this.start; index < this.chunks.length; index += 1) {
      joined += this.chunks[index]!.data;
    }
    this.cachedValue = joined;
    return joined;
  }

  private appendChunk(data: string): void {
    const byteLength = Buffer.byteLength(data);
    const lineBreaks = countLineBreaks(data);
    const previous = this.chunks.at(-1);
    if (previous && previous.data.length + data.length <= MAX_HISTORY_CHUNK_LENGTH) {
      previous.data += data;
      previous.byteLength += byteLength;
      previous.lineBreaks += lineBreaks;
    } else {
      this.chunks.push({ data, byteLength, lineBreaks });
    }
    this.byteLength += byteLength;
    this.lineBreaks += lineBreaks;
    this.lastCodeUnit = data.charCodeAt(data.length - 1);
    this.cachedValue = null;
  }

  private discardChunk(): void {
    const first = this.chunks[this.start]!;
    this.sequenceState = terminalSequenceStateAfter(this.sequenceState, first.data);
    this.byteLength -= first.byteLength;
    this.lineBreaks -= first.lineBreaks;
    this.chunks[this.start++] = undefined;
  }

  private trimChunk(offset: number, byteLength: number, lineBreaks: number): void {
    const first = this.chunks[this.start]!;
    if (offset === first.data.length) {
      this.discardChunk();
      return;
    }
    this.sequenceState = terminalSequenceStateAfter(this.sequenceState, first.data, 0, offset);
    first.data = first.data.slice(offset);
    first.byteLength -= byteLength;
    first.lineBreaks -= lineBreaks;
    this.byteLength -= byteLength;
    this.lineBreaks -= lineBreaks;
  }

  private trim(): void {
    const trailingNewline = this.lastCodeUnit === 10;
    let linesToDrop = this.lineBreaks + (trailingNewline ? 0 : 1) - this.maxLines;
    while (linesToDrop > 0) {
      const first = this.chunks[this.start]!;
      if (first.lineBreaks < linesToDrop) {
        linesToDrop -= first.lineBreaks;
        this.discardChunk();
        continue;
      }
      let offset = 0;
      for (let line = 0; line < linesToDrop; line += 1) {
        offset = first.data.indexOf("\n", offset) + 1;
      }
      this.trimChunk(offset, Buffer.byteLength(first.data.slice(0, offset)), linesToDrop);
      linesToDrop = 0;
    }

    while (this.byteLength > this.maxBytes) {
      const first = this.chunks[this.start]!;
      const bytesToDrop = this.byteLength - this.maxBytes;
      if (first.byteLength <= bytesToDrop) {
        this.discardChunk();
        continue;
      }
      if (first.byteLength === first.data.length && first.lineBreaks === 0) {
        // ASCII without newlines needs no scan to find the byte cutoff.
        this.trimChunk(bytesToDrop, bytesToDrop, 0);
        continue;
      }
      let offset = 0;
      let bytes = 0;
      let lineBreaks = 0;
      while (bytes < bytesToDrop) {
        const codePoint = first.data.codePointAt(offset)!;
        bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
        offset += codePoint <= 0xffff ? 1 : 2;
        if (codePoint === 10) lineBreaks += 1;
      }
      this.trimChunk(offset, bytes, lineBreaks);
    }

    // A cut inside a control sequence would replay the rest of it as text.
    while (this.sequenceState !== TERMINAL_SEQUENCE_GROUND && this.start < this.chunks.length) {
      const first = this.chunks[this.start]!;
      const dropped = first.data.slice(0, terminalSequenceEnd(this.sequenceState, first.data));
      this.trimChunk(dropped.length, Buffer.byteLength(dropped), countLineBreaks(dropped));
    }

    if (
      this.start === this.chunks.length ||
      (this.start > 2_048 && this.start * 2 >= this.chunks.length)
    ) {
      this.chunks = this.chunks.slice(this.start);
      this.start = 0;
      if (this.chunks.length === 0) this.lastCodeUnit = undefined;
    }
  }
}

function countLineBreaks(data: string): number {
  let lineBreaks = 0;
  for (let index = data.indexOf("\n"); index !== -1; index = data.indexOf("\n", index + 1)) {
    lineBreaks += 1;
  }
  return lineBreaks;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
