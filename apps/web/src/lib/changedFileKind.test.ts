import { describe, expect, it } from "vitest";

import { classifyChangedFile, isTestChangedFile } from "./changedFileKind";

describe("classifyChangedFile", () => {
  it.each([
    ["src/contest.py", "code"],
    ["src/Latest.java", "code"],
    ["requirements.txt", "code"],
    ["test/fixtures/pr.json", "mocks"],
    ["src/__snapshots__/a.snap", "mocks"],
    ["src/api.mock.ts", "mocks"],
    ["pnpm-lock.yaml", "generated"],
    ["convex/_generated/api.d.ts", "generated"],
    ["dist/app.min.js", "generated"],
    ["src/agent.eval.ts", "tests"],
    ["evals/title-generation.ts", "tests"],
    ["src/app.test.tsx", "tests"],
    ["src/FooTest.java", "tests"],
    ["pkg/thing_test.go", "tests"],
    ["tests/README.md", "tests"],
    ["README.md", "docs"],
    ["windows\\app.spec.ts", "tests"],
  ] as const)("%s is %s", (path, kind) => {
    expect(classifyChangedFile(path)).toBe(kind);
  });
});

describe("isTestChangedFile", () => {
  it("counts tests and test support, and nothing else", () => {
    expect(isTestChangedFile("src/app.test.ts")).toBe(true);
    expect(isTestChangedFile("test/fixtures/pr.json")).toBe(true);
    expect(isTestChangedFile("src/app.ts")).toBe(false);
    expect(isTestChangedFile("README.md")).toBe(false);
    expect(isTestChangedFile("bun.lock")).toBe(false);
  });
});
