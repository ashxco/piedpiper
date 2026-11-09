/**
 * Single Zustand store for terminal UI state keyed by threadId.
 *
 * Terminal transition helpers are intentionally private to keep the public
 * API constrained to store actions/selectors.
 */

import type { TerminalEvent, TerminalSessionStatus, ThreadId } from "@piedpiper/contracts";
import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "./types";

export type TerminalSplitDirection = "horizontal" | "vertical";

// Absent splitDirection means side by side, so groups stored before stacking stay valid.
export interface ThreadTerminalLayoutGroup extends ThreadTerminalGroup {
  splitDirection?: TerminalSplitDirection;
}

interface ThreadTerminalState {
  terminalOpen: boolean;
  terminalHeight: number;
  terminalIds: string[];
  runningTerminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalLayoutGroup[];
  activeTerminalGroupId: string;
}

export interface TerminalEventEntry {
  id: number;
  event: TerminalEvent;
}

const TERMINAL_STATE_STORAGE_KEY = "piedpiper:terminal-state:v1";
const EMPTY_TERMINAL_EVENT_ENTRIES: ReadonlyArray<TerminalEventEntry> = [];
const MAX_TERMINAL_EVENT_BUFFER = 200;

function createTerminalStateStorage() {
  try {
    return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
  } catch {
    // localStorage access can throw (sandboxed iframe, blocked site data).
    return resolveStorage(undefined);
  }
}

interface PersistedTerminalState {
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
}

/**
 * JSON persist storage that skips serialization and the localStorage write while
 * the persisted slice is referentially unchanged (e.g. terminal output chunks only
 * touch the non-persisted event buffer).
 */
export function createTerminalStatePersistStorage(
  baseStorage: ReturnType<typeof createTerminalStateStorage> = createTerminalStateStorage(),
): PersistStorage<PersistedTerminalState> {
  let lastPersistedSlice: PersistedTerminalState["terminalStateByThreadId"] | undefined;
  const parse = (raw: string | null): StorageValue<PersistedTerminalState> | null =>
    typeof raw === "string" ? (JSON.parse(raw) as StorageValue<PersistedTerminalState>) : null;
  return {
    getItem: (name) => {
      const raw = baseStorage.getItem(name);
      return raw instanceof Promise ? raw.then(parse) : parse(raw);
    },
    setItem: (name, value) => {
      const slice = value.state.terminalStateByThreadId;
      if (slice === lastPersistedSlice) {
        return;
      }
      try {
        baseStorage.setItem(name, JSON.stringify(value));
        lastPersistedSlice = slice;
      } catch (error) {
        // Leave the guard unset so the next set() retries the write.
        lastPersistedSlice = undefined;
        console.warn("[terminalStateStore] failed to persist terminal state", error);
      }
    },
    removeItem: (name) => {
      lastPersistedSlice = undefined;
      baseStorage.removeItem(name);
    },
  };
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const ids = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  return ids.length > 0 ? ids : [DEFAULT_THREAD_TERMINAL_ID];
}

