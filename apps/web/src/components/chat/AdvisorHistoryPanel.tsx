import { type ThreadId } from "@piedpiper/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { type KeyboardEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { type ParsedAdvisor } from "../../lib/advisorIdentity";
import { newCommandId } from "../../lib/utils";
import { readNativeApi } from "../../nativeApi";
import { useAdvisorThreadIds, useThreadById } from "../../storeSelectors";
import { toastManager } from "../ui/toast";

interface AdvisorHistoryPanelProps {
  /** The advisor whose chat history we're showing. */
  readonly advisor: ParsedAdvisor;
  /** Active thread id, used to highlight the current row. */
  readonly currentThreadId: ThreadId | null;
  /** Closes the panel. */
  readonly onClose: () => void;
}

const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSeconds = Math.round((then - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  if (absSeconds < 60) return RELATIVE_FORMATTER.format(diffSeconds, "second");
  const minutes = Math.round(diffSeconds / 60);
  if (Math.abs(minutes) < 60) return RELATIVE_FORMATTER.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE_FORMATTER.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return RELATIVE_FORMATTER.format(days, "day");
  const weeks = Math.round(days / 7);
  if (Math.abs(weeks) < 5) return RELATIVE_FORMATTER.format(weeks, "week");
  const months = Math.round(days / 30);
  return RELATIVE_FORMATTER.format(months, "month");
}

interface AdvisorHistoryRowProps {
  readonly threadId: ThreadId;
  readonly isActive: boolean;
  readonly isRenaming: boolean;
  readonly onStartRename: (id: ThreadId, title: string) => void;
  readonly onRequestRowOpen: (id: ThreadId) => void;
  readonly onRequestDelete: (id: ThreadId, title: string) => void;
  readonly onCommitRename: (id: ThreadId) => void;
  readonly onCancelRename: () => void;
  readonly renameDraft: string;
  readonly onRenameDraftChange: (next: string) => void;
  readonly renameInputRef: React.RefObject<HTMLInputElement | null>;
}

/**
 * Per-row child component. Subscribes to **only its own thread** via
 * `useThreadById`, so a streaming chunk in another thread (or in the active
 * chat) re-renders only that thread's row instead of the whole panel. The
 * panel itself only re-renders when the filtered id list changes shape.
 */
const AdvisorHistoryRow = memo(function AdvisorHistoryRow({
  threadId,
  isActive,
  isRenaming,
  onStartRename,
  onRequestRowOpen,
  onRequestDelete,
  onCommitRename,
  onCancelRename,
  renameDraft,
  onRenameDraftChange,
  renameInputRef,
}: AdvisorHistoryRowProps) {
  const thread = useThreadById(threadId);
  const title = thread?.title ?? "";
  const updatedAt = thread?.updatedAt ?? thread?.createdAt ?? "";
  const relative = useMemo(() => formatRelativeTime(updatedAt), [updatedAt]);
  const firstUserMessage = useMemo(
    () => thread?.messages.find((m) => m.role === "user")?.text ?? null,
    [thread?.messages],
  );

  const handleClick = useCallback(() => {
    if (isRenaming) return;
    if (isActive) return;
    onRequestRowOpen(threadId);
  }, [isActive, isRenaming, onRequestRowOpen, threadId]);

  const handleKeyDownRow = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleClick();
      }
    },
    [handleClick],
  );

  const handleStartRename = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onStartRename(threadId, title);
    },
    [onStartRename, threadId, title],
  );

  const handleDelete = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onRequestDelete(threadId, title);
    },
    [onRequestDelete, threadId, title],
  );

  const handleRenameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onCommitRename(threadId);
      } else if (event.key === "Escape") {
        event.preventDefault();
        onCancelRename();
      }
    },
    [onCancelRename, onCommitRename, threadId],
  );

  const handleConfirmRename = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onCommitRename(threadId);
    },
    [onCommitRename, threadId],
  );

  if (!thread) return null;

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={handleKeyDownRow}
        className={`group flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 transition-colors ${
          isActive ? "bg-accent text-foreground" : "text-foreground/85 hover:bg-accent/60"
        }`}
      >
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameDraft}
              onChange={(event) => onRenameDraftChange(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={handleRenameKeyDown}
              onBlur={() => onCommitRename(threadId)}
              className="w-full rounded border border-border bg-secondary px-1.5 py-0.5 text-xs text-foreground outline-none focus:border-ring"
            />
          ) : (
            <div className="truncate text-xs font-medium" title={title}>
              {title}
            </div>
          )}
          {firstUserMessage && (
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground/50">
              {firstUserMessage}
            </div>
          )}
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground/70">{relative}</div>
        </div>
        {!isRenaming && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              aria-label="Rename chat"
              title="Rename"
              onClick={handleStartRename}
              className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <PencilIcon className="size-3" />
            </button>
            <button
              type="button"
              aria-label="Delete chat"
              title="Delete"
              onClick={handleDelete}
              className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
            >
              <Trash2Icon className="size-3" />
            </button>
          </div>
        )}
        {isRenaming && (
          <button
            type="button"
            aria-label="Confirm rename"
            onClick={handleConfirmRename}
            className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <CheckIcon className="size-3" />
          </button>
        )}
      </div>
    </li>
  );
});

