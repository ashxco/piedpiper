import { Debouncer } from "@tanstack/react-pacer";
import { type ProjectId, type ThreadId } from "@piedpiper/contracts";
import { create } from "zustand";

const PERSISTED_STATE_KEY = "piedpiper:ui-state:v1";
// Bump when the meaning of stored changed-files expansion values changes; older values are dropped.
const THREAD_CHANGED_FILES_EXPANSION_VERSION = 1;
const LEGACY_PERSISTED_STATE_KEYS = [
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

interface PersistedUiState {
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  threadChangedFilesExpansionVersion?: number;
  threadChangedFilesExpandedById?: Record<string, Record<string, boolean>>;
  pinnedThreadIds?: string[];
  snoozedThreadsById?: Record<string, unknown>;
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: ProjectId[];
}

/** A local "hide until later" overlay on a thread; the agent keeps running underneath it. */
export interface ThreadSnooze {
  readonly snoozedUntil: string;
  readonly snoozedAt: string;
  /** A question already pending when snoozing means "ask me later"; only a newer one wakes. */
  readonly questionPendingAtSnooze: boolean;
  /** The wake the user has already opened the thread for; a newer one shows the marker again. */
  readonly wakeSeenAt?: string;
}

export interface UiThreadState {
  threadLastVisitedAtById: Record<string, string>;
  /** Explicit expand/collapse choices for changed-files cards, by thread then turn. */
  threadChangedFilesExpandedById: Record<string, Record<string, boolean>>;
  /** Threads pinned to the top of their project's sidebar list (local to this device). */
  pinnedThreadIds: ThreadId[];
  /** Threads tucked into their project's snoozed shelf (local to this device). */
  snoozedThreadsById: Record<string, ThreadSnooze>;
}

export interface UiState extends UiProjectState, UiThreadState {}

export interface SyncProjectInput {
  id: ProjectId;
  cwd: string;
}

export interface SyncThreadInput {
  id: ThreadId;
  seedVisitedAt?: string | undefined;
}

const initialState: UiState = {
  projectExpandedById: {},
  projectOrder: [],
  threadLastVisitedAtById: {},
  threadChangedFilesExpandedById: {},
  pinnedThreadIds: [],
  snoozedThreadsById: {},
};

const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];
const currentProjectCwdById = new Map<ProjectId, string>();
let legacyKeysCleanedUp = false;

function readPersistedState(): UiState {
  if (typeof window === "undefined") {
    return initialState;
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        const legacyRaw = window.localStorage.getItem(legacyKey);
        if (!legacyRaw) {
          continue;
        }
        hydratePersistedProjectState(JSON.parse(legacyRaw) as PersistedUiState);
        return initialState;
      }
      return initialState;
    }
    const parsed = JSON.parse(raw) as PersistedUiState;
    hydratePersistedProjectState(parsed);
    return {
      ...initialState,
      threadChangedFilesExpandedById: parsePersistedThreadChangedFilesExpanded(parsed),
      pinnedThreadIds: parsePersistedPinnedThreadIds(parsed),
      snoozedThreadsById: parsePersistedSnoozedThreads(parsed),
    };
  } catch {
    return initialState;
  }
}

export function parsePersistedThreadChangedFilesExpanded(
  parsed: PersistedUiState,
): Record<string, Record<string, boolean>> {
  if (parsed.threadChangedFilesExpansionVersion !== THREAD_CHANGED_FILES_EXPANSION_VERSION) {
    return {};
  }
  const value = parsed.threadChangedFilesExpandedById;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const next: Record<string, Record<string, boolean>> = {};
  for (const [threadId, turns] of Object.entries(value)) {
    if (!threadId || !turns || typeof turns !== "object" || Array.isArray(turns)) continue;
    const nextTurns: Record<string, boolean> = {};
    for (const [turnId, expanded] of Object.entries(turns)) {
      if (turnId && typeof expanded === "boolean") {
        nextTurns[turnId] = expanded;
      }
    }
    if (Object.keys(nextTurns).length > 0) {
      next[threadId] = nextTurns;
    }
  }
  return next;
}

