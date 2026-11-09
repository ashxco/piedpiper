import { useCallback, useEffect, useRef, useState } from "react";
import {
  COMPOSER_TYPING_IDLE_MS,
  type ComposerTypingGuardEvent,
  createComposerTypingGuardState,
  updateComposerTypingGuard,
} from "./composerTypingGuard";

/**
 * Holds approvals and questions that arrive while the user is typing in the composer,
 * until 1.5 s after the last keystroke, a blur, or a send. `scope` is the thread id.
 * Keystrokes only re-render the caller when a typing burst starts and ends.
 */
export function useComposerTypingGuard(scope: string, requestIds: readonly string[]) {
  const requestsKey = requestIds.join("\u0000");
  const [snapshot, setSnapshot] = useState(() => ({
    scope,
    requestsKey,
    state: updateComposerTypingGuard(createComposerTypingGuardState(), {
      type: "requests",
      requestIds,
    }),
  }));
  if (snapshot.scope !== scope || snapshot.requestsKey !== requestsKey) {
    // Adjusting state during render: a different thread starts fresh but keeps editor focus.
    const base =
      snapshot.scope === scope
        ? snapshot.state
        : { ...createComposerTypingGuardState(), focused: snapshot.state.focused };
    setSnapshot({
      scope,
      requestsKey,
      state: updateComposerTypingGuard(base, { type: "requests", requestIds }),
    });
  }
  const idleTimeoutRef = useRef<number | null>(null);
  const dispatch = useCallback((event: ComposerTypingGuardEvent) => {
    setSnapshot((current) => {
      const next = updateComposerTypingGuard(current.state, event);
      return next === current.state ? current : { ...current, state: next };
    });
  }, []);
  const clearIdleTimeout = useCallback(() => {
    if (idleTimeoutRef.current === null) return;
    window.clearTimeout(idleTimeoutRef.current);
    idleTimeoutRef.current = null;
  }, []);
  const onDraftChange = useCallback(() => {
    // A pending timeout means this burst already dispatched "type"; only re-arm it.
    const burstStarted = idleTimeoutRef.current !== null;
    clearIdleTimeout();
    idleTimeoutRef.current = window.setTimeout(() => {
      idleTimeoutRef.current = null;
      dispatch({ type: "idle" });
    }, COMPOSER_TYPING_IDLE_MS);
    if (!burstStarted) dispatch({ type: "type" });
  }, [clearIdleTimeout, dispatch]);
  const endBurst = useCallback(
    (type: "blur" | "send") => {
      clearIdleTimeout();
      dispatch({ type });
    },
    [clearIdleTimeout, dispatch],
  );
  const onFocus = useCallback(() => dispatch({ type: "focus" }), [dispatch]);
  const onBlur = useCallback(() => endBurst("blur"), [endBurst]);
  const onSend = useCallback(() => endBurst("send"), [endBurst]);
  const onFocusChange = useCallback(
    (focused: boolean) => (focused ? dispatch({ type: "focus" }) : endBurst("blur")),
    [dispatch, endBurst],
  );
  // A new thread starts with no typing burst, so the next keystroke must dispatch "type" again.
  useEffect(() => clearIdleTimeout, [scope, clearIdleTimeout]);
  return {
    heldRequestIds: snapshot.state.held,
    onDraftChange,
    onFocus,
    onBlur,
    onFocusChange,
    onSend,
  };
}
