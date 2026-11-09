import { describe, expect, it } from "vitest";

import {
  codexGoalToProviderGoal,
  describeProviderGoal,
  latestProviderGoal,
  parseCodexGoalCommand,
} from "./codexGoalCommand.ts";

describe("parseCodexGoalCommand", () => {
  it.each([
    ["/goal", { type: "show" }],
    ["  /goal  ", { type: "show" }],
    ["/goal edit", { type: "show" }],
    ["/goal clear", { type: "clear" }],
    ["/goal PAUSE", { type: "pause" }],
    ["/goal resume", { type: "resume" }],
    ["/goal ship the fix", { type: "set", objective: "ship the fix" }],
    ["/goal\nline one\nline two", { type: "set", objective: "line one\nline two" }],
    ["/goal clear the cache", { type: "set", objective: "clear the cache" }],
  ])("parses %j", (text, expected) => {
    expect(parseCodexGoalCommand(text)).toEqual(expected);
  });

  it.each(["/goals", "/goalie now", "goal x", "say /goal", ""])("ignores %j", (text) => {
    expect(parseCodexGoalCommand(text)).toBeNull();
  });
});

describe("codexGoalToProviderGoal", () => {
  const goal = {
    threadId: "t",
    objective: " Ship it ",
    status: "usageLimited",
    tokenBudget: null,
    tokensUsed: 12,
    timeUsedSeconds: 3,
    createdAt: 1,
    updatedAt: 2,
  };

  it("maps the protocol's goal and status", () => {
    const mapped = codexGoalToProviderGoal(goal);
    expect(mapped).toEqual({
      objective: "Ship it",
      status: "usage_limited",
      tokensUsed: 12,
      tokenBudget: null,
      timeUsedSeconds: 3,
    });
    expect(describeProviderGoal(mapped!)).toBe("Goal usage limited: Ship it");
  });

  it("reads no goal, a blank objective or an unknown status as null", () => {
    expect(codexGoalToProviderGoal(null)).toBeNull();
    expect(codexGoalToProviderGoal(undefined)).toBeNull();
    expect(codexGoalToProviderGoal({ ...goal, objective: "  " })).toBeNull();
    expect(codexGoalToProviderGoal({ ...goal, status: "new-status" })).toBeNull();
  });
});

const report = (payload: unknown) => ({ kind: "goal.updated", payload });

describe("latestProviderGoal", () => {
  it("takes the newest readable report, and a clear wins", () => {
    const active = { goal: { objective: "x", status: "active" } };
    expect(latestProviderGoal([])).toBeNull();
    expect(latestProviderGoal([report(active), { kind: "tool.started", payload: {} }])).toEqual(
      active.goal,
    );
    expect(latestProviderGoal([report(active), report({ goal: null })])).toBeNull();
    expect(latestProviderGoal([report(active), report({ bad: true })])).toEqual(active.goal);
  });
});
