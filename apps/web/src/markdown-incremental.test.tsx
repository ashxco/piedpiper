import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

import { remarkCodexDirectives } from "@piedpiper/shared/codexMarkdownDirectives";

import { createIncrementalMarkdownPlugin } from "./markdown-incremental";

type RemarkPlugin = Extract<
  NonNullable<Options["remarkPlugins"]>[number],
  (...args: never[]) => unknown
>;

function render(
  source: string,
  incremental?: RemarkPlugin,
  parsedSources?: string[],
  extraPlugins: NonNullable<Options["remarkPlugins"]> = [],
) {
  let tree: unknown;
  const observeParsing: RemarkPlugin = function () {
    const original = this.parser;
    if (original) {
      this.parser = (text, file) => {
        parsedSources?.push(text);
        return original(text, file);
      };
    }
  };
  const capture: RemarkPlugin = () => (root: unknown) => {
    tree = structuredClone(root);
  };
  const html = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        observeParsing,
        ...extraPlugins,
        capture,
        remarkGfm,
        ...(incremental ? [incremental] : []),
      ]}
    >
      {source}
    </ReactMarkdown>,
  );
  return { html, tree };
}

const prefix = "# Before\n\n```ts\nconst values = [1, 2];\n```\n\n";

describe("incremental Markdown parsing", () => {
  it("parses only the suffix after a closed fence once the prefix is cached", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const first = prefix + "streaming";
    expect(render(first, incremental)).toEqual(render(first));

    const parsedSources: string[] = [];
    const next = first + " more text";
    expect(render(next, incremental, parsedSources)).toEqual(render(next));
    expect(parsedSources).toEqual(["streaming more text"]);
  });

  it.each([
    "a\n===\n\nb\n---\n",
    "- first\n\n  continued\n\n- next\n",
    "> quoted\n>\n> ```js\n> abc\n> ```\n\nend",
    "<div>\nhello\n\n</div>\n\nend",
    "[ref]\n\n[ref]: /later",
    "a[^x]\n\n[^x]: note",
    "a | b\n--|--\na | b\n",
    "```\na\n```\n\nnext\n\n~~~\nb\n~~~\n\nmore",
    "\n\n\tcode\n\nmore",
    "text <https://example.com> *bold*",
    "- [ ] task\n- [x] done",
    "﻿text after a byte-order mark",
  ])("preserves the parse tree, positions, and HTML while streaming %j", (tail) => {
    const source = prefix + tail;
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental), `prefix ${end}`).toEqual(render(text));
    }
  });

  it.each(["\r\n", "\r"])("preserves partial %j line endings", (newline) => {
    const source = (prefix + "next\n\n```\nlast\n```\n\nend").replaceAll("\n", newline);
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental)).toEqual(render(text));
    }
  });

  it("updates earlier references when definitions arrive after the cached prefix", () => {
    const before = "[later] and footnote[^note]\n\n" + prefix;
    const incremental = createIncrementalMarkdownPlugin();
    for (const tail of ["text", "[later]: /target", "[later]: /target\n\n[^note]: a note"]) {
      expect(render(before + tail, incremental)).toEqual(render(before + tail));
    }
  });

  it("handles edits, replacements, and repeated renders", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const documents = [
      prefix + "- first\n - second",
      prefix + "plain text",
      "replacement without fences",
      prefix.replace("Before", "Edited") + "edited prefix",
      prefix + "plain text",
      prefix + "plain text",
    ];
    for (const document of documents) {
      expect(render(document, incremental)).toEqual(render(document));
    }
  });

  it("does not freeze unclosed, nested, indented, or mismatched fences", () => {
    const prefixes = [
      "```\nopen\n\n",
      "````\n```\n\n",
      "> ```\n> code\n> ```\n\n",
      "- ```\n  code\n  ```\n\n",
      "    ```\n    code\n    ```\n\n",
      "<script>\n```\ncode\n```\n\n",
    ];
    for (const start of prefixes) {
      const incremental = createIncrementalMarkdownPlugin();
      for (const tail of ["", "text", "\n```\n", "\n```\n\nnext"]) {
        expect(render(start + tail, incremental)).toEqual(render(start + tail));
      }
    }
  });

  it("streams Codex directives to the same tree as a full parse", () => {
    const source =
      prefix +
      'See :codex-file-citation{path="src/a.ts" line_range_start="3"} and :codex-followup[Add tests]{prompt="Add tests"}.\n\n```\ncode\n```\n\n' +
      ':codex-file-citation{purpose="x"} stays literal';
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(
        render(text, incremental, undefined, [remarkCodexDirectives]),
        `prefix ${end}`,
      ).toEqual(render(text, undefined, undefined, [remarkCodexDirectives]));
    }
    const { html } = render(source, undefined, undefined, [remarkCodexDirectives]);
    expect(html).toContain('<a href="src/a.ts#L3">a.ts</a>');
    expect(html).toContain("<span>Add tests</span>");
    expect(html).toContain(":codex-file-citation{purpose=&quot;x&quot;} stays literal");
  });
});
