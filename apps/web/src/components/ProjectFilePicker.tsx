"use client";

import { type ProjectEntry, ThreadId } from "@piedpiper/contracts";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { openInPreferredEditor } from "../editorPreferences";
import { useFilePickerStore } from "../filePickerStore";
import { useTheme } from "../hooks/useTheme";
import { projectSearchEntriesQueryOptions } from "../lib/projectReactQuery";
import { isTerminalFocused } from "../lib/terminalFocus";
import { readNativeApi } from "../nativeApi";
import { projectScriptCwd } from "../projectScripts";
import { useServerKeybindings } from "../rpc/serverState";
import { useProjectById, useThreadById } from "../storeSelectors";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { visiblePathSearchEntries } from "./ChatView.logic";
import type {
  CommandPaletteActionItem,
  CommandPaletteGroup,
  CommandPaletteItem,
} from "./CommandPalette.logic";
import { CommandPaletteResults } from "./CommandPaletteResults";
import {
  FILE_PICKER_SEARCH_LIMIT,
  filePickerEntries,
  filePickerEntryLabels,
  isFilePickerResultStale,
  joinWorkspaceFilePath,
  normalizeFilePickerQuery,
  resolveFilePickerShortcut,
} from "./ProjectFilePicker.logic";
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

const FILE_PICKER_QUERY_DEBOUNCE_MS = 120;
const EMPTY_ENTRIES: ReadonlyArray<ProjectEntry> = [];

