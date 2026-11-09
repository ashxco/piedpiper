import { type ThreadId } from "@piedpiper/contracts";
import { Suspense, lazy, memo, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAllThreadIds } from "../../storeSelectors";
import { useComposerDraftStore } from "../../composerDraftStore";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { type TerminalContextSelection } from "../../lib/terminalContext";
import type { ResolvedKeybindingsConfig } from "@piedpiper/contracts";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  reconcileMountedTerminalThreadIds,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
} from "../ChatView.logic";

const PersistentThreadTerminalDrawer = lazy(() =>
  import("./PersistentThreadTerminalDrawer").then((mod) => ({
    default: mod.PersistentThreadTerminalDrawer,
  })),
);

export interface ChatTerminalSectionProps {
  activeThreadId: ThreadId | null;
  /** Monotonically increasing counter that triggers terminal focus. */
  terminalFocusRequestId: number;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

/**
 * Owns the `mountedTerminalThreadIds` state and renders the
 * `PersistentThreadTerminalDrawer` instances. Subscribes directly to the
 * terminal state store and thread id lists so that mount/unmount
 * reconciliation is self-contained.
 */
export const ChatTerminalSection = memo(function ChatTerminalSection({
  activeThreadId,
  terminalFocusRequestId,
  keybindings,
  onAddTerminalContext,
}: ChatTerminalSectionProps) {
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, activeThreadId ?? ("" as ThreadId)),
  );

  const openTerminalThreadIds = useTerminalStateStore(
    useShallow((state) =>
      Object.entries(state.terminalStateByThreadId).flatMap(([tid, ts]) =>
        ts.terminalOpen ? [tid as ThreadId] : [],
      ),
    ),
  );

  const serverThreadIds = useAllThreadIds();
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const draftThreadIds = useMemo(
    () => Object.keys(draftThreadsByThreadId) as ThreadId[],
    [draftThreadsByThreadId],
  );

  const existingOpenTerminalThreadIds = useMemo(() => {
    const existingThreadIds = new Set<ThreadId>([...serverThreadIds, ...draftThreadIds]);
    return openTerminalThreadIds.filter((tid) => existingThreadIds.has(tid));
  }, [draftThreadIds, openTerminalThreadIds, serverThreadIds]);

  const [mountedTerminalThreadIds, setMountedTerminalThreadIds] = useState<ThreadId[]>([]);

  useEffect(() => {
    setMountedTerminalThreadIds((currentThreadIds) => {
      const nextThreadIds = reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: existingOpenTerminalThreadIds,
        activeThreadId,
        activeThreadTerminalOpen: Boolean(activeThreadId && terminalState.terminalOpen),
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
      });
      return currentThreadIds.length === nextThreadIds.length &&
        currentThreadIds.every((tid, index) => tid === nextThreadIds[index])
        ? currentThreadIds
        : nextThreadIds;
    });
  }, [activeThreadId, existingOpenTerminalThreadIds, terminalState.terminalOpen]);

  // Shortcut labels for terminal actions.
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: Boolean(terminalState.terminalOpen),
      },
    }),
    [terminalState.terminalOpen],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const splitTerminalVerticalShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "terminal.splitVertical", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );

  return (
    <Suspense fallback={null}>
      {mountedTerminalThreadIds.map((mountedThreadId) => (
        <PersistentThreadTerminalDrawer
          key={mountedThreadId}
          threadId={mountedThreadId}
          visible={mountedThreadId === activeThreadId && terminalState.terminalOpen}
          focusRequestId={mountedThreadId === activeThreadId ? terminalFocusRequestId : 0}
          splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
          splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
          newShortcutLabel={newTerminalShortcutLabel ?? undefined}
          closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
          onAddTerminalContext={onAddTerminalContext}
        />
      ))}
    </Suspense>
  );
});
