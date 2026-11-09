import type { FileDiffMetadata } from "@pierre/diffs";
import type { GitDiffPreviewResult, GitDiffPreviewScope } from "@piedpiper/contracts";

import { isTestChangedFile } from "~/lib/changedFileKind";
import { buildDiffFileCollapseKey } from "~/lib/diffCollapse";
import { buildDiffFindMatchKey, type DiffFindMatch } from "~/lib/diffFind";
import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";

import { extractTrailingReviewComments } from "../reviewCommentContext";

/** Per rendered block: a type change (file to symlink) is two blocks with the same path. */
export function buildDiffFileBlockKey(
  fileDiff: Pick<FileDiffMetadata, "name" | "prevName" | "type">,
): string {
  return `${buildDiffFileCollapseKey(fileDiff)}:${fileDiff.type}`;
}

/** An edit above a match moves its line number, so the line's text says which match it still is. */
function findFollowedDiffFindMatchIndex(
  active: DiffFindMatch,
  next: ReadonlyArray<DiffFindMatch>,
): number {
  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  let sameLineIndex = -1;
  for (const [index, candidate] of next.entries()) {
    if (
      candidate.fileKey !== active.fileKey ||
      candidate.side !== active.side ||
      candidate.occurrence !== active.occurrence
    ) {
      continue;
    }
    if (candidate.lineNumber === active.lineNumber) sameLineIndex = index;
    if (candidate.lineText !== active.lineText) continue;
    const distance = Math.abs(candidate.lineNumber - active.lineNumber);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  }
  // No line with its text left: the same spot is the line edited in place.
  return nearestIndex === -1 ? sameLineIndex : nearestIndex;
}

/** The key the panel last revealed, kept while a refresh only moves that match to `matchKey`. */
export interface DiffFindRevealAnchor {
  matchKey: string;
  anchorKey: string;
}

/** Follows the active match into a refreshed list; a match that is gone keeps its position. */
export function followDiffFindMatch(
  previous: ReadonlyArray<DiffFindMatch>,
  previousIndex: number,
  next: ReadonlyArray<DiffFindMatch>,
  anchor: DiffFindRevealAnchor | null,
): { index: number; anchor: DiffFindRevealAnchor | null } {
  // The stored index can sit past the end of a list that shrank; the shown match is the last one.
  const active = previous[Math.min(previousIndex, previous.length - 1)];
  if (!active) return { index: previousIndex, anchor };
  const index = findFollowedDiffFindMatchIndex(active, next);
  const followed = next[index];
  if (!followed) return { index: previousIndex, anchor };
  const fromKey = buildDiffFindMatchKey(active);
  const matchKey = buildDiffFindMatchKey(followed);
  if (matchKey === fromKey) return { index, anchor };
  return {
    index,
    anchor: { matchKey, anchorKey: anchor?.matchKey === fromKey ? anchor.anchorKey : fromKey },
  };
}

/** Stays put while a match only moves, so a refresh does not scroll the panel or unfold its file. */
export function resolveDiffFindRevealKey(
  activeMatchKey: string | null,
  anchor: DiffFindRevealAnchor | null,
): string | null {
  return anchor?.matchKey === activeMatchKey ? anchor.anchorKey : activeMatchKey;
}

export type DiffHeaderClickAction = "toggle" | "open" | "ignore";

/**
 * Walks a click's composed path outward. Header controls handle their own clicks, so toggling
 * here too would undo the chevron and collapse on copy; anything outside the header is left alone.
 */
export function resolveDiffHeaderClickAction(input: {
  path: ReadonlyArray<EventTarget>;
  metaKey: boolean;
  ctrlKey: boolean;
}): DiffHeaderClickAction {
  for (const node of input.path) {
    const element = node as Partial<Pick<Element, "hasAttribute" | "matches">>;
    if (!element.hasAttribute || !element.matches) continue;
    if (element.matches("button, a, input, select, textarea")) return "ignore";
    if (element.hasAttribute("data-diffs-header")) {
      return input.metaKey || input.ctrlKey ? "open" : "toggle";
    }
  }
  return "ignore";
}

/** What the panel shows: checkpoint diffs of the turns, or live git changes. */
export type DiffPanelScope = "turns" | "tool" | GitDiffPreviewScope;

/** A thread with no turns has no checkpoints to show, so it opens on the working tree. */
export function resolveDiffPanelScope(input: {
  requestedScope: GitDiffPreviewScope | undefined;
  hasTurns: boolean;
}): DiffPanelScope {
  return input.requestedScope ?? (input.hasTurns ? "turns" : "uncommitted");
}

/** The section part of the collapse scope key; never collides with a turn id's own section. */
export function resolveDiffCollapseSection(
  scope: DiffPanelScope,
  selectedTurnId: string | null,
): string | null {
  return scope === "turns" ? selectedTurnId : `scope:${scope}`;
}

/**
 * Changes as soon as the turn, branch or commit count moves on, which refetches straight away.
 * The counts miss an untracked file's edits and a same-size edit; the query's interval catches those.
 */