function normalizeRunningTerminalIds(
  runningTerminalIds: string[],
  terminalIds: string[],
): string[] {
  if (runningTerminalIds.length === 0) return [];
  const validTerminalIdSet = new Set(terminalIds);
  return [...new Set(runningTerminalIds)]
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && validTerminalIdSet.has(id));
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalLayoutGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function normalizeTerminalGroupIds(terminalIds: string[]): string[] {
  return [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function splitDirectionFields(
  group: ThreadTerminalLayoutGroup,
): Pick<ThreadTerminalLayoutGroup, "splitDirection"> {
  return group.splitDirection === "vertical" ? { splitDirection: "vertical" } : {};
}

function normalizeTerminalGroups(
  terminalGroups: ThreadTerminalLayoutGroup[],
  terminalIds: string[],
): ThreadTerminalLayoutGroup[] {
  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: ThreadTerminalLayoutGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups) {
    const groupTerminalIds = normalizeTerminalGroupIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
    nextGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
      ...splitDirectionFields(group),
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  if (nextGroups.length === 0) {
    return [
      {
        id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      },
    ];
  }

  return nextGroups;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function terminalGroupsEqual(
  left: ThreadTerminalLayoutGroup[],
  right: ThreadTerminalLayoutGroup[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftGroup = left[index];
    const rightGroup = right[index];
    if (!leftGroup || !rightGroup) return false;
    if (leftGroup.id !== rightGroup.id) return false;
    if (!arraysEqual(leftGroup.terminalIds, rightGroup.terminalIds)) return false;
    if (
      splitDirectionFields(leftGroup).splitDirection !==
      splitDirectionFields(rightGroup).splitDirection
    ) {
      return false;
    }
  }
  return true;
}

function threadTerminalStateEqual(left: ThreadTerminalState, right: ThreadTerminalState): boolean {
  return (
    left.terminalOpen === right.terminalOpen &&
    left.terminalHeight === right.terminalHeight &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    arraysEqual(left.runningTerminalIds, right.runningTerminalIds) &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups)
  );
}

const DEFAULT_THREAD_TERMINAL_STATE: ThreadTerminalState = Object.freeze({
  terminalOpen: false,
  terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
  terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
  runningTerminalIds: [],
  activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
  terminalGroups: [
    {
      id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    },
  ],
  activeTerminalGroupId: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
});

function createDefaultThreadTerminalState(): ThreadTerminalState {
  return {
    ...DEFAULT_THREAD_TERMINAL_STATE,
    terminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.terminalIds],
    runningTerminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.runningTerminalIds],
    terminalGroups: copyTerminalGroups(DEFAULT_THREAD_TERMINAL_STATE.terminalGroups),
  };
}

function getDefaultThreadTerminalState(): ThreadTerminalState {
  return DEFAULT_THREAD_TERMINAL_STATE;
}

function normalizeThreadTerminalState(state: ThreadTerminalState): ThreadTerminalState {
  const terminalIds = normalizeTerminalIds(state.terminalIds);
  const nextTerminalIds = terminalIds.length > 0 ? terminalIds : [DEFAULT_THREAD_TERMINAL_ID];
  const runningTerminalIds = normalizeRunningTerminalIds(state.runningTerminalIds, nextTerminalIds);
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  const terminalGroups = normalizeTerminalGroups(state.terminalGroups, nextTerminalIds);
  const activeGroupIdFromState = terminalGroups.some(
    (group) => group.id === state.activeTerminalGroupId,
  )
    ? state.activeTerminalGroupId
    : null;
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ?? null;

  const normalized: ThreadTerminalState = {
    terminalOpen: state.terminalOpen,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: nextTerminalIds,
    runningTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId:
      activeGroupIdFromState ??
      activeGroupIdFromTerminal ??
      terminalGroups[0]?.id ??
      fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
  };
  return threadTerminalStateEqual(state, normalized) ? state : normalized;
}

function isDefaultThreadTerminalState(state: ThreadTerminalState): boolean {
  const normalized = normalizeThreadTerminalState(state);
  return threadTerminalStateEqual(normalized, DEFAULT_THREAD_TERMINAL_STATE);
}

function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

