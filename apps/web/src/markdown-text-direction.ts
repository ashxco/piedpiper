export type TextDirection = "ltr" | "rtl";

// Hebrew through Arabic Extended-A, their presentation forms, and the supplementary RTL blocks.
const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LETTER = /\p{L}/u;
const SENTENCE_END = /(?<=[.!?؟])(?<!\b(?:e\.g|i\.e)\.)\s+|\n+/i;
const MARKDOWN_CODE_OR_URL =
  /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`{1,2})(?!`)[\s\S]*?(?<!`)\2(?!`)|https?:\/\/\S+/g;

function majority(
  units: Iterable<TextDirection | undefined>,
  tieDirection?: () => TextDirection | undefined,
): TextDirection | undefined {
  let rtl = 0;
  let ltr = 0;
  let first: TextDirection | undefined;
  for (const direction of units) {
    if (!direction) continue;
    first ??= direction;
    if (direction === "rtl") rtl += 1;
    else ltr += 1;
  }
  if (rtl === ltr) return tieDirection ? tieDirection() : first;
  return rtl > ltr ? "rtl" : "ltr";
}

function wordDirection(word: string): TextDirection | undefined {
  const letter = LETTER.exec(word)?.[0];
  if (!letter) return undefined;
  return RTL_LETTER.test(letter) ? "rtl" : "ltr";
}

/**
 * The base direction for a block of prose, or undefined when it has no letters.
 *
 * `dir="auto"` follows the first letter, which lays out an Arabic line that opens with an English
 * term left to right. Each sentence follows its main language by word count and the text follows
 * most of its sentences, so one long English sentence cannot outvote the Arabic ones around it.
 * A tie between sentences goes to the whole text's word count, then to the first word.
 */
export function textDirection(text: string): TextDirection | undefined {
  if (!RTL_LETTER.test(text)) return LETTER.test(text) ? "ltr" : undefined;
  return majority(
    text.split(SENTENCE_END).map((sentence) => majority(sentence.split(/\s+/).map(wordDirection))),
    () => majority(text.split(/\s+/).map(wordDirection)),
  );
}

function withoutMarkdownCode(markdown: string): string {
  return markdown.replace(MARKDOWN_CODE_OR_URL, " ");
}

/** `textDirection` for Markdown source, leaving out code and URLs, which are always English. */
export function markdownProseDirection(markdown: string): TextDirection | undefined {
  return textDirection(withoutMarkdownCode(markdown));
}

/** One direction for a whole question set, so moving between its questions never flips the card. */
export function questionSetDirection(
  questions: ReadonlyArray<{
    readonly header: string;
    readonly question: string;
    readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
  }>,
): TextDirection | undefined {
  const fields = questions.flatMap((question) => [
    question.header,
    question.question,
    ...question.options.flatMap((option) => [option.label, option.description ?? ""]),
  ]);
  // Stripped field by field: a lone backtick must not pair with one in the next field.
  return textDirection(fields.map(withoutMarkdownCode).join(" "));
}

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

// Blocks end a sentence, so a long English list item cannot outvote the Arabic items around it.
const BLOCK_TAGS = new Set([
  "blockquote",
  "br",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

function proseText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "code" || node.tagName === "pre") return " ";
  const text = (node.children ?? []).map(proseText).join("");
  return node.tagName && BLOCK_TAGS.has(node.tagName) ? `\n${text}\n` : text;
}

function isolateCode(node: HastNode): void {
  if (node.tagName === "pre" || node.tagName === "code") {
    node.properties = { ...node.properties, dir: "ltr" };
    return;
  }
  node.children?.forEach(isolateCode);
}

/**
 * Marks each top-level block written mostly in Arabic or Hebrew as right to left, beside the
 * app's left-to-right English blocks. Lines inside a list or quote follow it, keeping markers and
 * rules on one side. Code is left out of the count and isolated left to right.
 */
export function rehypeTextDirection() {
  return (tree: HastNode) => {
    for (const block of tree.children ?? []) {
      if (block.type !== "element" || block.tagName === "pre") continue;
      if (textDirection(proseText(block)) !== "rtl") continue;
      block.properties = { ...block.properties, dir: "rtl" };
      isolateCode(block);
    }
  };
}
