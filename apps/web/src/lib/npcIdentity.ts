/**
 * Office NPC identity helpers: parse a character file id into display names.
 *
 * Pure: no React, no Zustand, no I/O.
 */
export interface ParsedNpcCharacter {
  /** The character file id, e.g. `character-sv-erlich-bachman-02`. */
  readonly id: string;
  /** Show key (`sv`, `tech`, `office`, etc). */
  readonly show: string;
  /** Display name with `(alt)` suffix for `-02` variants. */
  readonly displayName: string;
  /** Compact UI label — usually first name, with a few curated exceptions. */
  readonly shortName: string;
  /** Display name without the variant suffix. */
  readonly baseName: string;
  /** Canonical character lines key (variant suffix preserved if present). */
  readonly characterLinesKey: string;
}

// Everyone shows first name only. These exceptions need their full name
// because the first name alone is ambiguous or doesn't work.
const FULL_NAME_IDS: ReadonlySet<string> = new Set([
  "character-firefly-the-operative",
  "character-sv-big-head",
  "character-sv-jian-yang",
]);

/** Characters where the last name is more recognizable than the first. */
const LAST_NAME_IDS: Readonly<Record<string, string>> = {
  "character-tech-david-friedberg": "Friedberg",
  "character-tech-david-sacks": "Sacks",
};

function compactNpcName(id: string, displayName: string): string {
  if (FULL_NAME_IDS.has(id)) return displayName;
  const lastNameOverride = LAST_NAME_IDS[id];
  if (lastNameOverride) return lastNameOverride;
  return displayName.split(" ")[0] ?? displayName;
}

export function parseNpcCharacter(id: string): ParsedNpcCharacter | null {
  if (!id.startsWith("character-")) return null;
  const rest = id.slice("character-".length);
  const dashIdx = rest.indexOf("-");
  if (dashIdx === -1) return null;
  const show = rest.slice(0, dashIdx);
  let nameSlug = rest.slice(dashIdx + 1);
  const hasVariantSuffix = /-\d{2}$/.test(nameSlug);
  if (hasVariantSuffix) nameSlug = nameSlug.slice(0, -3);
  const baseName = nameSlug
    .split("-")
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : ""))
    .join(" ");
  const displayName = baseName;
  const shortName = compactNpcName(id, displayName);
  return {
    id,
    show,
    displayName,
    shortName,
    baseName,
    characterLinesKey: id,
  };
}
