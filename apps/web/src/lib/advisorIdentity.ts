/**
 * Lightweight advisor identity helpers — character id parsing, display-name
 * lookups, title/prompt-based thread detection. Kept free of the
 * `CHARACTER_LINES` corpus (~5000 lines of dialogue strings) so that consumers
 * on the chat critical path (`ChatView.tsx`) can detect advisor threads
 * without paying for the line data they never use. The line corpus lives in
 * the sibling `advisorCatalog.ts` module, which only `useStartAdvisorChat`
 * and the advisors page itself need to import.
 *
 * Pure: no React, no Zustand, no I/O.
 */
import {
  TIER_1,
  TIER_2,
  TIER_3,
  TIER_4,
  TIER_5,
  TIER_6,
  TIER_7,
} from "../components/office-mode/npcCharacters";

export interface ParsedAdvisor {
  /** The character file id, e.g. `character-sv-erlich-bachman-02`. */
  readonly id: string;
  /** Show key (`sv`, `tech`, `office`, etc). */
  readonly show: string;
  /** Display name with `(alt)` suffix for `-02` variants. */
  readonly displayName: string;
  /** Compact UI label — usually first name, with a few curated exceptions. */
  readonly shortName: string;
  /** Display name without the variant suffix — used for the persona prompt. */
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

function compactAdvisorName(id: string, displayName: string): string {
  if (FULL_NAME_IDS.has(id)) return displayName;
  const lastNameOverride = LAST_NAME_IDS[id];
  if (lastNameOverride) return lastNameOverride;
  return displayName.split(" ")[0] ?? displayName;
}

export function parseAdvisor(id: string): ParsedAdvisor | null {
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
  const shortName = compactAdvisorName(id, displayName);
  return {
    id,
    show,
    displayName,
    shortName,
    baseName,
    characterLinesKey: id,
  };
}

export function advisorThreadTitle(characterId: string): string {
  const parsed = parseAdvisor(characterId);
  if (!parsed) return "Advisor chat";
  return `Chat with ${parsed.displayName}`;
}

const ADVISOR_TITLE_PREFIX = "Chat with ";

/**
 * Extracts the advisor display name from a thread title produced by
 * {@link advisorThreadTitle}. Returns null for non-advisor titles.
 */
function parseAdvisorDisplayNameFromTitle(title: string): string | null {
  if (!title.startsWith(ADVISOR_TITLE_PREFIX)) return null;
  const name = title.slice(ADVISOR_TITLE_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

const ALL_ADVISORS: readonly ParsedAdvisor[] = (() => {
  const seen = new Set<string>();
  const out: ParsedAdvisor[] = [];
  for (const id of [...TIER_1, ...TIER_2, ...TIER_3, ...TIER_4, ...TIER_5, ...TIER_6, ...TIER_7]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const parsed = parseAdvisor(id);
    if (!parsed) continue;
    out.push(parsed);
  }
  return out.toSorted((a, b) => a.displayName.localeCompare(b.displayName));
})();

const ADVISORS_BY_DISPLAY_NAME: ReadonlyMap<string, ParsedAdvisor> = new Map(
  ALL_ADVISORS.map((advisor) => [advisor.displayName, advisor]),
);

/** All known advisors (deduped, sorted by display name). */
export function getAllAdvisors(): readonly ParsedAdvisor[] {
  return ALL_ADVISORS;
}

function findAdvisorByDisplayName(displayName: string): ParsedAdvisor | null {
  return ADVISORS_BY_DISPLAY_NAME.get(displayName) ?? null;
}

/**
 * Resolve the active advisor for a thread by inverting its title. Returns
 * null when the title doesn't match the `Chat with X` format or when the
 * extracted display name doesn't correspond to a known advisor.
 */
function findAdvisorByThreadTitle(title: string): ParsedAdvisor | null {
  const displayName = parseAdvisorDisplayNameFromTitle(title);
  if (!displayName) return null;
  return findAdvisorByDisplayName(displayName);
}

const SYSTEM_PROMPT_PREFIX = /^You are (.+?)[.,] /;

/**
 * Recover the active advisor by parsing the system prompt produced by
 * `buildAdvisorSystemPrompt`. Used as a fallback for threads whose title was
 * overwritten by the auto-titler before we learned to skip it.
 */
function findAdvisorBySystemPrompt(systemPrompt: string): ParsedAdvisor | null {
  const match = systemPrompt.match(SYSTEM_PROMPT_PREFIX);
  const displayName = match?.[1]?.trim();
  if (!displayName) return null;
  return findAdvisorByDisplayName(displayName);
}

/**
 * Title-keyed cache for {@link findAdvisorForThread}. Keys are stable strings
 * (V8 interns), values are the resolved advisor or `null`. Bounded by the
 * total number of distinct advisor titles ever observed in a session
 * (~hundreds at most). Hot-path optimization for the chat header re-resolving
 * the advisor on every render of every advisor thread.
 */
const ADVISOR_BY_TITLE_CACHE = new Map<string, ParsedAdvisor | null>();

/**
 * Resolve the advisor for a thread, trying the title first and falling back
 * to the persisted system prompt. Returns null for non-advisor threads.
 *
 * Title hits are memoised; system-prompt fallback is not (it only fires for
 * threads with overwritten titles, which is rare).
 */
export function findAdvisorForThread(input: {
  readonly title: string;
  readonly systemPrompt?: string | null;
}): ParsedAdvisor | null {
  const cached = ADVISOR_BY_TITLE_CACHE.get(input.title);
  if (cached !== undefined) {
    if (cached !== null) return cached;
    // Cached miss on the title path — still try the system prompt fallback
    // since the title may not have been a "Chat with …" string at all.
    if (input.systemPrompt) {
      return findAdvisorBySystemPrompt(input.systemPrompt);
    }
    return null;
  }
  const fromTitle = findAdvisorByThreadTitle(input.title);
  ADVISOR_BY_TITLE_CACHE.set(input.title, fromTitle);
  if (fromTitle) return fromTitle;
  if (input.systemPrompt) {
    return findAdvisorBySystemPrompt(input.systemPrompt);
  }
  return null;
}

/** Public path to the avatar PNG for an advisor id. */
export function advisorAvatarSrc(characterId: string): string {
  return `/characters/npcs/${characterId}.png`;
}
