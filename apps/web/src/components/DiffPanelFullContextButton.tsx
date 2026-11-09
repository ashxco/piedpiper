import { FoldVerticalIcon, UnfoldVerticalIcon } from "lucide-react";

import type { TurnDiffFullContextState } from "../lib/turnDiffFullContext";
import { cn } from "../lib/utils";
import { Spinner } from "./ui/spinner";

export function DiffPanelFullContextButton({
  state,
  disabledReason,
  onToggle,
}: {
  /** Null while the file shows only its hunks. */
  state: TurnDiffFullContextState | null;
  /** Set while toggling would drop something the user typed. */
  disabledReason?: string | null | undefined;
  onToggle: () => void;
}) {
  const kind = state?.kind ?? "off";
  const label = kind === "on" ? "Hide full context" : "Show full context";
  const detail = state?.kind === "unavailable" ? state.detail : null;
  return (
    <button
      type="button"
      aria-label={detail ? `Full context unavailable: ${detail}` : label}
      aria-pressed={kind === "on" || kind === "loading"}
      aria-busy={kind === "loading"}
      disabled={Boolean(disabledReason)}
      title={disabledReason ?? detail ?? label}
      className={cn(
        "inline-flex h-5 cursor-pointer items-center justify-center gap-1 rounded-sm text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground/60",
        kind === "unavailable" ? "px-1 text-destructive/80" : "w-5",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {kind === "loading" ? (
        <Spinner className="size-3" />
      ) : kind === "on" ? (
        <FoldVerticalIcon className="size-3" />
      ) : (
        <UnfoldVerticalIcon className="size-3" />
      )}
      {kind === "unavailable" && <span className="text-[11px]">Full context unavailable</span>}
    </button>
  );
}
