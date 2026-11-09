import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { isCommandSurfaceOpen } from "../filePickerStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { isInsideConfirmationDialog } from "../lib/confirmationDialogGuard";
import { resolveNewThreadShortcutOptions, selectableProjects } from "../lib/projectArchive";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import { useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import {
  resolveNewLocalThreadOptions,
  resolveSidebarNewThreadEnvMode,
} from "~/components/Sidebar.logic";
import { useSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "~/rpc/serverState";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadIdsSize = useThreadSelectionStore((state) => state.selectedThreadIds.size);
  const { activeDraftThread, activeThread, defaultProjectId, handleNewThread, routeThreadId } =
    useHandleNewThread();
  const keybindings = useServerKeybindings();
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, routeThreadId).terminalOpen
      : false,
  );
  const appSettings = useSettings();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // New threads and cleared selections behind the palette or file picker would make its results stale.
      if (isCommandSurfaceOpen()) return;

      if (
        event.key === "Escape" &&
        selectedThreadIdsSize > 0 &&
        !isInsideConfirmationDialog(event.target)
      ) {
        event.preventDefault();
        clearSelection();
        return;
      }

      const contextProjectId = activeThread?.projectId ?? activeDraftThread?.projectId;
      // An archived project takes no new threads from a shortcut, so fall through to the default.
      const hasThreadContext =
        contextProjectId !== undefined &&
        selectableProjects(useStore.getState().projects).some(
          (project) => project.id === contextProjectId,
        );
      const projectId = hasThreadContext ? contextProjectId : defaultProjectId;
      if (!projectId) return;

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });

      if (
        (command === "chat.new" || command === "chat.newLocal") &&
        isInsideConfirmationDialog(event.target)
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(
          projectId,
          resolveNewLocalThreadOptions({
            projectId,
            defaultEnvMode: resolveSidebarNewThreadEnvMode({
              defaultEnvMode: appSettings.defaultThreadEnvMode,
            }),
            activeDraftProjectId: activeDraftThread?.projectId ?? null,
          }),
        );
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(
          projectId,
          resolveNewThreadShortcutOptions({
            hasThreadContext,
            activeThread,
            activeDraftThread,
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
        );
        return;
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    handleNewThread,
    keybindings,
    defaultProjectId,
    selectedThreadIdsSize,
    terminalOpen,
    appSettings.defaultThreadEnvMode,
  ]);

  return null;
}

function ChatRouteLayout() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <Outlet />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
