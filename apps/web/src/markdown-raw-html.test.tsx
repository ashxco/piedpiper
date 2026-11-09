import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { describe, expect, it, vi } from "vitest";

import { extractPreCodeMeta } from "./markdown-code-fence";
import { remarkMarkdownFileChips } from "./markdown-file-chip";
import { remarkGithubAlerts } from "./markdown-github-alerts";
import { remarkInlineCode } from "./markdown-inline-code";
import {
  CHAT_MARKDOWN_RAW_HTML_REHYPE_PLUGINS,
  escapeDisallowedRawHtml,
  needsHtmlParser,
  rehypeChatRawHtml,
  rehypeLiteralRawHtml,
  stripAllowedRawHtml,
} from "./markdown-raw-html";

const html = (markdown: string, components?: Components) =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        remarkGithubAlerts,
        [remarkMath, { singleDollarTextMath: false }],
        [remarkInlineCode, { cwd: "/repo" }],
        [remarkMarkdownFileChips, { cwd: "/repo" }],
      ]}
      rehypePlugins={CHAT_MARKDOWN_RAW_HTML_REHYPE_PLUGINS}
      {...(components ? { components } : {})}
    >
      {markdown}
    </ReactMarkdown>,
  );

describe("escapeDisallowedRawHtml", () => {
  it.each([
    ["<string>"],
    ["<thinking>\nreasoning\n</thinking>"],
    ['<div title="<br>">'],
    ["<script src=x"],
    ["<!-- not closed yet"],
    ["<?php echo 1; ?>"],
    ["<!DOCTYPE html>"],
    ["<foo:bar>"],
  ])("leaves no HTML in %j", (value) => {
    expect(escapeDisallowedRawHtml(value)).toBeNull();
  });

  it("keeps allowed tags, removes comments and escapes the rest of the same block", () => {
    expect(escapeDisallowedRawHtml('<details open>\n<Foo a="<br>">\n<!-- x -->\n</details>')).toBe(
      '<details open>\n&lt;Foo a="&lt;br>">\n\n</details>',
    );
  });

  it("removes a comment-only node rather than showing it as text", () => {
    expect(escapeDisallowedRawHtml("<!-- x -->")).toBe("");
  });

  it("matches tag names in any case", () => {
    expect(escapeDisallowedRawHtml("<BR/>")).toBe("<BR/>");
  });
});

describe("stripAllowedRawHtml", () => {
  it.each([
    ["Press <kbd>Ctrl</kbd>+<kbd>C</kbd> now", "Press Ctrl+C now"],
    ["<details> <summary>Build log</summary>", " Build log"],
    ["</details>", ""],
    ["a<!-- hidden -->b", "ab"],
    ['x <img src="a.png" alt="y"> z', "x  z"],
    ["one<br/>two", "one\ntwo"],
    ["An Array<string> value", "An Array<string> value"],
    ["1 < 2 <!-- open", "1 < 2 <!-- open"],
  ])("paints %j as %j", (value, expected) => {
    expect(stripAllowedRawHtml(value)).toBe(expected);
  });
});

