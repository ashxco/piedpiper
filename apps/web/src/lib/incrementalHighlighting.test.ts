import { disposeHighlighter, getSharedHighlighter } from "@pierre/diffs";
import { toHtml } from "hast-util-to-html";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createIncrementalHighlighter, highlightCodeToHast } from "./incrementalHighlighting";

const samples = {
  typescript: "/* multi\nline comment */\nconst x = `template\n${1 + 2}`;\nconst re = /abc/;\n",
  python: '#!/usr/bin/python\nx = """multi\nline"""\nprint(x)\n',
  bash: "#!/bin/bash\ncat <<EOF\nhello\nEOF\necho hi\n",
  html: "<script>\nconst x = 1;\n</script>\n<style>\np {color:red;}\n</style>\n",
  markdown: "# heading\n\n```ts\nconst a = 1;\n```\n\ntext\n",
  json: '{\n "value": [1,\n 2, 3]\n}\n',
} as const;

const theme = "pierre-dark";

describe.each(["shiki-wasm", "highlights"] as const)("incremental highlighting (%s)", (engine) => {
  const load = () =>
    getSharedHighlighter({
      langs: Object.keys(samples) as Array<keyof typeof samples>,
      themes: [theme, "pierre-light"],
      preferredHighlighter: engine,
    });

  beforeAll(() => disposeHighlighter());
  afterAll(() => disposeHighlighter());

  it.each(Object.entries(samples))(
    "matches full HTML at every streaming prefix in %s",
    async (language, code) => {
      const highlighter = await load();
      const highlight = createIncrementalHighlighter(highlighter, language, theme);
      for (let end = 0; end <= code.length; end++) {
        const text = code.slice(0, end);
        expect(toHtml(highlight(text)), `prefix ${end}`).toBe(
          highlighter.codeToHtml(text, { lang: language, theme }),
        );
      }
      highlight.dispose();
    },
  );

  it("shapes the full highlight like codeToHtml", async () => {
    const highlighter = await load();
    const code = samples.typescript;
    expect(toHtml(highlightCodeToHast(highlighter, code, "typescript", theme))).toBe(
      highlighter.codeToHtml(code, { lang: "typescript", theme }),
    );
  });

  it("resets after edits and truncation, including edits to a completed line", async () => {
    const highlighter = await load();
    const highlight = createIncrementalHighlighter(highlighter, "typescript", theme);
    for (const text of [
      "/* open\ncomment\n",
      "/* open\ncomment\n*/\nconst x = 1;",
      "const edited = 2;\nconst x = 1;",
      "const edited = 2;\nconst x = 10;",
      "const edited = 2;\n",
      "",
      "\n\n\nconst fresh = true;\n",
    ]) {
      expect(toHtml(highlight(text))).toBe(
        highlighter.codeToHtml(text, { lang: "typescript", theme }),
      );
    }
    highlight.dispose();
  });

  it("preserves partial CRLF and CR line endings, then resumes streaming", async () => {
    const highlighter = await load();
    const highlight = createIncrementalHighlighter(highlighter, "typescript", theme);
    const code = "/* multi\r\nline */\r\nconst x = 1;\r\n";
    for (let end = 0; end <= code.length; end++) {
      const text = code.slice(0, end);
      expect(toHtml(highlight(text))).toBe(
        highlighter.codeToHtml(text, { lang: "typescript", theme }),
      );
    }
    expect(toHtml(highlight("const y = 2;\n"))).toBe(
      highlighter.codeToHtml("const y = 2;\n", { lang: "typescript", theme }),
    );
  });

  it("frees its tokenizer on dispose, tolerates repeats and restarts on the next call", async () => {
    const highlighter = await load();
    const dispose = vi.fn();
    const proxy = new Proxy(highlighter, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key !== "createStreamTokenizer") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...args: Parameters<typeof highlighter.createStreamTokenizer>) => {
          const tokenizer = highlighter.createStreamTokenizer(...args);
          const original = tokenizer.dispose.bind(tokenizer);
          tokenizer.dispose = () => {
            dispose();
            original();
          };
          return tokenizer;
        };
      },
    });
    const highlight = createIncrementalHighlighter(proxy, "typescript", theme);
    const code = "/* open\ncomment */\nconst x = 1;";
    highlight(code);
    highlight.dispose();
    highlight.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(toHtml(highlight(code))).toBe(
      highlighter.codeToHtml(code, { lang: "typescript", theme }),
    );
    highlight.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("creates a highlighter for a language that is not loaded without throwing", async () => {
    const highlighter = await load();
    const onFallback = vi.fn();
    const highlight = createIncrementalHighlighter(highlighter, "cobol", theme, onFallback);
    expect(toHtml(highlight("IDENTIFICATION DIVISION.\n"))).toBe(
      highlighter.codeToHtml("IDENTIFICATION DIVISION.\n", { lang: "text", theme }),
    );
    expect(onFallback).toHaveBeenCalledTimes(engine === "highlights" ? 0 : 1);
    highlight.dispose();
  });
});
