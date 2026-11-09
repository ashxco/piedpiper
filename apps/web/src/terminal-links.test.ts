import { describe, expect, it } from "vitest";

import {
  collectWrappedTerminalLinkLine,
  createTerminalLinkModifierState,
  extractTerminalLinks,
  isTerminalLinkActivation,
  isTerminalUrl,
  MAX_WRAPPED_TERMINAL_LINK_ROWS_AROUND_ANCHOR,
  resolvePathLinkTarget,
  resolveTerminalHyperlinkTarget,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
  type TerminalBufferLineLike,
} from "./terminal-links";

function createBufferLine(text: string, isWrapped = false): TerminalBufferLineLike {
  return {
    isWrapped,
    translateToString: (trimRight = false) => (trimRight ? text.replace(/\s+$/u, "") : text),
  };
}

// Mirrors xterm: a wide character takes a width-2 cell then an empty width-0 tail; "" is an empty cell.
type CellSpec = string | { chars: string; width: number };

function createCellLine(cells: CellSpec[], isWrapped = false): TerminalBufferLineLike {
  const expanded = cells.flatMap((cell) => {
    if (typeof cell === "string") return [{ chars: cell, width: 1 }];
    return cell.width === 2 ? [cell, { chars: "", width: 0 }] : [cell];
  });
  return {
    isWrapped,
    length: expanded.length,
    getCell: (x) => {
      const cell = expanded[x];
      return cell && { getChars: () => cell.chars, getWidth: () => cell.width };
    },
    translateToString: (trimRight = false) => {
      const text = expanded
        .filter((cell) => cell.width > 0)
        .map((cell) => cell.chars || " ")
        .join("");
      return trimRight ? text.replace(/\s+$/u, "") : text;
    },
  };
}

const wide = (chars: string) => ({ chars, width: 2 });

function linkRange(lines: TerminalBufferLineLike[], bufferLineNumber = 1) {
  const wrappedLine = collectWrappedTerminalLinkLine(bufferLineNumber, (index) => lines[index]);
  if (!wrappedLine) throw new Error("Expected wrapped terminal line to be present.");
  const [match] = extractTerminalLinks(wrappedLine.text);
  if (!match) throw new Error(`Expected a link in ${wrappedLine.text}`);
  return { text: match.text, range: resolveWrappedTerminalLinkRange(wrappedLine, match) };
}

describe("extractTerminalLinks", () => {
  it.each([
    String.raw`C:\dev\ai-test\dir 1`,
    String.raw`C:\dev\ai-test\dir 1\test`,
    "C:\\",
    String.raw`\\server\my share\dir 1`,
    "/home/Jane Doe/project",
    String.raw`C:\dev\folder (draft)\name!`,
  ])("keeps the full PowerShell prompt path %s in one link", (path) => {
    expect(extractTerminalLinks(`PS ${path}> `)).toEqual([
      { kind: "path", text: path, start: 3, end: 3 + path.length },
    ]);
  });

  it("keeps links in a command separate from the PowerShell prompt path", () => {
    const path = String.raw`C:\dev\dir 1\test`;
    const prompt = `PS ${path}> `;
    const url = "https://example.com";
    expect(extractTerminalLinks(`${prompt}echo ${url}`)).toEqual([
      { kind: "path", text: path, start: 3, end: 3 + path.length },
      { kind: "url", text: url, start: prompt.length + 5, end: prompt.length + 5 + url.length },
    ]);
  });

  it("does not extend ordinary output paths through trailing prose", () => {
    const path = String.raw`C:\dev\project`;
    expect(extractTerminalLinks(`see ${path} for details`)).toEqual([
      { kind: "path", text: path, start: 4, end: 4 + path.length },
    ]);
  });

  it("classifies uppercase schemes as URLs", () => {
    expect(isTerminalUrl("HTTPS://example.com/docs")).toBe(true);
    expect(isTerminalUrl("Http://example.com")).toBe(true);
    expect(isTerminalUrl("src/components/main.ts")).toBe(false);
    expect(isTerminalUrl("httpsdocs/readme.md")).toBe(false);
  });

  it("finds URLs regardless of scheme casing", () => {
    expect(extractTerminalLinks("open HTTPS://example.com/docs")).toEqual([
      { kind: "url", text: "HTTPS://example.com/docs", start: 5, end: 29 },
    ]);
  });

  it("finds http urls and path tokens", () => {
    const line =
      "failed at https://example.com/docs and src/components/ThreadTerminalDrawer.tsx:42";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 10,
        end: 34,
      },
      {
        kind: "path",
        text: "src/components/ThreadTerminalDrawer.tsx:42",
        start: 39,
        end: 81,
      },
    ]);
  });

  it("trims trailing punctuation from links", () => {
    const line = "(https://example.com/docs), ./src/main.ts:12.";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 1,
        end: 25,
      },
      {
        kind: "path",
        text: "./src/main.ts:12",
        start: 28,
        end: 44,
      },
    ]);
  });

  it("finds Windows absolute paths with forward slashes", () => {
    const line = "see C:/Users/someone/project/src/file.ts:42 for details";
    const path = "C:/Users/someone/project/src/file.ts:42";
    const start = line.indexOf(path);
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "path",
        text: path,
        start,
        end: start + path.length,
      },
    ]);
  });

  it("trims trailing punctuation from Windows forward-slash paths", () => {
    const line = "(C:/tmp/x.ts).";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "path",
        text: "C:/tmp/x.ts",
        start: 1,
        end: 12,
      },
    ]);
  });
});