describe("chat raw HTML rendering", () => {
  it("renders a line break inside a table cell", () => {
    expect(html("| a |\n| - |\n| x<br>y |")).toContain("<td>x<br/>y</td>");
  });

  it("renders the allowed inline tags", () => {
    const output = html("Press <kbd>Cmd</kbd>, H<sub>2</sub>O, x<sup>2</sup>, <mark>hi</mark>.");
    expect(output).toContain("<kbd>Cmd</kbd>");
    expect(output).toContain("<sub>2</sub>");
    expect(output).toContain("<sup>2</sup>");
    expect(output).toContain("<mark>hi</mark>");
  });

  it("keeps an image's size and strips its handlers", () => {
    const output = html(
      '<img src="https://x.test/a.png" width="20" height="10" onerror="alert(1)">',
    );
    expect(output).toContain('src="https://x.test/a.png"');
    expect(output).toContain('width="20"');
    expect(output).toContain('height="10"');
    expect(output).not.toContain("onerror");
  });

  it.each([
    ["script", "<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ["style", "x <style>a{}</style>", "&lt;style&gt;"],
    ["iframe", '<iframe src="https://x.test"></iframe>', "&lt;iframe"],
    ["link", '<a href="javascript:alert(1)">x</a>', "&lt;a href="],
  ])("shows a %s tag as text", (_name, markdown, expected) => {
    const output = html(markdown);
    expect(output).toContain(expected);
    expect(output).not.toMatch(/<(?:script|style|iframe|a)\b/);
  });

  it("drops script URLs and unsafe attributes from allowed tags", () => {
    expect(html('<img src="javascript:alert(1)">')).not.toContain("javascript:");
    expect(html('[x](javascript:alert(1)) <kbd onclick="a()" style="x" id="y">k</kbd>')).toBe(
      '<p><a href="">x</a> <kbd>k</kbd></p>',
    );
  });

  it("does not let raw HTML clobber names", () => {
    const output = html('<img src="a.png" id="location" name="cookie" srcset="b.png 2x">');
    expect(output).not.toMatch(/\b(?:id|name|srcset|srcSet)=/);
  });

  it("keeps generic-looking text readable", () => {
    expect(html("An Array<string> value")).toBe("<p>An Array&lt;string&gt; value</p>");
    expect(html("<thinking>\nhmm\n</thinking>")).toBe(
      "<p>&lt;thinking&gt;\nhmm\n&lt;/thinking&gt;</p>",
    );
  });

  it("hides a closed comment", () => {
    expect(html("a\n\n<!-- hidden -->\n\nb")).not.toContain("hidden");
  });

  // The parser ends a comment early at these, so a comment handed to it would let tags through.
  it.each([
    ['<!--><a id="nativeApi" href="https://evil.example">x</a>-->'],
    ['<!---><a id="nativeApi" href="https://evil.example">x</a>-->'],
    ['<!-- x --!><a id="nativeApi" href="https://evil.example">x</a>-->'],
    ['<!--><h2 id="desktopBridge">x</h2>-->'],
    ['<!--><li id="x">x</li>-->'],
    ['<!--><input type="checkbox"><table><tr><td>x</td></tr></table>-->'],
    ['<!--><blockquote data-alert="constructor">boom</blockquote>-->'],
    ['a\n\n<!--><a data-inline-code-link="src/a.ts" href="https://evil.example">x</a>-->'],
  ])("lets no element out of the comment %j", (markdown) => {
    expect(html(markdown)).not.toMatch(/<(?:a|h2|li|input|table|blockquote)\b/);
  });

  it("leaves an abrupt comment with no closer as text", () => {
    const output = html('<!--><a id="x" href="https://evil.example">x</a>');
    expect(output).toContain("&lt;!--&gt;");
    expect(output).not.toMatch(/<a\b/);
  });

  it("drops an alert kind nothing draws", () => {
    const output = (value: string) =>
      renderToStaticMarkup(
        <ReactMarkdown
          rehypePlugins={[
            () => (tree: { children: { properties?: Record<string, unknown> }[] }) => {
              tree.children[0]!.properties = { dataAlert: value };
            },
            ...CHAT_MARKDOWN_RAW_HTML_REHYPE_PLUGINS,
          ]}
        >
          {"> quote"}
        </ReactMarkdown>,
      );
    expect(output("warning")).toContain('data-alert="warning"');
    expect(output("constructor")).not.toContain("data-alert");
  });

  it("closes an unclosed details at the end of the stream", () => {
    expect(html("<details><summary>More</summary>\n\nbody")).toContain(
      "<details><summary>More</summary>",
    );
  });

  it("keeps details open only when asked", () => {
    expect(html("<details open>\n\nbody\n\n</details>")).toContain("<details open");
    expect(html("<details>\n\nbody\n\n</details>")).not.toContain("open");
  });

  // Each case has raw HTML, so the tree also goes through the parser, which respells properties.
  describe.each([
    ["without raw HTML", ""],
    ["with raw HTML", "\n\nx<br>y"],
  ])("plugin properties %s", (_name, suffix) => {
    it("keeps inline-code and file-chip markers", () => {
      const output = html(`See \`src/a.ts\`, \`npm test\` and [a](src/a.ts).${suffix}`);
      expect(output).toContain('data-inline-code-link="src/a.ts"');
      expect(output).toContain('data-file-chip-suffix=""');
      expect(output).toContain('<code data-inline-code="true">npm test</code>');
    });

    it("keeps fence languages, math classes, task lists and alerts", () => {
      const output = html(
        `\`\`\`ts\nx\n\`\`\`\n\n$$a$$ and\n\n- [x] done\n\n> [!NOTE]\n> body${suffix}`,
      );
      expect(output).toContain('class="language-ts"');
      expect(output).toContain('class="language-math math-inline"');
      expect(output).toContain('type="checkbox"');
      expect(output).toContain('class="task-list-item"');
      expect(output).toContain('data-alert="note"');
    });

    it("keeps local hrefs for the URL transform to judge", () => {
      const seen: string[] = [];
      renderToStaticMarkup(
        <ReactMarkdown
          rehypePlugins={CHAT_MARKDOWN_RAW_HTML_REHYPE_PLUGINS}
          urlTransform={(url) => {
            seen.push(url);
            return url;
          }}
        >
          {`[a](name.ts:12) [b](<C:\\x\\y.ts>) [c](file:///x/y.ts) ![d](<C:\\x\\y.png>)${suffix}`}
        </ReactMarkdown>,
      );
      expect(seen).toEqual(["name.ts:12", "C:%5Cx%5Cy.ts", "file:///x/y.ts", "C:%5Cx%5Cy.png"]);
    });

    it("links footnotes to ids that exist", () => {
      const output = html(`Note[^1]\n\n[^1]: body${suffix}`);
      const href = /href="#([^"]+)"[^>]*data-footnote-ref/.exec(output)?.[1];
      expect(href).toBe("user-content-fn-1");
      expect(output).toContain(`id="${href}"`);
      expect(output).toContain('id="user-content-fnref-1"');
      expect(output).toContain('href="#user-content-fnref-1"');
      expect(output).toContain('id="footnote-label"');
      expect(output).toContain('aria-describedby="footnote-label"');
    });

    it("gives a code block its source position and fence meta", () => {
      const pre = vi.fn();
      const source = `\`\`\`sh title="a.sh"\nls\n\`\`\`${suffix}`;
      html(source, {
        pre({ node }) {
          pre(node?.position?.start.offset, node?.position?.end.offset, extractPreCodeMeta(node));
          return null;
        },
      });
      expect(pre).toHaveBeenCalledWith(0, '```sh title="a.sh"\nls\n```'.length, 'title="a.sh"');
    });
  });
});

