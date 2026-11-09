import {
  EventId,
  type OrchestrationThreadActivity,
  type ProviderGoal,
  THREAD_GOAL_ACTIVITY_KIND,
} from "@piedpiper/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { deriveThreadGoal, threadGoalDetails, ThreadGoalRow } from "./ChatView.threadGoal";

const goalActivity = (id: string, payload: unknown, kind = THREAD_GOAL_ACTIVITY_KIND) =>
  ({
    id: EventId.makeUnsafe(id),
    tone: "info",
    kind,
    summary: "Goal updated",
    payload,
    turnId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  }) as OrchestrationThreadActivity;

const goal: ProviderGoal = { objective: "Ship the release", status: "active" };

describe("deriveThreadGoal", () => {
  it("is null without a report", () => {
    expect(deriveThreadGoal([])).toBeNull();
    expect(deriveThreadGoal([goalActivity("a", { goal }, "context-window.updated")])).toBeNull();
  });

  it("uses the latest report", () => {
    const paused = { ...goal, status: "paused" as const };
    expect(
      deriveThreadGoal([goalActivity("a", { goal }), goalActivity("b", { goal: paused })]),
    ).toEqual(paused);
  });

  it("drops the goal once a clear is reported", () => {
    expect(
      deriveThreadGoal([goalActivity("a", { goal }), goalActivity("b", { goal: null })]),
    ).toBeNull();
  });

  it("skips a malformed report", () => {
    expect(
      deriveThreadGoal([goalActivity("a", { goal }), goalActivity("b", { goal: { status: 1 } })]),
    ).toEqual(goal);
  });
});

describe("threadGoalDetails", () => {
  it("labels every status", () => {
    const labels = [
      ["active", "Active"],
      ["paused", "Paused"],
      ["blocked", "Blocked"],
      ["usage_limited", "Usage limited"],
      ["budget_limited", "Budget limited"],
      ["complete", "Complete"],
    ] as const;
    for (const [status, label] of labels) {
      expect(threadGoalDetails({ ...goal, status })).toBe(label);
    }
  });

  it("adds the check count and last check", () => {
    expect(threadGoalDetails({ ...goal, checks: 1 })).toBe("Active · 1 check");
    expect(threadGoalDetails({ ...goal, checks: 3, lastCheck: " Tests still fail " })).toBe(
      "Active · 3 checks · Tests still fail",
    );
  });

  it("adds the tokens and time a goal used", () => {
    expect(threadGoalDetails({ ...goal, tokensUsed: 12_000, tokenBudget: 100_000 })).toBe(
      "Active · 12k / 100k tokens",
    );
    expect(threadGoalDetails({ ...goal, tokensUsed: 0, tokenBudget: 100_000 })).toBe(
      "Active · 0 / 100k tokens",
    );
    expect(threadGoalDetails({ ...goal, tokensUsed: 12_000, tokenBudget: null })).toBe(
      "Active · 12k tokens",
    );
    expect(threadGoalDetails({ ...goal, tokensUsed: 0, tokenBudget: null })).toBe("Active");
    expect(threadGoalDetails({ ...goal, timeUsedSeconds: 90 })).toBe("Active · 1m 30s");
    expect(threadGoalDetails({ ...goal, timeUsedSeconds: 0 })).toBe("Active");
  });

  it("does not round a token count up to 1000k", () => {
    expect(threadGoalDetails({ ...goal, tokensUsed: 999_600 })).toBe("Active · 1m tokens");
  });
});

describe("ThreadGoalRow", () => {
  it("shows the objective, details and Clear", () => {
    const markup = renderToStaticMarkup(
      <ThreadGoalRow goal={{ ...goal, checks: 2 }} clearDisabled={false} onClear={vi.fn()} />,
    );
    expect(markup).toContain("Ship the release");
    expect(markup).toContain("Active · 2 checks");
    expect(markup).toContain("Clear");
  });
});
