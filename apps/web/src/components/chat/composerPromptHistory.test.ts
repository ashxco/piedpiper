import { ThreadId } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  appendReviewCommentsToPrompt,
  type ReviewCommentContext,
} from "../../reviewCommentContext";

import { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "~/lib/imageOnlyBootstrapPrompt";
import { buildPlanImplementationPrompt } from "../../proposedPlan";
import {
  appendTerminalContextsToPrompt,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
} from "../../lib/terminalContext";
import {
  buildComposerPromptHistoryEntries,
  canBrowseComposerPromptHistory,
  type ComposerPromptHistoryMessage,
  PLAN_IMPLEMENTATION_PROMPT_PREFIX,
  recallableComposerPrompt,
  stepComposerPromptHistory,
} from "./composerPromptHistory";

const user = (id: string, text: string): ComposerPromptHistoryMessage => ({
  id,
  role: "user",
  text,
});

const terminalContext = (lineStart: number, lineEnd: number) => ({
  id: `ctx-${lineStart}`,
  threadId: ThreadId.makeUnsafe("thread-1"),
  createdAt: "2026-03-13T12:00:00.000Z",
  terminalId: "default",
  terminalLabel: "Terminal 1",
  lineStart,
  lineEnd,
  text: "git status\nOn branch main",
});

describe("recallableComposerPrompt", () => {
  it("returns plain prompts trimmed", () => {
    expect(recallableComposerPrompt("  fix the bug \n")).toBe("fix the bug");
  });

  it("strips the ultrathink prefix", () => {
    expect(recallableComposerPrompt("Ultrathink:\nInvestigate this")).toBe("Investigate this");
  });

  it("strips the trailing terminal block and its inline labels", () => {
    const sent = appendTerminalContextsToPrompt(
      `Investigate ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} and ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} carefully`,
      [terminalContext(12, 13), terminalContext(4, 4)],
    );
    expect(sent).toContain("<terminal_context>");
    expect(recallableComposerPrompt(sent)).toBe("Investigate and carefully");
  });

  it("drops diff comment blocks, with or without a terminal block", () => {
    const comment: ReviewCommentContext = {
      id: "comment-1",
      sectionId: "turn-1",
      sectionTitle: "Turn 1",
      filePath: "src/app.ts",
      startIndex: 1,
      endIndex: 1,
      rangeLabel: "line 11",
      text: "see @terminal-1:4 here",
      diff: "+new line",
    };
    const withComment = appendReviewCommentsToPrompt("Fix this", [comment]);
    expect(withComment).toContain("<review_comment");
    expect(recallableComposerPrompt(withComment)).toBe("Fix this");
    expect(recallableComposerPrompt(appendReviewCommentsToPrompt("", [comment]))).toBe("");

    const withBoth = appendReviewCommentsToPrompt(
      appendTerminalContextsToPrompt(`Fix ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} this`, [
        terminalContext(4, 4),
      ]),
      [comment],
    );
    expect(recallableComposerPrompt(withBoth)).toBe("Fix this");
  });

  it("does not strip a longer label that only starts like a context label", () => {
    const sent = appendTerminalContextsToPrompt(
      `see @terminal-1:40 and ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}`,
      [terminalContext(4, 4)],
    );
    expect(recallableComposerPrompt(sent)).toBe("see @terminal-1:40 and");
  });

  it("drops app-composed sends", () => {
    expect(recallableComposerPrompt(IMAGE_ONLY_BOOTSTRAP_PROMPT)).toBe("");
    expect(recallableComposerPrompt(`ultrathink: ${IMAGE_ONLY_BOOTSTRAP_PROMPT}`)).toBe("");
    expect(recallableComposerPrompt(`Ultrathink:\n${IMAGE_ONLY_BOOTSTRAP_PROMPT}`)).toBe("");
    expect(recallableComposerPrompt(buildPlanImplementationPrompt("## Ship it"))).toBe("");
  });

  it("matches the plan prompt that proposedPlan builds", () => {
    expect(PLAN_IMPLEMENTATION_PROMPT_PREFIX.length).toBeGreaterThan(0);
    expect(buildPlanImplementationPrompt("x")).toBe(`${PLAN_IMPLEMENTATION_PROMPT_PREFIX}x`);
  });
});

describe("buildComposerPromptHistoryEntries", () => {
  it("keeps user prompts oldest first and collapses consecutive duplicates", () => {
    expect(
      buildComposerPromptHistoryEntries([
        user("1", "first"),
        { id: "a", role: "assistant", text: "reply" },
        user("2", "second"),
        user("3", "second"),
        user("4", IMAGE_ONLY_BOOTSTRAP_PROMPT),
        user("5", "first"),
      ]),
    ).toEqual([
      { id: "1", prompt: "first" },
      { id: "3", prompt: "second" },
      { id: "5", prompt: "first" },
    ]);
  });
});

describe("stepComposerPromptHistory", () => {
  const entries = buildComposerPromptHistoryEntries([
    user("1", "oldest"),
    user("2", "middle"),
    user("3", "newest"),
  ]);

  it("walks back from an empty composer and stops at the oldest entry", () => {
    const first = stepComposerPromptHistory({
      direction: "backward",
      entries,
      position: null,
      currentPrompt: "",
    });
    expect(first?.prompt).toBe("newest");
    const second = stepComposerPromptHistory({
      direction: "backward",
      entries,
      position: first!.position,
      currentPrompt: "newest",
    });
    expect(second?.prompt).toBe("middle");
    const third = stepComposerPromptHistory({
      direction: "backward",
      entries,
      position: second!.position,
      currentPrompt: "middle",
    });
    expect(third?.prompt).toBe("oldest");
    expect(
      stepComposerPromptHistory({
        direction: "backward",
        entries,
        position: third!.position,
        currentPrompt: "oldest",
      }),
    ).toBeNull();
  });

  it("walks forward and clears the composer past the newest entry", () => {
    const forward = stepComposerPromptHistory({
      direction: "forward",
      entries,
      position: { entryId: "2", recalled: "middle" },
      currentPrompt: "middle",
    });
    expect(forward).toEqual({ position: { entryId: "3", recalled: "newest" }, prompt: "newest" });
    expect(
      stepComposerPromptHistory({
        direction: "forward",
        entries,
        position: forward!.position,
        currentPrompt: "newest",
      }),
    ).toEqual({ position: null, prompt: "" });
  });

  it("falls through for a typed draft, an edited recall or forward without browsing", () => {
    expect(
      stepComposerPromptHistory({
        direction: "backward",
        entries,
        position: null,
        currentPrompt: "draft",
      }),
    ).toBeNull();
    expect(
      stepComposerPromptHistory({
        direction: "backward",
        entries,
        position: { entryId: "3", recalled: "newest" },
        currentPrompt: "newest!",
      }),
    ).toBeNull();
    expect(
      stepComposerPromptHistory({
        direction: "forward",
        entries,
        position: null,
        currentPrompt: "",
      }),
    ).toBeNull();
  });

  it("keeps its place when the recalled id was retired by a duplicate collapse", () => {
    expect(
      stepComposerPromptHistory({
        direction: "backward",
        entries,
        position: { entryId: "optimistic-3", recalled: "newest" },
        currentPrompt: "newest",
      })?.prompt,
    ).toBe("middle");
  });

  it("does nothing without history", () => {
    expect(
      stepComposerPromptHistory({
        direction: "backward",
        entries: [],
        position: null,
        currentPrompt: "",
      }),
    ).toBeNull();
  });
});

describe("canBrowseComposerPromptHistory", () => {
  const event = {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 38,
  };
  const base = {
    event,
    hasPendingApproval: false,
    hasPendingUserInput: false,
    imageCount: 0,
    terminalContextCount: 0,
  };

  it("allows plain arrows in an idle composer", () => {
    expect(canBrowseComposerPromptHistory(base)).toBe(true);
  });

  it("yields to modifiers, IME, pending requests and attachments", () => {
    for (const blocked of [
      { ...base, event: { ...event, shiftKey: true } },
      { ...base, event: { ...event, metaKey: true } },
      { ...base, event: { ...event, isComposing: true } },
      { ...base, event: { ...event, keyCode: 229 } },
      { ...base, hasPendingApproval: true },
      { ...base, hasPendingUserInput: true },
      { ...base, imageCount: 1 },
      { ...base, terminalContextCount: 1 },
    ]) {
      expect(canBrowseComposerPromptHistory(blocked)).toBe(false);
    }
  });
});

describe("buildComposerPromptHistoryEntries and restart continuations", () => {
  it("skips a continuation, so the previous prompt stays newest", () => {
    const entries = buildComposerPromptHistoryEntries([
      { id: "prompt", role: "user", text: "my prompt" },
      {
        id: "message:restart-continuation:1",
        role: "user",
        text: "Continue where you left off.",
      },
    ] as never);
    expect(JSON.stringify(entries)).toContain("my prompt");
    expect(JSON.stringify(entries)).not.toContain("Continue where you left off.");
  });
});
