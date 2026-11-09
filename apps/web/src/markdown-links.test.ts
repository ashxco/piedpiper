import { describe, expect, it } from "vitest";

import {
  githubHeadingSlugs,
  inlineCodeFilePathCandidate,
  isLocalFileMarkdownHref,
  isMarkdownFragmentHref,
  isWindowsAbsolutePath,
  isNetworkPath,
  resolveMarkdownBareFileName,
  resolveMarkdownFileLinkTarget,
  resolveMarkdownRelativeFilePath,
  markdownWebLinkProminentHost,
  resolveMarkdownWebLinkDestination,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";

describe("isMarkdownFragmentHref", () => {
  it("accepts only hrefs that start with a fragment", () => {
    expect(isMarkdownFragmentHref("#setup")).toBe(true);
    expect(isMarkdownFragmentHref(" #setup")).toBe(true);
    expect(isMarkdownFragmentHref("https://example.com/#setup")).toBe(false);
    expect(isMarkdownFragmentHref("src/a.ts#L1")).toBe(false);
    expect(isMarkdownFragmentHref(undefined)).toBe(false);
  });
});

describe("githubHeadingSlugs", () => {
  it("drops punctuation, keeps unicode letters and hyphens, and joins words", () => {
    expect(githubHeadingSlugs(["What's New?", "  Déjà vu: part-2 ", "snake_case & more"])).toEqual([
      "whats-new",
      "déjà-vu-part-2",
      "snake_case--more",
    ]);
  });

  it("suffixes repeats and never lands on a slug already taken", () => {
    expect(githubHeadingSlugs(["Setup", "Setup", "Setup-1", "Setup"])).toEqual([
      "setup",
      "setup-1",
      "setup-1-1",
      "setup-2",
    ]);
  });
});

describe("resolveMarkdownWebLinkDestination", () => {
  const base = "http://localhost:3000/thread";

  it("returns the normalized absolute URL with a lookalike host in punycode", () => {
    expect(resolveMarkdownWebLinkDestination("https://example.com", base)).toBe(
      "https://example.com/",
    );
    expect(resolveMarkdownWebLinkDestination("https://\u0430pple.com/login", base)).toBe(
      "https://xn--pple-43d.com/login",
    );
    expect(resolveMarkdownWebLinkDestination("https://%D0%B0pple.com/login", base)).toBe(
      "https://xn--pple-43d.com/login",
    );
    expect(resolveMarkdownWebLinkDestination("https://good.test@evil.test/", base)).toBe(
      "https://good.test@evil.test/",
    );
  });

  it("resolves relative links against the page and rejects other schemes", () => {
    expect(resolveMarkdownWebLinkDestination("/docs", base)).toBe("http://localhost:3000/docs");
    expect(resolveMarkdownWebLinkDestination("//evil.test/x", base)).toBe("http://evil.test/x");
    expect(resolveMarkdownWebLinkDestination("/docs", "piedpiper://app/")).toBeNull();
    expect(resolveMarkdownWebLinkDestination("mailto:me@example.com", base)).toBeNull();
    expect(resolveMarkdownWebLinkDestination(undefined, base)).toBeNull();
    expect(resolveMarkdownWebLinkDestination("https://", base)).toBeNull();
  });
});

describe("markdownWebLinkProminentHost", () => {
  it("leaves a plain URL, whose start already shows its host", () => {
    expect(markdownWebLinkProminentHost("https://example.com/a?b=1")).toBeNull();
    expect(markdownWebLinkProminentHost(`https://example.com/${"a".repeat(2000)}`)).toBeNull();
  });

  it("names the real host when userinfo comes first", () => {
    expect(markdownWebLinkProminentHost("https://good.test@evil.test/")).toBe("evil.test");
    expect(markdownWebLinkProminentHost("https://:secret@evil.test:8080/")).toBe("evil.test:8080");
    expect(
      markdownWebLinkProminentHost(
        new URL(`https://accounts.google.com.${"a".repeat(800)}@evil.test/x`).href,
      ),
    ).toBe("evil.test");
  });

  it("names a host too long to be a real one", () => {
    const host = `accounts.google.com.${"a.".repeat(300)}evil.test`;
    expect(markdownWebLinkProminentHost(`https://${host}/`)).toBe(host);
  });
});

describe("rewriteMarkdownFileUriHref", () => {
  it("rewrites file uri hrefs into direct path hrefs", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/src/main.ts#L42")).toBe(
      "/Users/julius/project/src/main.ts#L42",
    );
    expect(rewriteMarkdownFileUriHref("file:///C:/repo/app.ts")).toBe("C:/repo/app.ts");
  });

  it("preserves encoded octets so file paths are decoded only once later", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%2520name.md",
    );
  });

  it("keeps a file uri host as a network path", () => {
    expect(rewriteMarkdownFileUriHref("file://attacker.test/share/x.md")).toBe(
      "//attacker.test/share/x.md",
    );
    expect(rewriteMarkdownFileUriHref("file://localhost/home/me/notes.md")).toBe(
      "/home/me/notes.md",
    );
  });

  it("ignores non-file hrefs", () => {
    expect(rewriteMarkdownFileUriHref("https://example.com/a.ts")).toBeNull();
    expect(rewriteMarkdownFileUriHref("/Users/julius/a.ts")).toBeNull();
  });
});

