import type { ModelSelection, ProviderKind, ThreadId } from "@piedpiper/contracts";
import { create } from "zustand";

export interface ComposerModelRef {
  readonly provider: ProviderKind;
  readonly model: string;
}

export function isSameComposerModel(a: ComposerModelRef, b: ComposerModelRef): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/**
 * Shift-click on a model. Starting from one model adds to it; dropping back below two returns
 * to ordinary single-model sending with `single` as the selected model.
 */
export function toggleComposerMultiModelSelection(input: {
  current: ReadonlyArray<ModelSelection> | null;
  primary: ModelSelection;
  toggled: ComposerModelRef;
}): { selections: ReadonlyArray<ModelSelection> | null; single: ModelSelection | null } {
  const base = input.current ?? [input.primary];
  const next = base.some((selection) => isSameComposerModel(selection, input.toggled))
    ? base.filter((selection) => !isSameComposerModel(selection, input.toggled))
    : [...base, { provider: input.toggled.provider, model: input.toggled.model } as ModelSelection];
  if (next.length > 1) return { selections: next, single: null };
  return { selections: null, single: next[0] ?? input.primary };
}

/** Says where a multi-model send will run, which the footer has no other control for. */
export function formatComposerMultiModelNotice(
  modelCount: number,
  baseBranch: string | null | undefined,
): string {
  const target = baseBranch ? `a new worktree from ${baseBranch}` : "a new worktree";
  return modelCount === 1
    ? `Sends in ${target}`
    : `Sends to ${modelCount} models, each in ${target}`;
}

interface ComposerMultiModelState {
  /** A key means the draft sends to these models, each in a new worktree; absent means one model. */
  selectionsByThreadId: Readonly<Record<string, ReadonlyArray<ModelSelection>>>;
}

/** In memory on purpose: a reload returns the draft to its single selected model. */
export const useComposerMultiModelStore = create<ComposerMultiModelState>(() => ({
  selectionsByThreadId: {},
}));

export function readComposerMultiModelSelections(
  threadId: ThreadId,
): ReadonlyArray<ModelSelection> | null {
  return useComposerMultiModelStore.getState().selectionsByThreadId[threadId] ?? null;
}

export function setComposerMultiModelSelections(
  threadId: ThreadId,
  selections: ReadonlyArray<ModelSelection> | null,
): void {
  useComposerMultiModelStore.setState((state) => {
    const { [threadId]: _previous, ...rest } = state.selectionsByThreadId;
    return { selectionsByThreadId: selections ? { ...rest, [threadId]: selections } : rest };
  });
}
