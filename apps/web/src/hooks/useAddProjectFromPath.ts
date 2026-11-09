import { type NativeApi, type ProjectId } from "@piedpiper/contracts";
import { normalizeWorktreePathForComparison } from "@piedpiper/shared/path";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { isNonEmpty as isNonEmptyString } from "effect/String";

import { getFirstThreadForSidebar } from "../components/Sidebar.logic";
import { stripTrailingPathSeparators } from "../components/sidebar/projectPathSuggestions.logic";
import { toastManager } from "../components/ui/toast";
import { dispatchProjectArchived, isProjectArchived } from "../lib/projectArchive";
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
   * {@link addProjectFromPath}, resolving to whether the project is now added, for a caller whose
   * next step depends on it. False when nothing was attempted, or after the error was reported.
   */
  readonly tryAddProjectFromPath: (rawCwd: string) => Promise<boolean>;

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

/** The already-added project at a path; `/repo/` and `/repo`, or Windows casing, name the same one. */
export function findExistingProjectByPath<TProject extends { readonly cwd: string }>(
  projects: readonly TProject[],
  cwd: string,
): TProject | undefined {
  const key = normalizeWorktreePathForComparison(cwd);
  return projects.find((project) => normalizeWorktreePathForComparison(project.cwd) === key);
}

/**
 * The project a `project.create` refusal names. `~/repo` and `/x/../repo` only match after the
 * server normalizes them, and the store can lag, so the refusal is the only reliable lookup.
 */
export function findExistingProjectFromCreateError<TProject extends { readonly cwd: string }>(
  projects: readonly TProject[],
  error: unknown,
): TProject | undefined {
  const path =
    error instanceof Error ? /A project already exists at '(.+)'\./.exec(error.message)?.[1] : null;
  return path ? findExistingProjectByPath(projects, path) : undefined;
}

/**
 * The project a `project.create` acted on. The decider unarchives an existing project under its
 * own id, so the generated id can name nothing, and only the acted event says which one it was.
 */
export async function resolveCreatedProjectId(
  api: Pick<NativeApi, "orchestration">,
  input: {
    readonly projectId: ProjectId;
    readonly sequence: number;
    readonly projects: readonly { readonly id: ProjectId }[];
  },
): Promise<ProjectId> {
  if (input.projects.some((project) => project.id === input.projectId)) return input.projectId;
  try {
    const events = await api.orchestration.replayEvents(input.sequence - 1);
    const acted = events.find((event) => event.sequence === input.sequence);
    return acted?.aggregateKind === "project" ? (acted.aggregateId as ProjectId) : input.projectId;
  } catch {
    return input.projectId;
  }
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
      const latestThread = getFirstThreadForSidebar(
        threadIds
          .map((threadId) => state.sidebarThreadsById[threadId])
          .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
          .filter((thread) => thread.archivedAt === null),
        appSettings.sidebarThreadSortOrder,
      );
      if (!latestThread) {
        void handleNewThread(projectId, {
          envMode: appSettings.defaultThreadEnvMode,
        }).catch(() => undefined);
        return;
      }

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [
      appSettings.defaultThreadEnvMode,
      appSettings.sidebarThreadSortOrder,
      handleNewThread,
      navigate,
    ],
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

  const tryAddProjectFromPath = useCallback(
    async (rawCwd: string): Promise<boolean> => {
      const cwd = stripTrailingPathSeparators(rawCwd);
      if (!cwd || isAddingProject) return false;
      const api = readNativeApi();
      if (!api) return false;

      setIsAddingProject(true);

      const existing = findExistingProjectByPath(useStore.getState().projects, cwd);
      if (existing) {
        // This returns before project.create, so the server's own re-add unarchive never runs.
        if (isProjectArchived(existing)) {
          try {
            await dispatchProjectArchived(api, existing.id, null);
          } catch (error) {
            setIsAddingProject(false);
            reportError(
              error instanceof Error
                ? error.message
                : "An error occurred while adding the project.",
            );
            return false;
          }
        }
        focusMostRecentThreadForProject(existing.id);
        setIsAddingProject(false);
        onSuccess?.();
        return true;
      }

      // Ensure the directory is a git repo before creating the project.
      await api.git.init({ cwd }).catch(() => undefined);

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
      try {
        const result = await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          // Null so new drafts follow the installed provider instead of a stamped Claude default.
          defaultModelSelection: null,
          createdAt,
        });
        const actedProjectId = await resolveCreatedProjectId(api, {
          projectId,
          sequence: result.sequence,
          projects: useStore.getState().projects,
        });
        await handleNewThread(actedProjectId, {
          envMode: appSettings.defaultThreadEnvMode,
        }).catch(() => undefined);
      } catch (error) {
        const recovered = findExistingProjectFromCreateError(useStore.getState().projects, error);
        if (recovered) {
          focusMostRecentThreadForProject(recovered.id);
          setIsAddingProject(false);
          onSuccess?.();
          return true;
        }
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        reportError(description);
        return false;
      }
      setIsAddingProject(false);
      onSuccess?.();
      return true;
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

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      await tryAddProjectFromPath(rawCwd);
    },
    [tryAddProjectFromPath],
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
    tryAddProjectFromPath,
    isAddingProject,
    pickAndAddProject,
  };
}
