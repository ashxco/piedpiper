/**
 * Stateful per-instance JSON string extractor with a strict no-lossy-escape
 * invariant. One instance is owned by each in-flight tool; the adapter calls
 * `update(partialInputJson)` every time more partial JSON arrives from the
 * Claude SDK and forwards the returned delta over the runtime event stream.
 *
 * The extractor never silently substitutes characters: every escape either
 * decodes correctly, is emitted verbatim (only for malformed `\uXXXX`), or
 * extraction pauses until the next call has more buffer to consume.
 *
 * Limitation (v1 scope): file path extraction only works when a `"path"` key
 * appears in the JSON before the target field. This covers all known Claude
 * tool schemas (Write, StrReplace, Bash) where the path precedes the content
 * field. The scanner is intentionally simple — it is not a general-purpose
 * JSON parser.
 */
export class ToolInputStreamExtractor {
  readonly targetField: string;
  private valueStartOffset: number | null = null;
  private cursor = 0;
  private scanOffset = 0;
  private _filePath: string | undefined = undefined;
  private _oldString: string | undefined = undefined;
  private _done = false;

  constructor(targetField: string) {
    this.targetField = targetField;
  }

  get filePath(): string | undefined {
    return this._filePath;
  }

  /**
   * For Edit-style tools (`new_string` target), the value of `old_string`
   * captured from earlier in the JSON object — used by the UI to render the
   * removed lines as a real diff.
   */
  get oldString(): string | undefined {
    return this._oldString;
  }

  get done(): boolean {
    return this._done;
  }

  /**
   * Re-run the opportunistic file-path / old-string scan against the current
   * buffer. Called from the adapter on every input_json_delta so the meta
   * fields can be filled in even AFTER the target field has started
   * streaming. Both scans always start at offset 0 since these keys live at
   * the top of the tool input object.
   */
  refreshOpportunisticHints(partialJson: string): void {
    this.runOpportunisticScans(partialJson);
  }

  /**
   * Consume more of the accumulated `partialJson` buffer and return the new
   * extracted text since the last call. Returns `null` if no progress was
   * made or extraction is already complete.
   *
   * The caller MUST pass the FULL accumulated buffer (not the incremental
   * SDK delta), because the extractor needs to recover from chunk boundaries
   * that fall inside `\uXXXX` escapes or at trailing `\` characters.
   */
  update(partialJson: string): string | null {
    if (this._done) {
      return null;
    }

    if (this.valueStartOffset === null) {
      const found = this.scanForFieldStart(partialJson);
      if (found === null) {
        // Bound the next scan so we don't miss a key whose `"<key>":"` prefix
        // straddles two update() calls. The padding (key length + 10) covers
        // the surrounding quotes, colon, optional whitespace, and the value's
        // opening quote.
        this.scanOffset = Math.max(0, partialJson.length - this.targetField.length - 10);
        return null;
      }
      this.valueStartOffset = found;
      this.cursor = found;
    }

    if (this.cursor >= partialJson.length) {
      return null;
    }

    const len = partialJson.length;
    let delta = "";
    let i = this.cursor;
    while (i < len) {
      const ch = partialJson.charCodeAt(i);

      // Closing quote of the target string value — extraction is done.
      if (ch === 0x22 /* " */) {
        this._done = true;
        i += 1;
        break;
      }

      // Escape sequence — decode strictly or pause without consuming.
      if (ch === 0x5c /* \ */) {
        if (i + 1 >= len) {
          // Trailing backslash; wait for the next chunk.
          break;
        }
        const next = partialJson.charCodeAt(i + 1);
        if (next === 0x75 /* u */) {
          if (i + 5 >= len) {
            // Need 4 hex digits after `\u`; pause.
            break;
          }
          const hex = partialJson.slice(i + 2, i + 6);
          const code = parseInt(hex, 16);
          if (Number.isNaN(code)) {
            // Malformed \uXXXX — emit the 6 source characters verbatim.
            // This is the only deviation from spec; the alternative would
            // be to drop or substitute, which violates our invariant.
            delta += partialJson.slice(i, i + 6);
          } else {
            delta += String.fromCharCode(code);
          }
          i += 6;
          continue;
        }

        // Single-character escape.
        switch (next) {
          case 0x22 /* " */:
            delta += '"';
            break;
          case 0x5c /* \ */:
            delta += "\\";
            break;
          case 0x2f /* / */:
            delta += "/";
            break;
          case 0x6e /* n */:
            delta += "\n";
            break;
          case 0x72 /* r */:
            delta += "\r";
            break;
          case 0x74 /* t */:
            delta += "\t";
            break;
          case 0x62 /* b */:
            delta += "\b";
            break;
          case 0x66 /* f */:
            delta += "\f";
            break;
          default:
            // Unknown escape — preserve the source target character verbatim.
            delta += partialJson.charAt(i + 1);
            break;
        }
        i += 2;
        continue;
      }

      // Plain literal character.
      delta += partialJson.charAt(i);
      i += 1;
    }

    this.cursor = i;
    return delta.length > 0 ? delta : null;
  }

