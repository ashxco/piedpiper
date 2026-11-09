import { describe, expect, it } from "vitest";
import {
  buildDiffFileBlockKey,
  resolveDiffHeaderClickAction,
  buildGitDiffPreviewCacheScope,
  countDiffTestFiles,
  isDiffFileShown,
  followDiffFindMatch,
  resolveDiffCollapseSection,
  resolveDiffFindRevealKey,
  resolveDiffPanelScope,
  resolveDiffReviewSection,
  resolveEmptyDiffMessage,
  resolveGitDiffPreviewEmptyMessage,
  resolveGitDiffPreviewNotices,
  resolveTurnPickerMessageLabel,
} from "./DiffPanel.logic";
import { appendReviewCommentsToPrompt, type ReviewCommentContext } from "../reviewCommentContext";

function pathNode(attributes: ReadonlyArray<string>, tagName = "div") {
  return {
    hasAttribute: (name: string) => attributes.includes(name),
    matches: (selector: string) => selector.split(", ").includes(tagName),
  } as unknown as EventTarget;
}

const match = (fileKey: string, lineNumber: number, occurrence = 0, lineText = "needle") => ({
  fileKey,
  side: "additions" as const,
  lineNumber,
  occurrence,
  lineText,
  isContext: false,
  unifiedRow: lineNumber,
  splitRow: lineNumber,
  separators: 0,
});

const key = (lineNumber: number) => `a\u0000additions\u0000${lineNumber}\u00000`;

describe("followDiffFindMatch", () => {
  const remapDiffFindIndex = (
    previous: Parameters<typeof followDiffFindMatch>[0],
    previousIndex: number,
    next: Parameters<typeof followDiffFindMatch>[2],
  ) => followDiffFindMatch(previous, previousIndex, next, null).index;
  const a = match("a", 1);
  const b = match("b", 1);
  const c = match("c", 1);

  it("follows the match when one is inserted before it", () => {
    expect(remapDiffFindIndex([b, c], 1, [a, b, c])).toBe(2);
  });

  it("follows the match when an earlier one goes away", () => {
    expect(remapDiffFindIndex([a, b, c], 2, [b, c])).toBe(1);
  });

  it("tells occurrences on one line apart", () => {
    expect(remapDiffFindIndex([match("a", 1, 1)], 0, [match("a", 1, 0), match("a", 1, 1)])).toBe(1);
  });

  it("keeps the position when the match is gone", () => {
    expect(remapDiffFindIndex([a, b, c], 1, [a, c])).toBe(1);
    expect(remapDiffFindIndex([a, b, c], 2, [a])).toBe(2);
    expect(remapDiffFindIndex([a, b], 1, [])).toBe(1);
  });

  it("reads a stored index past the end as the last match, which is the one on show", () => {
    expect(remapDiffFindIndex([a, b], 5, [c, a, b])).toBe(2);
  });

  it("has nothing to follow from an empty list", () => {
    expect(remapDiffFindIndex([], 3, [a, b])).toBe(3);
  });

  describe("when an edit above moves the match within its file", () => {
    const line = (lineNumber: number, lineText: string, occurrence = 0) =>
      match("a", lineNumber, occurrence, lineText);

    it("follows it past a new match that lands above it", () => {
      const previous = [line(10, "first"), line(50, "second")];
      expect(
        remapDiffFindIndex(previous, 1, [line(5, "new"), line(11, "first"), line(51, "second")]),
      ).toBe(2);
    });

    it("is not fooled by another match shifting onto its old line number", () => {
      const previous = [line(10, "first"), line(50, "second")];
      expect(remapDiffFindIndex(previous, 1, [line(50, "first"), line(90, "second")])).toBe(1);
      expect(remapDiffFindIndex(previous, 0, [line(50, "first"), line(90, "second")])).toBe(0);
    });

    it("follows it however far it moved", () => {
      const previous = [line(10, "first"), line(50, "second")];
      expect(remapDiffFindIndex(previous, 1, [line(11, "first"), line(500, "second")])).toBe(1);
    });

    it("takes the nearest of several lines with the same text", () => {
      const previous = [line(10, "same"), line(50, "same"), line(90, "same")];
      const next = [line(5, "new"), line(11, "same"), line(51, "same"), line(91, "same")];
      expect(remapDiffFindIndex(previous, 1, next)).toBe(2);
    });

    it("keeps to the same occurrence on the moved line", () => {
      const previous = [line(10, "two two", 0), line(10, "two two", 1)];
      const next = [line(11, "two two", 0), line(11, "two two", 1)];
      expect(remapDiffFindIndex(previous, 1, next)).toBe(1);
    });

    it("does not follow it to the other side of the diff", () => {
      const deleted = { ...line(50, "same"), side: "deletions" as const };
      expect(remapDiffFindIndex([line(10, "first"), line(50, "same")], 1, [deleted])).toBe(1);
    });

    it("stays on a line edited in place", () => {
      const previous = [line(10, "first"), line(50, "needle")];
      expect(
        remapDiffFindIndex(previous, 1, [line(5, "new"), line(10, "first"), line(50, "needle!")]),
      ).toBe(2);
    });

    it("keeps the position when neither its text nor its line is left", () => {
      const previous = [line(10, "first"), line(50, "second"), line(90, "third")];
      expect(remapDiffFindIndex(previous, 1, [line(10, "first"), line(90, "third")])).toBe(1);
    });
  });

  describe("the reveal anchor", () => {
    const line = (lineNumber: number, lineText: string) => match("a", lineNumber, 0, lineText);

    it("is left alone when the match did not move", () => {
      const anchor = { matchKey: "other", anchorKey: "older" };
      const { index, anchor: next } = followDiffFindMatch(
        [line(50, "second")],
        0,
        [line(10, "new"), line(50, "second")],
        anchor,
      );
      expect(index).toBe(1);
      expect(next).toBe(anchor);
    });

    it("holds the revealed key while the match moves, across several refreshes", () => {
      const once = followDiffFindMatch([line(50, "second")], 0, [line(51, "second")], null);
      expect(once.anchor).toEqual({ matchKey: key(51), anchorKey: key(50) });
      expect(resolveDiffFindRevealKey(key(51), once.anchor)).toBe(key(50));

      const twice = followDiffFindMatch([line(51, "second")], 0, [line(52, "second")], once.anchor);
      expect(twice.anchor).toEqual({ matchKey: key(52), anchorKey: key(50) });
      expect(resolveDiffFindRevealKey(key(52), twice.anchor)).toBe(key(50));
    });

    it("does not anchor a match that is gone, so its replacement gets revealed", () => {
      const followed = followDiffFindMatch(
        [line(10, "first"), line(50, "second")],
        1,
        [line(10, "first"), line(90, "third")],
        null,
      );
      expect(followed).toEqual({ index: 1, anchor: null });
      expect(resolveDiffFindRevealKey(key(90), followed.anchor)).toBe(key(90));
    });

    it("no longer applies once another match is active", () => {
      const anchor = { matchKey: key(51), anchorKey: key(50) };
      expect(resolveDiffFindRevealKey(key(10), anchor)).toBe(key(10));
      expect(resolveDiffFindRevealKey(null, anchor)).toBeNull();
      expect(resolveDiffFindRevealKey(key(10), null)).toBe(key(10));
    });
  });
});

