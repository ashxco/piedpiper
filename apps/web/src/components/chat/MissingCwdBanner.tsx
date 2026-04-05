import { type CommandId, type ProjectId, type ThreadId } from "@piedpiper/contracts";
import { AlertTriangleIcon, FolderPlusIcon, FolderSearchIcon, Trash2Icon } from "lucide-react";
import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { newCommandId } from "../../lib/utils";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { getWsRpcClient } from "../../wsRpcClient";

interface MissingCwdBannerProps {
  missingCwd: string;
  threadId: ThreadId;
  projectId: ProjectId;
  onResolved: () => void;
}

export function MissingCwdBanner({
  missingCwd,
  threadId,
  projectId,
  onResolved,
}: MissingCwdBannerProps) {
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const handleCreate = useCallback(async () => {
    setBusy(true);
    try {
      const api = readNativeApi();
      const rpcClient = getWsRpcClient();
      await rpcClient.projects.createDirectory({ path: missingCwd });
      await api?.git.init({ cwd: missingCwd }).catch(() => undefined);
      onResolved();
    } catch {
      // noop
    } finally {
      setBusy(false);
    }
  }, [missingCwd, onResolved]);

  const handleLocate = useCallback(async () => {
    const api = readNativeApi();
    if (!api) return;

    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      return;
    }
    if (!pickedPath) return;

    setBusy(true);
    try {
      const existing = useStore.getState().projects.find((p) => p.cwd === pickedPath);

      if (existing && existing.id !== projectId) {
        const confirmed = await api.dialogs.confirm(
          `"${existing.name}" already uses this folder. Delete the old project and switch to it?`,
        );
        if (!confirmed) {
          setBusy(false);
          return;
        }
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: crypto.randomUUID() as CommandId,
            threadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: crypto.randomUUID() as CommandId,
          projectId,
        });
        void navigate({ to: "/" });
        return;
      }

      await api.orchestration
        .dispatchCommand({
          type: "thread.session.stop",
          commandId: crypto.randomUUID() as CommandId,
          threadId,
          createdAt: new Date().toISOString(),
        })
        .catch(() => undefined);

      await api.git.init({ cwd: pickedPath }).catch(() => undefined);

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId,
        workspaceRoot: pickedPath,
      });
      onResolved();
    } catch {
      // noop
    } finally {
      setBusy(false);
    }
  }, [navigate, onResolved, projectId, threadId]);

  const handleDelete = useCallback(async () => {
    setBusy(true);
    try {
      const api = readNativeApi();
      if (!api) return;
      await api.orchestration
        .dispatchCommand({
          type: "thread.session.stop",
          commandId: crypto.randomUUID() as CommandId,
          threadId,
          createdAt: new Date().toISOString(),
        })
        .catch(() => undefined);
      await api.orchestration.dispatchCommand({
        type: "project.delete",
        commandId: crypto.randomUUID() as CommandId,
        projectId,
      });
      void navigate({ to: "/" });
    } catch {
      // noop
    } finally {
      setBusy(false);
    }
  }, [navigate, projectId, threadId]);

  return (
    <div className="shrink-0 border-t border-border/50 bg-secondary/50 px-4 py-4 sm:px-6">
      <div className="mx-auto flex max-w-[52rem] items-start gap-3">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Project Folder Not Found</p>
          <code className="mt-1 block truncate text-xs text-muted-foreground/60">{missingCwd}</code>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleCreate()}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FolderPlusIcon className="size-3" />
              Recreate Folder
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleLocate()}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-4 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FolderSearchIcon className="size-3" />
              Locate Folder
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleDelete()}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-4 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2Icon className="size-3" />
              Delete Project
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
