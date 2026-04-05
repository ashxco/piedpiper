import { useEffect, type ReactNode } from "react";
import { useTheme } from "../hooks/useTheme";
import { useNavigate } from "@tanstack/react-router";
import { PanelLeftIcon } from "lucide-react";

import ThreadSidebar from "./Sidebar";
import { Sidebar, SidebarProvider, SidebarRail, useSidebar } from "./ui/sidebar";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

function SidebarToggleButton() {
  const { toggleSidebar } = useSidebar();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void toggleSidebar();
      }}
      aria-label="Toggle sidebar"
      className="fixed z-50 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      style={{ left: 90, top: 16, WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <PanelLeftIcon className="size-4" />
    </button>
  );
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="dark:text-white dark:[--foreground:white] dark:[--muted-foreground:rgba(255,255,255,1)] dark:[--sidebar-accent-foreground:white] dark:[--accent-foreground:white]"
        resizable={{
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className="min-h-0 flex flex-1 flex-col overflow-hidden rounded-xl"
          style={{
            backgroundColor: isDark ? "rgba(10, 10, 11, 0.95)" : "rgba(255, 255, 255, 0.95)",
          }}
        >
          {children}
        </div>
      </div>
      <SidebarToggleButton />
    </SidebarProvider>
  );
}
