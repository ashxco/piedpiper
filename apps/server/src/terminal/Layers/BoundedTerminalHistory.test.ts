import { describe, expect, it } from "vitest";

import { BoundedTerminalHistory } from "./BoundedTerminalHistory";

// Apply the line policy, then keep the longest code-point-aligned byte tail.
function retainedHistory(text: string, maxLines: number, maxBytes = Infinity): string {
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  if (terminated) lines.pop();
  const retained = lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  const capped = terminated ? `${retained}\n` : retained;
  if (Buffer.byteLength(capped) <= maxBytes) return capped;
  const points = Array.from(capped);
  let start = points.length;
  let bytes = 0;
  while (start > 0) {
    const next = Buffer.byteLength(points[start - 1]!);
    if (bytes + next > maxBytes) break;
    bytes += next;
    start -= 1;
  }
  return points.slice(start).join("");
}

describe("BoundedTerminalHistory", () => {
  it("matches the line and byte policy across arbitrary chunks, Unicode, ANSI sequences and clear", () => {
    let randomSeed = 0x20260904;
    const fragments = [
      "",
      "a",
      "\n",
      "\n\n",
      "\r",
      "\r\n",
      "café",
      "名",
      "🚀",
      "\u001b[31m",
      "\u001b[0m",
      "\u001b]8;;url\u0007",
      "\ud83d",
      "\ude80",
    ];
    const nextFragment = () => {
      randomSeed = (Math.imul(randomSeed, 1_664_525) + 1_013_904_223) >>> 0;
      return fragments[randomSeed % fragments.length]!;
    };

    for (const maxBytes of [0, 3, 8, 64, Infinity]) {
      for (const maxLines of [0, 1, 3, 5, 5_000]) {
        let expected = retainedHistory("before\ninitial\n", maxLines, maxBytes);
        const history = new BoundedTerminalHistory(maxLines, "before\ninitial\n", maxBytes);
        expect(history.value()).toBe(expected);

        for (let step = 0; step < 300; step += 1) {
          if (step % 73 === 0) {
            history.clear();
            expected = "";
            expect(history.value()).toBe(expected);
          }
          const chunk = nextFragment() + nextFragment();
          history.append(chunk);
          expected = retainedHistory(expected + chunk, maxLines, maxBytes);
          expect(history.value()).toBe(expected);
          expect(history.bytes).toBe(Buffer.byteLength(expected));
        }
      }
    }
  });

  it("bounds long partial lines and joins surrogate pairs across chunk boundaries", () => {
    const maxBytes = 65_539;
    let expected = "";
    const history = new BoundedTerminalHistory(5_000, "", maxBytes);
    const writes = [
      "a".repeat(16_383) + "😀" + "b".repeat(70_000),
      "\r" + "c".repeat(70_000) + "\ud83d",
      "\ude80" + "d".repeat(100),
      "\uFEFF" + "名".repeat(30_000),
    ];
    for (const text of writes) {
      history.append(text);
      expected = retainedHistory(expected + text, 5_000, maxBytes);
      expect(history.value()).toBe(expected);
      expect(Buffer.byteLength(history.value())).toBeLessThanOrEqual(maxBytes);
    }
  });

  it("preserves retained lines as older storage is compacted", () => {
    for (const maxLines of [3, 5_000]) {
      let expected = "";
      const history = new BoundedTerminalHistory(maxLines);
      for (let batch = 0; batch < 40; batch += 1) {
        const chunk = Array.from({ length: 300 }, (_, line) => `${batch}:${line}\n`).join("");
        history.append(chunk);
        expected = retainedHistory(expected + chunk, maxLines);
        expect(history.value()).toBe(expected);
      }
    }
  });

  it("caps the initial value and caches the joined text until the next mutation", () => {
    const history = new BoundedTerminalHistory(2, "a\nb\nc\nd");
    expect(history.value()).toBe("c\nd");
    expect(history.value()).toBe(history.value());
    history.append("e\nf");
    expect(history.value()).toBe("de\nf");
    history.reset("x\ny\nz\n");
    expect(history.value()).toBe("y\nz\n");
  });

  it("keeps at most the byte limit of the newest UTF-8 text", () => {
    const fragments = ["a", "\n", "é", "名", "🚀", "\ud83d", "\ude80", "\u001b[31m"];
    let randomSeed = 0x8_0000;
    const nextFragment = () => {
      randomSeed = (Math.imul(randomSeed, 1_664_525) + 1_013_904_223) >>> 0;
      return fragments[randomSeed % fragments.length]!;
    };
    for (const maxBytes of [1, 3, 7, 64]) {
      const history = new BoundedTerminalHistory(5_000, "", maxBytes);
      let full = "";
      for (let step = 0; step < 400; step += 1) {
        const chunk = nextFragment() + nextFragment();
        history.append(chunk);
        full += chunk;
        const value = history.value();
        expect(Buffer.byteLength(value)).toBeLessThanOrEqual(maxBytes);
        expect(history.bytes).toBe(Buffer.byteLength(value));
        expect(full.endsWith(value)).toBe(true);
        // Never starts with the second half of a pair that was split by eviction.
        const first = value.charCodeAt(0);
        const beforeFirst = full.charCodeAt(full.length - value.length - 1);
        expect(
          first >= 0xdc00 && first <= 0xdfff && beforeFirst >= 0xd800 && beforeFirst <= 0xdbff,
        ).toBe(false);
      }
    }
  });

  it("applies both caps and joins a surrogate pair split across appends", () => {
    const history = new BoundedTerminalHistory(3, "", 10);
    history.append("one\ntwo\nthree\nfour\n");
    expect(history.value()).toBe("hree\nfour\n");
    history.append("\ud83d");
    history.append("\ude80");
    expect(history.value()).toBe("\nfour\n🚀");
    expect(history.bytes).toBe(10);
  });

  it("splits huge appends into chunks without losing text", () => {
    const line = "x".repeat(40_000);
    const history = new BoundedTerminalHistory(3, "", 100_000);
    history.append(`${line}\n${line}\n${line}`);
    expect(history.value()).toBe(`${"x".repeat(19_998)}\n${line}\n${line}`);
    history.append("\n🚀".repeat(3));
    expect(history.value()).toBe("\n🚀\n🚀\n🚀".slice(1));
  });
});