describe("resolveDiffHeaderClickAction", () => {
  const header = pathNode(["data-diffs-header"]);
  const title = pathNode(["data-title"]);
  const noModifier = { metaKey: false, ctrlKey: false };

  it("toggles on the title and on the rest of the header", () => {
    expect(resolveDiffHeaderClickAction({ path: [title, header], ...noModifier })).toBe("toggle");
    expect(resolveDiffHeaderClickAction({ path: [header], ...noModifier })).toBe("toggle");
  });

  it("opens the file on a modified click", () => {
    expect(
      resolveDiffHeaderClickAction({ path: [title, header], metaKey: true, ctrlKey: false }),
    ).toBe("open");
    expect(
      resolveDiffHeaderClickAction({ path: [title, header], metaKey: false, ctrlKey: true }),
    ).toBe("open");
  });

  it("leaves controls inside the header to their own handlers", () => {
    const icon = pathNode([], "svg");
    for (const tagName of ["button", "a"]) {
      const control = pathNode([], tagName);
      expect(resolveDiffHeaderClickAction({ path: [icon, control, header], ...noModifier })).toBe(
        "ignore",
      );
      expect(
        resolveDiffHeaderClickAction({ path: [control, header], metaKey: true, ctrlKey: false }),
      ).toBe("ignore");
    }
  });

  it("never acts on the file body, including controls and nodes that are not elements", () => {
    const body = pathNode(["data-line"]);
    expect(resolveDiffHeaderClickAction({ path: [body], ...noModifier })).toBe("ignore");
    expect(resolveDiffHeaderClickAction({ path: [{} as EventTarget, body], ...noModifier })).toBe(
      "ignore",
    );
    expect(resolveDiffHeaderClickAction({ path: [], ...noModifier })).toBe("ignore");
  });
});

describe("buildDiffFileBlockKey", () => {
  it("separates the two blocks of a type change and keeps renames distinct", () => {
    const deleted = buildDiffFileBlockKey({ name: "AGENTS.md", type: "deleted" });
    const added = buildDiffFileBlockKey({ name: "AGENTS.md", type: "new" });
    expect(deleted).not.toBe(added);
    expect(buildDiffFileBlockKey({ name: "b.ts", prevName: "a.ts", type: "rename-pure" })).toBe(
      "a.ts:b.ts:rename-pure",
    );
  });
});