describe("isLocalFileMarkdownHref", () => {
  it("detects file uris and Windows drive paths, including encoded backslashes", () => {
    expect(isLocalFileMarkdownHref("file:///Users/julius/a.ts")).toBe(true);
    expect(isLocalFileMarkdownHref("C:/repo/app.ts")).toBe(true);
    expect(isLocalFileMarkdownHref("C:%5Crepo%5Capp.ts")).toBe(true);
  });

  it("keeps UNC shares away from the web-link path, but not scheme-relative web links", () => {
    expect(isLocalFileMarkdownHref("\\\\attacker.test\\share\\x.md")).toBe(true);
    expect(isLocalFileMarkdownHref("\\/attacker.test/x.md")).toBe(true);
    expect(isLocalFileMarkdownHref("%5C%5Cattacker.test%5Cshare%5Cx.md")).toBe(true);
    expect(isLocalFileMarkdownHref("//example.com/page")).toBe(false);
  });

  it("keeps relative file hrefs with a line suffix, whose name reads as a scheme", () => {
    expect(isLocalFileMarkdownHref("ChatView.tsx:42")).toBe(true);
    expect(isLocalFileMarkdownHref("src/main.ts:4:2")).toBe(true);
    expect(isLocalFileMarkdownHref("mailto:me@example.com")).toBe(false);
    expect(isLocalFileMarkdownHref("tel:12345")).toBe(false);
  });

  it.each(["127.0.0.1:8080", "example.com:8080", "localhost:3000", "$HOME/.zshrc:3"])(
    "leaves the host or variable href %s to the default sanitizer",
    (href) => {
      expect(isLocalFileMarkdownHref(href)).toBe(false);
    },
  );

  it("leaves other hrefs to the default sanitizer", () => {
    expect(isLocalFileMarkdownHref("https://example.com")).toBe(false);
    expect(isLocalFileMarkdownHref("javascript:alert(1)")).toBe(false);
    expect(isLocalFileMarkdownHref("d:alert(1)")).toBe(false);
    expect(isLocalFileMarkdownHref("/Users/julius/a.ts")).toBe(false);
  });
});

describe("resolveMarkdownRelativeFilePath", () => {
  it("returns a relative link's path and position as written", () => {
    expect(resolveMarkdownRelativeFilePath("apps/web/src/a.ts:4:2", "/repo")).toEqual({
      path: "apps/web/src/a.ts",
      position: ":4:2",
    });
    expect(resolveMarkdownRelativeFilePath("apps/web/src/a.ts#L7", "/repo")).toEqual({
      path: "apps/web/src/a.ts",
      position: ":7",
    });
  });

  it("ignores absolute and home-relative links", () => {
    for (const href of [
      "/repo/apps/web/a.ts",
      "file:///repo/apps/web/a.ts",
      "C:/repo/apps/web/a.ts",
      "~/apps/web/a.ts",
    ]) {
      expect(resolveMarkdownRelativeFilePath(href, "/repo")).toBeNull();
    }
  });
});

