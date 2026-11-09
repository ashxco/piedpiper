import { describe, expect, it } from "vitest";

import { type ComposerTrigger, detectComposerTrigger } from "../../composer-logic";
import {
  applyComposerTriggerDismissal,
  keepEquivalentComposerTrigger,
  resolveDismissedComposerTrigger,
} from "./composerTriggerState";

const trigger = (overrides: Partial<ComposerTrigger> = {}): ComposerTrigger => ({
  kind: "path",
  query: "src",
  rangeStart: 0,
  rangeEnd: 4,
  ...overrides,
});

describe("keepEquivalentComposerTrigger", () => {
  it("keeps the previous object when the trigger is unchanged", () => {
    const previous = trigger();
    expect(keepEquivalentComposerTrigger(previous, trigger())).toBe(previous);
  });

  it("returns the next trigger when any field differs", () => {
    const previous = trigger();
    for (const next of [
      trigger({ kind: "slash-command" }),
      trigger({ query: "srcx" }),
      trigger({ rangeStart: 1 }),
      trigger({ rangeEnd: 5 }),
    ]) {
      expect(keepEquivalentComposerTrigger(previous, next)).toBe(next);
    }
  });

  it("handles null on either side", () => {
    const next = trigger();
    expect(keepEquivalentComposerTrigger(null, null)).toBeNull();
    expect(keepEquivalentComposerTrigger(null, next)).toBe(next);
    expect(keepEquivalentComposerTrigger(next, null)).toBeNull();
  });
});

describe("composer trigger dismissal", () => {
  const initialPrompt = "pnpm install -g @openai";
  const command = "pnpm install -g @openai/codex@latest";

  /** Replays prompt states through the dismissal, like keystrokes in the composer. */
  function replay(dismissed: ComposerTrigger | null, states: Array<[string, number?]>) {
    let current = dismissed;
    const triggers: Array<ComposerTrigger | null> = [];
    for (const [text, cursor] of states) {
      const next = applyComposerTriggerDismissal(
        current,
        detectComposerTrigger(text, cursor ?? text.length),
      );
      current = next.dismissed;
      triggers.push(next.trigger);
    }
    return { dismissed: current, triggers };
  }

  const dismissedAtStart = detectComposerTrigger(initialPrompt, initialPrompt.length);

  it("rejects the dismissed token for keyboard selection", () => {
    expect(dismissedAtStart).not.toBeNull();
    expect(resolveDismissedComposerTrigger(dismissedAtStart, dismissedAtStart)).toBeNull();
    expect(resolveDismissedComposerTrigger(null, dismissedAtStart)).toBe(dismissedAtStart);
  });

  it("stays dismissed while typing a scoped package, including its second @", () => {
    const states: Array<[string]> = [];
    for (let cursor = initialPrompt.length; cursor <= command.length; cursor += 1) {
      states.push([command.slice(0, cursor)]);
    }
    const { triggers, dismissed } = replay(dismissedAtStart, states);
    expect(triggers.every((trigger) => trigger === null)).toBe(true);
    expect(dismissed).toBe(dismissedAtStart);
  });

  it("stays dismissed while deleting or moving the caret within the token", () => {
    const states: Array<[string, number?]> = [];
    for (let cursor = initialPrompt.length - 1; cursor > initialPrompt.indexOf("@"); cursor -= 1) {
      states.push([initialPrompt, cursor], [initialPrompt.slice(0, cursor)]);
    }
    expect(replay(dismissedAtStart, states).triggers.every((trigger) => trigger === null)).toBe(
      true,
    );
  });

  it("opens suggestions for a new @ token", () => {
    const { triggers } = replay(dismissedAtStart, [[`${command} `], [`${command} @src`]]);
    expect(triggers.at(-1)?.query).toBe("src");
    expect(triggers.at(-1)?.rangeStart).toBe(command.length + 1);
  });

  it("reopens after the caret leaves the dismissed token", () => {
    const { triggers } = replay(dismissedAtStart, [[initialPrompt, 0], [initialPrompt]]);
    expect(triggers.at(-1)?.query).toBe("openai");
  });

  it("reopens at the same position after deleting and retyping @", () => {
    const prefix = initialPrompt.slice(0, initialPrompt.indexOf("@"));
    const { triggers } = replay(dismissedAtStart, [[prefix], [`${prefix}@`]]);
    expect(triggers.at(-1)?.query).toBe("");
  });

  it("also dismisses slash-command suggestions", () => {
    const slash = detectComposerTrigger("/pl", 3);
    expect(slash?.kind).toBe("slash-command");
    const { triggers } = replay(slash, [["/pla"], ["/plan"]]);
    expect(triggers).toEqual([null, null]);
    expect(replay(slash, [["@src"]]).triggers[0]?.kind).toBe("path");
  });

  it("stays dismissed when a slash command turns into /model while typing", () => {
    const slash = detectComposerTrigger("/", 1);
    expect(slash?.kind).toBe("slash-command");
    const states: Array<[string]> = [
      "/m",
      "/mo",
      "/mod",
      "/mode",
      "/model",
      "/model ",
      "/model so",
    ].map((text) => [text]);
    expect(detectComposerTrigger("/model", 6)?.kind).toBe("slash-model");
    const { triggers, dismissed } = replay(slash, states);
    expect(triggers.every((trigger) => trigger === null)).toBe(true);
    expect(dismissed).toBe(slash);
  });
});
