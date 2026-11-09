import { describe, expect, it } from "vitest";

import { type ToolInputStream } from "../types";
import {
  appendLiveCommandOutput,
  findLiveCommandOutput,
  LIVE_COMMAND_OUTPUT_FIELD,
  LIVE_COMMAND_OUTPUT_MAX_CHARS,
  sanitizeLiveCommandOutput,
} from "./liveCommandOutput";

describe("sanitizeLiveCommandOutput with a stray escape", () => {
  it("hides at most one line behind an unfinished OSC", () => {
    const text = sanitizeLiveCommandOutput("before\n\u001b]garbage\nline two\nline three\n");
    expect(text).toContain("line two");
    expect(text).toContain("line three");
  });

  it("keeps the lines between a stray OSC and a later BEL", () => {
    const text = sanitizeLiveCommandOutput(
      "before\n\u001b]garbage\nline two\nline three\n\u0007after\n",
    );
    expect(text).toContain("line two");
    expect(text).toContain("line three");
    expect(text).toContain("after");
  });

  it("still removes an OSC terminated on its own line", () => {
    expect(sanitizeLiveCommandOutput("\u001b]0;title\u0007shown\n")).toBe("shown\n");
    expect(sanitizeLiveCommandOutput("\u001b]8;;http://x\u001b\\link\n")).toBe("link\n");
  });
});

describe("appendLiveCommandOutput", () => {
  it("appends below the cap", () => {
    expect(appendLiveCommandOutput("one\n", "two")).toBe("one\ntwo");
  });

  it("keeps the tail from a whole line once over the cap", () => {
    const line = `${"x".repeat(99)}\n`;
    const text = appendLiveCommandOutput(line.repeat(LIVE_COMMAND_OUTPUT_MAX_CHARS / 100), "end\n");
    expect(text.length).toBeLessThanOrEqual(LIVE_COMMAND_OUTPUT_MAX_CHARS);
    expect(text.startsWith("x".repeat(99))).toBe(true);
    expect(text.endsWith("\nend\n")).toBe(true);
  });

  it("does not start with half a surrogate pair when no newline can be cut at", () => {
    const text = appendLiveCommandOutput("", "😀".repeat(LIVE_COMMAND_OUTPUT_MAX_CHARS));
    expect(text.length).toBeLessThanOrEqual(LIVE_COMMAND_OUTPUT_MAX_CHARS);
    expect(text.codePointAt(0)).toBe("😀".codePointAt(0));
  });
});

describe("sanitizeLiveCommandOutput", () => {
  it("strips color and title sequences", () => {
    expect(sanitizeLiveCommandOutput("\u001b[31mred\u001b[0m \u001b]0;title\u0007done\n")).toBe(
      "red done\n",
    );
  });

  it("hides a sequence split across chunks until it completes", () => {
    const first = "ok\u001b[3";
    expect(sanitizeLiveCommandOutput(first)).toBe("ok");
    expect(sanitizeLiveCommandOutput(`${first}1mred`)).toBe("okred");
  });

  it("shows only the latest version of a line rewritten with carriage returns", () => {
    expect(sanitizeLiveCommandOutput("10%\r50%\r100%\nnext\n")).toBe("100%\nnext\n");
    expect(sanitizeLiveCommandOutput("building\r")).toBe("building");
  });

  it("treats CRLF as a plain line ending", () => {
    expect(sanitizeLiveCommandOutput("one\r\ntwo\r\n")).toBe("one\ntwo\n");
  });

  it("drops other control characters but keeps tabs", () => {
    expect(sanitizeLiveCommandOutput("a\tb\u0007c\u0008")).toBe("a\tbc");
  });
});

const stream = (fieldName: string, text = "output"): ToolInputStream => ({
  toolName: "Bash",
  fieldName,
  text,
  updatedAt: 0,
});

describe("findLiveCommandOutput", () => {
  it("finds the running entry's live output", () => {
    const live = stream(LIVE_COMMAND_OUTPUT_FIELD);
    expect(
      findLiveCommandOutput(
        [{ providerItemId: "done" }, { inProgress: true, providerItemId: "running" }],
        { done: stream(LIVE_COMMAND_OUTPUT_FIELD, "old"), running: live },
      ),
    ).toBe(live);
  });

  it("ignores finished entries, command previews and empty output", () => {
    expect(
      findLiveCommandOutput([{ providerItemId: "a" }], { a: stream(LIVE_COMMAND_OUTPUT_FIELD) }),
    ).toBeUndefined();
    expect(
      findLiveCommandOutput([{ inProgress: true, providerItemId: "a" }], { a: stream("command") }),
    ).toBeUndefined();
    expect(
      findLiveCommandOutput([{ inProgress: true, providerItemId: "a" }], {
        a: stream(LIVE_COMMAND_OUTPUT_FIELD, ""),
      }),
    ).toBeUndefined();
  });
});
