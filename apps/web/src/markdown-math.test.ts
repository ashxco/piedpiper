import { describe, expect, it } from "vitest";

import { markdownMathKind, mayContainMarkdownMath, normalizeMarkdownMath } from "./markdown-math";

describe("normalizeMarkdownMath", () => {
  it("turns \\(..\\) into inline math", () => {
    expect(normalizeMarkdownMath("Runs in \\(O(n \\log n)\\) time")).toBe(
      "Runs in $$O(n \\log n)$$ time",
    );
  });

  it("turns a line of \\[..\\] or $$..$$ into a display block", () => {
    expect(normalizeMarkdownMath("Energy:\n\\[E = mc^2\\]\ndone")).toBe(
      "Energy:\n$$\nE = mc^2\n$$\ndone",
    );
    expect(normalizeMarkdownMath("$$a^2 + b^2 = c^2$$")).toBe("$$\na^2 + b^2 = c^2\n$$");
  });

  it("keeps a display block inside its list item or quote", () => {
    expect(normalizeMarkdownMath("1. \\[x^2\\]")).toBe("1. $$\n   x^2\n   $$");
    expect(normalizeMarkdownMath("> $$x^2$$")).toBe("> $$\n> x^2\n> $$");
  });

  it("turns multi-line \\[ .. \\] into a display block", () => {
    expect(normalizeMarkdownMath("\\[\n\\sum_i x_i\n\\]")).toBe("$$\n\\sum_i x_i\n$$");
  });

  it("leaves an unclosed \\[ line alone", () => {
    expect(normalizeMarkdownMath("\\[\nx\n\nmore")).toBe("\\[\nx\n\nmore");
  });

  it("keeps two formulas on one line inline", () => {
    expect(normalizeMarkdownMath("$$a$$ and $$b$$")).toBe("$$a$$ and $$b$$");
  });

  it("turns TeX-looking single-dollar math into inline math", () => {
    expect(normalizeMarkdownMath("where $x$ and $n^2$ and $a + b$")).toBe(
      "where $$x$$ and $$n^2$$ and $$a + b$$",
    );
  });

  it.each([
    ["prices", "It costs $5 and $10 later"],
    ["a price range", "between $5-$10 a month"],
    ["shell variables", "set $HOME/$USER first"],
    ["spaced shell variables", "echo $A $B"],
    ["an escaped dollar", "\\$x$ stays"],
    ["plain words", "the $foo$ value"],
    ["braced shell variables", "Paths like ${HOME}/${USER} work"],
    ["a braced shell variable before math-like text", "cd ${DIR}_old && ls $x"],
    ["escaped-bracket citations", "As shown in \\[1\\] and \\[2, 3\\]."],
    ["escaped-bracket indexing", "Matrix A\\[i\\]\\[j\\] here"],
    ["a link destination", "See [docs](https://example.com/\\(a\\)) here."],
    ["a link destination with a title", 'See [docs](https://e.com/$x^2$ "t $y_1$") here.'],
    ["an autolink", "Open <https://example.com/$x^2$> now"],
    ["a bare URL", "Query https://graph.microsoft.com/users?$x_i$ now"],
    ["indented code", "text\n\n    echo $a+b$\n    grep '\\(foo\\)'\n\n    \\[x\\]"],
    ["indented code at the start", "    $$x$$\n    \\(y\\)"],
  ])("leaves %s as text", (_, text) => {
    expect(normalizeMarkdownMath(text)).toBe(text);
  });

  it("still converts math next to a link, URL or bracketed formula", () => {
    expect(normalizeMarkdownMath("[a $x^2$ label](https://e.com/$y$) and \\[x^2\\] mid-line")).toBe(
      "[a $$x^2$$ label](https://e.com/$y$) and $$x^2$$ mid-line",
    );
    expect(normalizeMarkdownMath("Go to https://e.com/a, then $n^2$")).toBe(
      "Go to https://e.com/a, then $$n^2$$",
    );
  });

  it("treats indented lines inside a list or paragraph as prose", () => {
    expect(normalizeMarkdownMath("1. item\n\n    where \\(x\\)")).toBe(
      "1. item\n\n    where $$x$$",
    );
    expect(normalizeMarkdownMath("para\n    then \\(x\\)")).toBe("para\n    then $$x$$");
    expect(normalizeMarkdownMath("    code $x$\n\nback to \\(y\\)")).toBe(
      "    code $x$\n\nback to $$y$$",
    );
  });

  it("leaves inline code and fenced code untouched", () => {
    const text = "Use `\\(x\\)` or `$x$`\n\n```tex\n\\[x\\]\n$x$\n```\n\nthen \\(y\\)";
    expect(normalizeMarkdownMath(text)).toBe(
      "Use `\\(x\\)` or `$x$`\n\n```tex\n\\[x\\]\n$x$\n```\n\nthen $$y$$",
    );
  });

  it("does not pair delimiters across a blank line", () => {
    expect(normalizeMarkdownMath("\\(a\n\nb\\)")).toBe("\\(a\n\nb\\)");
  });

  it("leaves an escaped \\\\( alone", () => {
    expect(normalizeMarkdownMath("a \\\\(b\\\\) c")).toBe("a \\\\(b\\\\) c");
  });

  it("skips text without math characters", () => {
    expect(mayContainMarkdownMath("plain text")).toBe(false);
    expect(mayContainMarkdownMath("```math\nx\n```")).toBe(true);
  });
});

describe("markdownMathKind", () => {
  it("reads remark-math and fence classes", () => {
    expect(markdownMathKind("language-math math-inline")).toBe("inline");
    expect(markdownMathKind("language-math math-display")).toBe("display");
    expect(markdownMathKind("language-math")).toBe("fence");
    expect(markdownMathKind("language-mathematica")).toBeNull();
    expect(markdownMathKind(undefined)).toBeNull();
  });
});
