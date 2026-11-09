export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  // Count code points so surrogate pairs (emoji) are never split.
  const characters = Array.from(trimmed);
  if (characters.length <= maxLength) {
    return trimmed;
  }

  return `${characters.slice(0, maxLength).join("")}...`;
}

/** Returns `end`, moved back one code unit when cutting there would split a surrogate pair. */
export function surrogateSafeEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return Math.max(0, Math.min(end, text.length));
  const previous = text.charCodeAt(end - 1);
  return previous >= 0xd800 && previous <= 0xdbff ? end - 1 : end;
}

/** `text.slice(0, end)` that never ends on half of an emoji or other astral character. */
export function sliceSurrogateSafe(text: string, end: number): string {
  return text.slice(0, surrogateSafeEnd(text, end));
}
