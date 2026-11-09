import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

/** Ellipsizes a path from the start so the filename stays visible; the full path is in a tooltip. */
export function StartTruncatedPath({ path, className }: { path: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left",
              className,
            )}
            dir="rtl"
          />
        }
      >
        {/* bdi keeps the path's own left-to-right order inside the rtl container. */}
        <bdi>{path}</bdi>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-sm break-all font-mono">
        {path}
      </TooltipPopup>
    </Tooltip>
  );
}
