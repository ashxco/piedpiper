import { memo, useEffect, useState } from "react";
import { ChevronDownIcon, ChevronLeftIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatWorkingTimer } from "../../session-logic";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { isThreadForceStopInFlight, isThreadStopUnresponsive } from "./composerThreadStop";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  compact: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isPreparingWorktree: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  /** When Stop was pressed on the running turn; the button then shows that it is stopping. */
  stopRequestedAtMs?: number | null;
  /** When Force stop was last dispatched; the button waits on it before it can be sent again. */
  forceStopRequestedAtMs?: number | null;
  onForceStop?: () => void;
}

const UNRESPONSIVE_STOP_MESSAGE = "Agent not responding to Stop";

const formatPendingPrimaryActionLabel = (input: {
  isLastQuestion: boolean;
  isResponding: boolean;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  return input.isLastQuestion ? "Submit" : "Next";
};

/** One button for Stop and Stopping, so keyboard focus survives pressing it. */
function ThreadStopControl({
  requestedAtMs,
  forceStopRequestedAtMs,
  compact,
  onInterrupt,
  onForceStop,
  className,
}: {
  requestedAtMs: number | null;
  forceStopRequestedAtMs: number | null;
  compact: boolean;
  onInterrupt: () => void;
  onForceStop: (() => void) | undefined;
  className: string | undefined;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (requestedAtMs === null) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [requestedAtMs]);
  const isStopping = requestedAtMs !== null;
  const elapsed = isStopping
    ? formatWorkingTimer(
        new Date(requestedAtMs).toISOString(),
        new Date(Math.max(nowMs, requestedAtMs)).toISOString(),
      )
    : null;
  const isUnresponsive =
    isStopping && onForceStop !== undefined && isThreadStopUnresponsive(requestedAtMs, nowMs);
  const isForceStopping = isThreadForceStopInFlight(forceStopRequestedAtMs, nowMs);
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* Mounted before it has text, since a live region inserted with its content may not be read. */}
      <span role="status" className="sr-only">
        {isUnresponsive ? UNRESPONSIVE_STOP_MESSAGE : isStopping ? "Stopping" : null}
      </span>
      {isUnresponsive ? (
        <>
          {compact ? null : (
            <span aria-hidden="true" className="whitespace-nowrap text-muted-foreground text-xs">
              {UNRESPONSIVE_STOP_MESSAGE}
            </span>
          )}
          <Button
            type="button"
            size="xs"
            variant="destructive-outline"
            className="rounded-full aria-disabled:cursor-default aria-disabled:opacity-64"
            aria-disabled={isForceStopping || undefined}
            onClick={onForceStop}
          >
            {isForceStopping ? "Force stopping..." : "Force stop"}
          </Button>
        </>
      ) : null}
      <button
        type="button"
        aria-disabled={isStopping || undefined}
        aria-label={isStopping ? undefined : "Stop generation"}
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full text-white transition-all duration-150",
          isStopping
            ? "h-8 cursor-default gap-1.5 bg-rose-500/50 px-3 text-xs"
            : "size-8 cursor-pointer bg-rose-500/90 hover:scale-105 hover:bg-rose-500",
          className,
        )}
        onClick={isStopping ? undefined : onInterrupt}
      >
        {isStopping ? (
          <>
            Stopping
            {elapsed ? (
              <span aria-hidden="true" className="tabular-nums">
                {elapsed}
              </span>
            ) : null}
          </>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
            <rect x="2" y="2" width="8" height="8" rx="1.5" />
          </svg>
        )}
      </button>
    </div>
  );
}

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  isConnecting,
  isPreparingWorktree,
  onPreviousPendingQuestion,
  onInterrupt,
  onImplementPlanInNewThread,
  stopRequestedAtMs = null,
  forceStopRequestedAtMs = null,
  onForceStop,
}: ComposerPrimaryActionsProps) {
  const renderStopControl = (className?: string) => (
    <ThreadStopControl
      requestedAtMs={stopRequestedAtMs}
      forceStopRequestedAtMs={forceStopRequestedAtMs}
      compact={compact}
      onInterrupt={onInterrupt}
      onForceStop={onForceStop}
      className={className}
    />
  );

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {isRunning ? renderStopControl(stopRequestedAtMs === null ? "sm:size-7" : "sm:h-7") : null}
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        <Button
          type={
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
              ? "button"
              : "submit"
          }
          size="sm"
          className={cn("rounded-full", compact ? "px-3" : "px-4")}
          onClick={(e) => {
            if (pendingAction.isResponding) {
              e.preventDefault();
              toastManager.add({
                type: "info",
                title: "Please wait",
                description: "Submitting your response...",
              });
            } else if (
              pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance
            ) {
              e.preventDefault();
              toastManager.add({
                type: "info",
                title: "Answer required",
                description: "Please answer the question before continuing.",
              });
            }
          }}
        >
          {formatPendingPrimaryActionLabel({
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
          })}
        </Button>
      </div>
    );
  }

  if (isRunning) {
    return renderStopControl();
  }

  if (showPlanFollowUpPrompt) {
    if (promptHasText) {
      return (
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "h-9 px-3 sm:h-8" : "h-9 px-4 sm:h-8")}
          disabled={isSendBusy || isConnecting}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Refine"}
        </Button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <Button
          type="submit"
          size="sm"
          className={cn(
            "h-9 rounded-l-full rounded-r-none sm:h-8 [&:active:not([aria-haspopup])]:scale-100",
            compact ? "px-3" : "px-4",
          )}
          disabled={isSendBusy || isConnecting}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Implement"}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="default"
                className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                aria-label="Implementation actions"
                disabled={isSendBusy || isConnecting}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            <MenuItem
              disabled={isSendBusy || isConnecting}
              onClick={() => void onImplementPlanInNewThread()}
            >
              Implement in a New Thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  return (
    <button
      type="submit"
      className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-all duration-150 hover:opacity-90 hover:scale-105 sm:h-8 sm:w-8"
      aria-label={
        isConnecting
          ? "Connecting"
          : isPreparingWorktree
            ? "Preparing worktree"
            : isSendBusy
              ? "Sending"
              : "Send message"
      }
    >
      {isConnecting || isSendBusy ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          className="animate-spin"
          aria-hidden="true"
        >
          <circle
            cx="7"
            cy="7"
            r="5.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray="20 12"
          />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
});
