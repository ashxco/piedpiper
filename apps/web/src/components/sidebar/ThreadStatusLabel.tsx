import { memo } from "react";

import { type resolveThreadStatusPill } from "../Sidebar.logic";
import { UnicodeSpinner } from "./UnicodeSpinner";

interface ThreadStatusLabelProps {
  status: NonNullable<ReturnType<typeof resolveThreadStatusPill>>;
  compact?: boolean;
}

export const ThreadStatusLabel = memo(function ThreadStatusLabel({
  status,
  compact = false,
}: ThreadStatusLabelProps) {
  if (compact) {
    return (
      <span
        title={status.label}
        className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
      >
        {status.pulse ? (
          <UnicodeSpinner colorClass="bg-foreground" />
        ) : (
          <span className={`size-[7px] rounded-full ${status.dotClass}`} />
        )}
        <span className="sr-only">{status.label}</span>
      </span>
    );
  }

  return (
    <span
      title={status.label}
      className={`inline-flex items-center gap-1 text-[10px] ${status.colorClass}`}
    >
      {status.pulse ? (
        <UnicodeSpinner colorClass="bg-foreground" pixel={1} gap={1} />
      ) : (
        <span className={`h-1 w-1 rounded-full ${status.dotClass}`} />
      )}
      <span className="hidden md:inline">{status.label}</span>
    </span>
  );
});
