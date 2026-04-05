import { CheckCircleIcon } from "lucide-react";
import { memo } from "react";

export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
}: {
  planTitle: string | null;
}) {
  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="flex items-center gap-2.5">
        <CheckCircleIcon className="size-4 shrink-0 text-emerald-500" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              Plan ready
            </span>
            {planTitle ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">{planTitle}</span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
});
