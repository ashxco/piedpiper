export interface ModelPickerSearchable {
  readonly name: string;
  readonly slug: string;
  readonly providerLabel: string;
  readonly isFavorite: boolean;
}

const FUZZY_MIN_TOKEN_LENGTH = 3;

const compact = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, "");

function isBoundaryMatch(value: string, token: string): boolean {
  for (let index = value.indexOf(token); index !== -1; index = value.indexOf(token, index + 1)) {
    if (index === 0 || compact(value.charAt(index - 1)) === "") return true;
  }
  return false;
}

function isSubsequence(value: string, token: string): boolean {
  let matched = 0;
  for (const character of value) {
    if (character === token[matched]) matched += 1;
    if (matched === token.length) return true;
  }
  return false;
}

/** Lower is better: name and slug beat the provider's name, and fuzzy matches come last. */
function scoreToken(model: ModelPickerSearchable, token: string): number | null {
  const name = model.name.toLowerCase();
  const slug = model.slug.toLowerCase();
  if (name === token || slug === token) return 0;
  if (name.startsWith(token)) return 1;
  if (isBoundaryMatch(name, token)) return 2;
  if (name.includes(token)) return 3;
  if (slug.includes(token)) return 4;
  const compactToken = compact(token);
  if (
    compactToken &&
    (compact(name).includes(compactToken) || compact(slug).includes(compactToken))
  )
    return 5;
  if (model.providerLabel.toLowerCase().includes(token)) return 6;
  if (
    token.length >= FUZZY_MIN_TOKEN_LENGTH &&
    (isSubsequence(name, token) || isSubsequence(slug, token))
  )
    return 7;
  return null;
}

/** Returns null when any token misses, so every word of the query must match somewhere. */
export function scoreModelPickerSearch(model: ModelPickerSearchable, query: string): number | null {
  const normalized = query.trim().toLowerCase().replace(/\s+/gu, " ");
  if (!normalized) return 0;
  if (normalized === model.name.toLowerCase() || normalized === model.slug.toLowerCase()) return -1;
  let total = 0;
  for (const token of normalized.split(" ")) {
    const score = scoreToken(model, token);
    if (score === null) return null;
    total += score;
  }
  return total;
}

/** Best match first; ties list favorites first and otherwise keep the input's provider order. */
export function rankModelPickerSearch<T extends ModelPickerSearchable>(
  items: ReadonlyArray<T>,
  query: string,
): T[] {
  const ranked: Array<{ item: T; score: number; order: number }> = [];
  items.forEach((item, order) => {
    const score = scoreModelPickerSearch(item, query);
    if (score !== null) ranked.push({ item, score, order });
  });
  return ranked
    .toSorted(
      (a, b) =>
        a.score - b.score ||
        Number(b.item.isFavorite) - Number(a.item.isFavorite) ||
        a.order - b.order,
    )
    .map((entry) => entry.item);
}