describe("extractTerminalLinks edge cases", () => {
  it("keeps a trailing colon on URLs", () => {
    expect(extractTerminalLinks("GET https://example.test/items/foo:")).toEqual([
      { kind: "url", text: "https://example.test/items/foo:", start: 4, end: 35 },
    ]);
  });

  it.each([
    ["./main.go:10:5: undefined: x", "./main.go:10:5"],
    ["/home/dev/app/src/main.c:10:5: error: expected ';'", "/home/dev/app/src/main.c:10:5"],
    ["C:\\dev\\app\\src\\main.c:10:5: error: expected ';'", "C:\\dev\\app\\src\\main.c:10:5"],
    ["wrote ./out/report.txt:", "./out/report.txt"],
  ])("drops the colon that ends a compiler diagnostic location in %s", (line, text) => {
    const start = line.indexOf(text);
    expect(extractTerminalLinks(line)).toEqual([
      { kind: "path", text, start, end: start + text.length },
    ]);
  });

  it.each([
    String.raw`src\index.ts:12`,
    String.raw`.\src\index.ts:12:7`,
    String.raw`..\src\index.ts:12`,
    String.raw`C:\Users\Jane\project\index.ts:12`,
    String.raw`\\server\share\index.ts:12`,
  ])("finds Windows path %s", (text) => {
    const line = `error at ${text}: failed`;
    expect(extractTerminalLinks(line)).toEqual([
      { kind: "path", text, start: 9, end: 9 + text.length },
    ]);
  });

  it.each(['"', "'", "`"])("finds paths containing spaces enclosed in %s", (quote) => {
    const text = String.raw`C:\Users\Jane Doe\project\index.ts:12:7`;
    expect(extractTerminalLinks(`see ${quote}${text}${quote}.`)).toEqual([
      { kind: "path", text, start: 5, end: 5 + text.length },
    ]);
  });

  it.each([
    String.raw`src\my folder\index.ts`,
    "./my folder/index.ts",
    "/home/Jane Doe/index.ts",
    "/home/Jane Doe/file)",
    String.raw`\\server\my share\index.ts`,
  ])("keeps positions outside quotes on %s", (path) => {
    expect(extractTerminalLinks(`"${path}":12:7: error`)).toEqual([
      { kind: "path", text: `${path}:12:7`, start: 1, end: path.length + 7 },
    ]);
  });

  it("does not treat quoted prose as a path", () => {
    expect(extractTerminalLinks('error: "something went wrong"')).toEqual([]);
    expect(extractTerminalLinks('error: "something went wrong."')).toEqual([]);
  });

  it.each([
    ['"my file.ts":12:7', "my file.ts:12:7", 17],
    ["'my file.ts:12:7'", "my file.ts:12:7", 16],
    ["`my file.ts`", "my file.ts", 11],
    ['"mój plik.ts":12', "mój plik.ts:12", 16],
  ])("finds a quoted basename in %s", (line, text, end) => {
    expect(extractTerminalLinks(line)).toEqual([{ kind: "path", text, start: 1, end }]);
  });

  it("keeps quoted paths and URLs separate without duplicate partial paths", () => {
    const path = String.raw`C:\Jane Doe\index.ts:12`;
    const url = "https://example.com/docs";
    const line = `"${path}" ${url} src/index.ts`;
    expect(extractTerminalLinks(line)).toEqual([
      { kind: "path", text: path, start: 1, end: 1 + path.length },
      { kind: "url", text: url, start: path.length + 3, end: path.length + 3 + url.length },
      { kind: "path", text: "src/index.ts", start: line.length - 12, end: line.length },
    ]);
  });

  it.each([
    "src/żółć.ts:12:7",
    "żółć/main.ts:12",
    String.raw`żółć\main.ts:12`,
    "src/ściśle/plik.ts",
    "src/cafe\u0301.ts:12",
    "src/𐐀.ts:12",
    "src/app/[id]/page.tsx:3:10",
    "src/routes/(app)/+page.svelte:12:4",
    "node_modules/.pnpm/react@18.3.1/node_modules/react/index.js:12:5",
    "app/routes/posts.$id.tsx:5",
  ])("keeps the complete relative path %s", (text) => {
    expect(extractTerminalLinks(`see ${text} for details`)).toEqual([
      { kind: "path", text, start: 4, end: 4 + text.length },
    ]);
  });

  it("keeps compiler parenthesized locations out of relative paths", () => {
    expect(extractTerminalLinks("error src/foo.ts(3,10): bad")).toEqual([
      { kind: "path", text: "src/foo.ts", start: 6, end: 16 },
    ]);
  });

  it("trims long runs of unbalanced closing brackets quickly", () => {
    const startedAt = performance.now();
    expect(extractTerminalLinks(`a/[${"]".repeat(20_000)}`)).toEqual([
      { kind: "path", text: "/[]", start: 1, end: 4 },
    ]);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it.each([
    " GET /api/trpc/post.list,user.me?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%7D 200 in 35ms",
    "GET /api?+debug 200",
    'Started GET "/posts?page=2" for ::1',
    "proxying api/trpc/post.list?batch=1 to the backend",
  ])("does not turn a logged request route into an editor link: %s", (line) => {
    expect(extractTerminalLinks(line)).toEqual([]);
  });

  it("keeps file and URL links before and after a logged request route", () => {
    const before = "src/server.ts:12";
    const after = "/app/bin/server:3:7";
    const url = "https://example.com/api/users?id=42";
    const line = `${before} GET /api/users?id=42 200 ${after} ${url}`;
    const afterStart = line.indexOf(after);
    const urlStart = line.indexOf(url);

    expect(extractTerminalLinks(line)).toEqual([
      { kind: "path", text: before, start: 0, end: before.length },
      { kind: "path", text: after, start: afterStart, end: afterStart + after.length },
      { kind: "url", text: url, start: urlStart, end: urlStart + url.length },
    ]);
  });

  it("keeps a question mark inside a filesystem path", () => {
    const path = "/tmp/report?draft";
    expect(extractTerminalLinks(`wrote ${path}`)).toEqual([
      { kind: "path", text: path, start: 6, end: 6 + path.length },
    ]);
  });

  it.each([
    "connected to redis://127.0.0.1:6379/0",
    "connected to redis://host/0",
    "connected to postgres://localhost:5432/app",
    "uploaded s3://bucket/reports/today.csv",
    "    at main (file:///Users/jane/app/src/index.mjs:3:7)",
    "+redis://localhost:6379/0",
    "-redis://localhost:6379/0",
  ])("does not turn part of a non-web URL into an editor link: %s", (line) => {
    expect(extractTerminalLinks(line)).toEqual([]);
  });

  it("keeps file links beside a non-web URL", () => {
    const line = "src/db.ts:4 redis://localhost:6379/0 C:/app/src/db.ts:9";
    expect(extractTerminalLinks(line)).toEqual([
      { kind: "path", text: "src/db.ts:4", start: 0, end: 11 },
      { kind: "path", text: "C:/app/src/db.ts:9", start: 37, end: 55 },
    ]);
  });
});

describe("collectWrappedTerminalLinkLine", () => {
  it("reconstructs a wrapped line from any physical row", () => {
    const firstSegment = "see https://example.com/a";
    const secondSegment = "/bc?x=1";
    const lines = [
      createBufferLine("prompt> "),
      createBufferLine(firstSegment),
      createBufferLine(secondSegment, true),
      createBufferLine("done"),
    ];

    const fromFirstRow = collectWrappedTerminalLinkLine(2, (index) => lines[index]);
    const fromWrappedRow = collectWrappedTerminalLinkLine(3, (index) => lines[index]);

    expect(fromFirstRow).toEqual({
      text: `${firstSegment}${secondSegment}`,
      segments: [
        {
          bufferLineNumber: 2,
          text: firstSegment,
          startIndex: 0,
          endIndex: firstSegment.length,
        },
        {
          bufferLineNumber: 3,
          text: secondSegment,
          startIndex: firstSegment.length,
          endIndex: firstSegment.length + secondSegment.length,
        },
      ],
    });
    expect(fromWrappedRow).toEqual(fromFirstRow);
  });

  it("returns a single trimmed segment for an unwrapped line", () => {
    const lines = [createBufferLine("plain text   "), createBufferLine("next")];
    expect(collectWrappedTerminalLinkLine(1, (index) => lines[index])).toEqual({
      text: "plain text",
      segments: [{ bufferLineNumber: 1, text: "plain text", startIndex: 0, endIndex: 10 }],
    });
  });

  it("bounds the walk to a window of rows around the anchor on very long wrapped lines", () => {
    const lines = Array.from({ length: 1_000 }, (_, index) =>
      createBufferLine(`r${String(index).padStart(3, "0")}`, index > 0),
    );
    let reads = 0;
    const wrappedLine = collectWrappedTerminalLinkLine(
      500,
      (index) => {
        reads += 1;
        return lines[index];
      },
      2,
    );

    expect(wrappedLine?.segments.map((segment) => segment.bufferLineNumber)).toEqual([
      498, 499, 500, 501, 502,
    ]);
    expect(wrappedLine?.text).toBe("r497r498r499r500r501");
    expect(reads).toBeLessThanOrEqual(10);
  });

  it("uses the default window when no limit is passed", () => {
    const lines = Array.from({ length: 1_000 }, (_, index) =>
      createBufferLine("x".repeat(4), index > 0),
    );
    const wrappedLine = collectWrappedTerminalLinkLine(500, (index) => lines[index]);
    expect(wrappedLine?.segments).toHaveLength(
      MAX_WRAPPED_TERMINAL_LINK_ROWS_AROUND_ANCHOR * 2 + 1,
    );
  });

  it("returns null for a missing anchor line", () => {
    expect(collectWrappedTerminalLinkLine(3, () => undefined)).toBeNull();
  });

  it("preserves trailing spaces on continued segments for downstream offsets", () => {
    const firstSegment = "prefix   ";
    const secondSegment = "https://example.com/path";
    const lines = [createBufferLine(firstSegment), createBufferLine(secondSegment, true)];

    const wrappedLine = collectWrappedTerminalLinkLine(2, (index) => lines[index]);

    expect(wrappedLine?.text).toBe(`${firstSegment}${secondSegment}`);
    expect(extractTerminalLinks(wrappedLine?.text ?? "")).toEqual([
      {
        kind: "url",
        text: secondSegment,
        start: firstSegment.length,
        end: firstSegment.length + secondSegment.length,
      },
    ]);
  });
});

describe("resolveWrappedTerminalLinkRange", () => {
  it("maps wrapped URL matches back to the correct buffer rows", () => {
    const prefix = "see ";
    const firstSegment = `${prefix}https://example.com/a`;
    const secondSegment = "/bc?x=1";
    const lines = [
      createBufferLine("prompt> "),
      createBufferLine(firstSegment),
      createBufferLine(secondSegment, true),
    ];
    const wrappedLine = collectWrappedTerminalLinkLine(2, (index) => lines[index]);
    if (!wrappedLine) {
      throw new Error("Expected wrapped terminal line to be present.");
    }

    const [match] = extractTerminalLinks(wrappedLine.text);
    expect(match).toEqual({
      kind: "url",
      text: "https://example.com/a/bc?x=1",
      start: prefix.length,
      end: firstSegment.length + secondSegment.length,
    });
    if (!match) {
      throw new Error("Expected wrapped URL match to be present.");
    }

    const range = resolveWrappedTerminalLinkRange(wrappedLine, match);

    expect(range).toEqual({
      start: { x: prefix.length + 1, y: 2 },
      end: { x: secondSegment.length, y: 3 },
    });
    expect(wrappedTerminalLinkRangeIntersectsBufferLine(range, 1)).toBe(false);
    expect(wrappedTerminalLinkRangeIntersectsBufferLine(range, 2)).toBe(true);
    expect(wrappedTerminalLinkRangeIntersectsBufferLine(range, 3)).toBe(true);
    expect(wrappedTerminalLinkRangeIntersectsBufferLine(range, 4)).toBe(false);
  });
});

describe("resolveWrappedTerminalLinkRange with cell widths", () => {
  const url = [..."https://a.io/x"];

  it("starts after CJK at the cell column, not the string offset", () => {
    expect(linkRange([createCellLine([wide("日"), wide("本"), " ", ...url])])).toEqual({
      text: "https://a.io/x",
      range: { start: { x: 6, y: 1 }, end: { x: 19, y: 1 } },
    });
  });

  it("counts a width-1 surrogate-pair emoji as one cell", () => {
    expect(linkRange([createCellLine([{ chars: "😀", width: 1 }, " ", ...url])]).range).toEqual({
      start: { x: 3, y: 1 },
      end: { x: 16, y: 1 },
    });
  });

  it("keeps combining marks in their base cell", () => {
    expect(linkRange([createCellLine(["e\u0301", " ", ...url])]).range).toEqual({
      start: { x: 3, y: 1 },
      end: { x: 16, y: 1 },
    });
  });

  it("ends a URL on the tail cell of its last wide character", () => {
    expect(linkRange([createCellLine([...url, wide("語")])])).toEqual({
      text: "https://a.io/x語",
      range: { start: { x: 1, y: 1 }, end: { x: 16, y: 1 } },
    });
  });

  it("does not split a link at the pad cell of a wide character moved to the next row", () => {
    const lines = [
      createCellLine([..."https://a.io/", ""]),
      createCellLine([wide("語"), ..."/x"], true),
    ];
    expect(linkRange(lines)).toEqual({
      text: "https://a.io/語/x",
      range: { start: { x: 1, y: 1 }, end: { x: 4, y: 2 } },
    });
  });

  it("keeps an empty last cell as a space when the next row starts narrow", () => {
    const lines = [createCellLine([..."ab", ""]), createCellLine(["c"], true)];
    expect(collectWrappedTerminalLinkLine(1, (index) => lines[index])?.text).toBe("ab c");
  });

  it("maps a wrapped URL across rows holding CJK", () => {
    const lines = [
      createCellLine([wide("日"), " ", ..."https://a.io"]),
      createCellLine(["/", wide("語"), "/"], true),
    ];
    expect(linkRange(lines, 2)).toEqual({
      text: "https://a.io/語/",
      range: { start: { x: 4, y: 1 }, end: { x: 4, y: 2 } },
    });
  });

  it("skips the cell map for ASCII rows", () => {
    const lines = [createCellLine([...url])];
    expect(collectWrappedTerminalLinkLine(1, (index) => lines[index])?.segments[0]?.cells).toBe(
      undefined,
    );
  });
});

describe("resolvePathLinkTarget", () => {
  it("resolves a quoted terminal link against a Windows environment", () => {
    const [link] = extractTerminalLinks(String.raw`error at "src\my folder\index.ts":12:7`);
    expect(resolvePathLinkTarget(link?.text ?? "", String.raw`C:\Users\Jane Doe\project`)).toBe(
      String.raw`C:\Users\Jane Doe\project\src\my folder\index.ts:12:7`,
    );
  });

  it("keeps the line and column of a compiler diagnostic", () => {
    const [link] = extractTerminalLinks("/Users/julius/project/main.c:10:5: error: expected ';'");
    expect(resolvePathLinkTarget(link?.text ?? "", "/Users/julius/project")).toBe(
      "/Users/julius/project/main.c:10:5",
    );
  });

  it("expands a Windows home-relative path", () => {
    expect(
      resolvePathLinkTarget(String.raw`~\src\app.ts:3`, String.raw`C:\Users\jane\project`),
    ).toBe(String.raw`C:\Users\jane\src\app.ts:3`);
  });

  it.each([
    [String.raw`C:\Users\jane\project`, String.raw`C:\Users\jane\notes.md:3`],
    ["C:/Users/jane/project", String.raw`C:/Users/jane\notes.md:3`],
    [String.raw`C:\users\alice\project`, String.raw`C:\users\alice\notes.md:3`],
    ["C:/uSeRs/alice/project", String.raw`C:/uSeRs/alice\notes.md:3`],
  ])("expands ~/ against the Windows cwd %s", (cwd, expected) => {
    expect(resolvePathLinkTarget("~/notes.md:3", cwd)).toBe(expected);
  });

  it("does not treat /Users/Shared as a home", () => {
    expect(resolvePathLinkTarget("~/x.ts:3", "/Users/Shared/proj")).toBe("~/x.ts:3");
    expect(resolvePathLinkTarget("~/x.ts:3", "/Users/alice/proj")).toBe("/Users/alice/x.ts:3");
  });

  it("stays case-sensitive for POSIX homes and leaves unknown homes alone", () => {
    for (const cwd of ["C:/work/project", "/Home/alice/project", "/users/alice/project"]) {
      expect(resolvePathLinkTarget("~/notes.md:3", cwd)).toBe("~/notes.md:3");
    }
  });

  it("resolves relative paths against cwd", () => {
    expect(
      resolvePathLinkTarget(
        "src/components/ThreadTerminalDrawer.tsx:42:7",
        "/Users/julius/project",
      ),
    ).toBe("/Users/julius/project/src/components/ThreadTerminalDrawer.tsx:42:7");
  });

  it("keeps absolute paths unchanged", () => {
    expect(
      resolvePathLinkTarget("/Users/julius/project/src/main.ts:12", "/Users/julius/project"),
    ).toBe("/Users/julius/project/src/main.ts:12");
  });

  it.each([
    {
      name: "a backslash-relative path against a Windows cwd",
      path: String.raw`src\index.ts:12:7`,
      cwd: String.raw`C:\Users\Jane Doe\project`,
      expected: String.raw`C:\Users\Jane Doe\project\src\index.ts:12:7`,
    },
    {
      name: "a forward-slash path against a forward-slash Windows cwd",
      path: "src/index.ts:12:7",
      cwd: "C:/Users/Jane Doe/project",
      expected: String.raw`C:/Users/Jane Doe/project\src\index.ts:12:7`,
    },
    {
      name: "a dot-relative path against a UNC cwd",
      path: String.raw`.\src\index.ts:12`,
      cwd: String.raw`\\server\share\project`,
      expected: String.raw`\\server\share\project\.\src\index.ts:12`,
    },
    {
      name: "a POSIX relative path against a POSIX cwd",
      path: "src/index.ts:12:7",
      cwd: "/Users/jane/project",
      expected: "/Users/jane/project/src/index.ts:12:7",
    },
  ])("resolves $name", ({ path, cwd, expected }) => {
    expect(resolvePathLinkTarget(path, cwd)).toBe(expected);
  });

  it("keeps Windows absolute paths with forward slashes unchanged", () => {
    expect(
      resolvePathLinkTarget("C:/Users/julius/project/src/main.ts:12", "C:\\Users\\julius\\project"),
    ).toBe("C:/Users/julius/project/src/main.ts:12");
  });
});

describe("isTerminalLinkActivation", () => {
  it("requires cmd on macOS", () => {
    expect(
      isTerminalLinkActivation(
        {
          metaKey: true,
          ctrlKey: false,
        },
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      isTerminalLinkActivation(
        {
          metaKey: false,
          ctrlKey: true,
        },
        "MacIntel",
      ),
    ).toBe(false);
  });

  it("requires ctrl on non-macOS", () => {
    expect(
      isTerminalLinkActivation(
        {
          metaKey: false,
          ctrlKey: true,
        },
        "Win32",
      ),
    ).toBe(true);
    expect(
      isTerminalLinkActivation(
        {
          metaKey: true,
          ctrlKey: false,
        },
        "Linux",
      ),
    ).toBe(false);
  });
});

describe("createTerminalLinkModifierState", () => {
  it("starts new link decorations from the current modifier state", () => {
    const state = createTerminalLinkModifierState("MacIntel");
    expect(state.createDecorations()).toEqual({ pointerCursor: false, underline: false });
    state.update({ metaKey: true, ctrlKey: false });
    expect(state.createDecorations()).toEqual({ pointerCursor: true, underline: true });
    state.update({ metaKey: false, ctrlKey: true });
    expect(state.isActive()).toBe(false);
  });

  it("uses Ctrl as the link modifier outside macOS", () => {
    const state = createTerminalLinkModifierState("Win32");
    state.update({ metaKey: true, ctrlKey: false });
    expect(state.isActive()).toBe(false);
    state.update({ metaKey: false, ctrlKey: true });
    expect(state.isActive()).toBe(true);
  });

  it("updates the hovered link through its current decorations object", async () => {
    const state = createTerminalLinkModifierState("MacIntel");
    const link = { decorations: state.createDecorations() };
    state.hover(link);
    // Simulate xterm replacing decorations with its own object after hover.
    const proxy = { pointerCursor: false, underline: false };
    link.decorations = proxy;

    state.update({ metaKey: true, ctrlKey: false });
    expect(proxy).toEqual({ pointerCursor: true, underline: true });

    state.reset();
    expect(proxy).toEqual({ pointerCursor: false, underline: false });

    state.leave(link);
    state.update({ metaKey: true, ctrlKey: false });
    expect(proxy).toEqual({ pointerCursor: false, underline: false });
    await Promise.resolve();
  });

  it("syncs a link hovered with stale decorations once xterm installs its proxy", async () => {
    const state = createTerminalLinkModifierState("MacIntel");
    const link = { decorations: state.createDecorations() };
    state.update({ metaKey: true, ctrlKey: false });
    state.hover(link);
    const proxy = { pointerCursor: false, underline: false };
    link.decorations = proxy;
    await Promise.resolve();
    expect(proxy).toEqual({ pointerCursor: true, underline: true });
  });
});

describe("resolveTerminalHyperlinkTarget", () => {
  it.each([
    ["https://example.com/docs", { kind: "external", url: "https://example.com/docs" }],
    ["HTTP://example.com", { kind: "external", url: "http://example.com/" }],
    ["file:///repo/src/a.ts", { kind: "editor", path: "/repo/src/a.ts" }],
    ["file://my-laptop/repo/a%20b.ts", { kind: "editor", path: "/repo/a b.ts" }],
    ["file://localhost/repo/a.ts", { kind: "editor", path: "/repo/a.ts" }],
    ["file:///C:/repo/a.ts", { kind: "editor", path: "C:/repo/a.ts" }],
    // UNC is deliberately unsupported: the host is ignored like any other.
    ["file://server/share/a.ts", { kind: "editor", path: "/share/a.ts" }],
  ])("resolves %s", (uri, expected) => {
    expect(resolveTerminalHyperlinkTarget(uri)).toEqual(expected);
  });

  it.each([
    "mailto:someone@example.com",
    "ssh://host/path",
    "javascript:alert(1)",
    "file://host",
    "file:///bad%zz",
    "file:///a%00b",
    "not a url",
    "",
  ])("ignores %s", (uri) => {
    expect(resolveTerminalHyperlinkTarget(uri)).toBeNull();
  });
});
