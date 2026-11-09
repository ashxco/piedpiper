import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { TerminalEvent, NativeApi } from "@piedpiper/contracts";
import type { TerminalViewportOptions } from "./terminalViewport";
import { selectTerminalEventEntries, useTerminalStateStore } from "../terminalStateStore";
import { useTerminalTabStateStore } from "~/terminalTabStateStore";
import {
  canFitTerminal,
  writeSystemMessage,
  writeTerminalSnapshot,
  isTerminalEventInSnapshot,
  selectPendingTerminalEventEntries,
  selectTerminalEventEntriesAfterSnapshot,
  isTerminalSessionGoneError,
} from "./terminalViewportHelpers";

const TERMINAL_RESUME_DEBOUNCE_MS = 150;

export function connectTerminalSession(
  terminal: Terminal,
  fitAddon: FitAddon,
  mount: HTMLElement,
  api: NativeApi,
  options: Pick<
    TerminalViewportOptions,
    "threadId" | "terminalId" | "cwd" | "runtimeEnv" | "readAutoFocus" | "onSessionExited"
  >,
  clearSelectionAction: () => void,
) {
  const { threadId, terminalId, cwd, runtimeEnv } = options;
  let disposed = false;
  let activeTerminal: Terminal | null = terminal;
  let hasHandledExit = false;
  let lastAppliedTerminalEventId = 0;
  let terminalHydrated = false;
  let exitTimer: number | null = null;
  const scheduleSessionExited = () => {
    if (hasHandledExit) {
      return;
    }
    hasHandledExit = true;
    exitTimer = window.setTimeout(() => {
      exitTimer = null;
      if (disposed || !hasHandledExit) {
        return;
      }
      options.onSessionExited();
    }, 0);
  };

  const applyTerminalEvent = (event: TerminalEvent) => {
    const currentTerminal = activeTerminal;
    if (!currentTerminal) {
      return;
    }

    if (event.type === "activity") {
      return;
    }

    if (event.type === "output") {
      currentTerminal.write(event.data);
      return;
    }

    if (event.type === "started" || event.type === "restarted") {
      hasHandledExit = false;
      clearSelectionAction();
      writeTerminalSnapshot(currentTerminal, event.snapshot);
      return;
    }

    if (event.type === "cleared") {
      clearSelectionAction();
      currentTerminal.clear();
      currentTerminal.write("\u001bc");
      return;
    }

    if (event.type === "error") {
      writeSystemMessage(currentTerminal, event.message);
      return;
    }

    const details = [
      typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
      typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
    ]
      .filter((value): value is string => value !== null)
      .join(", ");
    writeSystemMessage(
      currentTerminal,
      details.length > 0 ? `Process exited (${details})` : "Process exited",
    );
    scheduleSessionExited();
  };
  let hydratedSnapshotSequence: number | undefined;
  const applyPendingTerminalEvents = (
    terminalEventEntries: ReadonlyArray<{ id: number; event: TerminalEvent }>,
  ) => {
    const pendingEntries = selectPendingTerminalEventEntries(
      terminalEventEntries,
      lastAppliedTerminalEventId,
    );
    if (pendingEntries.length === 0) {
      return;
    }
    for (const entry of pendingEntries) {
      if (isTerminalEventInSnapshot(entry.event, hydratedSnapshotSequence)) continue;
      applyTerminalEvent(entry.event);
    }
    lastAppliedTerminalEventId = pendingEntries.at(-1)?.id ?? lastAppliedTerminalEventId;
  };

  let resumeTimer: number | null = null;
  const scheduleResume = () => {
    if (resumeTimer !== null) window.clearTimeout(resumeTimer);
    resumeTimer = window.setTimeout(() => {
      resumeTimer = null;
      void openTerminal({ resume: true });
    }, TERMINAL_RESUME_DEBOUNCE_MS);
  };

  const unsubscribeTerminalEvents = useTerminalStateStore.subscribe((state, previousState) => {
    if (state.terminalResyncEpoch !== previousState.terminalResyncEpoch) {
      scheduleResume();
    }

    if (!terminalHydrated) {
      return;
    }

    const previousLastEntryId =
      selectTerminalEventEntries(previousState.terminalEventEntriesByKey, threadId, terminalId).at(
        -1,
      )?.id ?? 0;
    const nextEntries = selectTerminalEventEntries(
      state.terminalEventEntriesByKey,
      threadId,
      terminalId,
    );
    const nextLastEntryId = nextEntries.at(-1)?.id ?? 0;
    if (nextLastEntryId === previousLastEntryId) {
      return;
    }

    applyPendingTerminalEvents(nextEntries);
  });

  // Only the newest open may touch the terminal: a resume supersedes one still in flight.
  let latestOpenId = 0;
  const hydrateTerminal = async (openId: number, resume: boolean) => {
    const currentTerminal = activeTerminal;
    if (!currentTerminal) return;
    // A hidden viewport keeps and sends its last real size.
    if (canFitTerminal(currentTerminal, mount)) fitAddon.fit();
    const snapshot = await api.terminal.open({
      threadId,
      terminalId,
      cwd,
      cols: currentTerminal.cols,
      rows: currentTerminal.rows,
      ...(runtimeEnv ? { env: runtimeEnv } : {}),
      ...(resume ? { resume: true } : {}),
    });
    if (disposed || openId !== latestOpenId) return;
    useTerminalTabStateStore.getState().applySnapshot(snapshot);
    if (resume) clearSelectionAction();
    writeTerminalSnapshot(currentTerminal, snapshot);
    const bufferedEntries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      threadId,
      terminalId,
    );
    const replayEntries = selectTerminalEventEntriesAfterSnapshot(
      bufferedEntries,
      snapshot.updatedAt,
      snapshot.sequence,
    );
    for (const entry of replayEntries) {
      applyTerminalEvent(entry.event);
    }
    hydratedSnapshotSequence = snapshot.sequence;
    lastAppliedTerminalEventId = bufferedEntries.at(-1)?.id ?? 0;
    terminalHydrated = true;
    // The exit event was missed while disconnected, so exit handling runs from the snapshot.
    if (resume && snapshot.status === "exited") {
      scheduleSessionExited();
      return;
    }
    // The reset above wiped the failure message; replay restores it if its event is still buffered.
    if (
      resume &&
      snapshot.status === "error" &&
      !replayEntries.some((entry) => entry.event.type === "error")
    ) {
      writeSystemMessage(currentTerminal, "Terminal failed to start");
    }
    // Startup may finish after the user has returned to the composer.
    if (options.readAutoFocus() && mount.contains(document.activeElement)) {
      currentTerminal.focus();
    }
  };
  const openTerminal = (options: { resume: boolean }) => {
    latestOpenId += 1;
    const openId = latestOpenId;
    return hydrateTerminal(openId, options.resume).catch((err: unknown) => {
      if (disposed || openId !== latestOpenId) return;
      if (options.resume && isTerminalSessionGoneError(err)) {
        scheduleSessionExited();
        return;
      }
      writeSystemMessage(terminal, err instanceof Error ? err.message : "Failed to open terminal");
    });
  };

  void openTerminal({ resume: false });
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      activeTerminal = null;
      unsubscribeTerminalEvents();
      if (resumeTimer !== null) window.clearTimeout(resumeTimer);
      if (exitTimer !== null) window.clearTimeout(exitTimer);
    },
  };
}
