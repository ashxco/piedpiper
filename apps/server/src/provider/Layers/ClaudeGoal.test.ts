import { type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { type ProviderGoal } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  claudeGoalMetByTurn,
  claudeGoalsEqual,
  isClaudeGoalAcknowledgement,
  isClaudeGoalModelOutput,
  nextClaudeGoal,
  readClaudeGoal,
} from "./ClaudeGoal.ts";

const assistant = (
  text: string,
  options?: { readonly model?: string; readonly parent?: string },
): SDKMessage =>
  ({
    type: "assistant",
    parent_tool_use_id: options?.parent ?? null,
    message: { model: options?.model ?? "<synthetic>", content: [{ type: "text", text }] },
  }) as unknown as SDKMessage;

const feedback = (text: string, extra?: Record<string, unknown>): SDKMessage =>
  ({
    type: "user",
    parent_tool_use_id: null,
    isSynthetic: true,
    message: { role: "user", content: [{ type: "text", text }] },
    ...extra,
  }) as unknown as SDKMessage;

const active: ProviderGoal = { objective: "tests pass", status: "active", checks: 1 };

describe("nextClaudeGoal", () => {
  it("reads a new goal from its confirmation", () => {
    expect(nextClaudeGoal(null, assistant("Goal set: tests pass\n"))).toEqual({
      objective: "tests pass",
      status: "active",
      checks: 0,
    });
    expect(nextClaudeGoal(null, assistant("Goal set:   "))).toBeUndefined();
  });

  it("clears on both of the CLI's clear answers and its error warning", () => {
    expect(nextClaudeGoal(active, assistant("Goal cleared: tests pass"))).toBeNull();
    expect(nextClaudeGoal(active, assistant("No goal set. Usage: `/goal <condition>`"))).toBeNull();
    expect(
      nextClaudeGoal(active, {
        type: "system",
        subtype: "informational",
        level: "warning",
        content: `Goal cleared after an unrecoverable error (api): "tests pass". Run /goal again to continue.`,
      } as unknown as SDKMessage),
    ).toBeNull();
  });

  it("reads the status answer, with or without a last check", () => {
    expect(nextClaudeGoal(null, assistant("Goal active: ship (not yet evaluated)"))).toEqual({
      objective: "ship",
      status: "active",
      checks: 0,
    });
    expect(
      nextClaudeGoal(active, assistant("Goal active: tests pass (3 turns)\nLast check: Not yet.")),
    ).toEqual({ objective: "tests pass", status: "active", checks: 3, lastCheck: "Not yet." });
    expect(nextClaudeGoal(active, assistant("Goal active: tests pass (1 turn)"))).toEqual(active);
  });

  it("keeps a status-like parenthetical inside the objective", () => {
    expect(nextClaudeGoal(null, assistant("Goal active: fix (2 turns) flake (0 turns)"))).toEqual({
      objective: "fix (2 turns) flake",
      status: "active",
      checks: 0,
    });
    const known: ProviderGoal = {
      objective: "a (2 turns)\nLast check: b",
      status: "active",
      checks: 1,
    };
    expect(
      nextClaudeGoal(known, assistant("Goal active: a (2 turns)\nLast check: b (3 turns)")),
    ).toEqual({ ...known, checks: 3 });
  });

  it("counts an unmet check from Stop hook feedback naming the objective", () => {
    expect(
      nextClaudeGoal(active, feedback("Stop hook feedback:\n[tests pass]: One fails.")),
    ).toEqual({ objective: "tests pass", status: "active", checks: 2, lastCheck: "One fails." });
    expect(nextClaudeGoal(active, feedback("Stop hook feedback:\n[other]: No."))).toBeUndefined();
    expect(
      nextClaudeGoal(null, feedback("Stop hook feedback:\n[tests pass]: No.")),
    ).toBeUndefined();
    expect(
      nextClaudeGoal(
        active,
        feedback("Stop hook feedback:\n[tests pass]: No.", { isSynthetic: false }),
      ),
    ).toBeUndefined();
  });

  it("ignores the same words from the model or a subagent", () => {
    expect(
      nextClaudeGoal(null, assistant("Goal set: tests pass", { model: "claude-opus-4-8" })),
    ).toBeUndefined();
    expect(nextClaudeGoal(null, assistant("Goal set: x", { parent: "tool-1" }))).toBeUndefined();
    expect(nextClaudeGoal(active, assistant("Some other notice"))).toBeUndefined();
  });
});

