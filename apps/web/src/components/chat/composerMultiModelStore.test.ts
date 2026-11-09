import { type ModelSelection, ThreadId } from "@piedpiper/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  formatComposerMultiModelNotice,
  readComposerMultiModelSelections,
  setComposerMultiModelSelections,
  toggleComposerMultiModelSelection,
  useComposerMultiModelStore,
} from "./composerMultiModelStore";

const primary: ModelSelection = {
  provider: "claudeAgent",
  model: "claude-opus-4-6",
  options: { effort: "high" },
};
const codex: ModelSelection = { provider: "codex", model: "gpt-5.4" };
const sonnet: ModelSelection = { provider: "claudeAgent", model: "claude-sonnet-4-6" };

describe("toggleComposerMultiModelSelection", () => {
  it("starts a multi selection from the primary model, keeping its options", () => {
    expect(toggleComposerMultiModelSelection({ current: null, primary, toggled: codex })).toEqual({
      selections: [primary, codex],
      single: null,
    });
  });

  it("adds and removes while two or more stay selected", () => {
    expect(
      toggleComposerMultiModelSelection({ current: [primary, codex], primary, toggled: sonnet }),
    ).toEqual({ selections: [primary, codex, sonnet], single: null });
    expect(
      toggleComposerMultiModelSelection({
        current: [primary, codex, sonnet],
        primary,
        toggled: primary,
      }),
    ).toEqual({ selections: [codex, sonnet], single: null });
  });

  it("returns to single-model sending with the one that is left", () => {
    expect(
      toggleComposerMultiModelSelection({ current: [primary, codex], primary, toggled: primary }),
    ).toEqual({ selections: null, single: codex });
  });

  it("treats the same slug on another provider as a different model", () => {
    const sameSlug = { provider: "codex", model: primary.model } as const;
    expect(
      toggleComposerMultiModelSelection({ current: null, primary, toggled: sameSlug }).selections,
    ).toHaveLength(2);
  });

  it("cannot deselect the only model", () => {
    expect(toggleComposerMultiModelSelection({ current: null, primary, toggled: primary })).toEqual(
      { selections: null, single: primary },
    );
    expect(
      toggleComposerMultiModelSelection({ current: [codex], primary, toggled: codex }),
    ).toEqual({ selections: null, single: primary });
  });
});

describe("composer multi-model store", () => {
  const threadA = ThreadId.makeUnsafe("thread-a");
  const threadB = ThreadId.makeUnsafe("thread-b");

  afterEach(() => {
    useComposerMultiModelStore.setState({ selectionsByThreadId: {} });
  });

  it("keeps selections per draft and clears them independently", () => {
    setComposerMultiModelSelections(threadA, [primary, codex]);
    setComposerMultiModelSelections(threadB, [sonnet, codex]);
    setComposerMultiModelSelections(threadA, null);
    expect(readComposerMultiModelSelections(threadA)).toBeNull();
    expect(readComposerMultiModelSelections(threadB)).toEqual([sonnet, codex]);
  });
});

describe("formatComposerMultiModelNotice", () => {
  it("names the base branch when it is known", () => {
    expect(formatComposerMultiModelNotice(3, "main")).toBe(
      "Sends to 3 models, each in a new worktree from main",
    );
    expect(formatComposerMultiModelNotice(2, null)).toBe(
      "Sends to 2 models, each in a new worktree",
    );
  });

  it("reads correctly for the one failed model left selected after a retry", () => {
    expect(formatComposerMultiModelNotice(1, "main")).toBe("Sends in a new worktree from main");
  });
});