export function parsePersistedPinnedThreadIds(parsed: PersistedUiState): ThreadId[] {
  if (!Array.isArray(parsed.pinnedThreadIds)) {
    return [];
  }
  const ids = parsed.pinnedThreadIds.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  return [...new Set(ids)] as ThreadId[];
}

/** Drops malformed entries: a snooze that cannot be read must never hide a thread. */
export function parsePersistedSnoozedThreads(
  parsed: PersistedUiState,
): Record<string, ThreadSnooze> {
  const value = parsed.snoozedThreadsById;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const next: Record<string, ThreadSnooze> = {};
  for (const [threadId, entry] of Object.entries(value)) {
    if (!threadId || !entry || typeof entry !== "object") continue;
    const { snoozedUntil, snoozedAt, questionPendingAtSnooze, wakeSeenAt } = entry as Record<
      string,
      unknown
    >;
    if (typeof snoozedUntil !== "string" || Number.isNaN(Date.parse(snoozedUntil))) continue;
    if (typeof snoozedAt !== "string" || Number.isNaN(Date.parse(snoozedAt))) continue;
    next[threadId] = {
      snoozedUntil,
      snoozedAt,
      questionPendingAtSnooze: questionPendingAtSnooze === true,
      ...(typeof wakeSeenAt === "string" ? { wakeSeenAt } : {}),
    };
  }
  return next;
}

function hydratePersistedProjectState(parsed: PersistedUiState): void {
  persistedExpandedProjectCwds.clear();
  persistedProjectOrderCwds.length = 0;
  for (const cwd of parsed.expandedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedExpandedProjectCwds.add(cwd);
    }
  }
  for (const cwd of parsed.projectOrderCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0 && !persistedProjectOrderCwds.includes(cwd)) {
      persistedProjectOrderCwds.push(cwd);
    }
  }
}

function persistState(state: UiState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const expandedProjectCwds = Object.entries(state.projectExpandedById)
      .filter(([, expanded]) => expanded)
      .flatMap(([projectId]) => {
        const cwd = currentProjectCwdById.get(projectId as ProjectId);
        return cwd ? [cwd] : [];
      });
    const projectOrderCwds = state.projectOrder.flatMap((projectId) => {
      const cwd = currentProjectCwdById.get(projectId);
      return cwd ? [cwd] : [];
    });
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds,
        projectOrderCwds,
        threadChangedFilesExpansionVersion: THREAD_CHANGED_FILES_EXPANSION_VERSION,
        threadChangedFilesExpandedById: state.threadChangedFilesExpandedById,
        pinnedThreadIds: state.pinnedThreadIds,
        snoozedThreadsById: state.snoozedThreadsById,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

function recordsEqual<T>(left: Record<string, T>, right: Record<string, T>): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [key, value] of leftEntries) {
    if (right[key] !== value) {
      return false;
    }
  }
  return true;
}

function nestedBooleanRecordsEqual(
  left: Record<string, Record<string, boolean>>,
  right: Record<string, Record<string, boolean>>,
): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) {
    return false;
  }
  for (const [key, value] of leftEntries) {
    const other = right[key];
    if (other === undefined || !recordsEqual(value, other)) {
      return false;
    }
  }
  return true;
}

function projectOrdersEqual(left: readonly ProjectId[], right: readonly ProjectId[]): boolean {
  return (
    left.length === right.length && left.every((projectId, index) => projectId === right[index])
  );
}