function terminalEventBufferKey(threadId: ThreadId, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function copyTerminalGroups(groups: ThreadTerminalLayoutGroup[]): ThreadTerminalLayoutGroup[] {
  return groups.map((group) => ({
    id: group.id,
    terminalIds: [...group.terminalIds],
    ...splitDirectionFields(group),
  }));
}

function upsertTerminalIntoGroups(
  state: ThreadTerminalState,
  terminalId: string,
  mode: "split" | "new",
  splitDirection: TerminalSplitDirection = "horizontal",
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!isValidTerminalId(terminalId)) {
    return normalized;
  }

  const isNewTerminal = !normalized.terminalIds.includes(terminalId);
  const terminalIds = isNewTerminal
    ? [...normalized.terminalIds, terminalId]
    : normalized.terminalIds;
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);

  const existingGroupIndex = findGroupIndexByTerminalId(terminalGroups, terminalId);
  if (existingGroupIndex >= 0) {
    terminalGroups[existingGroupIndex]!.terminalIds = terminalGroups[
      existingGroupIndex
    ]!.terminalIds.filter((id) => id !== terminalId);
    if (terminalGroups[existingGroupIndex]!.terminalIds.length === 0) {
      terminalGroups.splice(existingGroupIndex, 1);
    }
  }

  if (mode === "new") {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds);
    terminalGroups.push({ id: nextGroupId, terminalIds: [terminalId] });
    return normalizeThreadTerminalState({
      ...normalized,
      terminalOpen: true,
      terminalIds,
      activeTerminalId: terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
    });
  }

  let activeGroupIndex = terminalGroups.findIndex(
    (group) => group.id === normalized.activeTerminalGroupId,
  );
  if (activeGroupIndex < 0) {
    activeGroupIndex = findGroupIndexByTerminalId(terminalGroups, normalized.activeTerminalId);
  }
  if (activeGroupIndex < 0) {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(
      fallbackGroupId(normalized.activeTerminalId),
      usedGroupIds,
    );
    terminalGroups.push({ id: nextGroupId, terminalIds: [normalized.activeTerminalId] });
    activeGroupIndex = terminalGroups.length - 1;
  }

  const destinationGroup = terminalGroups[activeGroupIndex];
  if (!destinationGroup) {
    return normalized;
  }

  if (
    isNewTerminal &&
    !destinationGroup.terminalIds.includes(terminalId) &&
    destinationGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }

  if (!destinationGroup.terminalIds.includes(terminalId)) {
    const anchorIndex = destinationGroup.terminalIds.indexOf(normalized.activeTerminalId);
    if (anchorIndex >= 0) {
      destinationGroup.terminalIds.splice(anchorIndex + 1, 0, terminalId);
    } else {
      destinationGroup.terminalIds.push(terminalId);
    }
  }
  // A group lays out along one axis, so the latest split sets it for every pane.
  if (splitDirection === "vertical") {
    destinationGroup.splitDirection = "vertical";
  } else {
    delete destinationGroup.splitDirection;
  }

  return normalizeThreadTerminalState({
    ...normalized,
    terminalOpen: true,
    terminalIds,
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: destinationGroup.id,
  });
}

function setThreadTerminalOpen(state: ThreadTerminalState, open: boolean): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (normalized.terminalOpen === open) return normalized;
  return { ...normalized, terminalOpen: open };
}

function setThreadTerminalHeight(state: ThreadTerminalState, height: number): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!Number.isFinite(height) || height <= 0 || normalized.terminalHeight === height) {
    return normalized;
  }
  return { ...normalized, terminalHeight: height };
}

function splitThreadTerminal(
  state: ThreadTerminalState,
  terminalId: string,
  splitDirection: TerminalSplitDirection = "horizontal",
): ThreadTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "split", splitDirection);
}

function newThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "new");
}

function setThreadActiveTerminal(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const activeTerminalGroupId =
    normalized.terminalGroups.find((group) => group.terminalIds.includes(terminalId))?.id ??
    normalized.activeTerminalGroupId;
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.activeTerminalGroupId === activeTerminalGroupId
  ) {
    return normalized;
  }
  return {
    ...normalized,
    activeTerminalId: terminalId,
    activeTerminalGroupId,
  };
}

function closeThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const remainingTerminalIds = normalized.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    return createDefaultThreadTerminalState();
  }

  const closedTerminalIndex = normalized.terminalIds.indexOf(terminalId);
  const groupTerminalIds =
    normalized.terminalGroups.find((group) => group.terminalIds.includes(terminalId))
      ?.terminalIds ?? [];
  const groupIndex = groupTerminalIds.indexOf(terminalId);
  const nextActiveTerminalId =
    normalized.activeTerminalId === terminalId
      ? (groupTerminalIds[groupIndex + 1] ??
        groupTerminalIds[groupIndex - 1] ??
        remainingTerminalIds[Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)] ??
        remainingTerminalIds[0] ??
        DEFAULT_THREAD_TERMINAL_ID)
      : normalized.activeTerminalId;

  const terminalGroups = normalized.terminalGroups
    .map((group) => ({
      ...group,
      terminalIds: group.terminalIds.filter((id) => id !== terminalId),
    }))
    .filter((group) => group.terminalIds.length > 0);

  const nextActiveTerminalGroupId =
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(nextActiveTerminalId);

  return normalizeThreadTerminalState({
    terminalOpen: normalized.terminalOpen,
    terminalHeight: normalized.terminalHeight,
    terminalIds: remainingTerminalIds,
    runningTerminalIds: normalized.runningTerminalIds.filter((id) => id !== terminalId),
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: nextActiveTerminalGroupId,
  });
}

