import { DownloadIcon, RotateCwIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { isElectron } from "../../env";
import type { useDesktopUpdate } from "../../hooks/useDesktopUpdate";
import {
  getDesktopUpdateButtonTooltip,
  shouldShowDesktopUpdateButton,
} from "../desktopUpdate.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarUpdatePill({ update }: { update: ReturnType<typeof useDesktopUpdate> }) {
  const { state, disabled, action, handleAction } = update;
  const [dismissed, setDismissed] = useState(false);
  const visible = isElectron && shouldShowDesktopUpdateButton(state) && !dismissed;
  const tooltip = state ? getDesktopUpdateButtonTooltip(state) : "Update available";

  if (!visible) return null;

  return (
    <div
      className={`group/update relative flex h-7 w-full items-center rounded-lg bg-primary/15 text-xs font-medium text-primary ${
        disabled ? " cursor-not-allowed opacity-60" : ""
      }`}
    >
      <div className="pointer-events-none absolute inset-0 rounded-lg transition-colors group-has-[button.update-main:hover]/update:bg-primary/22" />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={tooltip}
              aria-disabled={disabled || undefined}
              disabled={disabled}
              className="update-main relative flex h-full flex-1 items-center gap-2 px-2 enabled:cursor-pointer"
              onClick={handleAction}
            >
              {action === "install" ? (
                <>
                  <RotateCwIcon className="size-3.5" />
                  <span>Restart to update</span>
                </>
              ) : state?.status === "downloading" ? (
                <>
                  <DownloadIcon className="size-3.5" />
                  <span>
                    Downloading
                    {typeof state.downloadPercent === "number"
                      ? ` (${Math.floor(state.downloadPercent)}%)`
                      : "…"}
                  </span>
                </>
              ) : (
                <>
                  <DownloadIcon className="size-3.5" />
                  <span>Update available</span>
                </>
              )}
            </button>
          }
        />
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
      {action === "download" && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Dismiss update"
                className="mr-1 inline-flex size-5 items-center justify-center rounded-md text-primary/60 transition-colors hover:text-primary"
                onClick={() => setDismissed(true)}
              >
                <XIcon className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup side="top">Dismiss until next launch</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}