const text = (value: string) => ({ type: "text", value });

const raw = (value: string) => ({ type: "raw", value });

const root = (...children: { type: string }[]) => ({ type: "root", children });

describe("rehypeChatRawHtml", () => {
  it("detects raw nodes at any depth", () => {
    expect(needsHtmlParser(root(text("a")))).toBe(false);
    expect(needsHtmlParser(root({ type: "element", children: [raw("<br>")] } as never))).toBe(true);
  });

  it("skips the parser when nothing is left as HTML", () => {
    const tree = root({ type: "element", tagName: "p", children: [raw("<string>")] } as never);
    expect(rehypeChatRawHtml()(tree, undefined)).toBeUndefined();
    expect((tree.children[0] as never as { children: unknown[] }).children).toEqual([
      text("<string>"),
    ]);
  });

  it("parses when an allowed tag remains", () => {
    const parsed = rehypeChatRawHtml()(root(raw("<br>")), undefined);
    expect(parsed?.children?.[0]).toMatchObject({ type: "element", tagName: "br" });
  });
});

describe("rehypeLiteralRawHtml", () => {
  const literalHtml = (markdown: string) =>
    renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeLiteralRawHtml]}>
        {markdown}
      </ReactMarkdown>,
    );

  it("wraps a top-level block in a paragraph and keeps its lines", () => {
    expect(literalHtml("<thinking>\nfoo\n</thinking>")).toBe(
      "<p>&lt;thinking&gt;<br/>foo<br/>&lt;/thinking&gt;</p>",
    );
  });

  it("keeps blank lines and CRLF line endings", () => {
    expect(literalHtml("<!-- a\r\n\r\nb -->")).toBe("<p>&lt;!-- a<br/><br/>b --&gt;</p>");
  });

  it("leaves inline tags in their own paragraph", () => {
    expect(literalHtml("Use Array<string> here")).toBe("<p>Use Array&lt;string&gt; here</p>");
  });

  it.each([
    ["<br>", "<p>&lt;br&gt;</p>"],
    ["<details open>", "<p>&lt;details open&gt;</p>"],
    ['<img src="x" onerror="y">', "<p>&lt;img src=&quot;x&quot; onerror=&quot;y&quot;&gt;</p>"],
    ["<script>alert(1)</script>", "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"],
  ])("allows no tag as HTML in %j", (markdown, expected) => {
    expect(literalHtml(markdown)).toBe(expected);
  });

  it("does not add a paragraph inside a list item", () => {
    expect(literalHtml("- <b>one</b>")).toContain("<li>&lt;b&gt;one&lt;/b&gt;</li>");
  });
});