function setThreadTerminalActivity(
  state: ThreadTerminalState,
  terminalId: string,
  hasRunningSubprocess: boolean,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const alreadyRunning = normalized.runningTerminalIds.includes(terminalId);
  if (hasRunningSubprocess === alreadyRunning) {
    return normalized;
  }
  const runningTerminalIds = new Set(normalized.runningTerminalIds);
  if (hasRunningSubprocess) {
    runningTerminalIds.add(terminalId);
  } else {
    runningTerminalIds.delete(terminalId);
  }
  return { ...normalized, runningTerminalIds: [...runningTerminalIds] };
}

// Replaces a thread's running set, keeping its identity when the members are unchanged.
function reconcileThreadRunningTerminals(
  state: ThreadTerminalState,
  runningTerminalIds: readonly string[],
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const next = normalizeRunningTerminalIds([...runningTerminalIds], normalized.terminalIds);
  const current = new Set(normalized.runningTerminalIds);
  if (next.length === current.size && next.every((id) => current.has(id))) {
    return normalized;
  }
  return { ...normalized, runningTerminalIds: next };
}

export interface TerminalRunningSummary {
  threadId: string;
  terminalId: string;
  status: TerminalSessionStatus;
  hasRunningSubprocess: boolean;
}

export type TerminalRunningMetadataEvent =
  | { type: "snapshot"; terminals: readonly TerminalRunningSummary[] }
  | { type: "upsert"; terminal: TerminalRunningSummary }
  | { type: "remove"; threadId: string; terminalId: string };

// An exited session may still report its last subprocess state; it no longer runs anything.
function isTerminalSummaryRunning(summary: TerminalRunningSummary): boolean {
  return (
    summary.hasRunningSubprocess && (summary.status === "running" || summary.status === "starting")
  );
}

export function selectThreadTerminalState(
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>,
  threadId: ThreadId,
): ThreadTerminalState {
  if (threadId.length === 0) {
    return getDefaultThreadTerminalState();
  }
  return terminalStateByThreadId[threadId] ?? getDefaultThreadTerminalState();
}

function updateTerminalStateByThreadId(
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>,
  threadId: ThreadId,
  updater: (state: ThreadTerminalState) => ThreadTerminalState,
): Record<ThreadId, ThreadTerminalState> {
  if (threadId.length === 0) {
    return terminalStateByThreadId;
  }

  const current = selectThreadTerminalState(terminalStateByThreadId, threadId);
  const next = updater(current);
  if (next === current) {
    return terminalStateByThreadId;
  }

  if (isDefaultThreadTerminalState(next)) {
    if (terminalStateByThreadId[threadId] === undefined) {
      return terminalStateByThreadId;
    }
    const { [threadId]: _removed, ...rest } = terminalStateByThreadId;
    return rest as Record<ThreadId, ThreadTerminalState>;
  }

  return {
    ...terminalStateByThreadId,
    [threadId]: next,
  };
}

export function selectTerminalEventEntries(
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>,
  threadId: ThreadId,
  terminalId: string,
): ReadonlyArray<TerminalEventEntry> {
  if (threadId.length === 0 || terminalId.trim().length === 0) {
    return EMPTY_TERMINAL_EVENT_ENTRIES;
  }
  return (
    terminalEventEntriesByKey[terminalEventBufferKey(threadId, terminalId)] ??
    EMPTY_TERMINAL_EVENT_ENTRIES
  );
}

