import type { ContextMenuItem } from "@piedpiper/contracts";

import type { ThreadSnoozeMenuItemId } from "./Sidebar.snooze";

export type ThreadActionMenuItemId =
  | "new-thread-on-branch"
  | "find-in-thread"
  | "rename"
  | "regenerate-title"
  | "restart-session"
  | "pin"
  | "unpin"
  | "mark-unread"
  | "copy-path"
  | "copy-branch"
  | "copy-thread-id"
  | "archive"
  | "delete";

/** One item list for the sidebar row menu and the chat header title menu, so they cannot drift. */
export function buildThreadActionMenuItems(input: {
  readonly branch: string | null;
  readonly pinned: boolean;
  readonly canRestartSession?: boolean;
  readonly regeneratingTitle?: boolean;
  readonly snoozeItems?: readonly ContextMenuItem<ThreadSnoozeMenuItemId>[];
  readonly archiveBlocked?: boolean;
  /** Only where the timeline is on screen; the sidebar row menu shares this list. */
  readonly canFindInThread?: boolean;
}): ContextMenuItem<ThreadActionMenuItemId | ThreadSnoozeMenuItemId>[] {
  return [
    ...(input.branch
      ? [{ id: "new-thread-on-branch" as const, label: `New thread on ${input.branch}` }]
      : []),
    ...(input.canFindInThread ? [{ id: "find-in-thread" as const, label: "Find in thread" }] : []),
    { id: "rename", label: "Rename thread" },
    input.regeneratingTitle
      ? { id: "regenerate-title", label: "Regenerating…", disabled: true }
      : { id: "regenerate-title", label: "Regenerate title" },
    ...(input.canRestartSession
      ? [{ id: "restart-session" as const, label: "Restart session" }]
      : []),
    input.pinned ? { id: "unpin", label: "Unpin thread" } : { id: "pin", label: "Pin thread" },
    ...(input.snoozeItems ?? []),
    { id: "mark-unread", label: "Mark unread" },
    { id: "copy-path", label: "Copy Path" },
    ...(input.branch ? [{ id: "copy-branch" as const, label: "Copy Branch" }] : []),
    { id: "copy-thread-id", label: "Copy Thread ID" },
    { id: "archive", label: "Archive thread", disabled: input.archiveBlocked === true },
    { id: "delete", label: "Delete", destructive: true },
  ];
}

/** The folder a thread works in: its worktree, else its project's root. */
export function resolveThreadWorkspacePath(
  thread: { readonly worktreePath: string | null },
  projectCwd: string | null | undefined,
): string | null {
  return thread.worktreePath ?? projectCwd ?? null;
}
