import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSettings } from "./useSettings";
import {
  setDesktopUpdateStateQueryData,
  trackDesktopInstallRequest,
  useDesktopUpdateState,
} from "../lib/desktopUpdateReactQuery";
import { readNativeApi } from "../nativeApi";
import { toastManager } from "../components/ui/toast";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldToastDesktopUpdateActionResult,
} from "../components/desktopUpdate.logic";

/** One action path for the update pill and the architecture warning. */
export function useDesktopUpdate() {
  const queryClient = useQueryClient();
  const state = useDesktopUpdateState().data ?? null;
  const disabled = isDesktopUpdateButtonDisabled(state);
  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const continueThreadsAfterRestart = useSettings(
    (settings) => settings.continueThreadsAfterRestart,
  );

  const handleAction = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || !state) return;
    if (disabled || action === "none") return;

    try {
      if (action === "install") {
        const api = readNativeApi();
        const message = getDesktopUpdateInstallConfirmationMessage(state, navigator.platform, {
          continueThreadsAfterRestart,
        });
        const confirmed = api ? await api.dialogs.confirm(message) : window.confirm(message);
        if (!confirmed) return;
      }

      const result = await (action === "install"
        ? trackDesktopInstallRequest(() => bridge.installUpdate())
        : bridge.downloadUpdate());
      setDesktopUpdateStateQueryData(queryClient, result.state);
      if (action === "download" && result.completed) {
        toastManager.add({
          type: "success",
          title: "Update downloaded",
          description: "Restart the app from the update button to install it.",
        });
      }
      if (!shouldToastDesktopUpdateActionResult(result)) return;
      const actionError = getDesktopUpdateActionError(result);
      if (actionError) {
        toastManager.add({
          type: "error",
          title: action === "install" ? "Could not install update" : "Could not download update",
          description: actionError,
        });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title:
          action === "install" ? "Could not install update" : "Could not start update download",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
  }, [action, continueThreadsAfterRestart, disabled, queryClient, state]);

  return { state, disabled, action, handleAction };
}
