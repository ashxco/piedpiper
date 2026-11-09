import { MessageCircleIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { ReviewCommentContext } from "~/reviewCommentContext";

/** Rough height of one collapsed card, for the timeline's row estimate. */
export const USER_MESSAGE_REVIEW_COMMENT_ESTIMATED_HEIGHT_PX = 58;

function diffLineClassName(line: string): string {
  if (line.startsWith("+")) return "text-[color:var(--diff-addition)]";
  if (line.startsWith("-")) return "text-[color:var(--diff-deletion)]";
  if (line.startsWith("@@")) return "text-muted-foreground/70";
  return "";
}

/** The diff comments of a sent message, parsed by `extractTrailingReviewComments`. */
export function UserMessageReviewComments(props: {
  comments: ReadonlyArray<ReviewCommentContext>;
  className?: string;
}) {
  if (props.comments.length === 0) return null;
  return (
    <div className={cn("flex w-full flex-col gap-1", props.className)}>
      {props.comments.map((comment) => (
        <details
          key={comment.id}
          data-review-comment-card
          className="rounded-md border border-border/70 bg-accent/30 px-2.5 py-1.5 text-xs"
        >
          <summary className="flex cursor-pointer list-none items-start gap-1.5">
            <MessageCircleIcon className="mt-0.5 size-3.5 shrink-0 opacity-70" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-foreground/80">
                {comment.filePath} {comment.rangeLabel}
              </span>
              <span className="block whitespace-pre-wrap wrap-break-word text-foreground">
                {comment.text}
              </span>
            </span>
          </summary>
          <pre className="mt-1.5 max-h-64 overflow-auto rounded border border-border/60 bg-background/70 p-2 font-mono text-[11px] leading-relaxed">
            {comment.diff
              .split("\n")
              .map((line, index) => ({ key: `line-${index}`, line }))
              .map(({ key, line }) => (
                <span key={key} className={cn("block", diffLineClassName(line))}>
                  {line || " "}
                </span>
              ))}
          </pre>
        </details>
      ))}
    </div>
  );
}
