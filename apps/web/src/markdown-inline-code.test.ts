import { describe, expect, it } from "vitest";

import {
  INLINE_CODE_LINK_PROPERTY,
  remarkInlineCode,
  resolveInlineCodeFileHref,
} from "./markdown-inline-code";

const CWD = "/Users/julius/project";

describe("resolveInlineCodeFileHref", () => {
  it.each([
    [".plans/worktree-management-v1.md", ".plans/worktree-management-v1.md"],
    ["src/processRunner.ts:71", "src/processRunner.ts:71"],
    ["script.ts:10", "script.ts:10"],
    ["model.pt:3", "model.pt:3"],
    ["/Users/julius/project/AGENTS.md", "/Users/julius/project/AGENTS.md"],
    ["/usr/local/bin/tool", "/usr/local/bin/tool"],
    ["./scripts/deploy", "./scripts/deploy"],
    ["src\\main.ts", "src/main.ts"],
    ["Makefile:12", `${CWD}/Makefile:12`],
    ["Dockerfile:8:2", `${CWD}/Dockerfile:8:2`],
  ])("links %s", (code, href) => {
    expect(resolveInlineCodeFileHref(code, CWD)).toBe(href);
  });

  it.each([
    "AGENTS.md",
    "error:1",
    "TODO:12",
    "exit:0",
    "port:3000",
    "http:80",
    "10.0.0.1:80:1",
    "src/**/*.ts",
    "pnpm install",
    "/chat/settings",
    "https://example.com/docs.html",
  ])("does not link %s", (code) => {
    expect(resolveInlineCodeFileHref(code, CWD)).toBeNull();
  });

  it("needs a cwd for relative paths and extensionless names", () => {
    expect(resolveInlineCodeFileHref(".plans/notes.md", undefined)).toBeNull();
    expect(resolveInlineCodeFileHref("Makefile:12", undefined)).toBeNull();
    expect(resolveInlineCodeFileHref("C:\\repo\\main.ts", undefined)).toBe("C:\\repo\\main.ts");
  });
});

interface Node {
  type: string;
  url?: string;
  value?: string;
  children?: Node[];
  data?: { hProperties?: Record<string, unknown> };
}

function paragraph(...children: Node[]): Node {
  return { type: "root", children: [{ type: "paragraph", children }] };
}

describe("remarkInlineCode", () => {
  it("wraps file-path inline code in a link and tags every inline code span", () => {
    const tree = paragraph(
      { type: "inlineCode", value: "src/app.ts:4" },
      { type: "text", value: " and " },
      { type: "inlineCode", value: "npm test" },
    );
    remarkInlineCode({ cwd: CWD })(tree);
    const [link, , plain] = tree.children![0]!.children!;
    expect(link).toMatchObject({
      type: "link",
      url: "src/app.ts:4",
      data: { hProperties: { [INLINE_CODE_LINK_PROPERTY]: "src/app.ts:4" } },
      children: [{ type: "inlineCode", data: { hProperties: { "data-inline-code": "true" } } }],
    });
    expect(plain).toMatchObject({
      type: "inlineCode",
      data: { hProperties: { "data-inline-code": "true" } },
    });
  });

  it("leaves inline code inside link labels alone", () => {
    const tree = paragraph({
      type: "link",
      url: "https://example.com",
      children: [{ type: "inlineCode", value: "src/app.ts" }],
    });
    remarkInlineCode({ cwd: CWD })(tree);
    expect(tree.children![0]!.children![0]!.children![0]!.type).toBe("inlineCode");
  });
});
