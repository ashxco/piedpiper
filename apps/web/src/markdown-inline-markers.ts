const INLINE_MARKERS: ReadonlyMap<string, string> = new Map([
  ["strong", "**"],
  ["b", "**"],
  ["em", "*"],
  ["i", "*"],
  ["del", "~~"],
  ["s", "~~"],
]);

/** The Markdown delimiter for an inline formatting tag, in either the DOM's or hast's casing. */
export function inlineMarkdownMarker(tagName: string): string | undefined {
  return INLINE_MARKERS.get(tagName.toLowerCase());
}

/** Puts markers around the text itself, since Markdown rejects a delimiter next to whitespace. */
export function wrapInlineMarker(content: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(content);
  const core = match?.[2] ?? "";
  if (!core) return content;
  return `${match?.[1] ?? ""}${marker}${core}${marker}${match?.[3] ?? ""}`;
}

/** A code span with a delimiter longer than any backtick run inside it. */
export function wrapInlineCode(code: string): string {
  const longestRun = [...(code.match(/`+/g) ?? [])].reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(1, longestRun + (longestRun > 0 ? 1 : 0)));
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}
