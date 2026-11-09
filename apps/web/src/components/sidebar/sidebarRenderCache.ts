import type { ProjectId, ThreadId } from "@piedpiper/contracts";

/** Element-wise identity comparison for derived arrays. */
export function arrayElementsEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export interface RenderedProjectInputs<TProject, TThread> {
  project: TProject;
  /** Project threads in index order, archived excluded. */
  threads: readonly TThread[];
  /** Parallel to `threads`. */
  lastVisitedAts: readonly (string | undefined)[];
  /** Parallel to `threads`: whether each thread is pinned. */
  pinnedFlags?: readonly boolean[];
  /** Parallel to `threads`: whether each thread is hidden in the snoozed shelf right now. */
  snoozedFlags?: readonly boolean[];
  /** Parallel to `threads`: when each shelved thread wakes, so re-snoozing re-sorts the shelf. */
  snoozedUntils?: readonly (string | undefined)[];
  sortOrder: string;
  /** Unpinned threads shown before the "Show more" fold. */
  previewLimit?: number;
  routeThreadId: ThreadId | null;
  isThreadListExpanded: boolean;
  draftThreadId: ThreadId | null;
}

export function renderedProjectInputsEqual<TProject, TThread>(
  left: RenderedProjectInputs<TProject, TThread>,
  right: RenderedProjectInputs<TProject, TThread>,
): boolean {
  return (
    left.project === right.project &&
    left.sortOrder === right.sortOrder &&
    left.previewLimit === right.previewLimit &&
    left.routeThreadId === right.routeThreadId &&
    left.isThreadListExpanded === right.isThreadListExpanded &&
    left.draftThreadId === right.draftThreadId &&
    arrayElementsEqual(left.threads, right.threads) &&
    arrayElementsEqual(left.lastVisitedAts, right.lastVisitedAts) &&
    arrayElementsEqual(left.pinnedFlags ?? [], right.pinnedFlags ?? []) &&
    arrayElementsEqual(left.snoozedFlags ?? [], right.snoozedFlags ?? []) &&
    arrayElementsEqual(left.snoozedUntils ?? [], right.snoozedUntils ?? [])
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shallowRecordEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key]);
}

/**
 * Carry over fields of a recomputed result that are equal to the previous one
 * (same-element arrays, shallow-equal records) and return the previous result
 * itself when nothing differs, so memoized consumers keep skipping renders.
 */
export function reuseEqualResultFields<TResult>(previous: TResult, next: TResult): TResult {
  if (previous === next || !isPlainRecord(previous) || !isPlainRecord(next)) return next;
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  let changed = previousKeys.length !== nextKeys.length;
  let merged: Record<string, unknown> | null = null;
  for (const key of nextKeys) {
    const before = previous[key];
    const after = next[key];
    if (before === after) continue;
    const reusable =
      Object.hasOwn(previous, key) &&
      ((Array.isArray(before) && Array.isArray(after) && arrayElementsEqual(before, after)) ||
        (isPlainRecord(before) && isPlainRecord(after) && shallowRecordEqual(before, after)));
    if (reusable) {
      merged ??= { ...next };
      merged[key] = before;
    } else {
      changed = true;
    }
  }
  if (!changed) return previous;
  return (merged ?? next) as TResult;
}

interface RenderedProjectCacheEntry<TProject, TThread, TResult> {
  inputs: RenderedProjectInputs<TProject, TThread>;
  result: TResult;
}

/**
 * Per-project memo for the sidebar's rendered-project derivation. A streaming
 * delta changes one thread summary, so only that thread's project recomputes;
 * every other project keeps its previous result object and its memoized item
 * skips the re-render.
 */
export class RenderedProjectCache<TProject, TThread, TResult> {
  private readonly entries = new Map<
    ProjectId,
    RenderedProjectCacheEntry<TProject, TThread, TResult>
  >();

  resolve(
    projectId: ProjectId,
    inputs: RenderedProjectInputs<TProject, TThread>,
    compute: (inputs: RenderedProjectInputs<TProject, TThread>) => TResult,
  ): TResult {
    const cached = this.entries.get(projectId);
    if (cached !== undefined && renderedProjectInputsEqual(cached.inputs, inputs)) {
      return cached.result;
    }
    const computed = compute(inputs);
    const result =
      cached === undefined ? computed : reuseEqualResultFields(cached.result, computed);
    this.entries.set(projectId, { inputs, result });
    return result;
  }

  /** Drop projects that no longer render so removed projects don't pin memory. */
  retainOnly(projectIds: ReadonlySet<ProjectId>): void {
    for (const projectId of this.entries.keys()) {
      if (!projectIds.has(projectId)) {
        this.entries.delete(projectId);
      }
    }
  }
}
