import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

import { remarkKeepAutolinkSuffixes } from "./markdown-autolink-suffix";
import { createIncrementalMarkdownPlugin } from "./markdown-incremental";
import { remarkNormalizeListItemIndentation } from "./markdown-list-indentation";

type RemarkPlugin = Extract<
  NonNullable<Options["remarkPlugins"]>[number],
  (...args: never[]) => unknown
>;

function renderMarkdown(markdown: string, incremental?: RemarkPlugin, parsedSources?: string[]) {
  const observeParsing: RemarkPlugin = function () {
    const original = this.parser;
    if (original) {
      this.parser = (text, file) => {
        parsedSources?.push(text);
        return original(text, file);
      };
    }
  };
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        observeParsing,
        remarkGfm,
        remarkNormalizeListItemIndentation,
        ...(incremental ? [incremental] : []),
      ]}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe("remarkNormalizeListItemIndentation", () => {
  it("renders same-line over-indented list content as list text", () => {
    const html = renderMarkdown(`why did you do this?

-       for (const step of rest.steps) {
-           if (step.request.body) {
-               step.request.body = "<redacted>";
-           }
-       }`);

    expect(html).not.toContain("<pre>");
    expect(html).toContain("<li>for (const step of rest.steps) {</li>");
    expect(html).toContain("<li>if (step.request.body) {</li>");
    expect(html).toContain("<li>step.request.body = &quot;&lt;redacted&gt;&quot;;</li>");
  });

  it("parses inline markdown in recovered list content", () => {
    const html = renderMarkdown(
      "-       **important** [docs](https://example.com) use `inline code`, not ~~plain text~~",
    );

    expect(html).toContain("<strong>important</strong>");
    expect(html).toContain('<a href="https://example.com">docs</a>');
    expect(html).toContain("<code>inline code</code>");
    expect(html).toContain("<del>plain text</del>");
    expect(html).not.toContain("**important**");
  });

  it("preserves every recovered block separated by blank lines", () => {
    const html = renderMarkdown(`-       **first block**

        [second block](https://example.com)`);

    expect(html).toContain("<strong>first block</strong>");
    expect(html).toContain('<a href="https://example.com">second block</a>');
  });

  it("recursively normalizes lists in recovered tail blocks", () => {
    const html = renderMarkdown(`-       first block

        -       nested block`);

    expect(html).not.toContain("<pre>");
    expect(html).toContain("<li>nested block</li>");
  });

  it("preserves fenced code blocks within list items", () => {
    const html = renderMarkdown(`- \`\`\`ts
  const value = 1;
  \`\`\``);

    expect(html).toContain('<pre><code class="language-ts">const value = 1;');
  });

  it("preserves indented code blocks that start below a list marker", () => {
    const html = renderMarkdown(`-
      const value = 1;`);

    expect(html).toContain("<pre><code>const value = 1;");
  });

  it("preserves same-line code blocks without excess indentation", () => {
    const html = renderMarkdown("-     const value = 1;");

    expect(html).toContain("<pre><code>const value = 1;");
  });

  it("drops recovered positions, so later plugins never slice the message with them", () => {
    const positions: Array<{ type: string; start: number | undefined }> = [];
    const collectPositions: RemarkPlugin = () => (tree) => {
      const walk = (node: {
        type: string;
        position?: { start: { offset?: number } };
        children?: unknown[];
      }) => {
        if (node.type !== "root" && node.type !== "list" && node.type !== "listItem") {
          positions.push({ type: node.type, start: node.position?.start.offset });
        }
        for (const child of node.children ?? []) walk(child as typeof node);
      };
      walk(tree as Parameters<typeof walk>[0]);
    };
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          remarkNormalizeListItemIndentation,
          remarkKeepAutolinkSuffixes,
          collectPositions,
        ]}
      >
        {"-       see https://x.com/name_\n\n        tail"}
      </ReactMarkdown>,
    );

    expect(html).toContain('<a href="https://x.com/name_">https://x.com/name_</a>');
    // The first recovered block keeps the code node's place in the message; nothing inside does.
    expect(positions[0]).toEqual({ type: "paragraph", start: 2 });
    expect(positions.length).toBeGreaterThan(3);
    expect(positions.slice(1).every((entry) => entry.start === undefined)).toBe(true);
  });

  it("matches a full parse while streaming over-indented lists that contain a fence", () => {
    const source =
      "# Before\n\n```ts\nconst values = [1, 2];\n```\n\n" +
      "-       first block\n\n        ```ts\n        const nested = 1;\n        ```\n\n        tail";
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(renderMarkdown(text, incremental), `prefix ${end}`).toBe(renderMarkdown(text));
    }

    const parsedSources: string[] = [];
    const next = `${source} more`;
    expect(renderMarkdown(next, incremental, parsedSources)).toBe(renderMarkdown(next));
    // The recovery parse must not reset the document cache, so the full text is never reparsed.
    expect(parsedSources).not.toContain(next);
    expect(parsedSources.some((text) => text.startsWith("piedpiper-markdown-inline-prefix:"))).toBe(
      true,
    );
  });
});
