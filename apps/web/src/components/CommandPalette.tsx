"use client";

import { ThreadId, type ProjectId } from "@piedpiper/contracts";
import { resolvePastedPath } from "@piedpiper/shared/path";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BuildingIcon,
  FileSearchIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  RotateCcwIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useState, type KeyboardEvent } from "react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useFilePickerStore } from "../filePickerStore";
import { isElectron } from "../env";
import { useAddProjectFromPath } from "../hooks/useAddProjectFromPath";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import { resolveNewThreadShortcutOptions } from "../lib/projectArchive";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isLinuxPlatform } from "../lib/utils";
import { useServerKeybindings } from "../rpc/serverState";
import { useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { restartThreadSession } from "../threadSessionRestart";
import {
  buildProjectItems,
  buildThreadItems,
  canRestartThreadSession,
  filterProjectPickerGroups,
  filterRootGroups,
  resolveCommandPaletteToggle,
  selectCommandPaletteSources,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteItem,
  type CommandPaletteView,
} from "./CommandPalette.logic";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { ProjectFavicon } from "./ProjectFavicon";
import { getFirstThreadForSidebar } from "./Sidebar.logic";
import { isSettingsPathname } from "./sidebar/settingsRoute";
import { ALERT_DIALOG_OPEN_ATTRIBUTE } from "./ui/alert-dialog-open-flag";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandInput,
  CommandPanel,
} from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";
import { toastManager } from "./ui/toast";

const ITEM_ICON_CLASS = "size-4 text-muted-foreground/80";

