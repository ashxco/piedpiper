import { DEFAULT_MODEL_BY_PROVIDER, type ProjectId } from "@piedpiper/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { isNonEmpty as isNonEmptyString } from "effect/String";

import { sortThreadsForSidebar } from "../components/Sidebar.logic";
import { toastManager } from "../components/ui/toast";
import { newCommandId, newProjectId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useHandleNewThread } from "./useHandleNewThread";
import { useSettings } from "./useSettings";

export interface UseAddProjectFromPathOptions {
  /**
   * Called when the dispatched project.create command throws. If omitted, the
   * error is surfaced via {@link toastManager}. Provide a callback when the
   * caller has its own surface for inline errors (e.g. the sidebar's add-project
   * input form).
   */
  readonly onError?: (description: string) => void;

  /**
   * Called after a successful add (or after navigating to an existing project's
   * latest thread). Used by callers that need to clean up local state, e.g.
   * close an inline form.
   */
  readonly onSuccess?: () => void;
}

export interface UseAddProjectFromPathResult {
  /**
   * Add a project for the given absolute path. Trims the input, no-ops on
   * empty strings or while another add is already in flight, deduplicates
   * against existing projects (navigating to the most recent thread of an
   * already-added project instead of creating a duplicate), dispatches
   * `project.create` and seeds a first thread using the user's default
   * env mode.
   */
  readonly addProjectFromPath: (rawCwd: string) => Promise<void>;

  /**
   * True while a project.create dispatch is in flight.
   */
  readonly isAddingProject: boolean;

  /**
   * Open the native folder picker and add whatever the user selects. Returns
   * `true` if a path was picked (and add was attempted), `false` if the user
   * dismissed the picker.
   */
  readonly pickAndAddProject: () => Promise<boolean>;
}

/**
 * Shared add-project flow used by the sidebar (inline form + drag/drop).
 * Centralises validation, dedup, project creation, first-thread seeding,
 * and error reporting.
 */
export function useAddProjectFromPath(
  options: UseAddProjectFromPathOptions = {},
): UseAddProjectFromPathResult {
  const navigate = useNavigate();
  const appSettings = useSettings();
  const { handleNewThread } = useHandleNewThread();
  const [isAddingProject, setIsAddingProject] = useState(false);

  const { onError, onSuccess } = options;

  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const state = useStore.getState();
      const threadIds = state.threadIdsByProjectId[projectId] ?? [];
      const latestThread = sortThreadsForSidebar(
        threadIds
          .map((threadId) => state.sidebarThreadsById[threadId])
          .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
          .filter((thread) => thread.archivedAt === null),
        appSettings.sidebarThreadSortOrder,
      )[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [appSettings.sidebarThreadSortOrder, navigate],
  );

  const reportError = useCallback(
    (description: string) => {
      if (onError) {
        onError(description);
        return;
      }
      toastManager.add({
        type: "error",
        title: "Failed to add project",
        description,
      });
    },
    [onError],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      setIsAddingProject(true);

      const existing = useStore.getState().projects.find((project) => project.cwd === cwd);
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        setIsAddingProject(false);
        onSuccess?.();
        return;
      }

      // Ensure the directory is a git repo before creating the project.
      await api.git.init({ cwd }).catch(() => undefined);

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModelSelection: {
            provider: "claudeAgent",
            model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
          },
          createdAt,
        });
        await handleNewThread(projectId, {
          envMode: appSettings.defaultThreadEnvMode,
        }).catch(() => undefined);
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        reportError(description);
        return;
      }
      setIsAddingProject(false);
      onSuccess?.();
    },
    [
      appSettings.defaultThreadEnvMode,
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      onSuccess,
      reportError,
    ],
  );

  const pickAndAddProject = useCallback(async () => {
    const api = readNativeApi();
    if (!api) return false;
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Picker cancellation/failure leaves the caller's state untouched.
    }
    if (!pickedPath) return false;
    await addProjectFromPath(pickedPath);
    return true;
  }, [addProjectFromPath]);

  return {
    addProjectFromPath,
    isAddingProject,
    pickAndAddProject,
  };
}
