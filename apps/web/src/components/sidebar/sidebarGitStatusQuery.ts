import { queryOptions } from "@tanstack/react-query";

import { gitQueryKeys } from "../../lib/gitReactQuery";
import { ensureNativeApi } from "../../nativeApi";

/**
 * Git status for rows that only glance at it: reads local refs and the PR, never fetches the
 * remote. Sits under the active key, so invalidating a cwd's status refreshes it too. Callers set
 * their own stale time and polling.
 */
export function sidebarGitStatusQueryOptions(cwd: string | null) {
  return queryOptions({
    queryKey: [...gitQueryKeys.status(cwd), "passive"] as const,
    queryFn: async ({ client }) => {
      if (!cwd) throw new Error("Git status is unavailable.");
      const status = await ensureNativeApi().git.status({ cwd, refreshUpstream: false });
      // Opening the thread shows this at once; updatedAt 0 makes its active query fetch anyway.
      // Only a real active read sets updatedAt, so a seed keeps following the polls until then.
      const activeKey = gitQueryKeys.status(cwd);
      if ((client.getQueryState(activeKey)?.dataUpdatedAt ?? 0) === 0) {
        client.setQueryData(activeKey, status, { updatedAt: 0 });
      }
      return status;
    },
    enabled: cwd !== null,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
}
