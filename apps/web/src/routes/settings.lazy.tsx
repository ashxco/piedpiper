import { RotateCcwIcon, Trash2Icon } from "lucide-react";
import { Link, Outlet, createLazyFileRoute, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useArchivedThreadIds } from "../components/settings/panels/ArchivedThreadsPanel";
import { useSettingsRestore } from "../hooks/useSettingsRestore";
import { Button } from "../components/ui/button";
import { SidebarInset, useSidebar } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";

const TABS = [
  { path: "/settings/general", label: "General" },
  { path: "/settings/archived", label: "Archived" },
] as const;

function SettingsContentLayout() {
  const [restoreSignal, setRestoreSignal] = useState(0);
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(() =>
    setRestoreSignal((value) => value + 1),
  );
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const { state } = useSidebar();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        window.history.back();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-transparent text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
        <div
          className={cn(
            "flex items-center justify-between border-b border-border px-5 py-0",
            isElectron && "drag-region h-[52px]",
          )}
        >
          <div
            className="flex items-center gap-0"
            style={isElectron && state === "collapsed" ? { paddingLeft: 128 } : undefined}
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
          {pathname === "/settings/archived" ? (
            <SettingsDeleteAllArchivedButton />
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={changedSettingLabels.length === 0}
              onClick={() => void restoreDefaults()}
            >
              <RotateCcwIcon className="size-3.5" />
              Restore defaults
            </Button>
          )}
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

  return (
    <Button
      size="xs"
      variant="outline"
      disabled={archivedIds.length === 0}
      className="text-destructive hover:bg-destructive/10"
      onClick={async () => {
        const api = readNativeApi();
        if (!api) return;
        const confirmed = await api.dialogs.confirm(
          `Permanently delete ${archivedIds.length} archived thread${archivedIds.length === 1 ? "" : "s"}?`,
        );
        if (!confirmed) return;
        for (const tid of archivedIds) {
          await api.orchestration
            .dispatchCommand({
              type: "thread.delete",
              commandId: crypto.randomUUID() as never,
              threadId: tid,
            })
            .catch(() => undefined);
        }
      }}
    >
      <Trash2Icon className="size-3.5" />
      Delete all
    </Button>
  );
}

export const Route = createLazyFileRoute("/settings")({
  component: SettingsContentLayout,
});
