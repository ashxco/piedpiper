import { type ProjectId, type ThreadId } from "@piedpiper/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
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

/** Subscribe to the project list for user-facing pickers, counts and empty states. */
export function useUserProjects(): readonly Project[] {
  return useStore((state) => state.projects);
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
