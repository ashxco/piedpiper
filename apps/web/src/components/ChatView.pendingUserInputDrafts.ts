import { create } from "zustand";

import type { PendingUserInputDraftAnswer } from "../pendingUserInput";

export type PendingUserInputAnswersByKey = Record<
  string,
  Record<string, PendingUserInputDraftAnswer>
>;
export type PendingUserInputQuestionIndexByKey = Record<string, number>;

/** Thread-scoped so one thread's resolved requests can be pruned without touching others. */
export function pendingUserInputDraftKey(threadId: string, requestId: string): string {
  return JSON.stringify([threadId, requestId]);
}

function parseDraftKey(key: string): readonly [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
      ? [parsed[0], parsed[1]]
      : null;
  } catch {
    return null;
  }
}

/** Drops a thread's drafts whose request is no longer open; returns the same object when unchanged. */
export function pruneResolvedUserInputDrafts<T>(
  drafts: Record<string, T>,
  threadId: string,
  openRequestIds: ReadonlySet<string>,
): Record<string, T> {
  let next: Record<string, T> | null = null;
  for (const key of Object.keys(drafts)) {
    const parsed = parseDraftKey(key);
    if (!parsed || parsed[0] !== threadId || openRequestIds.has(parsed[1])) continue;
    next ??= { ...drafts };
    delete next[key];
  }
  return next ?? drafts;
}

type Updater<T> = (current: T) => T;

interface PendingUserInputDraftStore {
  answers: PendingUserInputAnswersByKey;
  questionIndex: PendingUserInputQuestionIndexByKey;
  updateAnswers: (updater: Updater<PendingUserInputAnswersByKey>) => void;
  updateQuestionIndex: (updater: Updater<PendingUserInputQuestionIndexByKey>) => void;
  pruneThread: (threadId: string, openRequestIds: ReadonlySet<string>) => void;
}

/** Module-level so typed answers survive ChatView remounts (e.g. opening Settings and coming back). */
export const usePendingUserInputDraftStore = create<PendingUserInputDraftStore>((set) => ({
  answers: {},
  questionIndex: {},
  updateAnswers: (updater) => set((state) => ({ answers: updater(state.answers) })),
  updateQuestionIndex: (updater) =>
    set((state) => ({ questionIndex: updater(state.questionIndex) })),
  pruneThread: (threadId, openRequestIds) =>
    set((state) => {
      const answers = pruneResolvedUserInputDrafts(state.answers, threadId, openRequestIds);
      const questionIndex = pruneResolvedUserInputDrafts(
        state.questionIndex,
        threadId,
        openRequestIds,
      );
      return answers === state.answers && questionIndex === state.questionIndex
        ? state
        : { answers, questionIndex };
    }),
}));