describe("resolveMarkdownBareFileName", () => {
  it("returns the name and position of a bare filename link", () => {
    expect(resolveMarkdownBareFileName("ChatView.tsx", "/repo")).toEqual({
      name: "ChatView.tsx",
      position: "",
    });
    expect(resolveMarkdownBareFileName("ChatView.tsx:42:3", "/repo")).toEqual({
      name: "ChatView.tsx",
      position: ":42:3",
    });
    expect(resolveMarkdownBareFileName("ChatView.tsx#L7", "/repo")).toEqual({
      name: "ChatView.tsx",
      position: ":7",
    });
  });

  it("ignores links that carry a directory", () => {
    expect(resolveMarkdownBareFileName("src/ChatView.tsx", "/repo")).toBeNull();
    expect(resolveMarkdownBareFileName("./ChatView.tsx", "/repo")).toBeNull();
    expect(resolveMarkdownBareFileName("/Users/julius/ChatView.tsx", "/repo")).toBeNull();
    expect(resolveMarkdownBareFileName("https://example.com/a.ts", "/repo")).toBeNull();
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("resolves relative paths and file names containing spaces", () => {
    expect(resolveMarkdownFileLinkTarget("docs/my%20notes.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/docs/my notes.md",
    );
    expect(
      resolveMarkdownFileLinkTarget(
        "Project%20Docs/sub%20dir/a%20b.ts:12",
        "/Users/julius/project",
      ),
    ).toBe("/Users/julius/project/Project Docs/sub dir/a b.ts:12");
    expect(
      resolveMarkdownFileLinkTarget("Updated%20cutover%20checklist.md", "/Users/julius/project"),
    ).toBe("/Users/julius/project/Updated cutover checklist.md");
  });

  it("does not treat leading, trailing or plain prose spaces as file names", () => {
    expect(resolveMarkdownFileLinkTarget("%20notes.md", "/Users/julius/project")).toBeNull();
    expect(resolveMarkdownFileLinkTarget("docs/notes.md%20", "/Users/julius/project")).toBeNull();
    expect(resolveMarkdownFileLinkTarget("some%20words", "/Users/julius/project")).toBeNull();
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });

  it("does not link network paths outside the project", () => {
    // Opening these would send the Windows user's NTLM credentials to attacker.test.
    for (const href of [
      "\\\\attacker.test\\share\\x.md",
      "//attacker.test/share/x.md",
      "/\\attacker.test/share/x.md",
      "file:////attacker.test/share/x.md",
      "%5C%5Cattacker.test%5Cshare%5Cx.md",
    ]) {
      expect(resolveMarkdownFileLinkTarget(href, "/Users/julius/project")).toBeNull();
      expect(resolveMarkdownFileLinkTarget(href)).toBeNull();
    }
  });

  it("links network paths only inside the project's own share", () => {
    const cwd = "\\\\server\\share\\project";
    expect(resolveMarkdownFileLinkTarget("\\\\server\\share\\project\\src\\a.ts", cwd)).toBe(
      "\\\\server\\share\\project\\src\\a.ts",
    );
    expect(resolveMarkdownFileLinkTarget("//SERVER/share/project/src/a.ts", cwd)).toBe(
      "//SERVER/share/project/src/a.ts",
    );
    expect(resolveMarkdownFileLinkTarget("\\\\attacker\\share\\project\\a.ts", cwd)).toBeNull();
    expect(resolveMarkdownFileLinkTarget("\\\\server\\share\\project-other\\a.ts", cwd)).toBeNull();
    expect(
      resolveMarkdownFileLinkTarget("\\\\server\\share\\project\\..\\..\\x\\a.ts", cwd),
    ).toBeNull();
  });

  it("rejects a file uri whose host names a network share", () => {
    expect(
      resolveMarkdownFileLinkTarget("file://attacker.test/share/x.md", "/Users/julius/project"),
    ).toBeNull();
    expect(resolveMarkdownFileLinkTarget("//attacker.test/share/x.md#L1")).toBeNull();
  });

  it("normalizes slash-prefixed Windows drive paths", () => {
    expect(resolveMarkdownFileLinkTarget("/C:/repo/app.ts")).toBe("C:/repo/app.ts");
    expect(resolveMarkdownFileLinkTarget("/C:/repo/app.ts#L4")).toBe("C:/repo/app.ts:4");
    expect(resolveMarkdownFileLinkTarget("file:///C:/repo/app.ts")).toBe("C:/repo/app.ts");
    expect(resolveMarkdownFileLinkTarget("C:%5Crepo%5Capp.ts")).toBe("C:\\repo\\app.ts");
  });

  it.each([
    ["app/routes/posts.$postId.tsx", "/repo/app/routes/posts.$postId.tsx"],
    ["src/routes/+page.svelte", "/repo/src/routes/+page.svelte"],
    ["app/(marketing)/page.tsx:12", "/repo/app/(marketing)/page.tsx:12"],
    ["pages/posts/%5Bid%5D.tsx", "/repo/pages/posts/[id].tsx"],
    ["@scope/package.json", "/repo/@scope/package.json"],
    ["+page.svelte", "/repo/+page.svelte"],
    ["[id].tsx", "/repo/[id].tsx"],
    ["%E7%B7%9A%E6%80%A7/%E8%80%83%E8%A9%A6.pdf", "/repo/線性/考試.pdf"],
    ["résumé.md", "/repo/résumé.md"],
    ["patches/", "/repo/patches/"],
    ["docs/My%20Folder/", "/repo/docs/My Folder/"],
  ])("recognizes %s as a file link", (href, target) => {
    expect(resolveMarkdownFileLinkTarget(href, "/repo")).toBe(target);
  });

  it.each([
    "me@example.com",
    "foo(bar)",
    "$HOME",
    "$HOME/",
    "$HOME/.zshrc",
    "patches",
    "127.0.0.1:8080",
    "example.com:8080",
    "example.com/docs/page.md",
  ])("does not treat %s as a file link", (href) => {
    expect(resolveMarkdownFileLinkTarget(href, "/repo")).toBeNull();
  });

  it("detects network paths with any two leading separators", () => {
    expect(isNetworkPath("\\\\host\\share")).toBe(true);
    expect(isNetworkPath("//host/share")).toBe(true);
    expect(isNetworkPath("/\\host/share")).toBe(true);
    expect(isNetworkPath("/Users/julius")).toBe(false);
    expect(isNetworkPath("C:\\Users")).toBe(false);
  });
});

describe("inlineCodeFilePathCandidate", () => {
  it.each([
    ["src\\main.ts", "src/main.ts"],
    [".\\scripts\\deploy", "./scripts/deploy"],
    ["C:\\Users\\mike\\src\\main.ts", "C:\\Users\\mike\\src\\main.ts"],
    ["allocator.cc:217", "allocator.cc:217"],
    ["script.pl:10", "script.pl:10"],
    ["Makefile:12", "Makefile:12"],
    ["conf.d/nginx.conf", "conf.d/nginx.conf"],
    ["share/man/ls.1", "share/man/ls.1"],
    ["usr/lib/libfoo.so.1", "usr/lib/libfoo.so.1"],
    ["vendor/jquery-3.6.0.min.js", "vendor/jquery-3.6.0.min.js"],
    ["./models/glm-5.3", "./models/glm-5.3"],
    ["./patches/", "./patches/"],
    ["origin/main", null],
    ["apps/web", null],
    ["src/main.ts/", null],
    ["node.meta", null],
    ["AGENTS.md", null],
    ["git worktree list", null],
    ["127.0.0.1:3000", null],
    ["localhost:3000", null],
    ["example.com:8080", null],
    ["example.com/index.html", null],
    ["example.uk/index.html", null],
    ["localhost/index.html", null],
    ["z-ai/glm-5.3", null],
    ["z-ai/glm-5.3:12", null],
    ["python/3.12", null],
    ["Qwen/Qwen2.5-Coder", null],
    ["meta-llama/Llama-3.1-8B", null],
    ["/tmp/claude-1000/...", null],
    ["/tmp/claude-1000/...:12", null],
    ["/tmp/.../scratchpad/notes.md", null],
    ["~/projects/…/notes.md", null],
    ["src/.../main.ts", null],
    ["\\w+\\.json", null],
    ["\\.test\\.ts", null],
    ["\\.config\\app.ts", null],
  ])("reads %s as %s", (source, candidate) => {
    expect(inlineCodeFilePathCandidate(source)).toBe(candidate);
  });
});

describe("isWindowsAbsolutePath", () => {
  it("accepts drive and UNC paths only", () => {
    expect(isWindowsAbsolutePath("C:\\x")).toBe(true);
    expect(isWindowsAbsolutePath("c:/x")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isWindowsAbsolutePath("/usr/x")).toBe(false);
    expect(isWindowsAbsolutePath("C:")).toBe(false);
  });
});

describe("resolveMarkdownFileLinkTarget system roots", () => {
  it("treats standard OS and container roots as files but not app routes", () => {
    expect(resolveMarkdownFileLinkTarget("/usr/local/bin/tool")).toBe("/usr/local/bin/tool");
    expect(resolveMarkdownFileLinkTarget("/workspace/Makefile")).toBe("/workspace/Makefile");
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });
});