/** Owns the toggle shortcut; the dialog's contents only mount while it is open. */
export function ProjectFilePicker() {
  const open = useFilePickerStore((store) => store.open);
  const setOpen = useFilePickerStore((store) => store.setOpen);
  const toggleOpen = useFilePickerStore((store) => store.toggleOpen);
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
    const outcome = resolveFilePickerShortcut(event, keybindings, {
      terminalFocus: isTerminalFocused(),
      terminalOpen,
    });
    if (!outcome) return;
    if (outcome === "yield-to-palette") {
      setOpen(false);
      return;
    }
    // Claimed first, so no path through here reaches the browser's print dialog.
    event.preventDefault();
    event.stopPropagation();
    // A confirmation has to be answered first; it must not end up under the picker.
    if (document.documentElement.hasAttribute(ALERT_DIALOG_OPEN_ATTRIBUTE)) return;
    if (outcome === "toggle") {
      useCommandPaletteStore.getState().setOpen(false);
      toggleOpen();
    }
  });

  useEffect(() => {
    // Capture phase: the composer editor would otherwise see mod+p first.
    const listener = (event: globalThis.KeyboardEvent) => onWindowKeyDown(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);

  return (
    <CommandDialog onOpenChange={(next) => setOpen(next)} open={open}>
      <CommandDialogPopup
        aria-label="File picker"
        className="overflow-hidden p-0"
        data-testid="project-file-picker"
      >
        <ProjectFilePickerContents onClose={() => setOpen(false)} routeThreadId={routeThreadId} />
      </CommandDialogPopup>
    </CommandDialog>
  );
}

function ProjectFilePickerContents(props: { routeThreadId: ThreadId | null; onClose: () => void }) {
  const serverThread = useThreadById(props.routeThreadId);
  const draftThread = useComposerDraftStore((store) =>
    props.routeThreadId ? (store.draftThreadsByThreadId[props.routeThreadId] ?? null) : null,
  );
  const project = useProjectById(serverThread?.projectId ?? draftThread?.projectId);

  // The settings, office and home routes have no thread, so no folder to search.
  if (!project) {
    return (
      <FilePickerLayout>
        <div className="py-10 text-center text-muted-foreground text-sm">
          Open a thread to search its project's files.
        </div>
      </FilePickerLayout>
    );
  }
  const cwd = projectScriptCwd({
    project: { cwd: project.cwd },
    worktreePath: serverThread?.worktreePath ?? draftThread?.worktreePath ?? null,
  });
  return <FilePickerSearch cwd={cwd} key={cwd} label={project.name} onClose={props.onClose} />;
}

function FilePickerLayout(props: {
  children: ReactNode;
  groups?: ReadonlyArray<CommandPaletteGroup>;
  query?: string;
  onQueryChange?: (query: string) => void;
}) {
  return (
    <Command
      autoHighlight="always"
      // Rows arrive after the typing: without `items`, the first one would not get highlighted.
      items={props.groups ?? []}
      mode="none"
      onValueChange={(nextQuery, details) => {
        // A chosen row reports its value here; only typing changes the query.
        if (details.reason === "item-press") return;
        props.onQueryChange?.(nextQuery);
      }}
      value={props.query ?? ""}
    >
      <CommandInput
        aria-label="File picker search"
        disabled={props.onQueryChange === undefined}
        placeholder="Search files..."
      />
      <CommandPanel className="flex max-h-[min(28rem,70vh)] flex-col overflow-hidden">
        {props.children}
      </CommandPanel>
      <CommandFooter className="gap-3 max-sm:flex-col max-sm:items-start">
        <div className="flex items-center gap-3">
          <KbdGroup className="items-center gap-1.5">
            <Kbd>Enter</Kbd>
            <span className="text-muted-foreground/80">Open in editor</span>
          </KbdGroup>
          <KbdGroup className="items-center gap-1.5">
            <Kbd>Esc</Kbd>
            <span className="text-muted-foreground/80">Close</span>
          </KbdGroup>
        </div>
      </CommandFooter>
    </Command>
  );
}

function FilePickerSearch(props: { cwd: string; label: string; onClose: () => void }) {
  const { cwd } = props;
  const { resolvedTheme } = useTheme();
  const keybindings = useServerKeybindings();
  const [query, setQuery] = useState("");
  const normalizedQuery = normalizeFilePickerQuery(query);
  const [debouncedQuery] = useDebouncedValue(normalizedQuery, {
    wait: FILE_PICKER_QUERY_DEBOUNCE_MS,
  });
  // An empty query skips the RPC right away, without waiting for the debounce.
  const searchQuery = normalizedQuery.length === 0 ? "" : debouncedQuery;
  const searchEntries = useQuery(
    projectSearchEntriesQueryOptions({
      cwd,
      query: searchQuery,
      limit: FILE_PICKER_SEARCH_LIMIT,
    }),
  );

  const toActionItem = (
    entry: ReturnType<typeof filePickerEntries>[number],
  ): CommandPaletteActionItem => {
    const { name, directory } = filePickerEntryLabels(entry.path);
    return {
      kind: "action",
      value: `file:${entry.path}`,
      searchTerms: [],
      title: name,
      ...(directory ? { description: directory } : {}),
      icon: <VscodeEntryIcon kind="file" pathValue={entry.path} theme={resolvedTheme} />,
      run: async () => {
        const api = readNativeApi();
        if (!api) throw new Error("Open in editor is unavailable.");
        await openInPreferredEditor(api, joinWorkspaceFilePath(cwd, entry.path));
      },
    };
  };
  const items = filePickerEntries(visiblePathSearchEntries(searchEntries, EMPTY_ENTRIES)).map(
    toActionItem,
  );

  const executeItem = (item: CommandPaletteItem) => {
    if (item.kind !== "action") return;
    if (
      isFilePickerResultStale({
        normalizedQuery,
        searchQuery,
        isPlaceholderData: searchEntries.isPlaceholderData,
      })
    ) {
      return;
    }
    props.onClose();
    item.run().catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Unable to open file",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    });
  };

  let emptyMessage: string;
  if (normalizedQuery.length === 0) {
    emptyMessage = `Type to search files in ${props.label}.`;
  } else if (searchQuery !== normalizedQuery || searchEntries.isFetching) {
    emptyMessage = "Searching files...";
  } else if (searchEntries.isError) {
    emptyMessage = "Unable to search files.";
  } else {
    emptyMessage = "No matching files.";
  }

  const groups: CommandPaletteGroup[] =
    items.length > 0 ? [{ value: "files", label: props.label, items }] : [];

  return (
    <FilePickerLayout groups={groups} onQueryChange={setQuery} query={query}>
      <CommandPaletteResults
        emptyMessage={emptyMessage}
        groups={groups}
        keybindings={keybindings}
        onExecuteItem={executeItem}
      />
    </FilePickerLayout>
  );
}
