import type { ThreadId } from "@piedpiper/contracts";
import { BotIcon, GitBranchIcon, TriangleAlertIcon } from "lucide-react";

import { useServerProviders } from "../../rpc/serverState";
import { useStore } from "../../store";
import type { SidebarThreadSummary } from "../../types";
import { textDirection } from "~/markdown-text-direction";
import { MiddleTruncate } from "../ui/middle-truncate";
import { resolveThreadModelName, resolveThreadTitleCardDetails } from "./ThreadTitleCard.logic";

/**
 * Body of the thread title hover card; mounted only while the card is open, so reading the model
 * from the full thread here costs nothing while a row just streams. The selector returns strings,
 * so a thread update that keeps the same model does not re-render the card.
 */
export function ThreadTitleCard(props: {
  thread: Pick<SidebarThreadSummary, "title" | "branch" | "worktreePath" | "session"> & {
    id: ThreadId;
  };
  currentGitBranch: string | null;
}) {
  const { thread } = props;
  const providers = useServerProviders();
  const provider = useStore(
    (state) => state.threads.find((entry) => entry.id === thread.id)?.modelSelection.provider,
  );
  const model = useStore(
    (state) => state.threads.find((entry) => entry.id === thread.id)?.modelSelection.model,
  );
  const details = resolveThreadTitleCardDetails({
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    currentGitBranch: props.currentGitBranch,
    lastError: thread.session?.lastError,
    sessionStatus: thread.session?.status,
  });
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={`thread-title-card-${thread.id}`}>
      <span dir={textDirection(thread.title) ?? "auto"}>{thread.title}</span>
      {details.branch !== null ? (
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <MiddleTruncate value={details.branch} showTitle={false} />
        </span>
      ) : null}
      {details.checkoutBranch !== null ? (
        <span className="flex min-w-0 items-center gap-1 text-warning-foreground">
          <TriangleAlertIcon aria-hidden className="size-3 shrink-0" />
          <span className="shrink-0">Checkout is on</span>
          <MiddleTruncate value={details.checkoutBranch} showTitle={false} />
        </span>
      ) : null}
      {provider !== undefined && model !== undefined ? (
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <BotIcon aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 truncate">
            {resolveThreadModelName(providers, provider, model)}
          </span>
        </span>
      ) : null}
      {details.failure !== null ? (
        <span className="line-clamp-3 wrap-anywhere text-destructive-foreground">
          {details.failure}
        </span>
      ) : null}
    </div>
  );
}
