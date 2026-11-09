import { getSharedHighlighter } from "@pierre/diffs";
import DOMPurify from "dompurify";
import { toHtml } from "hast-util-to-html";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  createIncrementalHighlighter,
  highlightCodeToHast,
} from "../../lib/incrementalHighlighting";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { HighlightedCodeLines } from "./HighlightedCodeLines";

const samples = {
  typescript: "/* multi\nline comment */\nconst x = `template\n${1 + 2}`;\n  const re = /abc/;\n",
  python: '#!/usr/bin/python\nx = """multi\nline"""\nprint(x)\n',
  bash: "#!/bin/bash\ncat <<EOF\nhello\nEOF\necho hi\n",
  html: "<script>\nconst x = 1;\n</script>\n<style>\np {color:red;}\n</style>\n",
  markdown: "# heading\n\n```ts\nconst a = 1;\n```\n\ntext\n",
  json: '{\n "value": [1,\n 2, 3]\n}\n',
  css: '/* comment\n continued */\np::before {\n content: "text";\n}\n',
  text: "plain <b>\n  indented\n\n\tlast line",
} as const;

const themes = ["pierre-dark", "pierre-light"] as const;

const highlighterPromise = getSharedHighlighter({
  langs: Object.keys(samples) as Array<keyof typeof samples>,
  themes: [...themes],
  preferredHighlighter: PREFERRED_HIGHLIGHTER,
});

function recordingTokenizer(
  highlighter: Awaited<typeof highlighterPromise>,
  shouldThrow: (chunk: string) => boolean = () => false,
) {
  const chunks: string[] = [];
  const proxy = new Proxy(highlighter, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== "createStreamTokenizer") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: Parameters<typeof highlighter.createStreamTokenizer>) => {
        const tokenizer = highlighter.createStreamTokenizer(...args);
        return new Proxy(tokenizer, {
          get(inner, innerKey) {
            const innerValue = Reflect.get(inner, innerKey);
            if (innerKey !== "enqueue") {
              return typeof innerValue === "function" ? innerValue.bind(inner) : innerValue;
            }
            return (chunk: string) => {
              chunks.push(chunk);
              if (shouldThrow(chunk)) throw new Error(`boom: ${chunk}`);
              return inner.enqueue(chunk);
            };
          },
        });
      };
    },
  });
  return { proxy, chunks };
}

const codeLines = (root: ReturnType<ReturnType<typeof createIncrementalHighlighter>>) => {
  const codeNode = root.children[0].children[0];
  if (codeNode?.type !== "element") throw new Error("Expected a code element");
  return codeNode.children.filter((child) => child.type === "element");
};

describe("createIncrementalHighlighter", () => {
  it.each(Object.entries(samples))(
    "matches full HTML at every streaming prefix in %s",
    async (language, code) => {
      const highlighter = await highlighterPromise;
      for (const theme of themes) {
        const highlight = createIncrementalHighlighter(highlighter, language, theme);
        for (let end = 0; end <= code.length; end++) {
          const text = code.slice(0, end);
          expect(toHtml(highlight(text)), `${theme}, prefix ${end}`).toBe(
            highlighter.codeToHtml(text, { lang: language, theme }),
          );
        }
      }
    },
  );

  it("keeps completed line nodes and enqueues only the new text", async () => {
    const { proxy, chunks } = recordingTokenizer(await highlighterPromise);
    const highlight = createIncrementalHighlighter(proxy, "typescript", "pierre-dark");
    const first = codeLines(highlight("const a = 1;\nconst b"));
    const second = codeLines(highlight("const a = 1;\nconst b = 2;"));
    expect(second[0]).toBe(first[0]);
    expect(chunks).toEqual(["const a = 1;\nconst b", " = 2;"]);
  });

  it("starts over when earlier text changes and uses the full path for text and CR input", async () => {
    const highlighter = await highlighterPromise;
    const highlight = createIncrementalHighlighter(highlighter, "typescript", "pierre-dark");
    for (const text of [
      "/* open\ncomment\n",
      "const edited = 2;\nconst x = 1;",
      "const x",
      "const a = 1;\r\nconst b = 2;\r\n",
    ]) {
      expect(toHtml(highlight(text))).toBe(
        highlighter.codeToHtml(text, { lang: "typescript", theme: "pierre-dark" }),
      );
    }
    const plain = createIncrementalHighlighter(highlighter, "text", "pierre-dark");
    expect(toHtml(plain("plain\ntext\n"))).toBe(
      highlighter.codeToHtml("plain\ntext\n", { lang: "text", theme: "pierre-dark" }),
    );
  });
});

