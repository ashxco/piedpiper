import { describe, expect, it } from "vitest";

import { parseDiffRouteSearch, stripDiffSearchParams } from "./diffRouteSearch";

describe("parseDiffRouteSearch", () => {
  it("parses valid diff search values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
  });

  it("treats numeric and boolean diff toggles as open", () => {
    expect(
      parseDiffRouteSearch({
        diff: 1,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });

    expect(
      parseDiffRouteSearch({
        diff: true,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });
  });

  it("drops turn and file values when diff is closed", () => {
    const parsed = parseDiffRouteSearch({
      diff: "0",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({});
  });

  it("drops file value when turn is not selected", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });

  it("normalizes whitespace-only values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "  ",
      diffFilePath: "  ",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });

  it("parses a git scope, keeps its file path and drops unknown values", () => {
    expect(
      parseDiffRouteSearch({ diff: "1", diffScope: "uncommitted", diffFilePath: "src/app.ts" }),
    ).toEqual({ diff: "1", diffScope: "uncommitted", diffFilePath: "src/app.ts" });
    expect(parseDiffRouteSearch({ diff: "1", diffScope: "branch" })).toEqual({
      diff: "1",
      diffScope: "branch",
    });
    expect(parseDiffRouteSearch({ diff: "1", diffScope: "staged" })).toEqual({ diff: "1" });
  });

  it("drops the git scope while the panel is closed or a turn is selected", () => {
    expect(parseDiffRouteSearch({ diffScope: "branch" })).toEqual({});
    expect(parseDiffRouteSearch({ diff: "1", diffScope: "branch", diffTurnId: "turn-1" })).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });
  });
});

describe("stripDiffSearchParams", () => {
  it("removes the git scope with the other diff params", () => {
    expect(
      stripDiffSearchParams({
        diff: "1",
        diffScope: "branch",
        diffTurnId: "turn-1",
        diffFilePath: "a.ts",
        other: "kept",
      }),
    ).toEqual({ other: "kept" });
  });
});