/** Owns the toggle shortcut; the dialog's contents only mount while it is open. */
export function CommandPalette() {
  const open = useCommandPaletteStore((store) => store.open);
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const keybindings = useServerKeybindings();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });

  const onWindowKeyDown = useEffectEvent((event: globalThis.KeyboardEvent) => {
    const terminalOpen = routeThreadId
      ? selectThreadTerminalState(
          useTerminalStateStore.getState().terminalStateByThreadId,
          routeThreadId,
        ).terminalOpen
      : false;
    const outcome = resolveCommandPaletteToggle(event, keybindings, {
      terminalFocus: isTerminalFocused(),
      terminalOpen,
    });
    if (!outcome) return;
    event.preventDefault();
    event.stopPropagation();
    // A confirmation has to be answered first; it must not end up under the palette.
    if (document.documentElement.hasAttribute(ALERT_DIALOG_OPEN_ATTRIBUTE)) return;
    if (outcome === "toggle") useCommandPaletteStore.getState().toggleOpen();
  });

  useEffect(() => {
    // Capture phase: the composer editor would otherwise see mod+k first.
    const listener = (event: globalThis.KeyboardEvent) => onWindowKeyDown(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);

  return (
    <CommandDialog onOpenChange={setOpen} open={open}>
      <CommandDialogPopup
        aria-label="Command palette"
        className="overflow-hidden p-0"
        data-testid="command-palette"
      >
        <CommandPaletteContents />
      </CommandDialogPopup>
    </CommandDialog>
  );
}

function CommandPaletteContents() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const keybindings = useServerKeybindings();
  const sortOrder = useSettings((settings) => settings.sidebarThreadSortOrder);
  const defaultThreadEnvMode = useSettings((settings) => settings.defaultThreadEnvMode);
  const { activeDraftThread, activeThread, defaultProjectId, handleNewThread, routeThreadId } =
    useHandleNewThread();
  const { addProjectFromPath, pickAndAddProject } = useAddProjectFromPath();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<CommandPaletteView | null>(null);
  // Read once per open: rows must not move under the highlight while threads stream.
  const [snapshot] = useState(() => {
    const state = useStore.getState();
    const routeThread = routeThreadId ? state.sidebarThreadsById[routeThreadId] : undefined;
    return {
      nowMs: Date.now(),
      projects: state.projects,
      // restartThreadSession checks again after its confirmation, so a stale row stays safe.
      restartableThreadId:
        routeThread && canRestartThreadSession(routeThread) ? routeThreadId : null,
      ...selectCommandPaletteSources(state),
    };
  });
  const { projects, restartableThreadId, selectableProjects, threads } = snapshot;

  const projectTitleById = new Map<ProjectId, string>(
    projects.map((project) => [project.id, project.name]),
  );
  const projectIcon = (cwd: string) => <ProjectFavicon className={ITEM_ICON_CLASS} cwd={cwd} />;

  const threadItems = buildThreadItems({
    threads,
    activeThreadId: routeThreadId,
    projectTitleById,
    sortOrder,
    nowMs: snapshot.nowMs,
    icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
    runThread: async (threadId) => {
      await navigate({ to: "/$threadId", params: { threadId } });
    },
  });

  const projectItems = buildProjectItems({
    projects: selectableProjects,
    valuePrefix: "project",
    icon: projectIcon,
    runProject: async (projectId) => {
      const latestThread = getFirstThreadForSidebar(
        threads.filter((thread) => thread.projectId === projectId && thread.archivedAt === null),
        sortOrder,
      );
      if (latestThread) {
        await navigate({ to: "/$threadId", params: { threadId: latestThread.id } });
        return;
      }
      await handleNewThread(projectId, { envMode: defaultThreadEnvMode });
    },
  });

  const newThreadInItems = buildProjectItems({
    projects: selectableProjects,
    valuePrefix: "new-thread-in",
    icon: projectIcon,
    runProject: (projectId) => handleNewThread(projectId, { envMode: defaultThreadEnvMode }),
  });

  // A thread still open in an archived project falls back to the default project.
  const contextProjectId = activeThread?.projectId ?? activeDraftThread?.projectId;
  const hasThreadContext = selectableProjects.some((project) => project.id === contextProjectId);
  const newThreadProjectId = hasThreadContext ? contextProjectId : defaultProjectId;
  const newThreadProjectName = selectableProjects.find(
    (project) => project.id === newThreadProjectId,
  )?.name;

  const browseForProjectImmediately = isElectron && !isLinuxPlatform(navigator.platform);

  const actionItems: CommandPaletteItem[] = [
    ...(newThreadProjectId && newThreadProjectName
      ? [
          {
            kind: "action" as const,
            value: "action:new-thread",
            searchTerms: [`New thread in ${newThreadProjectName}`, "chat", "create", "draft"],
            title: `New thread in ${newThreadProjectName}`,
            icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
            shortcutCommand: "chat.new" as const,
            run: () =>
              handleNewThread(
                newThreadProjectId,
                resolveNewThreadShortcutOptions({
                  hasThreadContext,
                  activeThread,
                  activeDraftThread,
                  defaultEnvMode: defaultThreadEnvMode,
                }),
              ),
          },
        ]
      : []),
    ...(selectableProjects.length > 0
      ? [
          {
            kind: "submenu" as const,
            value: "action:new-thread-in",
            searchTerms: ["New thread in...", "project", "pick", "choose"],
            title: "New thread in...",
            icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
            view: "new-thread-in" as const,
          },
        ]
      : []),
    browseForProjectImmediately
      ? {
          kind: "action" as const,
          value: "action:add-project",
          searchTerms: ["Add project", "folder", "open", "repository"],
          title: "Add project",
          icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
          run: async () => {
            await pickAndAddProject();
          },
        }
      : {
          kind: "submenu" as const,
          value: "action:add-project",
          searchTerms: ["Add project", "folder", "open", "repository"],
          title: "Add project",
          icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
          view: "add-project" as const,
        },
    {
      kind: "action",
      value: "action:open-file-picker",
      searchTerms: ["Open file picker", "file", "search files", "go to file"],
      title: "Open file picker",
      icon: <FileSearchIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "filePicker.toggle",
      run: async () => {
        useFilePickerStore.getState().setOpen(true);
      },
    },
    {
      kind: "action",
      value: "action:settings",
      searchTerms: ["Open settings", "preferences", "configuration", "keybindings"],
      title: "Open settings",
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        // Repeated opens must not stack duplicate settings history entries.
        if (isSettingsPathname(pathname)) return;
        await navigate({ to: "/settings" });
      },
    },
    {
      kind: "action",
      value: "action:virtual-office",
      searchTerms: ["Virtual Office", "office", "desks", "agents"],
      title: "Virtual Office",
      icon: <BuildingIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/virtual-office" });
      },
    },
    ...(restartableThreadId
      ? [
          {
            kind: "action" as const,
            value: "action:restart-session",
            searchTerms: ["Restart session", "reload", "reset", "mcp", "plugins", "settings"],
            title: "Restart session",
            description: "Reload MCP servers, plugins and settings, keeping the conversation",
            icon: <RotateCcwIcon className={ITEM_ICON_CLASS} />,
            run: () => restartThreadSession(restartableThreadId),
          },
        ]
      : []),
  ];

  const trimmedPath = query.trim();
  const addProjectItems: CommandPaletteActionItem[] = [
    ...(trimmedPath.length > 0
      ? [
          {
            kind: "action" as const,
            value: "add-project-path",
            searchTerms: [],
            title: `Add ${trimmedPath}`,
            icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
            run: () => addProjectFromPath(trimmedPath),
          },
        ]
      : []),
    ...(isElectron
      ? [
          {
            kind: "action" as const,
            value: "add-project-browse",
            searchTerms: [],
            title: "Browse for folder",
            icon: <FolderIcon className={ITEM_ICON_CLASS} />,
            run: async () => {
              await pickAndAddProject();
            },
          },
        ]
      : []),
  ];

  let groups: CommandPaletteGroup[];
  let emptyMessage: string;
  let placeholder: string;
  if (view === "new-thread-in") {
    groups = filterProjectPickerGroups({ query, projectItems: newThreadInItems });
    emptyMessage = "No matching projects.";
    placeholder = "Search projects...";
  } else if (view === "add-project") {
    groups =
      addProjectItems.length > 0
        ? [{ value: "add-project", label: "Add project", items: addProjectItems }]
        : [];
    emptyMessage = "Type the full path of a project folder.";
    placeholder = "/path/to/project";
  } else {
    groups = filterRootGroups({ query, actionItems, threadItems, projectItems });
    emptyMessage = query.startsWith(">")
      ? "No matching actions."
      : "No matching threads, projects, or actions.";
    placeholder = "Search threads, projects, and actions...";
  }

  const leaveView = () => {
    setView(null);
    setQuery("");
  };

  const executeItem = (item: CommandPaletteItem) => {
    // The input stays live through the closing transition, so a second Enter can land here.
    if (!useCommandPaletteStore.getState().open) return;
    if (item.kind === "submenu") {
      setView(item.view);
      setQuery("");
      return;
    }
    setOpen(false);
    item.run().catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Unable to run command",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    });
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Not on repeat: holding Backspace to clear the text must not also leave the view.
    if (event.key === "Backspace" && !event.repeat && query === "" && view !== null) {
      event.preventDefault();
      leaveView();
    }
  };

  return (
    <Command
      autoHighlight="always"
      key={view ?? "root"}
      mode="none"
      onValueChange={(nextQuery, details) => {
        // A chosen row reports its value here; only typing changes the query.
        if (details.reason === "item-press") return;
        setQuery(view === "add-project" ? resolvePastedPath(query, nextQuery) : nextQuery);
      }}
      value={query}
    >
      <CommandInput
        aria-label="Command palette search"
        onKeyDown={handleInputKeyDown}
        placeholder={placeholder}
        {...(view === null
          ? {}
          : {
              wrapperClassName: "**:data-[slot=autocomplete-start-addon]:pointer-events-auto",
              startAddon: (
                <button
                  aria-label="Back"
                  className="flex cursor-pointer items-center"
                  onClick={leaveView}
                  type="button"
                >
                  <ArrowLeftIcon />
                </button>
              ),
            })}
      />
      <CommandPanel className="flex max-h-[min(28rem,70vh)] flex-col overflow-hidden">
        <CommandPaletteResults
          emptyMessage={emptyMessage}
          groups={groups}
          keybindings={keybindings}
          onExecuteItem={executeItem}
        />
      </CommandPanel>
      <CommandFooter className="gap-3 max-sm:flex-col max-sm:items-start">
        <div className="flex items-center gap-3">
          <KbdGroup className="items-center gap-1.5">
            <Kbd>Enter</Kbd>
            <span className="text-muted-foreground/80">Select</span>
          </KbdGroup>
          {view !== null ? (
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Backspace</Kbd>
              <span className="text-muted-foreground/80">Back</span>
            </KbdGroup>
          ) : (
            <KbdGroup className="items-center gap-1.5">
              <Kbd>&gt;</Kbd>
              <span className="text-muted-foreground/80">Actions only</span>
            </KbdGroup>
          )}
          <KbdGroup className="items-center gap-1.5">
            <Kbd>Esc</Kbd>
            <span className="text-muted-foreground/80">Close</span>
          </KbdGroup>
        </div>
      </CommandFooter>
    </Command>
  );
}
