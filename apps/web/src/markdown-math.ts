// Normalizes the TeX delimiters models write into what `remark-math` parses with
// `singleDollarTextMath: false`: `$$..$$` inline and `$$` fenced blocks for display.

const FENCE_LINE = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/;
const LINE_PREFIX = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?/;
const BLANK_LINE = /^[ \t>]*$/;

/** Messages without these characters skip math parsing entirely. */
export function mayContainMarkdownMath(text: string): boolean {
  return (
    text.includes("$") ||
    text.includes("\\(") ||
    text.includes("\\[") ||
    /(?:`{3,}|~{3,})[ \t]*math\b/.test(text)
  );
}

/** How a rendered `code` element with this class holds math, or null when it holds code. */
export function markdownMathKind(
  className: string | undefined,
): "inline" | "display" | "fence" | null {
  if (!className || !/(?:^|\s)language-math(?:\s|$)/.test(className)) return null;
  if (/(?:^|\s)math-display(?:\s|$)/.test(className)) return "display";
  if (/(?:^|\s)math-inline(?:\s|$)/.test(className)) return "inline";
  return "fence";
}

/** The prefix for lines that continue a block opened on a line with this prefix. */
function continuationPrefix(prefix: string): string {
  return prefix.replace(/(?:[-*+]|\d{1,9}[.)])(?=[ \t])/, (marker) => " ".repeat(marker.length));
}

// A whole line of `$$x$$` or `\[x\]` is display math, so it becomes a `$$` block.
function displayLine(line: string): string[] | null {
  if (line.includes("`")) return null;
  const prefix = LINE_PREFIX.exec(line)?.[0] ?? "";
  const rest = line.slice(prefix.length).trimEnd();
  const tex =
    /^\$\$(?!\$)(.*[^$\\])\$\$$/.exec(rest)?.[1] ?? /^\\\[(.+)(?<!\\)\\\]$/.exec(rest)?.[1];
  if (tex === undefined || !tex.trim() || /\$\$|\\[[\]]/.test(tex)) return null;
  const next = continuationPrefix(prefix);
  return [`${prefix}$$`, `${next}${tex.trim()}`, `${next}$$`];
}

const TEX_HINT = /[\\^_{}=<>]/;

function looksLikeTex(content: string): boolean {
  if (TEX_HINT.test(content) || /^[A-Za-z]$/.test(content)) return true;
  return (
    content.length <= 40 &&
    /^[\w\s+\-*/().,]+$/.test(content) &&
    /[A-Za-z]/.test(content) &&
    /[+\-*/]/.test(content)
  );
}

// Pandoc's rule (no space inside the dollars, no digit after the closer) plus a TeX-looking body,
// so prices ($5 and $10) and shell variables ($HOME/$USER, ${HOME}) stay text.
const SINGLE_DOLLAR =
  /(?<![\\$\w])\$(?!\{[A-Za-z_]\w*\})(?=[^\s$])([^$\n]*?[^\s$\\])\$(?![\d$\w])/g;
const INLINE_PAREN = /(?<!\\)\\\(((?:(?!\n[ \t>]*\n)[\s\S])+?)(?<!\\)\\\)/g;
// Mid-line `\[..\]` is also an escaped Markdown bracket (`\[1\]`, `A\[i\]`), so it needs a TeX
// body and no word or bracket right before it.
const INLINE_BRACKET = /(?<![\\\w\]])\\\[((?:(?!\n[ \t>]*\n)[\s\S])+?)(?<!\\)\\\]/g;

function normalizeInlineText(text: string): string {
  return text
    .replace(INLINE_PAREN, (_, tex: string) => `$$${tex}$$`)
    .replace(INLINE_BRACKET, (match, tex: string) => (looksLikeTex(tex) ? `$$${tex}$$` : match))
    .replace(SINGLE_DOLLAR, (match, tex: string) => (looksLikeTex(tex) ? `$$${tex}$$` : match));
}

// Code spans, link destinations, autolinks and bare URLs are copied through untouched.
const PROTECTED_SPAN =
  /`+|\]\((?:[^()\s\\]|\\.|\([^()\s]*\))*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)|<[A-Za-z][\w+.-]*:[^<>\s]*>|(?<![\w/])(?:https?:\/\/|www\.)[^\s<]+/gi;

function normalizeProseInline(prose: string): string {
  let out = "";
  let index = 0;
  const ticks = /`+/g;
  while (index < prose.length) {
    PROTECTED_SPAN.lastIndex = index;
    const open = PROTECTED_SPAN.exec(prose);
    if (!open) break;
    if (open[0][0] !== "`") {
      out += normalizeInlineText(prose.slice(index, open.index));
      out += open[0];
      index = open.index + open[0].length;
      continue;
    }
    ticks.lastIndex = open.index + open[0].length;
    let close: RegExpExecArray | null = null;
    for (let candidate = ticks.exec(prose); candidate; candidate = ticks.exec(prose)) {
      if (candidate[0].length === open[0].length) {
        close = candidate;
        break;
      }
    }
    if (!close) {
      // An unmatched run is literal backticks; keep scanning after it.
      out += normalizeInlineText(prose.slice(index, open.index + open[0].length));
      index = open.index + open[0].length;
      continue;
    }
    out += normalizeInlineText(prose.slice(index, open.index));
    out += prose.slice(open.index, close.index + close[0].length);
    index = close.index + close[0].length;
  }
  return out + normalizeInlineText(prose.slice(index));
}