export function buildGitDiffPreviewCacheScope(input: {
  latestTurnId: string | null;
  status:
    | {
        branch: string | null;
        aheadCount: number;
        workingTree: { files: ReadonlyArray<unknown>; insertions: number; deletions: number };
      }
    | undefined;
}): string {
  const { latestTurnId, status } = input;
  const statusKey = status
    ? [
        status.branch ?? "",
        status.aheadCount,
        status.workingTree.files.length,
        status.workingTree.insertions,
        status.workingTree.deletions,
      ].join(":")
    : "";
  return `${latestTurnId ?? ""}|${statusKey}`;
}

export function resolveGitDiffPreviewEmptyMessage(input: {
  scope: GitDiffPreviewScope;
  result: Pick<GitDiffPreviewResult, "baseRef" | "truncated" | "untrackedIncomplete"> | undefined;
  ignoreWhitespace: boolean;
}): string {
  if (!input.result) return "No patch available for this selection.";
  if (input.result.truncated) return "This diff is too large to show.";
  // Claiming nothing changed would be false when untracked files never made it into the patch.
  if (input.result.untrackedIncomplete) {
    return "No tracked changes here. Untracked files are left out of this diff.";
  }
  const whitespaceSuffix = input.ignoreWhitespace ? " (whitespace hidden)" : "";
  if (input.scope === "commit") return `No changes in this commit${whitespaceSuffix}.`;
  if (input.scope === "uncommitted") return `No uncommitted changes${whitespaceSuffix}.`;
  if (input.result.baseRef === null) {
    return `No base branch, and no uncommitted changes${whitespaceSuffix}.`;
  }
  return `No changes compared to ${input.result.baseRef}${whitespaceSuffix}.`;
}

export function resolveGitDiffPreviewNotices(
  result: Pick<GitDiffPreviewResult, "truncated" | "untrackedIncomplete" | "baseRef"> | undefined,
  scope: GitDiffPreviewScope | null,
): string[] {
  if (!result) return [];
  const notices: string[] = [];
  if (result.baseRef !== null) notices.push(`Compared to ${result.baseRef}.`);
  else if (scope === "branch") notices.push("No base branch; showing uncommitted changes.");
  if (result.truncated)
    notices.push("This diff is too large to show in full; later files are left out.");
  if (result.untrackedIncomplete) notices.push("Untracked files are left out of this diff.");
  return notices;
}

/**
 * Hiding is display-only and never hides the file the panel was asked to reveal, or the one holding
 * the open comment form, whose text would otherwise vanish and silently block new selections.
 */
export function isDiffFileShown(input: {
  filePath: string;
  hideTestFiles: boolean;
  selectedFilePath: string | null;
  draftFilePath?: string | null | undefined;
}): boolean {
  return (
    !input.hideTestFiles ||
    input.filePath === input.selectedFilePath ||
    input.filePath === input.draftFilePath ||
    !isTestChangedFile(input.filePath)
  );
}

/** Paths, not blocks: a test file replaced by a symlink is two blocks but one file. */
export function countDiffTestFiles(paths: ReadonlyArray<string>): number {
  return new Set(paths.filter(isTestChangedFile)).size;
}

/** Without the prompt markup a review comment or terminal context carries; a comment-only turn gets a label. */
export function resolveTurnPickerMessageLabel(text: string): string {
  const visibleText = deriveDisplayedUserMessageState(text).visibleText.trim();
  if (visibleText.length > 0) return visibleText.slice(0, 80);
  const hasReviewComments = extractTrailingReviewComments(text).comments.length > 0;
  return hasReviewComments ? "Review comments" : "";
}

/** Identifies the diff a review comment's line numbers belong to. */
export function resolveDiffReviewSection(input: {
  scope: DiffPanelScope;
  selectedTurnId: string | null;
  selectedTurnLabel: string;
  selectionId?: string | undefined;
}): { sectionId: string; sectionTitle: string } {
  if (input.scope === "tool")
    return { sectionId: `tool:${input.selectionId}`, sectionTitle: "Tool edit" };
  if (input.scope === "commit")
    return {
      sectionId: `commit:${input.selectionId}`,
      sectionTitle: `Commit ${input.selectionId?.slice(0, 8)}`,
    };
  if (input.scope === "uncommitted") {
    return { sectionId: "uncommitted", sectionTitle: "Uncommitted changes" };
  }
  if (input.scope === "branch") return { sectionId: "branch", sectionTitle: "Branch changes" };
  return input.selectedTurnId === null
    ? { sectionId: "conversation", sectionTitle: "All turns" }
    : { sectionId: `turn:${input.selectedTurnId}`, sectionTitle: input.selectedTurnLabel };
}

export function resolveEmptyDiffMessage(input: {
  hasNoNetChanges: boolean;
  ignoreWhitespace: boolean;
  /** Whether the selection's exact (whitespace-aware) summary lists changed files; undefined when unknown. */
  selectionHasFileChanges: boolean | undefined;
}): string {
  if (!input.hasNoNetChanges) return "No patch available for this selection.";
  if (input.ignoreWhitespace && input.selectionHasFileChanges === undefined) {
    return "No changes (whitespace hidden).";
  }
  if (input.ignoreWhitespace && input.selectionHasFileChanges) {
    return "Only whitespace changes (hidden).";
  }
  return "No net changes in this selection.";
}
