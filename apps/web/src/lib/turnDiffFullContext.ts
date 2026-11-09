import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import type { OrchestrationGetTurnDiffFileContentsResult, ThreadId } from "@piedpiper/contracts";
import { queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "../nativeApi";
import { providerQueryKeys } from "./providerReactQuery";

// Re-diffing runs on the main thread and its cost grows with the square of the changed lines.
export const TURN_DIFF_FULL_CONTEXT_MAX_CHANGED_LINES = 5_000;

type TurnDiffFileContents = Pick<
  OrchestrationGetTurnDiffFileContentsResult,
  "oldContents" | "newContents" | "unavailableReason"
>;

/** What `git diff -w` ignores: all whitespace, where jsdiff's `ignoreWhitespace` only trims line ends. */
export function linesEqualIgnoringWhitespace(left: string, right: string): boolean {
  return left.replace(/\s+/g, "") === right.replace(/\s+/g, "");
}

export function turnDiffFileContentsQueryOptions(input: {
  threadId: ThreadId | null;
  fromTurnCount: number | null;
  toTurnCount: number | null;
  path: string;
  previousPath?: string | undefined;
  cacheScope: string | null;
}) {
  const { threadId, fromTurnCount, toTurnCount, path, previousPath } = input;
  return queryOptions({
    queryKey: [
      ...providerQueryKeys.all,
      "turnDiffFileContents",
      threadId,
      fromTurnCount,
      toTurnCount,
      path,
      previousPath ?? null,
      input.cacheScope,
    ] as const,
    queryFn: async () => {
      if (threadId === null || fromTurnCount === null || toTurnCount === null) {
        throw new Error("Full context is unavailable.");
      }
      return ensureNativeApi().orchestration.getTurnDiffFileContents({
        threadId,
        fromTurnCount,
        toTurnCount,
        path,
        ...(previousPath === undefined ? {} : { previousPath }),
      });
    },
    enabled: threadId !== null && fromTurnCount !== null && toTurnCount !== null,
    // A checkpoint's contents never change, and the cache scope separates reused turn counts.
    staleTime: Infinity,
    retry: 1,
  });
}

/** New, deleted and pure-rename diffs have no unchanged lines to reveal. */
export function canShowTurnDiffFullContext(
  fileDiff: Pick<FileDiffMetadata, "type" | "hunks" | "isPartial">,
): boolean {
  if (!fileDiff.isPartial || fileDiff.hunks.length === 0) return false;
  if (fileDiff.type !== "change" && fileDiff.type !== "rename-changed") return false;
  let changedLines = 0;
  for (const hunk of fileDiff.hunks) {
    changedLines += hunk.additionLines + hunk.deletionLines;
  }
  return changedLines <= TURN_DIFF_FULL_CONTEXT_MAX_CHANGED_LINES;
}

export function isTurnDiffRename(fileDiff: Pick<FileDiffMetadata, "type">): boolean {
  return fileDiff.type === "rename-changed" || fileDiff.type === "rename-pure";
}

// Query data keeps its identity, so a re-render reuses the parse and the viewer does not remount.
const fullContextFilesByContents = new WeakMap<
  Pick<TurnDiffFileContents, "oldContents" | "newContents">,
  Map<string, FileDiffMetadata | null>
>();

/** Null when the contents cannot reproduce a diff. Identity fields stay git's own. */
export function buildTurnDiffFullContextFile(input: {
  fileDiff: FileDiffMetadata;
  oldPath: string;
  newPath: string;
  contents: Pick<TurnDiffFileContents, "oldContents" | "newContents">;
  ignoreWhitespace: boolean;
}): FileDiffMetadata | null {
  const { fileDiff, contents, ignoreWhitespace } = input;
  const { oldContents, newContents } = contents;
  // Only files with both sides get here, so a missing side is a failed read, not an empty file.
  if (oldContents === null || newContents === null) return null;

  const baseKey = fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
  const memoKey = `${baseKey}:${ignoreWhitespace}`;
  let memo = fullContextFilesByContents.get(contents);
  if (!memo) {
    memo = new Map();
    fullContextFilesByContents.set(contents, memo);
  }
  const cached = memo.get(memoKey);
  if (cached !== undefined) return cached;

  let result: FileDiffMetadata | null = null;
  try {
    const parsed = parseDiffFromFile(
      { name: input.oldPath, contents: oldContents },
      { name: input.newPath, contents: newContents },
      // Three lines match git's hunks, so the rows a review comment anchors to stay put.
      { context: 3, ...(ignoreWhitespace ? { comparator: linesEqualIgnoringWhitespace } : {}) },
      true,
    );
    if (parsed.hunks.length > 0) {
      result = {
        ...fileDiff,
        hunks: parsed.hunks,
        splitLineCount: parsed.splitLineCount,
        unifiedLineCount: parsed.unifiedLineCount,
        additionLines: parsed.additionLines,
        deletionLines: parsed.deletionLines,
        isPartial: parsed.isPartial,
        cacheKey: `${baseKey}:full-context`,
      };
    }
  } catch {
    result = null;
  }
  memo.set(memoKey, result);
  return result;
}

export type TurnDiffFullContextState =
  | { readonly kind: "loading" }
  | { readonly kind: "on"; readonly file: FileDiffMetadata }
  | { readonly kind: "unavailable"; readonly detail: string };

export function resolveTurnDiffFullContextState(input: {
  fileDiff: FileDiffMetadata;
  oldPath: string;
  newPath: string;
  ignoreWhitespace: boolean;
  data: TurnDiffFileContents | undefined;
  error: unknown;
}): TurnDiffFullContextState {
  const { data, error } = input;
  if (data) {
    if (data.unavailableReason === "binary") {
      return { kind: "unavailable", detail: "Binary files cannot show full context." };
    }
    if (data.unavailableReason === "too-large") {
      return { kind: "unavailable", detail: "This file is too large to show in full." };
    }
    const file = buildTurnDiffFullContextFile({
      fileDiff: input.fileDiff,
      oldPath: input.oldPath,
      newPath: input.newPath,
      contents: data,
      ignoreWhitespace: input.ignoreWhitespace,
    });
    return file
      ? { kind: "on", file }
      : { kind: "unavailable", detail: "Full context is unavailable for this file." };
  }
  if (error) {
    return {
      kind: "unavailable",
      detail: error instanceof Error ? error.message : "Could not load this file's contents.",
    };
  }
  return { kind: "loading" };
}

/** The files showing full context, tied to the view they were turned on in. */
export interface TurnDiffFullContextSelection {
  readonly scopeKey: string;
  readonly paths: ReadonlySet<string>;
}

const NO_PATHS: ReadonlySet<string> = new Set();

export function resolveTurnDiffFullContextPaths(
  selection: TurnDiffFullContextSelection | null,
  scopeKey: string | null,
): ReadonlySet<string> {
  return selection !== null && selection.scopeKey === scopeKey ? selection.paths : NO_PATHS;
}

export function toggleTurnDiffFullContextPath(
  selection: TurnDiffFullContextSelection | null,
  scopeKey: string,
  path: string,
): TurnDiffFullContextSelection {
  const paths = new Set(resolveTurnDiffFullContextPaths(selection, scopeKey));
  if (!paths.delete(path)) paths.add(path);
  return { scopeKey, paths };
}

/** Null outside the turn views. Any change of turn, range or whitespace mode drops the selection. */
export function buildTurnDiffFullContextScopeKey(input: {
  threadId: string | null;
  range: { fromTurnCount: number; toTurnCount: number } | null;
  cacheScope: string | null;
  ignoreWhitespace: boolean;
}): string | null {
  if (input.threadId === null || input.range === null) return null;
  return [
    input.threadId,
    input.range.fromTurnCount,
    input.range.toTurnCount,
    input.cacheScope ?? "",
    input.ignoreWhitespace,
  ].join("|");
}
