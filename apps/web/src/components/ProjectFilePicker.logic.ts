import type { ProjectEntry, ResolvedKeybindingsConfig } from "@piedpiper/contracts";
import { isWindowsAbsolutePath } from "@piedpiper/shared/path";

import { resolveShortcutCommand, type ShortcutEventLike } from "../keybindings";
import { KEYBINDING_CAPTURE_SELECTOR } from "./AppSidebarLayout.logic";

/** The contract's largest request, since directories in the results are filtered out here. */
export const FILE_PICKER_SEARCH_LIMIT = 200;
export const FILE_PICKER_RESULT_LIMIT = 50;
const FILE_PICKER_QUERY_MAX_LENGTH = 256;

/** The search input schema refuses blank and over-long queries. */
export function normalizeFilePickerQuery(query: string): string {
  return query.trim().slice(0, FILE_PICKER_QUERY_MAX_LENGTH).trimEnd();
}

/** Keeps the server's ranking; only directories drop out. */
export function filePickerEntries(
  entries: ReadonlyArray<ProjectEntry>,
): ReadonlyArray<ProjectEntry> {
  return entries.filter((entry) => entry.kind === "file").slice(0, FILE_PICKER_RESULT_LIMIT);
}

/** Search results are always `/`-separated and relative to the searched folder. */
export function joinWorkspaceFilePath(cwd: string, relativePath: string): string {
  if (isWindowsAbsolutePath(cwd)) {
    return `${cwd.replace(/[\\/]+$/, "")}\\${relativePath.replaceAll("/", "\\")}`;
  }
  return `${cwd.replace(/\/+$/, "")}/${relativePath}`;
}

/** Rows left from the previous query stay visible, but Enter must not open one of them. */
export function isFilePickerResultStale(input: {
  normalizedQuery: string;
  searchQuery: string;
  isPlaceholderData: boolean;
}): boolean {
  return input.searchQuery !== input.normalizedQuery || input.isPlaceholderData;
}

export function filePickerEntryLabels(path: string): { name: string; directory?: string } {
  const separator = path.lastIndexOf("/");
  return separator < 0
    ? { name: path }
    : { name: path.slice(separator + 1), directory: path.slice(0, separator) };
}

export type FilePickerShortcutOutcome = "toggle" | "swallow" | "yield-to-palette";

export function resolveFilePickerShortcut(
  event: ShortcutEventLike & { defaultPrevented?: boolean; target?: EventTarget | null },
  keybindings: ResolvedKeybindingsConfig,
  context: { terminalFocus: boolean; terminalOpen: boolean; platform?: string },
): FilePickerShortcutOutcome | null {
  const target = event.target as { closest?: (selector: string) => unknown } | null | undefined;
  if (typeof target?.closest === "function" && target.closest(KEYBINDING_CAPTURE_SELECTOR)) {
    return null;
  }
  const command = resolveShortcutCommand(event, keybindings, {
    ...(context.platform ? { platform: context.platform } : {}),
    context: { terminalFocus: context.terminalFocus, terminalOpen: context.terminalOpen },
  });
  // Seen even when the palette's listener already claimed the event, whichever ran first.
  if (command === "commandPalette.toggle") return "yield-to-palette";
  if (command !== "filePicker.toggle" || event.defaultPrevented) return null;
  return event.repeat === true ? "swallow" : "toggle";
}