export function syncProjects(state: UiState, projects: readonly SyncProjectInput[]): UiState {
  const previousProjectCwdById = new Map(currentProjectCwdById);
  const previousProjectIdByCwd = new Map(
    [...previousProjectCwdById.entries()].map(([projectId, cwd]) => [cwd, projectId] as const),
  );
  currentProjectCwdById.clear();
  for (const project of projects) {
    currentProjectCwdById.set(project.id, project.cwd);
  }
  const cwdMappingChanged =
    previousProjectCwdById.size !== currentProjectCwdById.size ||
    projects.some((project) => previousProjectCwdById.get(project.id) !== project.cwd);

  const nextExpandedById: Record<string, boolean> = {};
  const previousExpandedById = state.projectExpandedById;
  const persistedOrderByCwd = new Map(
    persistedProjectOrderCwds.map((cwd, index) => [cwd, index] as const),
  );
  const mappedProjects = projects.map((project, index) => {
    const previousProjectIdForCwd = previousProjectIdByCwd.get(project.cwd);
    const expanded =
      previousExpandedById[project.id] ??
      (previousProjectIdForCwd ? previousExpandedById[previousProjectIdForCwd] : undefined) ??
      (persistedExpandedProjectCwds.size > 0
        ? persistedExpandedProjectCwds.has(project.cwd)
        : true);
    nextExpandedById[project.id] = expanded;
    return {
      id: project.id,
      cwd: project.cwd,
      incomingIndex: index,
    };
  });

  const nextProjectOrder =
    state.projectOrder.length > 0
      ? (() => {
          const nextProjectIdByCwd = new Map(
            mappedProjects.map((project) => [project.cwd, project.id] as const),
          );
          const usedProjectIds = new Set<ProjectId>();
          const orderedProjectIds: ProjectId[] = [];

          for (const projectId of state.projectOrder) {
            const matchedProjectId =
              (projectId in nextExpandedById ? projectId : undefined) ??
              (() => {
                const previousCwd = previousProjectCwdById.get(projectId);
                return previousCwd ? nextProjectIdByCwd.get(previousCwd) : undefined;
              })();
            if (!matchedProjectId || usedProjectIds.has(matchedProjectId)) {
              continue;
            }
            usedProjectIds.add(matchedProjectId);
            orderedProjectIds.push(matchedProjectId);
          }

          for (const project of mappedProjects) {
            if (usedProjectIds.has(project.id)) {
              continue;
            }
            orderedProjectIds.push(project.id);
          }

          return orderedProjectIds;
        })()
      : mappedProjects
          .map((project) => ({
            id: project.id,
            incomingIndex: project.incomingIndex,
            orderIndex:
              persistedOrderByCwd.get(project.cwd) ??
              persistedProjectOrderCwds.length + project.incomingIndex,
          }))
          .toSorted((left, right) => {
            const byOrder = left.orderIndex - right.orderIndex;
            if (byOrder !== 0) {
              return byOrder;
            }
            return left.incomingIndex - right.incomingIndex;
          })
          .map((project) => project.id);

  if (
    recordsEqual(state.projectExpandedById, nextExpandedById) &&
    projectOrdersEqual(state.projectOrder, nextProjectOrder) &&
    !cwdMappingChanged
  ) {
    return state;
  }

  return {
    ...state,
    projectExpandedById: nextExpandedById,
    projectOrder: nextProjectOrder,
  };
}

export function syncThreads(state: UiState, threads: readonly SyncThreadInput[]): UiState {
  const retainedThreadIds = new Set(threads.map((thread) => thread.id));
  const nextThreadLastVisitedAtById = Object.fromEntries(
    Object.entries(state.threadLastVisitedAtById).filter(([threadId]) =>
      retainedThreadIds.has(threadId as ThreadId),
    ),
  );
  for (const thread of threads) {
    if (
      nextThreadLastVisitedAtById[thread.id] === undefined &&
      thread.seedVisitedAt !== undefined &&
      thread.seedVisitedAt.length > 0
    ) {
      nextThreadLastVisitedAtById[thread.id] = thread.seedVisitedAt;
    }
  }
  const nextThreadChangedFilesExpandedById = Object.fromEntries(
    Object.entries(state.threadChangedFilesExpandedById).filter(([threadId]) =>
      retainedThreadIds.has(threadId as ThreadId),
    ),
  );
  const nextPinnedThreadIds = state.pinnedThreadIds.filter((threadId) =>
    retainedThreadIds.has(threadId),
  );
  const pinnedChanged = nextPinnedThreadIds.length !== state.pinnedThreadIds.length;
  const nextSnoozedThreadsById = Object.fromEntries(
    Object.entries(state.snoozedThreadsById).filter(([threadId]) =>
      retainedThreadIds.has(threadId as ThreadId),
    ),
  );
  if (
    recordsEqual(state.threadLastVisitedAtById, nextThreadLastVisitedAtById) &&
    nestedBooleanRecordsEqual(
      state.threadChangedFilesExpandedById,
      nextThreadChangedFilesExpandedById,
    ) &&
    !pinnedChanged &&
    recordsEqual(state.snoozedThreadsById, nextSnoozedThreadsById)
  ) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: nextThreadLastVisitedAtById,
    threadChangedFilesExpandedById: nextThreadChangedFilesExpandedById,
    pinnedThreadIds: pinnedChanged ? nextPinnedThreadIds : state.pinnedThreadIds,
    snoozedThreadsById: recordsEqual(state.snoozedThreadsById, nextSnoozedThreadsById)
      ? state.snoozedThreadsById
      : nextSnoozedThreadsById,
  };
}