describe("resolveEmptyDiffMessage", () => {
  it("explains an empty patch as hidden whitespace changes when whitespace is ignored", () => {
    expect(
      resolveEmptyDiffMessage({
        hasNoNetChanges: true,
        ignoreWhitespace: true,
        selectionHasFileChanges: true,
      }),
    ).toBe("Only whitespace changes (hidden).");
  });

  it("uses neutral wording when it is unknown whether the selection changed files", () => {
    expect(
      resolveEmptyDiffMessage({
        hasNoNetChanges: true,
        ignoreWhitespace: true,
        selectionHasFileChanges: undefined,
      }),
    ).toBe("No changes (whitespace hidden).");
  });

  it("keeps the no-net-changes wording when whitespace is shown or the turn changed no files", () => {
    expect(
      resolveEmptyDiffMessage({
        hasNoNetChanges: true,
        ignoreWhitespace: false,
        selectionHasFileChanges: true,
      }),
    ).toBe("No net changes in this selection.");
    expect(
      resolveEmptyDiffMessage({
        hasNoNetChanges: true,
        ignoreWhitespace: true,
        selectionHasFileChanges: false,
      }),
    ).toBe("No net changes in this selection.");
  });

  it("reports a missing patch when the diff has not resolved", () => {
    expect(
      resolveEmptyDiffMessage({
        hasNoNetChanges: false,
        ignoreWhitespace: true,
        selectionHasFileChanges: true,
      }),
    ).toBe("No patch available for this selection.");
  });
});

describe("resolveDiffPanelScope", () => {
  it("keeps today's turn view unless a scope was chosen", () => {
    expect(resolveDiffPanelScope({ requestedScope: undefined, hasTurns: true })).toBe("turns");
    expect(resolveDiffPanelScope({ requestedScope: "branch", hasTurns: true })).toBe("branch");
  });

  it("falls back to uncommitted on a thread with no turns", () => {
    expect(resolveDiffPanelScope({ requestedScope: undefined, hasTurns: false })).toBe(
      "uncommitted",
    );
    expect(resolveDiffPanelScope({ requestedScope: "branch", hasTurns: false })).toBe("branch");
  });
});

describe("resolveDiffCollapseSection", () => {
  it("separates each scope from the turns", () => {
    expect(resolveDiffCollapseSection("turns", null)).toBeNull();
    expect(resolveDiffCollapseSection("turns", "turn-1")).toBe("turn-1");
    expect(resolveDiffCollapseSection("uncommitted", null)).toBe("scope:uncommitted");
    expect(resolveDiffCollapseSection("branch", "turn-1")).toBe("scope:branch");
  });
});

function gitStatus(insertions: number, branch = "feature") {
  return { branch, aheadCount: 0, workingTree: { files: [{}], insertions, deletions: 0 } };
}

describe("buildGitDiffPreviewCacheScope", () => {
  it("changes when a turn completes or the working tree moves on", () => {
    const base = buildGitDiffPreviewCacheScope({ latestTurnId: "a", status: gitStatus(1) });
    expect(buildGitDiffPreviewCacheScope({ latestTurnId: "a", status: gitStatus(1) })).toBe(base);
    expect(buildGitDiffPreviewCacheScope({ latestTurnId: "b", status: gitStatus(1) })).not.toBe(
      base,
    );
    expect(buildGitDiffPreviewCacheScope({ latestTurnId: "a", status: gitStatus(2) })).not.toBe(
      base,
    );
    expect(
      buildGitDiffPreviewCacheScope({ latestTurnId: "a", status: gitStatus(1, "x") }),
    ).not.toBe(base);
  });

  it("changes when commits move on a clean tree, such as after a reset", () => {
    const status = gitStatus(0);
    expect(
      buildGitDiffPreviewCacheScope({ latestTurnId: null, status: { ...status, aheadCount: 2 } }),
    ).not.toBe(
      buildGitDiffPreviewCacheScope({ latestTurnId: null, status: { ...status, aheadCount: 1 } }),
    );
  });
});

