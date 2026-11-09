import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { APP_VERSION } from "../../../branding";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { useSettings } from "../../../hooks/useSettings";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDisabledReason,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../desktopUpdate.logic";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../../lib/desktopUpdateReactQuery";
import { ensureNativeApi } from "../../../nativeApi";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { SettingsRow } from "./SettingsPrimitives";

export function AboutVersionTitle() {
  const { copyToClipboard } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add({ type: "success", title: "Version copied", description: APP_VERSION });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy version",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });

  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="cursor-pointer rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Copy version ${APP_VERSION}`}
              onClick={() => copyToClipboard(APP_VERSION)}
            >
              <code className="text-[11px] font-medium">{APP_VERSION}</code>
            </button>
          }
        />
        <TooltipPopup>Copy version</TooltipPopup>
      </Tooltip>
    </span>
  );
}

export function AboutVersionSection() {
  const queryClient = useQueryClient();
  const updateStateQuery = useDesktopUpdateState();
  const continueThreadsAfterRestart = useSettings(
    (settings) => settings.continueThreadsAfterRestart,
  );

  const updateState = updateStateQuery.data ?? null;

  const handleButtonClick = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: error instanceof Error ? error.message : "Download failed.",
          });
        });
      return;
    }

    if (action === "install") {
      const confirmed = await ensureNativeApi().dialogs.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
          navigator.platform,
          { continueThreadsAfterRestart },
        ),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "Install failed.",
          });
        });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        setDesktopUpdateStateQueryData(queryClient, result.state);
        if (!result.checked) {
          toastManager.add({
            type: "error",
            title: "Could not check for updates",
            description:
              result.state.message ?? "Automatic updates are not available in this build.",
          });
        }
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not check for updates",
          description: error instanceof Error ? error.message : "Update check failed.",
        });
      });
  }, [continueThreadsAfterRestart, queryClient, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  // A disabled Button never opens its tooltip, so the reason goes in the description.
  const disabledReason = getDesktopUpdateDisabledReason(updateState);
  const description =
    disabledReason ??
    (action === "download" || action === "install"
      ? "Update available."
      : "Current version of the application.");

  return (
    <SettingsRow
      title={<AboutVersionTitle />}
      description={description}
      control={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant={action === "install" ? "default" : "outline"}
                disabled={buttonDisabled}
                onClick={() => void handleButtonClick()}
              >
                {buttonLabel}
              </Button>
            }
          />
          {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
        </Tooltip>
      }
    />
  );
}