export function markThreadVisited(state: UiState, threadId: ThreadId, visitedAt?: string): UiState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  const previousVisitedAt = state.threadLastVisitedAtById[threadId];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (
    Number.isFinite(previousVisitedAtMs) &&
    Number.isFinite(visitedAtMs) &&
    previousVisitedAtMs >= visitedAtMs
  ) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: at,
    },
  };
}

export function markThreadUnread(
  state: UiState,
  threadId: ThreadId,
  latestTurnCompletedAt: string | null | undefined,
): UiState {
  if (!latestTurnCompletedAt) {
    return state;
  }
  const latestTurnCompletedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(latestTurnCompletedAtMs)) {
    return state;
  }
  const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
  if (state.threadLastVisitedAtById[threadId] === unreadVisitedAt) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: unreadVisitedAt,
    },
  };
}

export function clearThreadUi(state: UiState, threadId: ThreadId): UiState {
  if (
    !(threadId in state.threadLastVisitedAtById) &&
    !(threadId in state.threadChangedFilesExpandedById) &&
    !state.pinnedThreadIds.includes(threadId) &&
    !(threadId in state.snoozedThreadsById)
  ) {
    return state;
  }
  const nextThreadLastVisitedAtById = { ...state.threadLastVisitedAtById };
  delete nextThreadLastVisitedAtById[threadId];
  const nextThreadChangedFilesExpandedById = { ...state.threadChangedFilesExpandedById };
  delete nextThreadChangedFilesExpandedById[threadId];
  return {
    ...state,
    threadLastVisitedAtById: nextThreadLastVisitedAtById,
    threadChangedFilesExpandedById: nextThreadChangedFilesExpandedById,
    pinnedThreadIds: setThreadPinned(state, threadId, false).pinnedThreadIds,
    snoozedThreadsById: unsnoozeThread(state, threadId).snoozedThreadsById,
  };
}

export function setThreadPinned(state: UiState, threadId: ThreadId, pinned: boolean): UiState {
  const isPinned = state.pinnedThreadIds.includes(threadId);
  if (isPinned === pinned) {
    return state;
  }
  return {
    ...state,
    pinnedThreadIds: pinned
      ? [...state.pinnedThreadIds, threadId]
      : state.pinnedThreadIds.filter((id) => id !== threadId),
  };
}

export function snoozeThread(state: UiState, threadId: ThreadId, snooze: ThreadSnooze): UiState {
  return {
    ...state,
    snoozedThreadsById: { ...state.snoozedThreadsById, [threadId]: snooze },
  };
}

export function unsnoozeThread(state: UiState, threadId: ThreadId): UiState {
  if (!(threadId in state.snoozedThreadsById)) {
    return state;
  }
  const nextSnoozedThreadsById = { ...state.snoozedThreadsById };
  delete nextSnoozedThreadsById[threadId];
  return { ...state, snoozedThreadsById: nextSnoozedThreadsById };
}

export function setThreadChangedFilesExpanded(
  state: UiState,
  threadId: ThreadId,
  turnId: string,
  expanded: boolean,
): UiState {
  const currentThreadState = state.threadChangedFilesExpandedById[threadId] ?? {};
  if (currentThreadState[turnId] === expanded) {
    return state;
  }
  return {
    ...state,
    threadChangedFilesExpandedById: {
      ...state.threadChangedFilesExpandedById,
      [threadId]: { ...currentThreadState, [turnId]: expanded },
    },
  };
}

