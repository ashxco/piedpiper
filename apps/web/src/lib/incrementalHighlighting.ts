import {
  renderTokenLines,
  type DiffsHighlighter,
  type DiffsThemeNames,
  type ThemedToken,
  type TokensResult,
} from "@pierre/diffs";
import type { Element, ElementContent, Root } from "hast";

export interface HighlightedCodeDocument extends Root {
  children: [Element];
}

export interface IncrementalHighlighter {
  (code: string): HighlightedCodeDocument;
  /** Frees the tokenizer. A later call starts over, so a remounted effect can keep using it. */
  dispose(): void;
}

// Mirrors the pre/code shell of DiffsHighlighter.codeToHtml so both paths render the same markup.
function highlightedDocument(
  shell: TokensResult,
  lines: ReadonlyArray<ElementContent>,
): HighlightedCodeDocument {
  const style =
    shell.rootStyle === false
      ? undefined
      : (shell.rootStyle ??
        [
          shell.fg != null ? `color:${shell.fg}` : "",
          shell.bg != null ? `background-color:${shell.bg}` : "",
        ]
          .filter(Boolean)
          .join(";"));
  return {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        properties: {
          class: "diffs",
          ...(style !== undefined ? { style } : {}),
          tabIndex: 0,
        },
        children: [
          {
            type: "element",
            tagName: "code",
            properties: {},
            children: lines.flatMap((line, index): ElementContent[] =>
              index === 0 ? [line] : [{ type: "text", value: "\n" }, line],
            ),
          },
        ],
      },
    ],
  };
}

/** Full (non-incremental) highlight, shaped like the incremental document. */
export function highlightCodeToHast(
  highlighter: DiffsHighlighter,
  code: string,
  language: string,
  theme: DiffsThemeNames,
): HighlightedCodeDocument {
  const result = highlighter.codeToTokens(code, { lang: language, theme });
  return highlightedDocument(result, renderTokenLines(result.tokens, {}));
}

/**
 * Highlights code that only grows by appending (a streaming fence). Completed lines leave the
 * stream tokenizer once and keep their hast node identity so a line renderer can skip them; only
 * the line still being written is re-tokenized. A language the highlighter cannot tokenize falls
 * back to plain text once, via `onFallback`.
 */
export function createIncrementalHighlighter(
  highlighter: DiffsHighlighter,
  language: string,
  theme: DiffsThemeNames,
  onFallback?: (error: unknown) => void,
): IncrementalHighlighter {
  let activeLanguage = language;
  let shell: TokensResult | undefined;
  let tokenizer: ReturnType<DiffsHighlighter["createStreamTokenizer"]> | undefined;
  let covered = "";
  const completedLines: ElementContent[] = [];

  function reset() {
    tokenizer?.dispose();
    tokenizer = undefined;
    shell = undefined;
    covered = "";
    completedLines.length = 0;
  }

  function highlight(code: string): HighlightedCodeDocument {
    // ANSI and CR-containing input need the full-source normalization path.
    if (activeLanguage === "ansi" || code.includes("\r")) {
      reset();
      return highlightCodeToHast(highlighter, code, activeLanguage, theme);
    }
    if (!code.startsWith(covered)) reset();
    const options = { lang: activeLanguage, theme };
    // Both are created on first use so an unknown language throws inside the fallback below.
    shell ??= highlighter.codeToTokens("", options);
    tokenizer ??= highlighter.createStreamTokenizer(options);

    const update = tokenizer.enqueue(code.slice(covered.length));
    if (update instanceof Promise) {
      reset();
      void update.catch(() => {});
      return highlightCodeToHast(highlighter, code, activeLanguage, theme);
    }
    covered = code;
    let line: ThemedToken[] = [];
    for (const token of update.stable) {
      if (token.content === "\n") {
        const [node] = renderTokenLines([line], {});
        if (node) completedLines.push(node);
        line = [];
      } else {
        line.push(token);
      }
    }
    return highlightedDocument(shell, [
      ...completedLines,
      ...renderTokenLines([update.unstable], {}),
    ]);
  }

  const incremental = (code: string): HighlightedCodeDocument => {
    try {
      return highlight(code);
    } catch (error) {
      // The tokenizer may have consumed part of the chunk, so the next call starts over.
      reset();
      if (activeLanguage === "text") throw error;
      onFallback?.(error);
      activeLanguage = "text";
      return highlight(code);
    }
  };
  return Object.assign(incremental, { dispose: reset });
}
