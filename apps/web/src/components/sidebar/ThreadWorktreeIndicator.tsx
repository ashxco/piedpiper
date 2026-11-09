import type { ThreadId } from "@piedpiper/contracts";
import { FolderGit2Icon } from "lucide-react";

import { formatThreadWorktreeLabel } from "../../worktreeCleanup";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// The row's accessible name carries the worktree label, so this icon stays hidden from assistive tech.
export function ThreadWorktreeIndicator(props: {
  threadId: ThreadId;
  worktreePath: string | null;
  branch: string | null;
}) {
  const label = formatThreadWorktreeLabel(props);
  if (label === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-hidden="true"
            data-testid={`thread-worktree-${props.threadId}`}
            className="inline-flex shrink-0 items-center justify-center"
          />
        }
      >
        <FolderGit2Icon className="size-3 text-muted-foreground/40" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