/** The stored choice for a turn's changed-files card, or `defaultExpanded` when untouched. */
export function resolveThreadChangedFilesExpanded(
  state: Pick<UiState, "threadChangedFilesExpandedById">,
  threadId: ThreadId,
  turnId: string,
  defaultExpanded: boolean,
): boolean {
  return state.threadChangedFilesExpandedById[threadId]?.[turnId] ?? defaultExpanded;
}

export function toggleProject(state: UiState, projectId: ProjectId): UiState {
  const expanded = state.projectExpandedById[projectId] ?? true;
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: !expanded,
    },
  };
}

export function setProjectExpanded(
  state: UiState,
  projectId: ProjectId,
  expanded: boolean,
): UiState {
  if ((state.projectExpandedById[projectId] ?? true) === expanded) {
    return state;
  }
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: expanded,
    },
  };
}

export function reorderProjects(
  state: UiState,
  draggedProjectId: ProjectId,
  targetProjectId: ProjectId,
): UiState {
  if (draggedProjectId === targetProjectId) {
    return state;
  }
  const draggedIndex = state.projectOrder.findIndex((projectId) => projectId === draggedProjectId);
  const targetIndex = state.projectOrder.findIndex((projectId) => projectId === targetProjectId);
  if (draggedIndex < 0 || targetIndex < 0) {
    return state;
  }
  const projectOrder = [...state.projectOrder];
  const [draggedProject] = projectOrder.splice(draggedIndex, 1);
  if (!draggedProject) {
    return state;
  }
  projectOrder.splice(targetIndex, 0, draggedProject);
  return {
    ...state,
    projectOrder,
  };
}

interface UiStateStore extends UiState {
  syncProjects: (projects: readonly SyncProjectInput[]) => void;
  syncThreads: (threads: readonly SyncThreadInput[]) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt?: string) => void;
  markThreadUnread: (threadId: ThreadId, latestTurnCompletedAt: string | null | undefined) => void;
  clearThreadUi: (threadId: ThreadId) => void;
  setThreadPinned: (threadId: ThreadId, pinned: boolean) => void;
  snoozeThread: (threadId: ThreadId, snooze: ThreadSnooze) => void;
  unsnoozeThread: (threadId: ThreadId) => void;
  /** Replaces the whole map; a reconcile that changed nothing passes the same object back. */
  setSnoozedThreads: (snoozedThreadsById: Record<string, ThreadSnooze>) => void;
  setThreadChangedFilesExpanded: (threadId: ThreadId, turnId: string, expanded: boolean) => void;
  toggleProject: (projectId: ProjectId) => void;
  setProjectExpanded: (projectId: ProjectId, expanded: boolean) => void;
  reorderProjects: (draggedProjectId: ProjectId, targetProjectId: ProjectId) => void;
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  syncProjects: (projects) => set((state) => syncProjects(state, projects)),
  syncThreads: (threads) => set((state) => syncThreads(state, threads)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId, latestTurnCompletedAt) =>
    set((state) => markThreadUnread(state, threadId, latestTurnCompletedAt)),
  clearThreadUi: (threadId) => set((state) => clearThreadUi(state, threadId)),
  setThreadPinned: (threadId, pinned) => set((state) => setThreadPinned(state, threadId, pinned)),
  snoozeThread: (threadId, snooze) => set((state) => snoozeThread(state, threadId, snooze)),
  unsnoozeThread: (threadId) => set((state) => unsnoozeThread(state, threadId)),
  setSnoozedThreads: (snoozedThreadsById) =>
    set((state) =>
      state.snoozedThreadsById === snoozedThreadsById ? state : { ...state, snoozedThreadsById },
    ),
  setThreadChangedFilesExpanded: (threadId, turnId, expanded) =>
    set((state) => setThreadChangedFilesExpanded(state, threadId, turnId, expanded)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  reorderProjects: (draggedProjectId, targetProjectId) =>
    set((state) => reorderProjects(state, draggedProjectId, targetProjectId)),
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}
