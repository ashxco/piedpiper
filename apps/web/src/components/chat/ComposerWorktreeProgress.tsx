import { Button } from "../ui/button";

export interface ComposerWorktreeProgressValue {
  readonly percent: number;
}

/** The worktree step of a send; a parent passes a handler only while that action is allowed. */
export function ComposerWorktreeProgress(props: {
  progress: ComposerWorktreeProgressValue | null;
  onCancel?: (() => void) | undefined;
  onWorkLocally?: (() => void) | undefined;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span className="flex items-center gap-1 whitespace-nowrap text-muted-foreground/70 text-xs tabular-nums">
        {/* Phone widths fit only the percent or a shorter name, and tighter buttons. */}
        <span role="status" className="sr-only sm:not-sr-only">
          Preparing worktree...
        </span>
        {/* Outside the live region: a checkout would otherwise queue up to 100 announcements. */}
        {props.progress ? (
          <span aria-hidden="true">{props.progress.percent}%</span>
        ) : (
          <span aria-hidden="true" className="sm:hidden">
            Preparing...
          </span>
        )}
      </span>
      {props.onWorkLocally ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="text-xs max-sm:px-1"
          onClick={props.onWorkLocally}
        >
          Work locally
        </Button>
      ) : null}
      {props.onCancel ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="text-xs max-sm:px-1"
          onClick={props.onCancel}
        >
          Cancel
        </Button>
      ) : null}
    </span>
  );
}