describe("resolveGitDiffPreviewEmptyMessage", () => {
  const complete = { truncated: false, untrackedIncomplete: false };

  it("does not claim nothing changed when part of the patch was left out", () => {
    expect(
      resolveGitDiffPreviewEmptyMessage({
        scope: "uncommitted",
        result: { baseRef: null, truncated: false, untrackedIncomplete: true },
        ignoreWhitespace: false,
      }),
    ).toBe("No tracked changes here. Untracked files are left out of this diff.");
    expect(
      resolveGitDiffPreviewEmptyMessage({
        scope: "branch",
        result: { baseRef: "main", truncated: true, untrackedIncomplete: false },
        ignoreWhitespace: false,
      }),
    ).toBe("This diff is too large to show.");
  });

  it("names what is empty for each scope", () => {
    expect(
      resolveGitDiffPreviewEmptyMessage({
        scope: "uncommitted",
        result: { baseRef: null, ...complete },
        ignoreWhitespace: false,
      }),
    ).toBe("No uncommitted changes.");
    expect(
      resolveGitDiffPreviewEmptyMessage({
        scope: "branch",
        result: { baseRef: "main", ...complete },
        ignoreWhitespace: true,
      }),
    ).toBe("No changes compared to main (whitespace hidden).");
    expect(
      resolveGitDiffPreviewEmptyMessage({
        scope: "branch",
        result: { baseRef: null, ...complete },
        ignoreWhitespace: false,
      }),
    ).toBe("No base branch, and no uncommitted changes.");
    expect(
      resolveGitDiffPreviewEmptyMessage({
        scope: "branch",
        result: undefined,
        ignoreWhitespace: false,
      }),
    ).toBe("No patch available for this selection.");
  });
});

describe("resolveGitDiffPreviewNotices", () => {
  it("reports the base, truncation and left-out untracked files", () => {
    expect(resolveGitDiffPreviewNotices(undefined, "uncommitted")).toEqual([]);
    const complete = { baseRef: null, truncated: false, untrackedIncomplete: false };
    expect(resolveGitDiffPreviewNotices(complete, "uncommitted")).toEqual([]);
    expect(
      resolveGitDiffPreviewNotices(
        { baseRef: "main", truncated: true, untrackedIncomplete: true },
        "branch",
      ),
    ).toHaveLength(3);
  });

  it("says when the branch view has no base to compare with", () => {
    expect(
      resolveGitDiffPreviewNotices(
        { baseRef: null, truncated: false, untrackedIncomplete: false },
        "branch",
      ),
    ).toEqual(["No base branch; showing uncommitted changes."]);
  });
});

describe("isDiffFileShown", () => {
  it("hides test files only when asked, and keeps the selected file", () => {
    const shown = (filePath: string, hideTestFiles: boolean, selectedFilePath: string | null) =>
      isDiffFileShown({ filePath, hideTestFiles, selectedFilePath });
    expect(shown("src/a.test.ts", false, null)).toBe(true);
    expect(shown("src/a.test.ts", true, null)).toBe(false);
    expect(shown("src/a.ts", true, null)).toBe(true);
    expect(shown("src/a.test.ts", true, "src/a.test.ts")).toBe(true);
  });

  it("keeps the file holding the open comment form", () => {
    const input = { filePath: "src/a.test.ts", hideTestFiles: true, selectedFilePath: null };
    expect(isDiffFileShown({ ...input, draftFilePath: "src/a.test.ts" })).toBe(true);
    expect(isDiffFileShown({ ...input, draftFilePath: "src/b.ts" })).toBe(false);
  });
});

describe("countDiffTestFiles", () => {
  it("counts paths, so a test file replaced by a symlink is one file", () => {
    expect(countDiffTestFiles(["a.test.ts", "a.test.ts", "b.test.ts", "c.ts"])).toBe(2);
  });
});

describe("resolveTurnPickerMessageLabel", () => {
  const comment: ReviewCommentContext = {
    id: "c1",
    sectionId: "uncommitted",
    sectionTitle: "Uncommitted changes",
    filePath: "a.ts",
    startIndex: 0,
    endIndex: 0,
    rangeLabel: "+1",
    text: "why?",
    diff: "@@ -0,0 +1,1 @@\n+a",
  };

  it("drops the review comment blocks and caps the length", () => {
    expect(resolveTurnPickerMessageLabel(appendReviewCommentsToPrompt("Fix it", [comment]))).toBe(
      "Fix it",
    );
    expect(resolveTurnPickerMessageLabel("x".repeat(200))).toHaveLength(80);
  });

  it("labels a comment-only turn, and leaves other empty messages blank", () => {
    expect(resolveTurnPickerMessageLabel(appendReviewCommentsToPrompt("", [comment]))).toBe(
      "Review comments",
    );
    expect(resolveTurnPickerMessageLabel("")).toBe("");
  });
});

describe("resolveDiffReviewSection", () => {
  it("gives every diff view its own section", () => {
    const section = (scope: "turns" | "uncommitted" | "branch", selectedTurnId: string | null) =>
      resolveDiffReviewSection({ scope, selectedTurnId, selectedTurnLabel: "Turn 2" });
    expect(section("turns", "t")).toEqual({ sectionId: "turn:t", sectionTitle: "Turn 2" });
    expect(section("turns", null)).toEqual({
      sectionId: "conversation",
      sectionTitle: "All turns",
    });
    expect(section("uncommitted", null).sectionId).toBe("uncommitted");
    expect(section("branch", null).sectionId).toBe("branch");
  });
});