/**
 * Right-side overlay listing every chat the user has had with the active
 * advisor. Subscribes to a stable, primitive id-list via
 * {@link useAdvisorThreadIds} so streaming chunks in unrelated threads do
 * **not** re-render the panel — only the per-row child whose own thread
 * actually changed will re-render. Each row supports inline rename + delete;
 * the footer offers a Clear all action that wipes every history entry for
 * this character.
 */
export const AdvisorHistoryPanel = memo(function AdvisorHistoryPanel({
  advisor,
  currentThreadId,
  onClose,
}: AdvisorHistoryPanelProps) {
  const navigate = useNavigate();
  const { deleteThread } = useThreadActions();
  const threadIds = useAdvisorThreadIds(advisor.id);

  const [renamingId, setRenamingId] = useState<ThreadId | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  const handleStartRename = useCallback((id: ThreadId, title: string) => {
    setRenamingId(id);
    setRenameDraft(title);
  }, []);

  const handleCancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameDraft("");
  }, []);

  const handleCommitRename = useCallback(
    async (rowId: ThreadId) => {
      const next = renameDraft.trim();
      if (!next) {
        handleCancelRename();
        return;
      }
      const api = readNativeApi();
      if (!api) return;
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: rowId,
          title: next,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Couldn't rename chat",
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        handleCancelRename();
      }
    },
    [handleCancelRename, renameDraft],
  );

  const handleRowOpen = useCallback(
    (rowId: ThreadId) => {
      void navigate({ to: "/$threadId", params: { threadId: rowId } });
    },
    [navigate],
  );

  const handleRequestDelete = useCallback(
    async (rowId: ThreadId, title: string) => {
      if (!window.confirm(`Delete "${title}"? This permanently clears the conversation.`)) {
        return;
      }
      try {
        await deleteThread(rowId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Couldn't delete chat",
          description: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
    [deleteThread],
  );

  const handleClearAll = useCallback(async () => {
    if (threadIds.length === 0) return;
    if (
      !window.confirm(
        `Delete all ${threadIds.length} chat${threadIds.length === 1 ? "" : "s"} with ${advisor.displayName}? This cannot be undone.`,
      )
    ) {
      return;
    }
    const errors: string[] = [];
    for (const id of threadIds) {
      try {
        await deleteThread(id);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Unknown error");
      }
    }
    if (errors.length > 0) {
      toastManager.add({
        type: "error",
        title: `Couldn't clear ${errors.length} chat${errors.length === 1 ? "" : "s"}`,
        description: errors[0] ?? "Unknown error",
      });
    }
  }, [advisor.displayName, deleteThread, threadIds]);

  return (
    <aside
      className="absolute top-0 right-0 z-40 flex h-full w-80 flex-col border-l border-border bg-background/95 shadow-2xl backdrop-blur-md"
      aria-label={`History of chats with ${advisor.displayName}`}
    >
      <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-border px-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">History</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {threadIds.length === 0
              ? `No chats yet`
              : `${threadIds.length} chat${threadIds.length === 1 ? "" : "s"} with ${advisor.shortName}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close history"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto py-2">
        {threadIds.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground/60">
            Start a conversation to see it here.
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5 px-2">
            {threadIds.map((id) => (
              <AdvisorHistoryRow
                key={id}
                threadId={id}
                isActive={id === currentThreadId}
                isRenaming={renamingId === id}
                onStartRename={handleStartRename}
                onRequestRowOpen={handleRowOpen}
                onRequestDelete={handleRequestDelete}
                onCommitRename={handleCommitRename}
                onCancelRename={handleCancelRename}
                renameDraft={renameDraft}
                onRenameDraftChange={setRenameDraft}
                renameInputRef={renameInputRef}
              />
            ))}
          </ul>
        )}
      </div>

      {threadIds.length > 0 && (
        <footer className="shrink-0 border-t border-border px-3 py-2.5">
          <button
            type="button"
            onClick={() => void handleClearAll()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/12 hover:text-destructive"
          >
            <Trash2Icon className="size-3" />
            Clear All Chats
          </button>
        </footer>
      )}
    </aside>
  );
});
