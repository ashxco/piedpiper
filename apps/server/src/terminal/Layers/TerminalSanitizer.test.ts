import { describe, expect, it } from "vitest";

import { sanitizeTerminalHistoryChunk } from "./TerminalSanitizer";

function sanitizeChunks(chunks: ReadonlyArray<string>): { text: string; pending: string } {
  let pending = "";
  let text = "";
  for (const chunk of chunks) {
    const result = sanitizeTerminalHistoryChunk(pending, chunk);
    text += result.visibleText;
    pending = result.pendingControlSequence;
  }
  return { text, pending };
}

describe("sanitizeTerminalHistoryChunk", () => {
  it("returns plain output unchanged without parsing it", () => {
    const data = "café\t界🙂\u0007\u009c\u0085 plain\r\n".repeat(64);
    const result = sanitizeTerminalHistoryChunk("", data);
    expect(result).toEqual({ visibleText: data, pendingControlSequence: "" });
  });

  it("retains plain Unicode and control characters around a split query", () => {
    const before = "café\t界🙂\u0007\u009c\u0085";
    const after = "é\r\n";
    expect(sanitizeChunks([before, "\u001b[5", `n${after}`])).toEqual({
      text: before + after,
      pending: "",
    });
  });

  it("keeps printable runs between styling sequences intact", () => {
    const data = "\u001b[31mred text\u001b[0m and \u009b1mbold\u009b0m plain";
    expect(sanitizeChunks([data])).toEqual({ text: data, pending: "" });
  });

  it("does not rescan the pending prefix of large chunked OSC 52 and DCS strings", () => {
    const sequences = [
      { prefix: `\u001b]52;c;${"YWJj".repeat(16_384)}\u001b`, terminator: "\\" },
      { prefix: `\u0090q${"?".repeat(65_536)}`, terminator: "\u009c" },
    ];
    const stripped = "\u001b]11;?\u0007\u0090$q m\u009c";
    const preserved = "\u001b[31m\u009d52;c;YWJj\u009c";
    const expected =
      sequences.map(({ prefix, terminator }) => prefix + terminator + preserved).join("") +
      "done\n";

    const charCodeAt = String.prototype.charCodeAt;
    let largeStringReads = 0;
    let result: { text: string; pending: string };
    try {
      // eslint-disable-next-line no-extend-native -- Count reads without retaining spy call records.
      String.prototype.charCodeAt = function (this: string, index: number) {
        if (this.length > 4_096) largeStringReads += 1;
        return charCodeAt.call(this, index);
      };
      const chunks: Array<string> = [];
      for (const { prefix, terminator } of sequences) {
        for (let offset = 0; offset < prefix.length; offset += 4_096) {
          chunks.push(prefix.slice(offset, offset + 4_096));
        }
        chunks.push(terminator + stripped + preserved);
      }
      chunks.push("done\n");
      result = sanitizeChunks(chunks);
    } finally {
      // eslint-disable-next-line no-extend-native -- Restore the counting hook.
      String.prototype.charCodeAt = charCodeAt;
    }

    expect(result).toEqual({ text: expected, pending: "" });
    expect(largeStringReads).toBeLessThan(2 * expected.length);
  });
});
