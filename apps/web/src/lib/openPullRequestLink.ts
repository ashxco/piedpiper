import type { GitStatusResult } from "@piedpiper/contracts";
import type { MouseEvent } from "react";

import { toastManager } from "../components/ui/toast";
import { readNativeApi } from "../nativeApi";

type GitStatusPr = NonNullable<GitStatusResult["pr"]>;

export interface PrStatusIndicator {
  label: "PR open" | "PR draft" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

const PR_STATUS_PRESENTATION: Record<
  GitStatusPr["state"],
  Pick<PrStatusIndicator, "label" | "colorClass">
> = {
  open: { label: "PR open", colorClass: "text-emerald-600 dark:text-emerald-300/90" },
  closed: { label: "PR closed", colorClass: "text-zinc-500 dark:text-zinc-400/80" },
  merged: { label: "PR merged", colorClass: "text-violet-600 dark:text-violet-300/90" },
};

const PR_DRAFT_PRESENTATION: Pick<PrStatusIndicator, "label" | "colorClass"> = {
  label: "PR draft",
  colorClass: "text-zinc-500 dark:text-zinc-400/80",
};

export function prStatusIndicator(pr: GitStatusPr | null | undefined) {
  if (!pr) return null;
  const isOpenDraft = pr.state === "open" && pr.isDraft === true;
  const presentation = isOpenDraft ? PR_DRAFT_PRESENTATION : PR_STATUS_PRESENTATION[pr.state];
  if (!presentation) return null;
  return {
    ...presentation,
    tooltip: isOpenDraft
      ? `#${pr.number} Draft: ${pr.title}`
      : `#${pr.number} ${presentation.label}: ${pr.title}`,
    url: pr.url,
  } satisfies PrStatusIndicator;
}

/** The status's PR, only when the status is for `branch` (a stale or different checkout has none). */
export function resolveBranchPullRequest(
  branch: string | null,
  status: Pick<GitStatusResult, "branch" | "pr"> | null | undefined,
): GitStatusPr | null {
  if (branch === null || !status || status.branch === null || status.branch !== branch) {
    return null;
  }
  return status.pr ?? null;
}

/** Opens a PR in the system browser without also activating an enclosing row or trigger. */
export function openPullRequestLink(event: MouseEvent<HTMLElement>, prUrl: string) {
  event.preventDefault();
  event.stopPropagation();

  const api = readNativeApi();
  if (!api) {
    toastManager.add({
      type: "error",
      title: "Link opening is unavailable.",
    });
    return;
  }

  void api.shell.openExternal(prUrl).catch((error: unknown) => {
    toastManager.add({
      type: "error",
      title: "Unable to open PR link",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  });
}
