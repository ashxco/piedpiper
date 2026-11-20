import type { DiffThemeName } from "./diffRendering";

// The key holds the code itself: a hash would let two different blocks share highlighted HTML.
// The length prefix keeps a language containing ":" unambiguous.
export function createHighlightCacheKey(
  code: string,
  language: string,
  themeName: DiffThemeName,
): string {
  return `${language.length}:${language}:${themeName}:${code}`;
}

/** Approximate UTF-16 bytes for a cache entry, counting its key, which holds the code. */
export function estimateHighlightedSize(html: string, cacheKey: string): number {
  return (cacheKey.length + html.length) * 2;
}
