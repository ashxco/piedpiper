import { ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { type TurnFoldRowData } from "./ChatView.turnFolds";

/** The "Worked for 3m" row a settled turn's tool work and interim replies collapse behind. */
export function TurnFoldRow({
  row,
  onToggle,
}: {
  row: TurnFoldRowData;
  onToggle: (foldId: string) => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={row.expanded}
      onClick={() => onToggle(row.id)}
      className="flex w-full cursor-pointer items-center gap-2 px-1 py-0.5 text-muted-foreground/70 text-xs transition-colors hover:text-foreground/80"
    >
      <ChevronRightIcon
        aria-hidden="true"
        className={cn("size-3 shrink-0 transition-transform", row.expanded && "rotate-90")}
      />
      <span className="shrink-0">{row.label}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </button>
  );
}
