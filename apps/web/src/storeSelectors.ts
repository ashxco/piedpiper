import { ADVISORS_PROJECT_ID, type ProjectId, type ThreadId } from "@piedpiper/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { findAdvisorForThread } from "./lib/advisorIdentity";
import { type AppState, useStore } from "./store";
import {
  type Project,
  type SidebarThreadSummary,
  type Thread,
  type ToolInputStream,
} from "./types";

const EMPTY_TOOL_INPUT_PREVIEWS: Record<string, ToolInputStream> = {};

export function useProjectById(projectId: Project["id"] | null | undefined): Project | undefined {
  const selector = useMemo(
    () =>
      (state: AppState): Project | undefined =>
        projectId ? state.projects.find((project) => project.id === projectId) : undefined,
    [projectId],
  );
  return useStore(selector);
}

export function useThreadById(threadId: ThreadId | null | undefined): Thread | undefined {
  const selector = useMemo(
    () =>
      (state: AppState): Thread | undefined =>
        threadId ? state.threads.find((thread) => thread.id === threadId) : undefined,
    [threadId],
  );
  return useStore(selector);
}

export function useSidebarThreadSummaryById(
  threadId: ThreadId | null | undefined,
): SidebarThreadSummary | undefined {
  const selector = useMemo(
    () =>
      (state: AppState): SidebarThreadSummary | undefined =>
        threadId ? state.sidebarThreadsById[threadId] : undefined,
    [threadId],
  );
  return useStore(selector);
}

/**
 * Subscribe to the list of server thread ids with shallow equality.
 *
 * Components that only care about which threads exist (not their full state)
 * should use this rather than `useStore((s) => s.threads)`. Thread events are
 * the most frequent store mutation in the app — broad thread subscribers
 * re-render on every streaming chunk, while id-list subscribers only re-render
 * when a thread is actually created, removed, or reordered.
 */
export function useAllThreadIds(): readonly ThreadId[] {
  return useStore(useShallow((state) => state.threads.map((thread) => thread.id)));
}

/**
 * Subscribe to the list of project ids with shallow equality. See
 * {@link useAllThreadIds} for the rationale.
 */
export function useAllProjectIds(): readonly ProjectId[] {
  return useStore(useShallow((state) => state.projects.map((project) => project.id)));
}

/**
 * Subscribe to user-owned projects only — excludes the hidden Advisors
 * workspace. Use this for any user-facing project list (dropdowns, pickers,
 * counts, empty states). Raw `store.projects` includes system-level projects
 * and should only be used in internal logic.
 */
export function useUserProjects(): readonly Project[] {
  return useStore(
    useShallow((state) => state.projects.filter((project) => project.id !== ADVISORS_PROJECT_ID)),
  );
}

/**
 * Subscribe to the ordered list of thread ids belonging to the hidden Advisors
 * project that map to a specific advisor character. Sorted newest-first by
 * `updatedAt ?? createdAt`.
 *
 * Returns a `ThreadId[]` (primitive elements), so `useShallow` can do correct
 * element-wise === comparison and the subscription only re-renders when the
 * filtered set actually changes (not on every streaming chunk in an unrelated
 * thread). Consumers render one child component per id and let each child
 * subscribe to its own thread via {@link useThreadById}, so per-row updates
 * stay local to that row.
 */
export function useAdvisorThreadIds(advisorId: string | null | undefined): readonly ThreadId[] {
  const selector = useMemo(
    () => (state: AppState) => {
      if (!advisorId) return [] as ThreadId[];
      const matched: { id: ThreadId; sortKey: string }[] = [];
      for (const thread of state.threads) {
        if (thread.projectId !== ADVISORS_PROJECT_ID) continue;
        const parsed = findAdvisorForThread({
          title: thread.title,
          ...(thread.systemPrompt != null ? { systemPrompt: thread.systemPrompt } : {}),
        });
        if (!parsed || parsed.id !== advisorId) continue;
        matched.push({ id: thread.id, sortKey: thread.updatedAt ?? thread.createdAt });
      }
      matched.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
      return matched.map((entry) => entry.id);
    },
    [advisorId],
  );
  return useStore(useShallow(selector));
}

/**
 * Subscribe to the per-thread tool-input preview map. Returns a stable empty
 * object reference when no previews exist for the thread to avoid spurious
 * re-renders. Uses shallow equality so additions and removals to the inner
 * record trigger updates without re-rendering on unrelated thread changes.
 */
export function useToolInputPreviews(
  threadId: string | undefined,
): Record<string, ToolInputStream> {
  return useStore(
    useShallow((state) =>
      threadId
        ? (state.toolInputPreviews[threadId] ?? EMPTY_TOOL_INPUT_PREVIEWS)
        : EMPTY_TOOL_INPUT_PREVIEWS,
    ),
  );
}
