import type { FileDiffMetadata } from "@pierre/diffs";

/** Theme-independent per-file key (the parsed cacheKey embeds the theme). */
export function buildDiffFileCollapseKey(fileDiff: Pick<FileDiffMetadata, "name" | "prevName">) {
  return `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

/** Scopes by thread plus section, so new turns in the all-turns view keep the collapse set. */
export function buildDiffCollapseScopeKey(
  threadId: string | null,
  selectedTurnId: string | null,
): string | null {
  if (threadId === null) return null;
  return `${threadId}:${selectedTurnId === null ? "conversation" : `turn:${selectedTurnId}`}`;
}

export function areAllDiffFilesCollapsed(
  fileKeys: ReadonlyArray<string>,
  collapsedFileKeys: ReadonlySet<string>,
): boolean {
  return fileKeys.length > 0 && fileKeys.every((fileKey) => collapsedFileKeys.has(fileKey));
}

export interface ScopedDiffCollapseState {
  scopeKey: string | null;
  /** Scope-wide default from collapse/expand all; null follows the setting. */
  collapsedByDefault: boolean | null;
  /** Files whose state differs from the scope default, so files added later get the default. */
  overrides: ReadonlySet<string>;
}

function resolveScopedState(
  current: ScopedDiffCollapseState | null,
  scopeKey: string | null,
): ScopedDiffCollapseState {
  return current !== null && current.scopeKey === scopeKey
    ? current
    : { scopeKey, collapsedByDefault: null, overrides: new Set() };
}

export function isDiffFileCollapsed(
  current: ScopedDiffCollapseState | null,
  scopeKey: string | null,
  fileKey: string,
  collapsedBySetting: boolean,
): boolean {
  const state = resolveScopedState(current, scopeKey);
  return (state.collapsedByDefault ?? collapsedBySetting) !== state.overrides.has(fileKey);
}

export function resolveCollapsedDiffFileKeys(
  current: ScopedDiffCollapseState | null,
  scopeKey: string | null,
  fileKeys: ReadonlyArray<string>,
  collapsedBySetting: boolean,
): ReadonlySet<string> {
  return new Set(
    fileKeys.filter((fileKey) =>
      isDiffFileCollapsed(current, scopeKey, fileKey, collapsedBySetting),
    ),
  );
}

export function toggleScopedDiffFile(
  current: ScopedDiffCollapseState | null,
  scopeKey: string | null,
  fileKey: string,
): ScopedDiffCollapseState {
  const state = resolveScopedState(current, scopeKey);
  const overrides = new Set(state.overrides);
  if (overrides.has(fileKey)) {
    overrides.delete(fileKey);
  } else {
    overrides.add(fileKey);
  }
  return { ...state, overrides };
}

/** Returns `current` unchanged when the file is already expanded. */
export function expandScopedDiffFile(
  current: ScopedDiffCollapseState | null,
  scopeKey: string | null,
  fileKey: string,
  collapsedBySetting: boolean,
): ScopedDiffCollapseState | null {
  if (!isDiffFileCollapsed(current, scopeKey, fileKey, collapsedBySetting)) return current;
  return toggleScopedDiffFile(current, scopeKey, fileKey);
}

export function setAllScopedDiffFilesCollapsed(
  scopeKey: string | null,
  collapsed: boolean,
): ScopedDiffCollapseState {
  return { scopeKey, collapsedByDefault: collapsed, overrides: new Set() };
}
