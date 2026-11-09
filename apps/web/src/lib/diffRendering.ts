import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

const DIFF_THEME_NAMES = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return theme === "dark" ? DIFF_THEME_NAMES.dark : DIFF_THEME_NAMES.light;
}

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32,
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

export function buildPatchCacheKey(patch: string, scope = "diff-panel"): string {
  const primary = fnv1a32(patch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(patch, SECONDARY_HASH_SEED, SECONDARY_HASH_MULTIPLIER).toString(36);
  return `${scope}:${patch.length}:${primary}:${secondary}`;
}

function buildFileCacheKey(file: FileDiffMetadata, scope: string): string {
  const identity = [
    file.name,
    file.prevName ?? "",
    file.type,
    file.mode ?? "",
    file.prevMode ?? "",
    ...file.hunks.map((hunk) => hunk.hunkSpecs ?? ""),
  ].join("\u0000");
  const contents = `${file.deletionLines.join("")}\u0000${file.additionLines.join("")}`;
  return buildPatchCacheKey(`${identity}\u0000${contents}`, scope);
}

export type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

// Only the emptiness check trims: trailing whitespace belongs to the last hunk's lines.
export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch?.trim()) return null;

  try {
    const parsedPatches = parsePatchFiles(patch);
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      // Per file, so a refreshed patch only re-renders and remounts the files that changed.
      const occurrences = new Map<string, number>();
      for (const file of files) {
        const key = buildFileCacheKey(file, cacheScope);
        const occurrence = occurrences.get(key) ?? 0;
        occurrences.set(key, occurrence + 1);
        file.cacheKey = occurrence === 0 ? key : `${key}:${occurrence}`;
      }
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: patch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: patch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

/**
 * Carries over the parsed object of every file whose contents did not change, so a refreshed patch
 * does not make those viewers re-render, which also detaches their comment forms and loses focus.
 */
export function reuseUnchangedDiffFiles(
  previous: ReadonlyArray<FileDiffMetadata>,
  next: ReadonlyArray<FileDiffMetadata>,
): ReadonlyArray<FileDiffMetadata> {
  const previousByKey = new Map(previous.map((file) => [file.cacheKey, file] as const));
  const reused = next.map((file) => previousByKey.get(file.cacheKey) ?? file);
  const unchanged =
    reused.length === previous.length && reused.every((file, index) => file === previous[index]);
  return unchanged ? previous : reused;
}

export interface DiffLineStat {
  additions: number;
  deletions: number;
}

export function getDiffLineStat(files: ReadonlyArray<FileDiffMetadata>): DiffLineStat {
  const total: DiffLineStat = { additions: 0, deletions: 0 };
  for (const file of files) {
    for (const hunk of file.hunks) {
      total.additions += hunk.additionLines;
      total.deletions += hunk.deletionLines;
    }
  }
  return total;
}
