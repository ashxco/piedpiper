/**
 * Pure ANSI/VT100 control-sequence sanitization for terminal history.
 *
 * Strips synthetic CSI/OSC query responses and DCS/PM/APC strings that the
 * terminal would otherwise emit when an attached client polls for cursor
 * position, terminal capabilities, or color reports. The sanitizer keeps
 * everything else intact (including normal CSI styling sequences).
 *
 * Supports both 7-bit ESC-prefixed sequences and 8-bit C1 control bytes,
 * and yields a `pendingControlSequence` tail for chunked input where a
 * sequence may straddle a chunk boundary.
 */

export function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

// CAN and SUB abort any control sequence in progress.
function isControlSequenceCancel(codePoint: number): boolean {
  return codePoint === 0x18 || codePoint === 0x1a;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") {
    return true;
  }
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) {
    return true;
  }
  // DECRQM queries ($p) and DECRPM replies ($y); the `$` guard keeps DECSTR (!p) and DECSCL ("p).
  if ((finalByte === "p" || finalByte === "y") && /^[0-9;?]*\$$/.test(body)) {
    return true;
  }
  // XTVERSION query (>q); DECSCUSR (space-intermediate q) stays.
  if (finalByte === "q" && /^>[0-9;]*$/.test(body)) {
    return true;
  }
  // Kitty keyboard protocol query/reply (?u); restore-cursor (bare u) stays.
  if (finalByte === "u" && body.startsWith("?")) {
    return true;
  }
  return false;
}

// DECRQSS ($q) and XTGETTCAP (+q) queries plus their [01]$r / [01]+r replies.
function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content);
}

function shouldStripOscSequence(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === "\u0007" || lastCharacter === "\u009c") {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c || isControlSequenceCancel(codePoint)) {
      return index + 1;
    }
    // Like xterm.js, an ESC that does not start ST ends the string and begins the next sequence.
    if (codePoint === 0x1b) {
      if (index + 1 >= input.length) return null;
      return input.charCodeAt(index + 1) === 0x5c ? index + 2 : index;
    }
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  // A second ESC restarts the sequence, so leave it for the next pass.
  if (input.charCodeAt(cursor) === 0x1b) {
    return cursor;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

// eslint-disable-next-line no-control-regex -- Terminal sequence introducers must reach the parser.
const HISTORY_SEQUENCE_START = /[\u001b\u0090\u009b\u009d\u009e\u009f]/;
const NEXT_HISTORY_SEQUENCE_START = new RegExp(HISTORY_SEQUENCE_START.source, "g");

export function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  // Plain output has nothing to filter; a pending sequence still needs the parser.
  if (pendingControlSequence.length === 0 && !HISTORY_SEQUENCE_START.test(data)) {
    return { visibleText: data, pendingControlSequence: "" };
  }

  const input = `${pendingControlSequence}${data}`;
  // A pending string sequence holds no terminator except possibly its final ESC, so skip rescanning it.
  const pendingScanStart = Math.max(0, pendingControlSequence.length - 1);
  let visibleText = "";
  let index = 0;

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          const cursorCodePoint = input.charCodeAt(cursor);
          if (cursorCodePoint === 0x1b) {
            // ESC aborts the CSI; keep the fragment for the replaying terminal and restart at ESC.
            append(input.slice(index, cursor));
            index = cursor;
            break;
          }
          const cancelled = isControlSequenceCancel(cursorCodePoint);
          if (cancelled || isCsiFinalByte(cursorCodePoint)) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (cancelled || !shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(sequence);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(
          input,
          Math.max(index + 2, pendingScanStart),
        );
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const strip =
          (nextCodePoint === 0x5d && shouldStripOscSequence(content)) ||
          (nextCodePoint === 0x50 && shouldStripDcsSequence(content));
        if (!strip) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      append(input.slice(index, escapeSequenceEndIndex));
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        const cursorCodePoint = input.charCodeAt(cursor);
        if (cursorCodePoint === 0x1b) {
          // ESC aborts the CSI; keep the fragment for the replaying terminal and restart at ESC.
          append(input.slice(index, cursor));
          index = cursor;
          break;
        }
        const cancelled = isControlSequenceCancel(cursorCodePoint);
        if (cancelled || isCsiFinalByte(cursorCodePoint)) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (cancelled || !shouldStripCsiSequence(body, input[cursor] ?? "")) {
            append(sequence);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(
        input,
        Math.max(index + 1, pendingScanStart),
      );
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      const strip =
        (codePoint === 0x9d && shouldStripOscSequence(content)) ||
        (codePoint === 0x90 && shouldStripDcsSequence(content));
      if (!strip) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    // One slice per printable run instead of one append per character.
    NEXT_HISTORY_SEQUENCE_START.lastIndex = index + 1;
    const nextSequenceStart = NEXT_HISTORY_SEQUENCE_START.exec(input)?.index ?? input.length;
    append(input.slice(index, nextSequenceStart));
    index = nextSequenceStart;
  }

  return { visibleText, pendingControlSequence: "" };
}

// Input modes a dead full-screen program can leave on: cursor/keypad application modes, mouse
// tracking/encodings, focus events, bracketed paste and synchronized output, plus a hidden cursor,
// kitty keyboard flags and xterm modifyOtherKeys.
export const INHERITED_MODE_RESET =
  "\u001b[?1;9;66;1000;1002;1003;1004;1005;1006;1015;1016;2004;2026l" +
  "\u001b[?25h\u001b[<100u\u001b[=0;1u\u001b[>4m";

/**
 * Appends a reset suffix to persisted history that is replayed into a fresh terminal, so modes
 * left on by a program that died with the previous shell do not leak into the new prompt. The
 * history is first trimmed so the suffix (which occupies the last line) stays within `maxLines`.
 */
export function neutralizeInheritedHistory(history: string, maxLines: number): string {
  if (!history.includes("\u001b")) return history;
  if (history.endsWith(INHERITED_MODE_RESET)) return history;
  const bounded = history.endsWith("\n")
    ? capHistory(history, Math.max(1, maxLines - 1))
    : capHistory(history, maxLines);
  if (!bounded.includes("\u001b")) return bounded;

  // Only leave the alternate screen when replay actually ends on it: an unconditional 1049l
  // would restore a stale saved cursor on the main screen.
  let alternateScreenMode: number | undefined;
  // eslint-disable-next-line no-control-regex -- Match replayed alternate-screen controls and RIS.
  for (const match of bounded.matchAll(/\u001b(?:\[\?([0-9;]*)([hl])|(c))/gu)) {
    if (match[3]) {
      alternateScreenMode = undefined;
      continue;
    }
    for (const parameter of (match[1] ?? "").split(";")) {
      const mode = Number(parameter);
      if (mode === 47 || mode === 1047 || mode === 1049) {
        alternateScreenMode = match[2] === "h" ? (alternateScreenMode ?? mode) : undefined;
      }
    }
  }
  // Save the cursor first so the exit is a no-op if a client trimmed away the alt-screen entry.
  const leaveAlternateScreen =
    alternateScreenMode === undefined ? "" : `\u001b7\u001b[?${alternateScreenMode}l`;
  return `${bounded}${leaveAlternateScreen}${INHERITED_MODE_RESET}`;
}
