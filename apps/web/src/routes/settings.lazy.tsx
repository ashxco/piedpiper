import { RotateCcwIcon, Trash2Icon } from "lucide-react";
import { Link, Outlet, createLazyFileRoute, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useArchivedThreadIds } from "../components/settings/panels/ArchivedThreadsPanel";
import {
  confirmAndDeleteArchivedThreads,
  useArchivedThreadActionStore,
} from "../components/settings/panels/archivedThreadActions";
import { isSettingsCloseKey } from "../components/settings/settingsCloseKey";
import { SettingsSearchField } from "../components/settings/SettingsSearchField";
import { useSettingsSearchTarget } from "../components/settings/useSettingsSearchTarget";
import { useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { useSettingsRestore } from "../hooks/useSettingsRestore";
import { useThreadActions } from "../hooks/useThreadActions";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { useElectronHeaderInsetPx } from "../hooks/useElectronHeaderInset";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { readNativeApi } from "../nativeApi";

const TABS = [
  { path: "/settings/general", label: "General" },
  { path: "/settings/keybindings", label: "Keybindings" },
  { path: "/settings/archived", label: "Archived" },
  { path: "/settings/diagnostics", label: "Diagnostics" },
] as const;

function SettingsContentLayout() {
  const [restoreSignal, setRestoreSignal] = useState(0);
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(() =>
    setRestoreSignal((value) => value + 1),
  );
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const headerInsetPx = useElectronHeaderInsetPx();
  const navigateToMainApp = useNavigateToMainApp();
  useSettingsSearchTarget();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSettingsCloseKey(event)) return;
      event.preventDefault();
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) activeElement.blur();
      void navigateToMainApp();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [navigateToMainApp]);

  return (
    <SidebarInset
      {...workspaceAreaProps("settings", 1, "Settings")}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-transparent text-foreground isolate"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
        <div
          className={cn(
            "flex items-center justify-between gap-3 border-b border-border px-5 py-0",
            isElectron &&
              "drag-region h-[52px] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
          )}
        >
          <div
            className="flex items-center gap-0"
            style={headerInsetPx !== undefined ? { paddingLeft: headerInsetPx } : undefined}
          >
            {TABS.map((tab) => (
              <Link
                key={tab.path}
                to={tab.path}
                className={cn(
                  "border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
                  pathname === tab.path
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            ))}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <SettingsSearchField className="w-36 lg:w-52" />
            {pathname === "/settings/archived" ? (
              <SettingsDeleteAllArchivedButton />
            ) : pathname === "/settings/keybindings" ? null : (
              <Button
                size="xs"
                variant="outline"
                className="shrink-0"
                disabled={changedSettingLabels.length === 0}
                onClick={() => void restoreDefaults()}
              >
                <RotateCcwIcon className="size-3.5" />
                Restore defaults
              </Button>
            )}
          </div>
        </div>

        <div key={restoreSignal} className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  );
}

function SettingsDeleteAllArchivedButton() {
  const archivedIds = useArchivedThreadIds();
  const { deleteThread } = useThreadActions();
  const isDeleting = useArchivedThreadActionStore((store) => store.deleteAllPhase === "deleting");

  const deleteAll = () => {
    const api = readNativeApi();
    if (!api) return;
    void confirmAndDeleteArchivedThreads({
      threadIds: archivedIds,
      confirm: (message) => api.dialogs.confirm(message),
      deleteThread,
    });
  };

  return (
    <Button
      size="xs"
      variant="outline"
      disabled={archivedIds.length === 0 || isDeleting}
      className="shrink-0 text-destructive hover:bg-destructive/10"
      onClick={deleteAll}
    >
      <Trash2Icon className="size-3.5" />
      {isDeleting ? "Deleting..." : "Delete all"}
    </Button>
  );
}

export const Route = createLazyFileRoute("/settings")({
  component: SettingsContentLayout,
});
