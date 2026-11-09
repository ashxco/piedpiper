import type {
  KeybindingCommand,
  ProjectId,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@piedpiper/contracts";
import type { SidebarThreadSortOrder } from "@piedpiper/contracts/settings";
import type { ReactNode } from "react";

import { resolveShortcutCommand, type ShortcutEventLike } from "../keybindings";
import { selectableProjects } from "../lib/projectArchive";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { Project, SidebarThreadSummary } from "../types";
import { KEYBINDING_CAPTURE_SELECTOR } from "./AppSidebarLayout.logic";
import { selectSidebarVisibleProjects, sortThreadsForSidebar } from "./Sidebar.logic";

export const RECENT_THREAD_LIMIT = 12;
// Rows stay cheap to mount; ranking runs first, so the best matches are never cut.
export const SEARCH_RESULT_LIMIT = 50;

interface CommandPaletteItemBase {
  readonly value: string;
  /** Most important first: earlier terms rank higher. */
  readonly searchTerms: ReadonlyArray<string>;
  readonly title: string;
  readonly description?: string;
  readonly timestamp?: string;
  readonly icon: ReactNode;
  readonly shortcutCommand?: KeybindingCommand;
}

export interface CommandPaletteActionItem extends CommandPaletteItemBase {
  readonly kind: "action";
  readonly run: () => Promise<void>;
}

export interface CommandPaletteSubmenuItem extends CommandPaletteItemBase {
  readonly kind: "submenu";
  readonly view: CommandPaletteView;
}

export type CommandPaletteItem = CommandPaletteActionItem | CommandPaletteSubmenuItem;

export type CommandPaletteView = "new-thread-in" | "add-project";

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteItem>;
}

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function rankFieldMatch(field: string, normalizedQuery: string): number | null {
  const normalizedField = normalizeSearchText(field);
  if (!normalizedField.includes(normalizedQuery)) return null;
  if (normalizedField === normalizedQuery) return 3;
  return normalizedField.startsWith(normalizedQuery) ? 2 : 1;
}

/** Null when the item does not match. A whole-query match in an earlier term ranks highest. */
export function rankCommandPaletteItem(
  searchTerms: ReadonlyArray<string>,
  normalizedQuery: string,
): number | null {
  const haystack = normalizeSearchText(searchTerms.join(" "));
  if (!normalizedQuery.split(" ").every((token) => haystack.includes(token))) return null;
  for (const [index, term] of searchTerms.entries()) {
    const fieldRank = rankFieldMatch(term, normalizedQuery);
    if (fieldRank !== null) return 1_000 - index * 100 + fieldRank;
  }
  // Every word matched, but across different terms.
  return 0;
}

function filterGroup(group: CommandPaletteGroup, normalizedQuery: string): CommandPaletteGroup[] {
  const items = group.items
    .flatMap((item, index) => {
      const rank = rankCommandPaletteItem(item.searchTerms, normalizedQuery);
      return rank === null ? [] : [{ item, index, rank }];
    })
    .toSorted((left, right) => right.rank - left.rank || left.index - right.index)
    .slice(0, SEARCH_RESULT_LIMIT)
    .map((entry) => entry.item);
  return items.length === 0 ? [] : [{ ...group, items }];
}

