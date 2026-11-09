/**
 * The marker gutter for an ordered list whose widest marker would overflow the default `1.25rem`
 * padding (`.chat-markdown ol`), or undefined to keep it. It fits the widest number, a negative
 * start's minus sign, the period and the trailing space.
 */
export function orderedListGutter(itemCount: number, start: unknown): string | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  const firstNumber = Number.isNaN(parsedStart) ? 1 : parsedStart;
  const lastNumber = firstNumber + Math.max(itemCount - 1, 0);
  const markerWidth = Math.max(String(firstNumber).length, String(lastNumber).length);
  if (markerWidth <= 1) return undefined;
  return `${markerWidth + 2}ch`;
}

const ROMAN_DIGITS: ReadonlyArray<readonly [number, number]> = [
  [1000, 1],
  [900, 2],
  [500, 1],
  [400, 2],
  [100, 1],
  [90, 2],
  [50, 1],
  [40, 2],
  [10, 1],
  [9, 2],
  [5, 1],
  [4, 2],
  [1, 1],
];

function romanLength(value: number): number {
  let length = 0;
  let rest = value;
  for (const [amount, glyphs] of ROMAN_DIGITS) {
    while (rest >= amount) {
      rest -= amount;
      length += glyphs;
    }
  }
  return length;
}

function alphaLength(value: number): number {
  let length = 0;
  for (let rest = value; rest > 0; rest = Math.floor((rest - 1) / 26)) length++;
  return length;
}

/** The list-style-type `.chat-markdown` gives an `ol` nested `depth` ordered lists deep (1 = top level). */
export function orderedListStyleAtDepth(depth: number): "decimal" | "lower-alpha" | "lower-roman" {
  if (depth <= 1) return "decimal";
  return depth === 2 ? "lower-alpha" : "lower-roman";
}

/**
 * Like `orderedListGutter`, but for the marker style of a list `depth` ordered lists deep: nested
 * lists use letters and roman numerals, which fall back to decimal outside their range.
 */
export function nestedOrderedListGutter(
  itemCount: number,
  start: unknown,
  depth: number,
): string | undefined {
  const style = orderedListStyleAtDepth(depth);
  if (style === "decimal") return orderedListGutter(itemCount, start);
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  const firstNumber = Number.isNaN(parsedStart) ? 1 : parsedStart;
  let markerWidth = 0;
  let needsWidening = false;
  for (let offset = 0; offset < Math.max(itemCount, 1); offset++) {
    const value = firstNumber + offset;
    let width: number;
    // Roman glyphs are narrow, so `iii.` still fits the default gutter.
    let fitsDefault: number;
    if (style === "lower-alpha" && value >= 1) {
      width = alphaLength(value);
      fitsDefault = 1;
    } else if (style === "lower-roman" && value >= 1 && value <= 3999) {
      width = romanLength(value);
      fitsDefault = 3;
    } else {
      width = String(value).length;
      fitsDefault = 1;
    }
    markerWidth = Math.max(markerWidth, width);
    if (width > fitsDefault) needsWidening = true;
  }
  if (!needsWidening) return undefined;
  return `${markerWidth + 2}ch`;
}
