import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

import { remarkKeepAutolinkSuffixes } from "./markdown-autolink-suffix";
import { remarkGithubAlerts } from "./markdown-github-alerts";
import { remarkNormalizeListItemIndentation } from "./markdown-list-indentation";
import { collectMessageFileChipPaths, splitMarkdownBlocks } from "./markdown-stream-blocks";
import { remarkKeepWindowsPaths } from "./markdown-windows-paths";

// Whitespace between top-level blocks collapses in the rendered message.
const html = (source: string) =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        remarkKeepAutolinkSuffixes,
        remarkKeepWindowsPaths,
        remarkGithubAlerts,
        remarkNormalizeListItemIndentation,
      ]}
    >
      {source}
    </ReactMarkdown>,
  )
    .replace(/>\s+</g, "><")
    .trim();

describe("splitMarkdownBlocks", () => {
  it.each([
    "# Title\n\nFirst paragraph with `code` and **bold**.\n\nSecond [link](https://example.com).",
    "- one\n- two\n\n- loose three\n\n  continued\n\nAfter the list.",
    "1. first\n\n2. second\n\nText\n\n3) restarted",
    "```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nafter\n\n~~~\nx\n\n~~~~\n\ny\n~~~\n\nend",
    "> quote\n\n> another quote\n\n> [!NOTE]\n> alert",
    "| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter the table.",
    "para\n\n    indented code\n\nnext",
    "Setext\n===\n\nnext\n---\n\n- [ ] task\n- [x] done",
    "- a\n\n  ```\n  x\n\n```\n\nb",
    "- a\n\n  ```\n  x\n\ny\n\n  ```\n\nb",
    "1. ```sh\n   x\n\n   ```\n\n```\ny\n\nz\n```\n\nb",
    "- ```\n  a\n\n  b\n  ```\n\nafter",
    "```a``` inline\n\n```\nx\n\ny\n```\n\nend",
  ])("renders each block as the whole text renders it, at every streamed prefix: %j", (text) => {
    for (let end = 0; end <= text.length; end++) {
      const source = text.slice(0, end);
      const blocks = splitMarkdownBlocks(source);
      expect(blocks?.join("")).toBe(source);
      expect(blocks!.map(html).join("")).toBe(html(source));
    }
  });

  it("splits only between closed blocks", () => {
    expect(splitMarkdownBlocks("a\n\n```\nb\n\nc\n```\n\n- d\n\n- e\n\nf")).toEqual([
      "a\n\n",
      "```\nb\n\nc\n```\n\n- d\n\n- e\n\n",
      "f",
    ]);
  });

  it.each([
    "[ref]\n\n[ref]: /later",
    "a[^x]\n\n[^x]: note",
    "<details>\n\nbody\n\n</details>",
    "Open <details>\n\nbody\n\nmore </details>",
    ":::note\n\ncontent\n\n:::",
    "$$\na\n\nb\n$$",
    "a\r\n\r\nb",
  ])("keeps text with document-wide syntax whole: %j", (text) => {
    expect(splitMarkdownBlocks(text)).toBeNull();
  });
});

describe("collectMessageFileChipPaths", () => {
  it("finds the files a message's links and inline code name", () => {
    expect(
      collectMessageFileChipPaths(
        "See [a](apps/web/index.ts:3), [b](<docs/My File.md>) and `apps/server/index.ts`.\n\n[site](https://example.com) `npm test`",
        "/repo",
      ),
    ).toEqual(["/repo/apps/web/index.ts", "/repo/docs/My File.md", "/repo/apps/server/index.ts"]);
  });

  it("skips fenced code and inline code in link labels, as the parsed message does", () => {
    expect(
      collectMessageFileChipPaths(
        "See `src/a/index.ts` and [`lib/x.ts`](src/b/index.ts).\n\n```sh\ncat `lib/b/index.ts` [c](lib/c.ts)\n```\n\n- ```\n  `lib/d.ts`\n  ```",
        "/repo",
      ),
    ).toEqual(["/repo/src/b/index.ts", "/repo/src/a/index.ts"]);
  });
});