interface TerminalStateStoreState {
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>;
  nextTerminalEventId: number;
  // Bumped when the terminal event stream reconnects; open viewports resume from a snapshot.
  terminalResyncEpoch: number;
  bumpTerminalResyncEpoch: () => void;
  reconcileRunningTerminals: (
    runningTerminalIdsByThreadId: Readonly<Record<string, readonly string[]>>,
  ) => void;
  applyTerminalMetadataEvent: (event: TerminalRunningMetadataEvent) => void;
  setTerminalOpen: (threadId: ThreadId, open: boolean) => void;
  setTerminalHeight: (threadId: ThreadId, height: number) => void;
  splitTerminal: (threadId: ThreadId, terminalId: string) => void;
  splitTerminalVertical: (threadId: ThreadId, terminalId: string) => void;
  newTerminal: (threadId: ThreadId, terminalId: string) => void;
  setActiveTerminal: (threadId: ThreadId, terminalId: string) => void;
  closeTerminal: (threadId: ThreadId, terminalId: string) => void;
  setTerminalActivity: (
    threadId: ThreadId,
    terminalId: string,
    hasRunningSubprocess: boolean,
  ) => void;
  recordTerminalEvent: (event: TerminalEvent) => void;
  clearTerminalState: (threadId: ThreadId) => void;
  removeTerminalState: (threadId: ThreadId) => void;
  removeOrphanedTerminalStates: (activeThreadIds: Set<ThreadId>) => void;
}