export function buildRootGroups(input: {
  actionItems: ReadonlyArray<CommandPaletteItem>;
  threadItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const recentThreads = input.threadItems.slice(0, RECENT_THREAD_LIMIT);
  return [
    ...(input.actionItems.length > 0
      ? [{ value: "actions", label: "Actions", items: input.actionItems }]
      : []),
    ...(recentThreads.length > 0
      ? [{ value: "recent-threads", label: "Recent threads", items: recentThreads }]
      : []),
  ];
}

/** `>` limits the root view to actions; a real query searches threads, then projects. */
export function filterRootGroups(input: {
  query: string;
  actionItems: ReadonlyArray<CommandPaletteItem>;
  threadItems: ReadonlyArray<CommandPaletteActionItem>;
  projectItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const isActionsFilter = input.query.startsWith(">");
  const normalizedQuery = normalizeSearchText(isActionsFilter ? input.query.slice(1) : input.query);
  const actionGroup: CommandPaletteGroup = {
    value: "actions",
    label: "Actions",
    items: input.actionItems,
  };
  if (normalizedQuery.length === 0) {
    return isActionsFilter
      ? buildRootGroups({ actionItems: input.actionItems, threadItems: [] })
      : buildRootGroups(input);
  }
  if (isActionsFilter) return filterGroup(actionGroup, normalizedQuery);
  return [
    actionGroup,
    { value: "threads", label: "Threads", items: input.threadItems },
    { value: "projects", label: "Projects", items: input.projectItems },
  ].flatMap((group) => filterGroup(group, normalizedQuery));
}

export function filterProjectPickerGroups(input: {
  query: string;
  projectItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const group: CommandPaletteGroup = {
    value: "projects",
    label: "Projects",
    items: input.projectItems,
  };
  const normalizedQuery = normalizeSearchText(input.query);
  return normalizedQuery.length === 0 ? [group] : filterGroup(group, normalizedQuery);
}

/** Unarchived threads, newest first by the sidebar's sort order. */
export function buildThreadItems(input: {
  threads: ReadonlyArray<SidebarThreadSummary>;
  activeThreadId: ThreadId | null;
  projectTitleById: ReadonlyMap<ProjectId, string>;
  sortOrder: SidebarThreadSortOrder;
  nowMs: number;
  icon: ReactNode;
  runThread: (threadId: ThreadId) => Promise<void>;
}): CommandPaletteActionItem[] {
  const threads = sortThreadsForSidebar(
    input.threads.filter((thread) => thread.archivedAt === null),
    input.sortOrder,
  );
  return threads.map((thread) => {
    const projectTitle = input.projectTitleById.get(thread.projectId) ?? "";
    const description = [
      projectTitle,
      thread.branch ? `#${thread.branch}` : "",
      thread.id === input.activeThreadId ? "Current thread" : "",
    ]
      .filter((part) => part.length > 0)
      .join(" · ");
    return {
      kind: "action",
      value: `thread:${thread.id}`,
      searchTerms: [thread.title, projectTitle, thread.branch ?? ""],
      title: thread.title,
      description,
      timestamp: formatRelativeTimeLabel(thread.updatedAt ?? thread.createdAt, input.nowMs),
      icon: input.icon,
      run: () => input.runThread(thread.id),
    };
  });
}

export function buildProjectItems(input: {
  projects: ReadonlyArray<Pick<Project, "id" | "name" | "cwd">>;
  valuePrefix: string;
  icon: (cwd: string) => ReactNode;
  runProject: (projectId: ProjectId) => Promise<void>;
}): CommandPaletteActionItem[] {
  return input.projects.map((project) => ({
    kind: "action",
    value: `${input.valuePrefix}:${project.id}`,
    searchTerms: [project.name, project.cwd],
    title: project.name,
    description: project.cwd,
    icon: input.icon(project.cwd),
    run: () => input.runProject(project.id),
  }));
}

/** What one open offers: never an archived project, and threads only where the sidebar lists them. */
export function selectCommandPaletteSources<
  TProject extends Pick<Project, "id" | "archivedAt">,
>(input: {
  projects: ReadonlyArray<TProject>;
  threadIdsByProjectId: Readonly<Record<string, ReadonlyArray<string>>>;
  sidebarThreadsById: Readonly<Record<string, SidebarThreadSummary | undefined>>;
}): { selectableProjects: TProject[]; threads: SidebarThreadSummary[] } {
  const visibleProjectIds = new Set(
    selectSidebarVisibleProjects(
      input.projects,
      input.threadIdsByProjectId,
      input.sidebarThreadsById,
    ).map((project) => project.id),
  );
  return {
    selectableProjects: selectableProjects(input.projects),
    threads: Object.values(input.sidebarThreadsById).filter(
      (thread): thread is SidebarThreadSummary =>
        thread !== undefined && visibleProjectIds.has(thread.projectId),
    ),
  };
}

/** A live session the next message can resume, with nothing in flight for a restart to cut off. */
export function canRestartThreadSession(
  thread: Pick<SidebarThreadSummary, "session" | "hasPendingApprovals" | "hasPendingUserInput">,
): boolean {
  const { session } = thread;
  if (!session || session.activeTurnId || thread.hasPendingApprovals) return false;
  if (thread.hasPendingUserInput) return false;
  if (session.status === "closed" || session.status === "running") return false;
  if (session.status === "connecting") return false;
  return session.orchestrationStatus !== "starting" && session.orchestrationStatus !== "running";
}

export type CommandPaletteToggleOutcome = "toggle" | "swallow";

/** Held auto-repeats are swallowed so the palette does not flicker open and shut. */
export function resolveCommandPaletteToggle(
  event: ShortcutEventLike & { defaultPrevented?: boolean; target?: EventTarget | null },
  keybindings: ResolvedKeybindingsConfig,
  context: { terminalFocus: boolean; terminalOpen: boolean; platform?: string },
): CommandPaletteToggleOutcome | null {
  if (event.defaultPrevented) return null;
  const target = event.target as { closest?: (selector: string) => unknown } | null | undefined;
  if (typeof target?.closest === "function" && target.closest(KEYBINDING_CAPTURE_SELECTOR)) {
    return null;
  }
  const command = resolveShortcutCommand(event, keybindings, {
    ...(context.platform ? { platform: context.platform } : {}),
    context: { terminalFocus: context.terminalFocus, terminalOpen: context.terminalOpen },
  });
  if (command !== "commandPalette.toggle") return null;
  return event.repeat === true ? "swallow" : "toggle";
}
