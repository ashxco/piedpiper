import type { GitStatusResult } from "@piedpiper/contracts";

import { resolveSidebarThreadPr } from "./Sidebar.logic";

export interface ThreadReferenceCopyTarget {
  readonly value: string;
  readonly successTitle: string;
  readonly failureTitle: string;
}

/**
 * What mod+shift+C copies: the PR link while the checkout is on the thread's branch, else the
 * thread ID. Status still loading also means the thread ID, since the toast names what was copied.
 */
export function resolveThreadReferenceCopyTarget(input: {
  readonly threadId: string;
  readonly threadBranch: string | null;
  readonly status: Pick<GitStatusResult, "branch" | "pr"> | null | undefined;
}): ThreadReferenceCopyTarget {
  const pullRequestUrl = resolveSidebarThreadPr({
    branch: input.threadBranch,
    status: input.status,
  })?.url;
  return pullRequestUrl
    ? {
        value: pullRequestUrl,
        successTitle: "PR link copied",
        failureTitle: "Failed to copy PR link",
      }
    : {
        value: input.threadId,
        successTitle: "Thread ID copied",
        failureTitle: "Failed to copy thread ID",
      };
}