describe("isClaudeGoalAcknowledgement", () => {
  it("hides confirmations only, not answers the user asked for", () => {
    expect(isClaudeGoalAcknowledgement(assistant("Goal set: x"))).toBe(true);
    expect(isClaudeGoalAcknowledgement(assistant("Goal cleared: x"))).toBe(true);
    expect(isClaudeGoalAcknowledgement(assistant("Goal active: x (2 turns)"))).toBe(false);
    expect(isClaudeGoalAcknowledgement(assistant("No goal set"))).toBe(true);
    expect(isClaudeGoalAcknowledgement(assistant("No goal set. Usage: `/goal <condition>`"))).toBe(
      false,
    );
    expect(isClaudeGoalAcknowledgement(assistant("Goal set: x", { model: "claude" }))).toBe(false);
  });
});

describe("isClaudeGoalModelOutput", () => {
  it("is true only for real root output", () => {
    expect(isClaudeGoalModelOutput(assistant("Done", { model: "claude" }))).toBe(true);
    expect(isClaudeGoalModelOutput(assistant("Goal set: x"))).toBe(false);
    expect(isClaudeGoalModelOutput(assistant("Done", { model: "claude", parent: "t" }))).toBe(
      false,
    );
  });
});

describe("claudeGoalMetByTurn", () => {
  const met = {
    goal: active,
    sawModelOutput: true,
    turnCompleted: true,
    result: { type: "result" } as unknown as SDKResultMessage,
    liveBackgroundWork: 0,
  };

  it("needs an active goal, real output, a completed turn and no background work", () => {
    expect(claudeGoalMetByTurn(met)).toBe(true);
    expect(claudeGoalMetByTurn({ ...met, goal: null })).toBe(false);
    expect(claudeGoalMetByTurn({ ...met, goal: { ...active, status: "complete" } })).toBe(false);
    expect(claudeGoalMetByTurn({ ...met, sawModelOutput: false })).toBe(false);
    expect(claudeGoalMetByTurn({ ...met, turnCompleted: false })).toBe(false);
    expect(claudeGoalMetByTurn({ ...met, liveBackgroundWork: 1 })).toBe(false);
  });

  it("needs a real result ending for completion", () => {
    expect(claudeGoalMetByTurn({ ...met, result: undefined })).toBe(false);
    const withReason = (terminal_reason: string) =>
      ({ type: "result", terminal_reason }) as unknown as SDKResultMessage;
    expect(claudeGoalMetByTurn({ ...met, result: withReason("completed") })).toBe(true);
    expect(claudeGoalMetByTurn({ ...met, result: withReason("hook_stopped") })).toBe(false);
  });
});

describe("goal helpers", () => {
  it("compares goals by value", () => {
    expect(claudeGoalsEqual(active, { ...active })).toBe(true);
    expect(claudeGoalsEqual(active, { ...active, checks: 2 })).toBe(false);
    expect(claudeGoalsEqual(null, null)).toBe(true);
    expect(claudeGoalsEqual(active, null)).toBe(false);
  });

  it("reads only a well-formed goal", () => {
    expect(readClaudeGoal(active)).toEqual(active);
    expect(readClaudeGoal({ objective: "x", status: "nope" })).toBeUndefined();
    expect(readClaudeGoal(undefined)).toBeUndefined();
  });
});