  /**
   * Linear scan for the opening `"` of the target field's string value.
   * Opportunistically extracts a `"path"` key encountered earlier in the
   * object. Returns the absolute offset of the first content character of
   * the target value, or `null` if the buffer doesn't yet contain enough
   * to commit.
   */
  private scanForFieldStart(partialJson: string): number | null {
    this.runOpportunisticScans(partialJson);
    const targetStart = this.findKeyValueOpening(partialJson, this.targetField, this.scanOffset);
    return targetStart;
  }

  /**
   * Try to capture file_path / old_string hints from anywhere in the buffer.
   * Always scans from offset 0 — these keys live at the top of the object so
   * the cost is bounded and we don't miss them when the advancing
   * `scanOffset` (used for the target field) skips past their position.
   */
  private runOpportunisticScans(partialJson: string): void {
    if (this._filePath === undefined) {
      for (const candidateKey of ["file_path", "path"]) {
        const candidateStart = this.findKeyValueOpening(partialJson, candidateKey, 0);
        if (candidateStart === null) continue;
        const decoded = this.decodeStringValue(partialJson, candidateStart);
        if (decoded !== null) {
          this._filePath = decoded.value;
          break;
        }
      }
    }
    if (this._oldString === undefined && this.targetField === "new_string") {
      const oldStart = this.findKeyValueOpening(partialJson, "old_string", 0);
      if (oldStart !== null) {
        const decoded = this.decodeStringValue(partialJson, oldStart);
        if (decoded !== null) {
          this._oldString = decoded.value;
        }
      }
    }
  }

  /**
   * Find a `"<key>"\s*:\s*"` pattern starting at `from` and return the offset
   * of the first content character of the value (right after the opening
   * quote). Returns `null` if not found or if the trailing `:` / opening
   * quote isn't present yet.
   */
  private findKeyValueOpening(buffer: string, key: string, from: number): number | null {
    const needle = `"${key}"`;
    let searchFrom = from;
    while (searchFrom <= buffer.length) {
      const keyIdx = buffer.indexOf(needle, searchFrom);
      if (keyIdx === -1) {
        return null;
      }
      let i = keyIdx + needle.length;
      // Skip whitespace before `:`.
      while (i < buffer.length && isJsonWhitespace(buffer.charCodeAt(i))) {
        i += 1;
      }
      if (i >= buffer.length) {
        return null;
      }
      if (buffer.charCodeAt(i) !== 0x3a /* : */) {
        // False match (e.g. `"path"` appeared inside another value). Keep
        // searching forward.
        searchFrom = keyIdx + needle.length;
        continue;
      }
      i += 1;
      // Skip whitespace before the value's opening quote.
      while (i < buffer.length && isJsonWhitespace(buffer.charCodeAt(i))) {
        i += 1;
      }
      if (i >= buffer.length) {
        return null;
      }
      if (buffer.charCodeAt(i) !== 0x22 /* " */) {
        // Value isn't a string (number, object, etc). Out of v1 scope —
        // keep searching for a later occurrence of the same key.
        searchFrom = keyIdx + needle.length;
        continue;
      }
      return i + 1;
    }
    return null;
  }

  /**
   * Decode a JSON string value starting at the given content offset using
   * the same escape rules as `update`. Returns `null` if the value is not
   * yet complete (closing quote missing, or trailing/incomplete escape).
   */
  private decodeStringValue(
    buffer: string,
    contentStart: number,
  ): { readonly value: string; readonly endOffset: number } | null {
    let value = "";
    let i = contentStart;
    const len = buffer.length;
    while (i < len) {
      const ch = buffer.charCodeAt(i);
      if (ch === 0x22 /* " */) {
        return { value, endOffset: i + 1 };
      }
      if (ch === 0x5c /* \ */) {
        if (i + 1 >= len) {
          return null;
        }
        const next = buffer.charCodeAt(i + 1);
        if (next === 0x75 /* u */) {
          if (i + 5 >= len) {
            return null;
          }
          const hex = buffer.slice(i + 2, i + 6);
          const code = parseInt(hex, 16);
          if (Number.isNaN(code)) {
            value += buffer.slice(i, i + 6);
          } else {
            value += String.fromCharCode(code);
          }
          i += 6;
          continue;
        }
        switch (next) {
          case 0x22:
            value += '"';
            break;
          case 0x5c:
            value += "\\";
            break;
          case 0x2f:
            value += "/";
            break;
          case 0x6e:
            value += "\n";
            break;
          case 0x72:
            value += "\r";
            break;
          case 0x74:
            value += "\t";
            break;
          case 0x62:
            value += "\b";
            break;
          case 0x66:
            value += "\f";
            break;
          default:
            value += buffer.charAt(i + 1);
            break;
        }
        i += 2;
        continue;
      }
      value += buffer.charAt(i);
      i += 1;
    }
    return null;
  }
}

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}
