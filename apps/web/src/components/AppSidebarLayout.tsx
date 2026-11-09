import { useEffect, type ReactNode } from "react";
import { ThreadId } from "@piedpiper/contracts";
import {
  MACOS_TRAFFIC_LIGHTS_INSET,
  useMacosTrafficLightInset,
} from "../hooks/useDesktopWindowFullscreen";
import { useTheme } from "../hooks/useTheme";
import { useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { PanelLeftIcon } from "lucide-react";

import { isCommandSurfaceOpen } from "../filePickerStore";
import { useSidebarThreadPinShortcut } from "../hooks/useSidebarThreadPinShortcut";
import { shortcutLabelForCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { moveWorkspaceFocus, startWorkspaceFocus, workspaceAreaProps } from "../lib/workspaceFocus";
import { useServerKeybindings } from "../rpc/serverState";
import { useTerminalStateStore } from "../terminalStateStore";
import { resolveAppShellShortcut, shouldAcceptThreadSidebarWidth } from "./AppSidebarLayout.logic";
import ThreadSidebar from "./Sidebar";
import { MainAppLocationTracker } from "./sidebar/mainAppLocation";
import { isSettingsPathname } from "./sidebar/settingsRoute";
import { Sidebar, SidebarProvider, SidebarRail, useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_OPEN_STORAGE_KEY = "chat_thread_sidebar_open";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

function SidebarToggleButton() {
  const { toggleSidebar } = useSidebar();
  const keybindings = useServerKeybindings();
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");
  const reserveTrafficLights = useMacosTrafficLightInset();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void toggleSidebar();
            }}
            aria-label="Toggle sidebar"
            data-sidebar="trigger"
            className="fixed z-50 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            style={
              {
                left: reserveTrafficLights ? MACOS_TRAFFIC_LIGHTS_INSET : 16,
                top: 16,
                WebkitAppRegion: "no-drag",
              } as React.CSSProperties
            }
          />
        }
      >
        <PanelLeftIcon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {shortcutLabel ? `Toggle sidebar (${shortcutLabel})` : "Toggle sidebar"}
      </TooltipPopup>
    </Tooltip>
  );
}

// Handles app-shell shortcuts (sidebar toggle, history back/forward) before focused editors can consume them.
export function AppShellShortcuts() {
  const { toggleSidebar } = useSidebar();
  const router = useRouter();
  const keybindings = useServerKeybindings();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });

  const routeTerminalOpen = useTerminalStateStore((state) =>
    routeThreadId ? (state.terminalStateByThreadId[routeThreadId]?.terminalOpen ?? false) : false,
  );
  // Here, not in the sidebar: below the md breakpoint its sheet unmounts while closed.
  useSidebarThreadPinShortcut({
    keybindings,
    platform: navigator.platform,
    routeTerminalOpen,
    routeThreadId,
  });

  useEffect(() => startWorkspaceFocus(), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const terminalOpen = routeThreadId
        ? (useTerminalStateStore.getState().terminalStateByThreadId[routeThreadId]?.terminalOpen ??
          false)
        : false;
      const outcome = resolveAppShellShortcut(event, keybindings, {
        terminalFocus: isTerminalFocused(),
        terminalOpen,
      });
      if (!outcome) return;
      if (event.isComposing && outcome.command.startsWith("workspace.")) return;

      event.preventDefault();
      event.stopPropagation();
      // Still claimed under the palette and file picker: browsers map these chords to their own back and forward.
      if (outcome.action === "swallow" || isCommandSurfaceOpen()) return;
      const { command } = outcome;
      if (command === "sidebar.toggle") toggleSidebar();
      else if (command === "navigation.back") router.history.back();
      else if (command === "workspace.focusNext") moveWorkspaceFocus(1);
      else if (command === "workspace.focusPrevious") moveWorkspaceFocus(-1);
      else router.history.forward();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, routeThreadId, router, toggleSidebar]);

  return null;
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const router = useRouter();

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      // Repeated Cmd+, presses must not stack duplicate settings history entries.
      if (isSettingsPathname(router.state.location.pathname)) return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, router]);

  const isOnSettings = useLocation({ select: (location) => isSettingsPathname(location.pathname) });
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  return (
    <SidebarProvider
      defaultOpen
      storageKey={THREAD_SIDEBAR_OPEN_STORAGE_KEY}
      mobileBreakpoint={THREAD_SIDEBAR_MIN_WIDTH + THREAD_MAIN_CONTENT_MIN_WIDTH}
    >
      <Sidebar
        side="left"
        collapsible="offcanvas"
        {...workspaceAreaProps("sidebar", 0, isOnSettings ? "Settings" : "Threads")}
        role="navigation"
        aria-label={isOnSettings ? "Settings" : "Threads"}
        className="contrast-palette dark:text-foreground dark:[--foreground:white] dark:[--muted-foreground:rgba(255,255,255,1)] dark:[--sidebar-accent-foreground:white] dark:[--accent-foreground:white]"
        resizable={{
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
            shouldAcceptThreadSidebarWidth({
              currentWidth,
              nextWidth,
              wrapperWidth: wrapper.clientWidth,
              minMainContentWidth: THREAD_MAIN_CONTENT_MIN_WIDTH,
            }),
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
      <AppShellShortcuts />
      <MainAppLocationTracker />
    </SidebarProvider>
  );
}
