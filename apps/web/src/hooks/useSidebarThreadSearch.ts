import type { ProjectId, ThreadId } from "@piedpiper/contracts";
import { useQueries } from "@tanstack/react-query";
import { useDeferredValue, useMemo } from "react";

import {
  normalizeSidebarSearchQuery,
  resolveSidebarThreadPr,
  searchSidebarThreads,
  sidebarSearchMayMatchPullRequest,
  type SidebarThreadSearchMatch,
} from "../components/Sidebar.logic";
import { sidebarGitStatusQueryOptions } from "../components/sidebar/sidebarGitStatusQuery";
import { useStore } from "../store";
import type { SidebarThreadSummary, Thread } from "../types";

const EMPTY_THREADS: readonly Thread[] = [];
const SIDEBAR_SNIPPET_OPTIONS = { maxLength: 120, leadContext: 36 } as const;
const SEARCH_GIT_STATUS_STALE_TIME_MS = 30_000;

function resolveThreadCwd(
  thread: SidebarThreadSummary,
  projectCwdById: ReadonlyMap<ProjectId, string>,
): string | null {
  return thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null;
}

/**
 * Client-side thread search for the sidebar. Full threads (with messages) are only
 * subscribed to while a query is active, so idle sidebars ignore streaming deltas.
 * Git status is read only for queries that can hit a PR, and a PR is known only while
 * the branch matches the cwd's checkout, as with the row badge.
 */
export function useSidebarThreadSearch(input: {
  query: string;
  orderedThreadIds: readonly ThreadId[];
  threadsById: Readonly<Record<string, SidebarThreadSummary>>;
  projectCwdById: ReadonlyMap<ProjectId, string>;
}): {
  normalizedQuery: string;
  matches: SidebarThreadSearchMatch<ThreadId>[];
} {
  const deferredQuery = useDeferredValue(input.query);
  const normalizedQuery = normalizeSidebarSearchQuery(deferredQuery);
  const isSearching = normalizedQuery.length > 0;
  // Deferred too: streaming deltas replace state.threads on every token.
  const threads = useDeferredValue(
    useStore((state) => (isSearching ? state.threads : EMPTY_THREADS)),
  );
  const { orderedThreadIds, threadsById, projectCwdById } = input;

  const searchesPullRequests = isSearching && sidebarSearchMayMatchPullRequest(normalizedQuery);
  const gitCwds = useMemo(() => {
    if (!searchesPullRequests) return [];
    const cwds = new Set<string>();
    for (const threadId of orderedThreadIds) {
      const thread = threadsById[threadId];
      const cwd =
        thread && thread.branch !== null ? resolveThreadCwd(thread, projectCwdById) : null;
      if (cwd !== null) cwds.add(cwd);
    }
    return [...cwds];
  }, [searchesPullRequests, orderedThreadIds, threadsById, projectCwdById]);
  const gitStatuses = useQueries({
    queries: gitCwds.map((cwd) => ({
      ...sidebarGitStatusQueryOptions(cwd),
      staleTime: SEARCH_GIT_STATUS_STALE_TIME_MS,
      refetchInterval: false as const,
      // Every distinct cwd is read here, so a window focus must not re-ask them all.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })),
    combine: (results) => results.map((result) => result.data),
  });

  const matches = useMemo(() => {
    if (!isSearching) return [];
    const messagesById = new Map(threads.map((thread) => [thread.id, thread.messages] as const));
    const orderedThreads = orderedThreadIds.flatMap((threadId) => {
      const thread = threadsById[threadId];
      return thread && thread.archivedAt === null ? [thread] : [];
    });
    const statusByCwd = new Map(gitCwds.map((cwd, index) => [cwd, gitStatuses[index]] as const));
    return searchSidebarThreads(
      orderedThreads,
      normalizedQuery,
      (threadId) => messagesById.get(threadId),
      SIDEBAR_SNIPPET_OPTIONS,
      (threadId) => {
        const thread = threadsById[threadId];
        if (!thread) return null;
        const cwd = resolveThreadCwd(thread, projectCwdById);
        return resolveSidebarThreadPr({
          branch: thread.branch,
          status: cwd === null ? null : statusByCwd.get(cwd),
        });
      },
    );
  }, [
    gitCwds,
    gitStatuses,
    isSearching,
    normalizedQuery,
    orderedThreadIds,
    projectCwdById,
    threads,
    threadsById,
  ]);

  return { normalizedQuery, matches };
}
