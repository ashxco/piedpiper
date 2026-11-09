import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { ThreadId, type NativeApi } from "@piedpiper/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as nativeApi from "../nativeApi";
import {
  buildTurnDiffFullContextFile,
  buildTurnDiffFullContextScopeKey,
  canShowTurnDiffFullContext,
  resolveTurnDiffFullContextPaths,
  resolveTurnDiffFullContextState,
  toggleTurnDiffFullContextPath,
  TURN_DIFF_FULL_CONTEXT_MAX_CHANGED_LINES,
  turnDiffFileContentsQueryOptions,
} from "./turnDiffFullContext";

const threadId = ThreadId.makeUnsafe("thread-1");
const OLD_LINES = Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`);
const OLD_CONTENTS = OLD_LINES.join("");
const NEW_CONTENTS = OLD_LINES.map((line, index) => (index === 9 ? "changed\n" : line)).join("");

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -7,7 +7,7 @@",
  " line 7",
  " line 8",
  " line 9",
  "-line 10",
  "+changed",
  " line 11",
  " line 12",
  " line 13",
  "",
].join("\n");

function parseFile(patch: string, scope = "test:light"): FileDiffMetadata {
  const file = parsePatchFiles(patch, scope)[0]?.files[0];
  if (!file) throw new Error("patch did not parse");
  return file;
}

function build(contents: {
  oldContents: string | null;
  newContents: string | null;
  ignoreWhitespace?: boolean;
}) {
  return buildTurnDiffFullContextFile({
    fileDiff: parseFile(PATCH),
    oldPath: "src/a.ts",
    newPath: "src/a.ts",
    contents: {
      oldContents: contents.oldContents,
      newContents: contents.newContents,
    },
    ignoreWhitespace: contents.ignoreWhitespace ?? false,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildTurnDiffFullContextFile", () => {
  it("carries the whole file while keeping git's hunks and identity", () => {
    const patchFile = parseFile(PATCH);
    const file = build({ oldContents: OLD_CONTENTS, newContents: NEW_CONTENTS });

    expect(patchFile.isPartial).toBe(true);
    expect(file?.isPartial).toBe(false);
    expect(file?.additionLines).toHaveLength(20);
    expect(file?.deletionLines).toHaveLength(20);
    expect(file?.name).toBe(patchFile.name);
    expect(file?.prevName).toBe(patchFile.prevName);
    expect(file?.type).toBe("change");
    expect(file?.cacheKey).toBe(`${patchFile.cacheKey}:full-context`);
    expect(file?.hunks.map((hunk) => [hunk.deletionStart, hunk.additionStart])).toEqual(
      patchFile.hunks.map((hunk) => [hunk.deletionStart, hunk.additionStart]),
    );
    expect(file?.hunks[0]?.additionLineIndex).toBe(6);
  });

  it("returns the same object for the same contents, so the viewer is not remounted", () => {
    const fileDiff = parseFile(PATCH);
    const contents = {
      oldContents: OLD_CONTENTS,
      newContents: NEW_CONTENTS,
      unavailableReason: null,
    };
    const input = { fileDiff, oldPath: "a", newPath: "a", contents };
    const first = buildTurnDiffFullContextFile({ ...input, ignoreWhitespace: false });

    expect(buildTurnDiffFullContextFile({ ...input, ignoreWhitespace: false })).toBe(first);
    expect(buildTurnDiffFullContextFile({ ...input, ignoreWhitespace: true })).not.toBe(first);
  });

  it("keeps whitespace-only changes out of the hunks when whitespace is hidden", () => {
    const reindented = OLD_CONTENTS.replace("line 3\n", "   line 3\n");
    const changed = reindented.replace("line 10\n", "changed\n");

    const hidden = build({
      oldContents: OLD_CONTENTS,
      newContents: changed,
      ignoreWhitespace: true,
    });
    const shown = build({ oldContents: OLD_CONTENTS, newContents: changed });

    expect(hidden?.hunks.reduce((total, hunk) => total + hunk.additionLines, 0)).toBe(1);
    expect(shown?.hunks.reduce((total, hunk) => total + hunk.additionLines, 0)).toBe(2);
  });

  it("hides mid-line whitespace changes too, as git diff -w does", () => {
    const reformatted = OLD_CONTENTS.replace("line 3\n", "line  3\n").replace(
      "line 10\n",
      "changed\n",
    );

    const hidden = build({
      oldContents: OLD_CONTENTS,
      newContents: reformatted,
      ignoreWhitespace: true,
    });

    expect(hidden?.hunks).toHaveLength(1);
    expect(hidden?.hunks[0]?.additionLines).toBe(1);
    expect(hidden?.hunks[0]?.additionStart).toBe(7);
  });

  it("re-diffs a whole-file reformat quickly once whitespace is hidden", () => {
    const lines = Array.from({ length: 25_000 }, (_, index) => `call(a,b,${index})\n`);
    const reformatted = lines.map((line) => line.replaceAll(",", ", "));
    reformatted[100] = "real change\n";

    const hidden = build({
      oldContents: lines.join(""),
      newContents: reformatted.join(""),
      ignoreWhitespace: true,
    });

    expect(hidden?.hunks.reduce((total, hunk) => total + hunk.additionLines, 0)).toBe(1);
  });

  it("is null when the contents cannot reproduce a diff", () => {
    expect(build({ oldContents: null, newContents: null })).toBeNull();
    // A failed read on one side must not look like a file rewritten from nothing.
    expect(build({ oldContents: null, newContents: NEW_CONTENTS })).toBeNull();
    expect(build({ oldContents: OLD_CONTENTS, newContents: null })).toBeNull();
    expect(build({ oldContents: OLD_CONTENTS, newContents: OLD_CONTENTS })).toBeNull();
  });
});

describe("canShowTurnDiffFullContext", () => {
  const withHeader = (header: string, hunk: ReadonlyArray<string>) =>
    parseFile(["diff --git a/x b/y", header, ...hunk, ""].join("\n"));

  it("offers it on modified and changed-rename files", () => {
    expect(canShowTurnDiffFullContext(parseFile(PATCH))).toBe(true);
    const renamed = withHeader("similarity index 90%\nrename from x\nrename to y", [
      "--- a/x",
      "+++ b/y",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
    ]);
    expect(renamed.type).toBe("rename-changed");
    expect(canShowTurnDiffFullContext(renamed)).toBe(true);
  });

  it("hides it where there are no unchanged lines to reveal", () => {
    const added = withHeader("new file mode 100644", [
      "--- /dev/null",
      "+++ b/y",
      "@@ -0,0 +1,1 @@",
      "+a",
    ]);
    const deleted = withHeader("deleted file mode 100644", [
      "--- a/x",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-a",
    ]);
    const pureRename = withHeader("similarity index 100%\nrename from x\nrename to y", []);
    const binary = withHeader("Binary files a/x and b/y differ", []);

    for (const file of [added, deleted, pureRename, binary]) {
      expect(canShowTurnDiffFullContext(file)).toBe(false);
    }
  });

  it("hides it on an already full file and past the re-diff limit", () => {
    const file = build({ oldContents: OLD_CONTENTS, newContents: NEW_CONTENTS });
    expect(file && canShowTurnDiffFullContext(file)).toBe(false);

    const patchFile = parseFile(PATCH);
    const huge = {
      ...patchFile,
      hunks: [{ ...patchFile.hunks[0]!, additionLines: TURN_DIFF_FULL_CONTEXT_MAX_CHANGED_LINES }],
    };
    expect(canShowTurnDiffFullContext(huge)).toBe(false);
  });
});

describe("resolveTurnDiffFullContextState", () => {
  const base = {
    fileDiff: parseFile(PATCH),
    oldPath: "src/a.ts",
    newPath: "src/a.ts",
    ignoreWhitespace: false,
  };

  it("loads, then swaps in the full file", () => {
    expect(resolveTurnDiffFullContextState({ ...base, data: undefined, error: null })).toEqual({
      kind: "loading",
    });
    const state = resolveTurnDiffFullContextState({
      ...base,
      data: { oldContents: OLD_CONTENTS, newContents: NEW_CONTENTS, unavailableReason: null },
      error: null,
    });
    expect(state.kind === "on" && state.file.isPartial).toBe(false);
  });

  it("explains binary, oversized, failed and missing contents", () => {
    const states = [
      { oldContents: null, newContents: null, unavailableReason: "binary" as const },
      { oldContents: null, newContents: null, unavailableReason: "too-large" as const },
      { oldContents: null, newContents: null, unavailableReason: null },
    ].map((data) => resolveTurnDiffFullContextState({ ...base, data, error: null }));
    expect(states.map((state) => state.kind === "unavailable" && state.detail)).toEqual([
      "Binary files cannot show full context.",
      "This file is too large to show in full.",
      "Full context is unavailable for this file.",
    ]);
    expect(
      resolveTurnDiffFullContextState({ ...base, data: undefined, error: new Error("bad turn") }),
    ).toEqual({ kind: "unavailable", detail: "bad turn" });
  });
});

describe("full context selection", () => {
  it("toggles paths independently within a view", () => {
    const first = toggleTurnDiffFullContextPath(null, "view", "a.ts");
    const second = toggleTurnDiffFullContextPath(first, "view", "b.ts");
    expect([...resolveTurnDiffFullContextPaths(second, "view")]).toEqual(["a.ts", "b.ts"]);
    const third = toggleTurnDiffFullContextPath(second, "view", "a.ts");
    expect([...resolveTurnDiffFullContextPaths(third, "view")]).toEqual(["b.ts"]);
  });

  it("drops the selection when the view changes", () => {
    const selection = toggleTurnDiffFullContextPath(null, "view", "a.ts");
    expect(resolveTurnDiffFullContextPaths(selection, "other").size).toBe(0);
    expect(resolveTurnDiffFullContextPaths(selection, null).size).toBe(0);
    expect([
      ...resolveTurnDiffFullContextPaths(
        toggleTurnDiffFullContextPath(selection, "other", "b.ts"),
        "other",
      ),
    ]).toEqual(["b.ts"]);
  });

  it("changes the scope key with the turn, range and whitespace mode, and has none in git views", () => {
    const base = {
      threadId: "thread-1",
      range: { fromTurnCount: 0, toTurnCount: 1 },
      cacheScope: "turn:a",
      ignoreWhitespace: false,
    };
    const key = buildTurnDiffFullContextScopeKey(base);
    expect(buildTurnDiffFullContextScopeKey(base)).toBe(key);
    for (const changed of [
      { cacheScope: "turn:b" },
      { range: { fromTurnCount: 1, toTurnCount: 2 } },
      { ignoreWhitespace: true },
    ]) {
      expect(buildTurnDiffFullContextScopeKey({ ...base, ...changed })).not.toBe(key);
    }
    expect(buildTurnDiffFullContextScopeKey({ ...base, threadId: null })).toBeNull();
    expect(buildTurnDiffFullContextScopeKey({ ...base, range: null })).toBeNull();
  });
});

describe("turnDiffFileContentsQueryOptions", () => {
  const input = {
    threadId,
    fromTurnCount: 0,
    toTurnCount: 1,
    path: "b.ts",
    previousPath: "a.ts",
    cacheScope: "turn:a",
  };

  it("requests the file through the native api", async () => {
    const getTurnDiffFileContents = vi.fn().mockResolvedValue({
      oldContents: "a",
      newContents: "b",
      unavailableReason: null,
    });
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      orchestration: { getTurnDiffFileContents },
    } as unknown as NativeApi);

    await new QueryClient().fetchQuery(turnDiffFileContentsQueryOptions(input));

    expect(getTurnDiffFileContents).toHaveBeenCalledWith({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      path: "b.ts",
      previousPath: "a.ts",
    });
  });

  it("separates reused turn counts by cache scope", () => {
    expect(turnDiffFileContentsQueryOptions(input).queryKey).not.toEqual(
      turnDiffFileContentsQueryOptions({ ...input, cacheScope: "turn:b" }).queryKey,
    );
  });
});
