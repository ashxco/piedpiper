import { describe, expect, it } from "vitest";

import { resolveRepoRelativeFilePath, resolveRepoRelativePathBase } from "./diffPathResolution";

describe("resolveRepoRelativeFilePath", () => {
  it("resolves against the repo root for a project in a repository subdirectory", () => {
    expect(
      resolveRepoRelativeFilePath("apps/web/src/index.ts", {
        cwd: "/repo/apps/web",
        repoRoot: "/repo",
      }),
    ).toBe("/repo/apps/web/src/index.ts");
  });

  it("resolves files outside the project folder against the repo root", () => {
    expect(
      resolveRepoRelativeFilePath("packages/shared/src/git.ts", {
        cwd: "/repo/apps/web",
        repoRoot: "/repo",
      }),
    ).toBe("/repo/packages/shared/src/git.ts");
  });

  it("falls back to the cwd when the repo root is unknown", () => {
    expect(resolveRepoRelativeFilePath("src/index.ts", { cwd: "/repo", repoRoot: undefined })).toBe(
      "/repo/src/index.ts",
    );
  });

  it("keeps Windows separators from the base path", () => {
    expect(
      resolveRepoRelativeFilePath("src/index.ts", { cwd: "C:\\repo\\app", repoRoot: "C:\\repo" }),
    ).toBe("C:\\repo\\src\\index.ts");
  });

  it("returns the raw path when neither base is known", () => {
    expect(resolveRepoRelativeFilePath("src/index.ts", { cwd: null, repoRoot: null })).toBe(
      "src/index.ts",
    );
    expect(resolveRepoRelativePathBase({ cwd: null, repoRoot: null })).toBeNull();
  });
});
