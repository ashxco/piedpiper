import { SquarePenIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Row tint for a sidebar thread holding an unsent composer draft. */
export const THREAD_UNSENT_DRAFT_ROW_CLASS_NAME =
  "bg-amber-500/6 hover:bg-amber-500/10 dark:bg-amber-400/6 dark:hover:bg-amber-400/10";

/** Small pen marker shown on sidebar rows (other than the active one) whose composer holds an unsent draft. */
export function ThreadUnsentDraftMarker() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Unsent draft"
            data-testid="thread-unsent-draft-marker"
            className="inline-flex shrink-0 items-center justify-center text-amber-600 dark:text-amber-300/90"
          >
            <SquarePenIcon className="size-3" />
          </span>
        }
      />
      <TooltipPopup side="top">Unsent draft</TooltipPopup>
    </Tooltip>
  );
}
