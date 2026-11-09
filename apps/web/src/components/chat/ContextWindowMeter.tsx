import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

const CRITICAL_USED_PERCENTAGE = 90;

function clampPercentage(value: number | null): number {
  return Math.max(0, Math.min(100, value ?? 0));
}

/** Bar under the popover readout; renders nothing while the window size is unknown. */
export function ContextWindowUsageBar(props: {
  usage: Pick<ContextWindowSnapshot, "maxTokens" | "usedPercentage">;
}) {
  const { maxTokens, usedPercentage } = props.usage;
  if (!maxTokens || maxTokens <= 0 || usedPercentage === null) return null;
  const pct = clampPercentage(usedPercentage);
  return (
    <div
      role="progressbar"
      aria-label="Context window used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className="h-1 w-full overflow-hidden rounded-full bg-foreground/10"
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
          pct > CRITICAL_USED_PERCENTAGE ? "bg-destructive" : "bg-foreground/50",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** The popover's compact action; renders nothing when the thread cannot compact on demand. */
export function ContextWindowCompactAction(props: {
  onCompact?: (() => void) | undefined;
  disabledReason?: string | null | undefined;
}) {
  const { onCompact, disabledReason } = props;
  if (!onCompact) return null;
  return (
    <div className="space-y-1 pt-0.5">
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={Boolean(disabledReason)}
        onClick={onCompact}
      >
        Compact
      </Button>
      {disabledReason ? (
        <div className="max-w-56 whitespace-normal text-xs text-muted-foreground">
          {disabledReason}
        </div>
      ) : null}
    </div>
  );
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  onCompact?: (() => void) | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const { usage, onCompact, compactDisabledReason } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const pct = clampPercentage(usage.usedPercentage);
  const usageColorClass =
    pct > CRITICAL_USED_PERCENTAGE ? "text-destructive" : "text-foreground/50";
  const radius = 12;
  const strokeWidth = 1.5;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (pct / 100) * circumference;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        // Long enough for the pointer to cross the gap to the popover's button.
        closeDelay={150}
        render={
          <button
            type="button"
            className="group inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-80"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-7 items-center justify-center">
              <svg
                viewBox="0 0 28 28"
                className="absolute inset-0 -rotate-90 size-full"
                aria-hidden="true"
              >
                <circle
                  cx="14"
                  cy="14"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={strokeWidth}
                  className="text-foreground/10"
                />
                <circle
                  cx="14"
                  cy="14"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className={cn(
                    usageColorClass,
                    "transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none",
                  )}
                />
              </svg>
              <span className={cn("relative text-[9px] leading-none font-medium", usageColorClass)}>
                {usage.usedPercentage !== null
                  ? Math.round(pct)
                  : formatContextWindowTokens(usage.usedTokens)}
              </span>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Context window
          </div>
          {usage.maxTokens !== null && usedPercentage ? (
            <div className="whitespace-nowrap text-xs font-medium text-foreground">
              <span>{usedPercentage}</span>
              <span className="mx-1">·</span>
              <span>{formatContextWindowTokens(usage.usedTokens)}</span>
              <span>/</span>
              <span>{formatContextWindowTokens(usage.maxTokens ?? null)} context used</span>
            </div>
          ) : (
            <div className="text-sm text-foreground">
              {formatContextWindowTokens(usage.usedTokens)} tokens used so far
            </div>
          )}
          <ContextWindowUsageBar usage={usage} />
          {(usage.totalProcessedTokens ?? null) !== null &&
          (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
            <div className="text-xs text-muted-foreground">
              Total processed: {formatContextWindowTokens(usage.totalProcessedTokens ?? null)}{" "}
              tokens
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="text-xs text-muted-foreground">
              Automatically compacts its context when needed.
            </div>
          ) : null}
          <ContextWindowCompactAction
            onCompact={onCompact}
            disabledReason={compactDisabledReason}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
