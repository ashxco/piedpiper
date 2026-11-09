import { CheckIcon, CopyIcon } from "lucide-react";

import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import type { ProviderVersionUpdate } from "./providerVersionUpdate.logic";

/** Low-emphasis line on a provider card for a CLI behind its latest release. */
export function ProviderVersionUpdateNotice({
  providerName,
  update,
}: {
  providerName: string;
  update: ProviderVersionUpdate;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy the update command",
        description: error.message,
      });
    },
  });
  const { latestVersion, updateCommand } = update;

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-0.5 text-[11px] text-muted-foreground">
      <span>
        v{latestVersion} is available.
        {updateCommand ? " Update with" : " Update it with the tool you installed it with."}
      </span>
      {updateCommand ? (
        <>
          <code className="min-w-0 break-all rounded-sm bg-muted px-1 py-0.5 text-foreground/80">
            {updateCommand}
          </code>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  aria-label={`Copy ${providerName} update command`}
                  onClick={() => copyToClipboard(updateCommand, undefined)}
                >
                  {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                </Button>
              }
            />
            <TooltipPopup side="top">{isCopied ? "Copied" : "Copy command"}</TooltipPopup>
          </Tooltip>
        </>
      ) : null}
    </div>
  );
}
