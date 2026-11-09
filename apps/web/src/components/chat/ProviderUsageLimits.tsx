import type { ServerProvider } from "@piedpiper/contracts";
import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  deriveProviderUsageLimitRows,
  describeProviderUsageLimits,
  readProviderUsageLimits,
} from "./ProviderUsageLimits.logic";

const COUNTDOWN_REFRESH_MS = 60_000;
const PROVIDER_LABELS: Record<ServerProvider["provider"], string> = {
  codex: "Codex",
  claudeAgent: "Claude",
};

function useCountdownNow(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), COUNTDOWN_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  return nowMs;
}

/** One provider's session and weekly bars with their reset times, or why there are none. */
export function ProviderUsageLimitRows(props: {
  readonly provider: ServerProvider;
  readonly className?: string;
}) {
  const nowMs = useCountdownNow();
  const limits = readProviderUsageLimits(props.provider);
  const rows = deriveProviderUsageLimitRows(limits, nowMs);
  const description = describeProviderUsageLimits(limits, props.provider.auth.status);

  return (
    <div className={cn("space-y-2", props.className)}>
      {rows.map((row) => (
        <div key={row.id} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="font-medium text-foreground">{row.label}</span>
            <span className="text-muted-foreground">
              {row.usedLabel}
              {row.resetLabel ? ` · ${row.resetLabel}` : null}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={`${row.label} usage`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(row.usedPercent)}
            className="h-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn(
                "h-full rounded-full",
                row.usedPercent >= 90 ? "bg-destructive" : "bg-primary",
              )}
              style={{ width: `${row.usedPercent}%` }}
            />
          </div>
        </div>
      ))}
      {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
    </div>
  );
}

/** What `/usage-limits` opens above the composer; it reads snapshots and never starts a turn. */
export function ProviderUsageLimitsPanel(props: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onClose: () => void;
}) {
  // A provider with no CLI can never report, so it would show a permanent "No usage data yet."
  const providers = props.providers.filter((provider) => provider.enabled && provider.installed);

  return (
    <section
      aria-label="Usage limits"
      className="space-y-3 rounded-lg border border-border bg-card p-3 text-card-foreground"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="font-medium text-sm">Usage limits</h2>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Close usage limits"
          onClick={props.onClose}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </header>
      {providers.length === 0 ? (
        <p className="text-muted-foreground text-xs">No providers are enabled.</p>
      ) : (
        providers.map((provider) => (
          <div key={provider.provider} className="space-y-1.5">
            <h3 className="text-muted-foreground text-xs">{PROVIDER_LABELS[provider.provider]}</h3>
            <ProviderUsageLimitRows provider={provider} />
          </div>
        ))
      )}
    </section>
  );
}
