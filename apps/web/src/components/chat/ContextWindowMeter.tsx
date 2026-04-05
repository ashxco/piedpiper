import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
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

export function ContextWindowMeter(props: { usage: ContextWindowSnapshot }) {
  const { usage } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const pct = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 12;
  const strokeWidth = 1.5;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (pct / 100) * circumference;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
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
                  className="text-foreground/50 transition-[stroke-dashoffset] duration-500 ease-out"
                />
              </svg>
              <span className="relative text-[9px] leading-none font-medium text-foreground/50">
                {usage.usedPercentage !== null
                  ? Math.round(usage.usedPercentage)
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
        </div>
      </PopoverPopup>
    </Popover>
  );
}
