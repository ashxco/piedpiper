import type { ProjectSearchEntriesResult, ProjectStatPathKind } from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  pickWorkspaceBasenameMatch,
  resolveMarkdownFileLinkOpenTarget,
  stripRepeatedWorkspacePrefix,
  unverifiedRepeatedPrefixPath,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "./markdown-basename-lookup";

function entries(
  ...items: Array<[path: string, kind?: "file" | "directory"]>
): ProjectSearchEntriesResult {
  return {
    entries: items.map(([path, kind = "file"]) => ({ path, kind })),
    truncated: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("pickWorkspaceBasenameMatch", () => {
  it("prefers an exact basename over fuzzy neighbours and skips directories", () => {
    expect(
      pickWorkspaceBasenameMatch(
        "ChatView.tsx",
        entries(
          ["src/ChatView.tsx", "directory"],
          ["src/ChatView.test.tsx"],
          ["apps/web/src/components/ChatView.tsx"],
        ).entries,
      ),
    ).toBe("apps/web/src/components/ChatView.tsx");
  });

  it("prefers the shallowest exact match, so a root file beats a nested namesake", () => {
    expect(
      pickWorkspaceBasenameMatch(
        "package.json",
        entries(["apps/web/package.json"], ["apps/package.json"], ["package.json"]).entries,
      ),
    ).toBe("package.json");
    expect(
      pickWorkspaceBasenameMatch(
        "index.ts",
        entries(["src/z/index.ts"], ["apps/web/src/index.ts"], ["src/a/index.ts"]).entries,
      ),
    ).toBe("src/a/index.ts");
  });

  it("falls back to a single case-insensitive match", () => {
    expect(pickWorkspaceBasenameMatch("readme.md", entries(["docs/README.md"]).entries)).toBe(
      "docs/README.md",
    );
    expect(
      pickWorkspaceBasenameMatch("FOO.ts", entries(["a/Foo.ts"], ["b/foo.ts"]).entries),
    ).toBeNull();
  });

  it("returns null when nothing has that basename", () => {
    expect(pickWorkspaceBasenameMatch("Missing.ts", entries(["src/Other.ts"]).entries)).toBeNull();
  });
});

describe("resolveMarkdownFileLinkOpenTarget", () => {
  it("opens the workspace match for a bare filename and keeps the line suffix", async () => {
    const searchEntries = vi.fn(async () => entries(["apps/web/src/ChatView.tsx"]));
    await expect(
      resolveMarkdownFileLinkOpenTarget({
        href: "ChatView.tsx:42",
        targetPath: "/repo/ChatView.tsx:42",
        cwd: "/repo",
        searchEntries,
      }),
    ).resolves.toBe("/repo/apps/web/src/ChatView.tsx:42");
    expect(searchEntries).toHaveBeenCalledWith({
      cwd: "/repo",
      query: "ChatView.tsx",
      limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
    });
  });

  it("falls back to the resolved path without a match or when the search fails", async () => {
    await expect(
      resolveMarkdownFileLinkOpenTarget({
        href: "Missing.ts",
        targetPath: "/repo/Missing.ts",
        cwd: "/repo",
        searchEntries: async () => entries(["src/Other.ts"]),
      }),
    ).resolves.toBe("/repo/Missing.ts");
    await expect(
      resolveMarkdownFileLinkOpenTarget({
        href: "Missing.ts",
        targetPath: "/repo/Missing.ts",
        cwd: "/repo",
        searchEntries: async () => {
          throw new Error("offline");
        },
      }),
    ).resolves.toBe("/repo/Missing.ts");
  });

  it("does not search for links that already name a directory", async () => {
    const searchEntries = vi.fn(async () => entries());
    await expect(
      resolveMarkdownFileLinkOpenTarget({
        href: "src/ChatView.tsx",
        targetPath: "/repo/src/ChatView.tsx",
        cwd: "/repo",
        searchEntries,
      }),
    ).resolves.toBe("/repo/src/ChatView.tsx");
    expect(searchEntries).not.toHaveBeenCalled();
  });

  it("lets the latest click win while an earlier lookup is in flight", async () => {
    const slow = deferred<ProjectSearchEntriesResult>();
    const first = resolveMarkdownFileLinkOpenTarget({
      href: "First.ts",
      targetPath: "/repo/First.ts",
      cwd: "/repo",
      searchEntries: () => slow.promise,
    });
    const second = resolveMarkdownFileLinkOpenTarget({
      href: "src/Second.ts",
      targetPath: "/repo/src/Second.ts",
      cwd: "/repo",
      searchEntries: async () => entries(),
    });
    slow.resolve(entries(["src/First.ts"]));
    await expect(second).resolves.toBe("/repo/src/Second.ts");
    await expect(first).resolves.toBeNull();
  });
});

describe("stripRepeatedWorkspacePrefix", () => {
  it.each([
    ["the project's folder", "web/src/a.ts", "/repo/apps/web", "src/a.ts"],
    ["several folders, longest first", "apps/web/src/a.ts", "/repo/apps/web", "src/a.ts"],
    ["a leading dot segment", "./apps/web/src/a.ts", "/repo/apps/web", "src/a.ts"],
    ["backslashes", "apps\\web\\src\\a.ts", "C:\\repo\\apps\\web", "src/a.ts"],
    ["a different case on Windows", "Apps/Web/src/a.ts", "C:/repo/apps/web", "src/a.ts"],
  ])("strips %s", (_, path, cwd, expected) => {
    expect(stripRepeatedWorkspacePrefix(path, cwd)).toBe(expected);
  });

  it.each([
    ["an unrelated path", "src/a.ts", "/repo/apps/web"],
    ["a different case on POSIX", "Apps/Web/src/a.ts", "/repo/apps/web"],
    ["a path that is only the prefix", "apps/web", "/repo/apps/web"],
    ["parent segments", "apps/web/../../secret.ts", "/repo/apps/web"],
    ["leading parent segments", "../web/src/a.ts", "/repo/apps/web"],
    ["an absolute path", "/repo/apps/web/src/a.ts", "/repo/apps/web"],
    ["a Windows absolute path", "C:/apps/web/src/a.ts", "C:/repo/apps/web"],
  ])("keeps %s", (_, path, cwd) => {
    expect(stripRepeatedWorkspacePrefix(path, cwd)).toBeNull();
  });
});

describe("resolveMarkdownFileLinkOpenTarget with a repeated workspace prefix", () => {
  const LITERAL = "/repo/apps/web/apps/web/src/a.ts";
  const STRIPPED = "/repo/apps/web/src/a.ts";
  const open = (
    statPath: ((path: string) => Promise<ProjectStatPathKind>) | undefined,
    href = "apps/web/src/a.ts:12:3",
    targetPath = `${LITERAL}:12:3`,
  ) =>
    resolveMarkdownFileLinkOpenTarget({
      href,
      targetPath,
      cwd: "/repo/apps/web",
      searchEntries: undefined,
      statPath,
    });
  const statsFrom = (kinds: Record<string, ProjectStatPathKind>) =>
    vi.fn(async (path: string) => kinds[path] ?? "missing");

  it("opens the stripped path and keeps the position when the literal one is missing", async () => {
    const statPath = statsFrom({ [LITERAL]: "missing", [STRIPPED]: "file" });
    await expect(open(statPath)).resolves.toBe(`${STRIPPED}:12:3`);
  });

  it("keeps the literal path when it exists, without checking the stripped one", async () => {
    const statPath = statsFrom({ [LITERAL]: "file", [STRIPPED]: "file" });
    await expect(open(statPath)).resolves.toBe(`${LITERAL}:12:3`);
    expect(statPath).toHaveBeenCalledTimes(1);
  });

  it("keeps the literal path when a stat cannot tell", async () => {
    const unknownLiteral = statsFrom({ [LITERAL]: "unknown", [STRIPPED]: "file" });
    await expect(open(unknownLiteral)).resolves.toBe(`${LITERAL}:12:3`);
    const unknownStripped = statsFrom({ [LITERAL]: "missing", [STRIPPED]: "unknown" });
    await expect(open(unknownStripped)).resolves.toBe(`${LITERAL}:12:3`);
  });

  it("keeps the literal path when neither exists", async () => {
    await expect(open(statsFrom({}))).resolves.toBe(`${LITERAL}:12:3`);
  });

  it("keeps the literal path when the stat fails", async () => {
    await expect(
      open(async () => {
        throw new Error("offline");
      }),
    ).resolves.toBe(`${LITERAL}:12:3`);
    await expect(
      open(() => {
        throw new Error("not connected");
      }),
    ).resolves.toBe(`${LITERAL}:12:3`);
  });

  it("keeps the literal path without a stat function", async () => {
    await expect(open(undefined)).resolves.toBe(`${LITERAL}:12:3`);
  });

  it("never checks absolute links or paths without the prefix", async () => {
    const statPath = statsFrom({});
    await expect(open(statPath, `${LITERAL}:4`, `${LITERAL}:4`)).resolves.toBe(`${LITERAL}:4`);
    await expect(open(statPath, "src/a.ts", "/repo/apps/web/src/a.ts")).resolves.toBe(
      "/repo/apps/web/src/a.ts",
    );
    await expect(
      open(statPath, "apps/web/../a.ts", "/repo/apps/web/apps/web/../a.ts"),
    ).resolves.toBe("/repo/apps/web/apps/web/../a.ts");
    expect(statPath).not.toHaveBeenCalled();
  });

  it("lets the latest click win while a stat is in flight", async () => {
    const slow = deferred<ProjectStatPathKind>();
    const first = open(() => slow.promise);
    const second = resolveMarkdownFileLinkOpenTarget({
      href: "src/Second.ts",
      targetPath: "/repo/apps/web/src/Second.ts",
      cwd: "/repo/apps/web",
      searchEntries: undefined,
    });
    slow.resolve("missing");
    await expect(second).resolves.toBe("/repo/apps/web/src/Second.ts");
    await expect(first).resolves.toBeNull();
  });
});

describe("unverifiedRepeatedPrefixPath", () => {
  it("returns the path as written when it repeats the workspace folder", () => {
    expect(unverifiedRepeatedPrefixPath("apps/web/src/a.ts:4", "/repo/apps/web")).toBe(
      "apps/web/src/a.ts:4",
    );
  });

  it.each([
    ["src/a.ts", "/repo/apps/web"],
    ["../web/src/a.ts", "/repo/apps/web"],
    ["/repo/apps/web/src/a.ts", "/repo/apps/web"],
    ["a.ts", "/repo/apps/web"],
    ["apps/web/src/a.ts", undefined],
  ])("returns null for %s in %s", (href, cwd) => {
    expect(unverifiedRepeatedPrefixPath(href, cwd)).toBeNull();
  });
});
