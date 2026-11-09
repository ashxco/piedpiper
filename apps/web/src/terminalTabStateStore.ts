/**
 * Live, unpersisted tab state for terminals: the command each one is running, as reported by the
 * server, and the ids whose close request is still in flight.
 */
import type {
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalSessionSnapshot,
} from "@piedpiper/contracts";
import { create } from "zustand";

import { nextTerminalId } from "./lib/terminalNumbering";

type TerminalCommandLabels = Readonly<Record<string, Readonly<Record<string, string>>>>;

const EMPTY_COMMAND_LABELS: Readonly<Record<string, string>> = {};
const EMPTY_TERMINAL_IDS: ReadonlyArray<string> = [];

interface TerminalTabState {
  commandLabelsByThreadId: TerminalCommandLabels;
  closingTerminalIdsByThreadId: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Running sessions the server reports, which this client's own tab list may not know. */
  liveTerminalIdsByThreadId: Readonly<Record<string, ReadonlyArray<string>>>;
  applyMetadata: (event: TerminalMetadataStreamEvent) => void;
  applyEvent: (event: TerminalEvent) => void;
  applySnapshot: (snapshot: TerminalSessionSnapshot) => void;
  beginClose: (threadId: string, terminalId: string) => void;
  endClose: (threadId: string, terminalId: string) => void;
}

function withCommandLabel(
  labels: TerminalCommandLabels,
  threadId: string,
  terminalId: string,
  label: string | undefined,
): TerminalCommandLabels {
  const threadLabels = labels[threadId];
  if (threadLabels?.[terminalId] === label) return labels;
  if (label !== undefined) {
    return { ...labels, [threadId]: { ...threadLabels, [terminalId]: label } };
  }
  const { [terminalId]: _removed, ...remaining } = threadLabels ?? {};
  if (Object.keys(remaining).length > 0) return { ...labels, [threadId]: remaining };
  const { [threadId]: _removedThread, ...otherThreads } = labels;
  return otherThreads;
}

function isLiveTerminalStatus(status: string): boolean {
  return status === "running" || status === "starting";
}

function withLiveTerminalId(
  liveIds: Readonly<Record<string, ReadonlyArray<string>>>,
  threadId: string,
  terminalId: string,
  live: boolean,
): Readonly<Record<string, ReadonlyArray<string>>> {
  const threadIds = liveIds[threadId] ?? EMPTY_TERMINAL_IDS;
  if (threadIds.includes(terminalId) === live) return liveIds;
  return {
    ...liveIds,
    [threadId]: live ? [...threadIds, terminalId] : threadIds.filter((id) => id !== terminalId),
  };
}

/** Returns the same object when the event changes nothing, so output events never notify. */
export function reduceTerminalCommandLabels(
  labels: TerminalCommandLabels,
  event: TerminalEvent,
): TerminalCommandLabels {
  switch (event.type) {
    case "activity":
      return withCommandLabel(labels, event.threadId, event.terminalId, event.label);
    case "started":
    case "restarted":
      return withCommandLabel(labels, event.threadId, event.terminalId, event.snapshot.label);
    case "exited":
    case "error":
      return withCommandLabel(labels, event.threadId, event.terminalId, undefined);
    default:
      return labels;
  }
}

export const useTerminalTabStateStore = create<TerminalTabState>()((set) => ({
  commandLabelsByThreadId: {},
  closingTerminalIdsByThreadId: {},
  liveTerminalIdsByThreadId: {},
  applyMetadata: (event) =>
    set((state) => {
      switch (event.type) {
        case "snapshot": {
          const liveTerminalIdsByThreadId: Record<string, string[]> = {};
          let commandLabelsByThreadId: TerminalCommandLabels = {};
          for (const terminal of event.terminals) {
            if (isLiveTerminalStatus(terminal.status)) {
              (liveTerminalIdsByThreadId[terminal.threadId] ??= []).push(terminal.terminalId);
            }
            commandLabelsByThreadId = withCommandLabel(
              commandLabelsByThreadId,
              terminal.threadId,
              terminal.terminalId,
              terminal.label,
            );
          }
          return { liveTerminalIdsByThreadId, commandLabelsByThreadId };
        }
        case "upsert": {
          const { threadId, terminalId, status, label } = event.terminal;
          return {
            liveTerminalIdsByThreadId: withLiveTerminalId(
              state.liveTerminalIdsByThreadId,
              threadId,
              terminalId,
              isLiveTerminalStatus(status),
            ),
            commandLabelsByThreadId: withCommandLabel(
              state.commandLabelsByThreadId,
              threadId,
              terminalId,
              label,
            ),
          };
        }
        case "remove":
          return {
            liveTerminalIdsByThreadId: withLiveTerminalId(
              state.liveTerminalIdsByThreadId,
              event.threadId,
              event.terminalId,
              false,
            ),
            commandLabelsByThreadId: withCommandLabel(
              state.commandLabelsByThreadId,
              event.threadId,
              event.terminalId,
              undefined,
            ),
          };
      }
    }),
  applyEvent: (event) =>
    set((state) => {
      const next = reduceTerminalCommandLabels(state.commandLabelsByThreadId, event);
      return next === state.commandLabelsByThreadId ? state : { commandLabelsByThreadId: next };
    }),
  applySnapshot: (snapshot) =>
    set((state) => {
      const next = withCommandLabel(
        state.commandLabelsByThreadId,
        snapshot.threadId,
        snapshot.terminalId,
        snapshot.label,
      );
      return next === state.commandLabelsByThreadId ? state : { commandLabelsByThreadId: next };
    }),
  beginClose: (threadId, terminalId) =>
    set((state) => ({
      commandLabelsByThreadId: withCommandLabel(
        state.commandLabelsByThreadId,
        threadId,
        terminalId,
        undefined,
      ),
      closingTerminalIdsByThreadId: {
        ...state.closingTerminalIdsByThreadId,
        [threadId]: [...(state.closingTerminalIdsByThreadId[threadId] ?? []), terminalId],
      },
    })),
  endClose: (threadId, terminalId) =>
    set((state) => {
      const closing = state.closingTerminalIdsByThreadId[threadId];
      if (!closing?.includes(terminalId)) return state;
      const remaining = closing.filter((id) => id !== terminalId);
      const { [threadId]: _removed, ...otherThreads } = state.closingTerminalIdsByThreadId;
      return {
        closingTerminalIdsByThreadId:
          remaining.length > 0 ? { ...otherThreads, [threadId]: remaining } : otherThreads,
      };
    }),
}));

export function useTerminalCommandLabels(threadId: string): Readonly<Record<string, string>> {
  return useTerminalTabStateStore(
    (state) => state.commandLabelsByThreadId[threadId] ?? EMPTY_COMMAND_LABELS,
  );
}

/** Allocates an id for a new terminal, keeping ids reserved while their close is in flight. */
export function allocateTerminalId(threadId: string, terminalIds: ReadonlyArray<string>): string {
  const { closingTerminalIdsByThreadId, liveTerminalIdsByThreadId } =
    useTerminalTabStateStore.getState();
  // A session this client cannot see would otherwise attach, or be killed for a different cwd.
  return nextTerminalId(terminalIds, [
    ...(closingTerminalIdsByThreadId[threadId] ?? EMPTY_TERMINAL_IDS),
    ...(liveTerminalIdsByThreadId[threadId] ?? EMPTY_TERMINAL_IDS),
  ]);
}
