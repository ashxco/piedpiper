import { type ProjectId, type RuntimeMode, ThreadId } from "@piedpiper/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { selectableProjects } from "../lib/projectArchive";
import { newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { useStore } from "../store";
import { useThreadById } from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";
import { useSettings } from "./useSettings";

export interface NewThreadOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
}

/** Initial state for a brand-new draft; its permission mode comes from the user's default. */
export function buildNewDraftThreadState(input: {
  readonly options: NewThreadOptions | undefined;
  readonly defaultRuntimeMode: RuntimeMode;
  readonly createdAt: string;
  readonly defaultEnvMode?: DraftThreadEnvMode;
}) {
  return {
    createdAt: input.createdAt,
    branch: input.options?.branch ?? null,
    worktreePath: input.options?.worktreePath ?? null,
    envMode: input.options?.envMode ?? input.defaultEnvMode ?? ("local" as const),
    runtimeMode: input.defaultRuntimeMode,
  };
}

/**
 * Workspace context to apply to a reused stored draft: explicit options win; otherwise a draft
 * that is not the open route goes back to the defaults so stale branch/worktree context is dropped.
 */
export function resolveStoredDraftThreadContext(input: {
  readonly options: NewThreadOptions | undefined;
  readonly isOpenRoute: boolean;
  readonly defaultEnvMode: DraftThreadEnvMode;
  readonly defaultRuntimeMode?: RuntimeMode;
}): (NewThreadOptions & { runtimeMode?: RuntimeMode }) | null {
  const { options } = input;
  const hasBranchOption = options?.branch !== undefined;
  const hasWorktreePathOption = options?.worktreePath !== undefined;
  const hasEnvModeOption = options?.envMode !== undefined;
  if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
    return {
      ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
      ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
      ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
    };
  }
  if (input.isOpenRoute) {
    return null;
  }
  return {
    branch: null,
    worktreePath: null,
    envMode: input.defaultEnvMode,
    ...(input.defaultRuntimeMode ? { runtimeMode: input.defaultRuntimeMode } : {}),
  };
}

/** A route draft is reused for its project unless its first send is still promoting it. */
export function canReuseRouteDraftThread(
  draftThread: Pick<DraftThreadState, "projectId" | "promoting"> | null,
  projectId: ProjectId,
): boolean {
  return draftThread !== null && draftThread.projectId === projectId && !draftThread.promoting;
}

/** Projects a new thread may default to. */
export function defaultableProjectIds(
  projects: ReadonlyArray<{ id: ProjectId; archivedAt?: string | null | undefined }>,
): ProjectId[] {
  return selectableProjects(projects).map((project) => project.id);
}

const selectDefaultRuntimeMode = (settings: { defaultRuntimeMode: RuntimeMode }) =>
  settings.defaultRuntimeMode;
const selectDefaultThreadEnvMode = (settings: { defaultThreadEnvMode: DraftThreadEnvMode }) =>
  settings.defaultThreadEnvMode;

export function useHandleNewThread() {
  // Only the default project skips archived ones; an explicit projectId is opened as given.
  const projectIds = useStore(useShallow((state) => defaultableProjectIds(state.projects)));
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const navigate = useNavigate();
  const defaultRuntimeMode = useSettings(selectDefaultRuntimeMode);
  const defaultThreadEnvMode = useSettings(selectDefaultThreadEnvMode);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const activeThread = useThreadById(routeThreadId);
  const activeDraftThread = useComposerDraftStore((store) =>
    routeThreadId ? (store.draftThreadsByThreadId[routeThreadId] ?? null) : null,
  );
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projectIds,
      preferredIds: projectOrder,
      getId: (projectId) => projectId,
    });
  }, [projectIds, projectOrder]);

  const handleNewThread = useCallback(
    (projectId: ProjectId, options?: NewThreadOptions): Promise<void> => {
      const {
        clearProjectDraftThreadId,
        getDraftThread,
        getDraftThreadByProjectId,
        applyStickyState,
        setDraftThreadContext,
        setProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const storedDraftThread = getDraftThreadByProjectId(projectId);
      const latestActiveDraftThread: DraftThreadState | null = routeThreadId
        ? getDraftThread(routeThreadId)
        : null;
      if (storedDraftThread) {
        return (async () => {
          const contextUpdate = resolveStoredDraftThreadContext({
            options,
            isOpenRoute: routeThreadId === storedDraftThread.threadId,
            defaultEnvMode: defaultThreadEnvMode,
            defaultRuntimeMode,
          });
          if (contextUpdate) {
            setDraftThreadContext(storedDraftThread.threadId, contextUpdate);
          }
          setProjectDraftThreadId(projectId, storedDraftThread.threadId);
          if (routeThreadId === storedDraftThread.threadId) {
            return;
          }
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        })();
      }

      clearProjectDraftThreadId(projectId);

      if (routeThreadId && canReuseRouteDraftThread(latestActiveDraftThread, projectId)) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(routeThreadId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setProjectDraftThreadId(projectId, routeThreadId);
        return Promise.resolve();
      }

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setProjectDraftThreadId(
          projectId,
          threadId,
          buildNewDraftThreadState({
            options,
            defaultRuntimeMode,
            defaultEnvMode: defaultThreadEnvMode,
            createdAt,
          }),
        );
        applyStickyState(threadId);

        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      })();
    },
    [defaultRuntimeMode, defaultThreadEnvMode, navigate, routeThreadId],
  );

  return {
    activeDraftThread,
    activeThread,
    defaultProjectId: orderedProjects[0] ?? null,
    handleNewThread,
    routeThreadId,
  };
}