function normalizeProseLines(lines: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const display = displayLine(line);
    if (display) {
      out.push(...display);
      continue;
    }
    // A `\[` line paired with a later `\]` line, with no blank line between, is a display block.
    const opener = /^([ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?)\\\[[ \t]*$/.exec(line);
    if (opener) {
      let end = index + 1;
      while (end < lines.length && !BLANK_LINE.test(lines[end]!)) {
        if (/^[ \t>]*\\\][ \t]*$/.test(lines[end]!)) break;
        end++;
      }
      if (end < lines.length && /^[ \t>]*\\\][ \t]*$/.test(lines[end]!)) {
        out.push(
          `${opener[1]}$$`,
          ...lines.slice(index + 1, end),
          lines[end]!.replace("\\]", () => "$$"),
        );
        index = end;
        continue;
      }
    }
    out.push(line);
  }
  return normalizeProseInline(out.join("\n")).split("\n");
}

function indentColumns(line: string): number {
  let column = 0;
  for (const char of line) {
    if (char === " ") column++;
    else if (char === "\t") column += 4 - (column % 4);
    else break;
  }
  return column;
}

const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/** Rewrites `\(..\)`, `\[..\]` and TeX-looking `$..$` outside code into `remark-math` delimiters. */
export function normalizeMarkdownMath(text: string): string {
  if (!mayContainMarkdownMath(text)) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  let fence: { char: string; length: number } | null = null;
  // Indented code starts after a blank line or a closed block, four columns past any list content.
  let canStartIndentedCode = true;
  let inIndentedCode = false;
  let listIndent: number | null = null;
  const flushProse = () => {
    if (prose.length > 0) out.push(...normalizeProseLines(prose));
    prose = [];
  };
  for (const line of lines) {
    const match = FENCE_LINE.exec(line);
    if (fence) {
      out.push(line);
      if (
        match &&
        match[1]![0] === fence.char &&
        match[1]!.length >= fence.length &&
        !match[2]!.trim()
      ) {
        fence = null;
        canStartIndentedCode = true;
      }
      continue;
    }
    if (BLANK_LINE.test(line)) {
      (inIndentedCode ? out : prose).push(line);
      canStartIndentedCode = true;
      continue;
    }
    const indent = indentColumns(line);
    if (indent >= (listIndent ?? 0) + 4 && (canStartIndentedCode || inIndentedCode)) {
      flushProse();
      out.push(line);
      inIndentedCode = true;
      continue;
    }
    inIndentedCode = false;
    const listItem = LIST_ITEM.exec(line);
    if (listItem) listIndent = indentColumns(listItem[0].replace(/\S/g, " "));
    else if (canStartIndentedCode && indent < (listIndent ?? 0)) listIndent = null;
    canStartIndentedCode = false;
    if (match && !(match[1]![0] === "`" && match[2]!.includes("`"))) {
      flushProse();
      fence = { char: match[1]![0]!, length: match[1]!.length };
      out.push(line);
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return out.join("\n");
}