describe("createIncrementalHighlighter fallbacks", () => {
  it("streams plain text line by line, keeping completed lines", async () => {
    const { proxy, chunks } = recordingTokenizer(await highlighterPromise);
    const highlight = createIncrementalHighlighter(proxy, "text", "pierre-dark");
    const first = codeLines(highlight("one\ntwo"));
    const second = codeLines(highlight("one\ntwo\nthree"));
    expect(second[0]).toBe(first[0]);
    expect(chunks).toEqual(["one\ntwo", "\nthree"]);
  });

  it("falls back to incremental plain text once for a language that is not loaded", async () => {
    const highlighter = await highlighterPromise;
    const onFallback = vi.fn();
    const highlight = createIncrementalHighlighter(
      highlighter,
      "console",
      "pierre-dark",
      onFallback,
    );
    const code = "$ ls\nfile.txt\n$ pwd";
    let previous: ReturnType<typeof codeLines> = [];
    for (let end = 0; end <= code.length; end++) {
      const root = highlight(code.slice(0, end));
      expect(toHtml(root)).toBe(
        highlighter.codeToHtml(code.slice(0, end), { lang: "text", theme: "pierre-dark" }),
      );
      const lines = codeLines(root);
      if (lines.length > 1 && previous.length === lines.length) expect(lines[0]).toBe(previous[0]);
      previous = lines;
    }
    // Highlights renders an unsupported language as text without throwing.
    expect(onFallback).toHaveBeenCalledTimes(highlighter.name === "highlights" ? 0 : 1);
  });

  it("starts over cleanly after the tokenizer throws", async () => {
    const highlighter = await highlighterPromise;
    let failOnce = true;
    const { proxy } = recordingTokenizer(highlighter, (chunk) => {
      if (!chunk.includes("boom") || !failOnce) return false;
      failOnce = false;
      return true;
    });
    const highlight = createIncrementalHighlighter(proxy, "text", "pierre-dark");
    highlight("a\n");
    expect(() => highlight("a\nb\nboom\nc")).toThrow("boom");
    expect(toHtml(highlight("a\nb\nboom\nc"))).toBe(
      highlighter.codeToHtml("a\nb\nboom\nc", { lang: "text", theme: "pierre-dark" }),
    );
  });
});

// Lines are sanitized, which re-serializes entities (`&#x3C;` becomes `&lt;`).
function normalizeHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.innerHTML;
}

describe("HighlightedCodeLines", () => {
  it("renders the same HTML as codeToHtml, including escaping, whitespace and blank lines", async () => {
    const highlighter = await highlighterPromise;
    for (const theme of themes) {
      const highlight = createIncrementalHighlighter(highlighter, "typescript", theme);
      const code =
        'const html = "<img src=x onerror=alert(1)>";\n\n/* multi\nline */\n\tconst x = 1;\n';
      for (let end = 0; end <= code.length; end++) {
        const root = highlight(code.slice(0, end));
        expect(normalizeHtml(renderToStaticMarkup(<HighlightedCodeLines root={root} />))).toBe(
          normalizeHtml(toHtml(root)),
        );
      }
    }
  });
});

describe("HighlightedCodeLines full re-highlights", () => {
  it("does not sanitize unchanged lines again when the hast is rebuilt", async () => {
    const highlighter = await highlighterPromise;
    const sanitize = vi.spyOn(DOMPurify, "sanitize");
    const rootFor = (code: string) => highlightCodeToHast(highlighter, code, "text", "pierre-dark");
    const screen = await render(<HighlightedCodeLines root={rootFor("one\ntwo\nthr")} />);
    try {
      sanitize.mockClear();
      await screen.rerender(<HighlightedCodeLines root={rootFor("one\ntwo\nthree\nfo")} />);
      // Only the line that grew and the new one.
      expect(sanitize).toHaveBeenCalledTimes(2);
      expect(screen.container.textContent).toBe("one\ntwo\nthree\nfo");
    } finally {
      sanitize.mockRestore();
      await screen.unmount();
    }
  });
});
