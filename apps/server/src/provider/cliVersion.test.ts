import { describe, expect, it } from "vitest";

import { compareCliVersions } from "./cliVersion";
import { compareCodexCliVersions } from "./codexCliVersion";

describe("compareCliVersions", () => {
  it.each([
    ["2.1.280", "2.1.280", 0],
    ["2.1", "2.1.0", 0],
    ["2.1.279", "2.1.280", -1],
    ["2.10.0", "2.9.9", 1],
    ["1.0.0-beta", "1.0.0", -1],
    ["1.0.0-beta.2", "1.0.0-beta.10", -1],
    ["1.0.0-alpha", "1.0.0-1", 1],
  ])("orders %s and %s", (left, right, expected) => {
    expect(Math.sign(compareCliVersions(left, right))).toBe(expected);
  });

  it("falls back to text order for what it cannot parse", () => {
    expect(Math.sign(compareCliVersions("nightly", "stable"))).toBe(-1);
  });

  it("is what the Codex name still points at", () => {
    expect(compareCodexCliVersions).toBe(compareCliVersions);
  });
});