export const useTerminalStateStore = create<TerminalStateStoreState>()(
  persist(
    (set, get) => {
      const updateTerminal = (
        threadId: ThreadId,
        updater: (state: ThreadTerminalState) => ThreadTerminalState,
      ) => {
        set((state) => {
          const nextTerminalStateByThreadId = updateTerminalStateByThreadId(
            state.terminalStateByThreadId,
            threadId,
            updater,
          );
          if (nextTerminalStateByThreadId === state.terminalStateByThreadId) {
            return state;
          }
          return {
            terminalStateByThreadId: nextTerminalStateByThreadId,
          };
        });
      };

      return {
        terminalStateByThreadId: {},
        terminalEventEntriesByKey: {},
        nextTerminalEventId: 1,
        terminalResyncEpoch: 0,
        bumpTerminalResyncEpoch: () =>
          set((state) => ({ terminalResyncEpoch: state.terminalResyncEpoch + 1 })),
        reconcileRunningTerminals: (runningTerminalIdsByThreadId) =>
          set((state) => {
            let next = state.terminalStateByThreadId;
            const threadIds = new Set([
              ...Object.keys(next),
              ...Object.keys(runningTerminalIdsByThreadId),
            ]);
            for (const threadId of threadIds) {
              next = updateTerminalStateByThreadId(next, threadId as ThreadId, (threadState) =>
                reconcileThreadRunningTerminals(
                  threadState,
                  runningTerminalIdsByThreadId[threadId] ?? [],
                ),
              );
            }
            return next === state.terminalStateByThreadId
              ? state
              : { terminalStateByThreadId: next };
          }),
        applyTerminalMetadataEvent: (event) => {
          const { reconcileRunningTerminals, setTerminalActivity } = get();
          if (event.type === "snapshot") {
            const runningByThreadId: Record<string, string[]> = {};
            for (const terminal of event.terminals) {
              if (!isTerminalSummaryRunning(terminal)) continue;
              (runningByThreadId[terminal.threadId] ??= []).push(terminal.terminalId);
            }
            reconcileRunningTerminals(runningByThreadId);
            return;
          }
          if (event.type === "upsert") {
            setTerminalActivity(
              event.terminal.threadId as ThreadId,
              event.terminal.terminalId,
              isTerminalSummaryRunning(event.terminal),
            );
            return;
          }
          setTerminalActivity(event.threadId as ThreadId, event.terminalId, false);
        },
        setTerminalOpen: (threadId, open) =>
          updateTerminal(threadId, (state) => setThreadTerminalOpen(state, open)),
        setTerminalHeight: (threadId, height) =>
          updateTerminal(threadId, (state) => setThreadTerminalHeight(state, height)),
        splitTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => splitThreadTerminal(state, terminalId)),
        splitTerminalVertical: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => splitThreadTerminal(state, terminalId, "vertical")),
        newTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => newThreadTerminal(state, terminalId)),
        setActiveTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => setThreadActiveTerminal(state, terminalId)),
        closeTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => closeThreadTerminal(state, terminalId)),
        setTerminalActivity: (threadId, terminalId, hasRunningSubprocess) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalActivity(state, terminalId, hasRunningSubprocess),
          ),
        recordTerminalEvent: (event) =>
          set((state) => {
            const key = terminalEventBufferKey(event.threadId as ThreadId, event.terminalId);
            const currentEntries =
              state.terminalEventEntriesByKey[key] ?? EMPTY_TERMINAL_EVENT_ENTRIES;
            const nextEntry: TerminalEventEntry = {
              id: state.nextTerminalEventId,
              event,
            };
            // Subscribers diff buffers by reference/last id, so append onto a single copy.
            const nextEntries =
              currentEntries.length >= MAX_TERMINAL_EVENT_BUFFER
                ? currentEntries.slice(1)
                : currentEntries.slice();
            nextEntries.push(nextEntry);
            return {
              terminalEventEntriesByKey: {
                ...state.terminalEventEntriesByKey,
                [key]: nextEntries,
              },
              nextTerminalEventId: state.nextTerminalEventId + 1,
            };
          }),
        clearTerminalState: (threadId) =>
          set((state) => {
            const nextTerminalStateByThreadId = updateTerminalStateByThreadId(
              state.terminalStateByThreadId,
              threadId,
              () => createDefaultThreadTerminalState(),
            );
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              if (key.startsWith(`${threadId}\u0000`)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            if (
              nextTerminalStateByThreadId === state.terminalStateByThreadId &&
              !removedEventEntries
            ) {
              return state;
            }
            return {
              terminalStateByThreadId: nextTerminalStateByThreadId,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
            };
          }),
        removeTerminalState: (threadId) =>
          set((state) => {
            const hasThreadState = state.terminalStateByThreadId[threadId] !== undefined;
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              if (key.startsWith(`${threadId}\u0000`)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            if (!hasThreadState && !removedEventEntries) {
              return state;
            }
            // Keep the persisted slice's reference when only the event buffer changed.
            let nextTerminalStateByThreadId = state.terminalStateByThreadId;
            if (hasThreadState) {
              nextTerminalStateByThreadId = { ...state.terminalStateByThreadId };
              delete nextTerminalStateByThreadId[threadId];
            }
            return {
              terminalStateByThreadId: nextTerminalStateByThreadId,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
            };
          }),
        removeOrphanedTerminalStates: (activeThreadIds) =>
          set((state) => {
            const orphanedIds = Object.keys(state.terminalStateByThreadId).filter(
              (id) => !activeThreadIds.has(id as ThreadId),
            );
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              const [threadId] = key.split("\u0000");
              if (threadId && !activeThreadIds.has(threadId as ThreadId)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            if (orphanedIds.length === 0 && !removedEventEntries) return state;
            let nextTerminalStateByThreadId = state.terminalStateByThreadId;
            if (orphanedIds.length > 0) {
              nextTerminalStateByThreadId = { ...state.terminalStateByThreadId };
              for (const id of orphanedIds) {
                delete nextTerminalStateByThreadId[id as ThreadId];
              }
            }
            return {
              terminalStateByThreadId: nextTerminalStateByThreadId,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
            };
          }),
      };
    },
    {
      name: TERMINAL_STATE_STORAGE_KEY,
      version: 1,
      storage: createTerminalStatePersistStorage(),
      partialize: (state): PersistedTerminalState => ({
        terminalStateByThreadId: state.terminalStateByThreadId,
      }),
    },
  ),
);

/**
 * Handler for the terminal event stream's `subscribed` frames: the first only confirms the initial
 * connection, every later one means events may have been missed, so open viewports must resync.
 */
export function createTerminalStreamSubscribedHandler(
  onResync: () => void = () => useTerminalStateStore.getState().bumpTerminalResyncEpoch(),
): () => void {
  let subscribedBefore = false;
  return () => {
    if (subscribedBefore) onResync();
    subscribedBefore = true;
  };
}
