import type { ThreadId } from "@piedpiper/contracts";
import { MessageCircleIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { selectReviewComments, useReviewCommentDraftStore } from "~/reviewCommentDraftStore";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Chips for the diff comments that will go out with the thread's next prompt. */
export function ComposerPendingReviewComments(props: { threadId: ThreadId; className?: string }) {
  const comments = useReviewCommentDraftStore(selectReviewComments(props.threadId));
  const removeComment = useReviewCommentDraftStore((state) => state.removeComment);
  if (comments.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-1.5", props.className)}>
      {comments.map((comment) => {
        const label = `${comment.filePath} ${comment.rangeLabel}`;
        return (
          <Tooltip key={comment.id}>
            <TooltipTrigger
              render={
                <span className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "pr-1")}>
                  <MessageCircleIcon className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
                  <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
                  <button
                    type="button"
                    aria-label={`Remove comment on ${label}`}
                    className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      removeComment(props.threadId, comment.id);
                    }}
                  >
                    <XIcon className="size-3" aria-hidden />
                  </button>
                </span>
              }
            />
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
              {comment.text}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
