import { useCallback, useRef, useState } from "react";

import type { ComposerTrigger } from "../../composer-logic";

/** Returns `previous` when `next` describes the same trigger, so a state update can bail out. */
export function keepEquivalentComposerTrigger(
  previous: ComposerTrigger | null,
  next: ComposerTrigger | null,
): ComposerTrigger | null {
  if (previous === next) return previous;
  if (previous === null || next === null) return next;
  return previous.kind === next.kind &&
    previous.query === next.query &&
    previous.rangeStart === next.rangeStart &&
    previous.rangeEnd === next.rangeEnd
    ? previous
    : next;
}

/** `/` tokens switch between slash-command and slash-model as they are typed (`/mo` → `/model`). */
function composerTriggerFamily(trigger: ComposerTrigger): "path" | "slash" {
  return trigger.kind === "path" ? "path" : "slash";
}

/**
 * Null when `candidate` is the token the user dismissed with Escape: same trigger
 * family and same start, so typing or deleting inside that token keeps the menu closed.
 */
export function resolveDismissedComposerTrigger(
  dismissed: ComposerTrigger | null,
  candidate: ComposerTrigger | null,
): ComposerTrigger | null {
  return candidate &&
    dismissed &&
    composerTriggerFamily(candidate) === composerTriggerFamily(dismissed) &&
    candidate.rangeStart === dismissed.rangeStart
    ? null
    : candidate;
}

/**
 * Applies a detected trigger against the current dismissal. The dismissal ends once
 * the caret leaves every token (no trigger) or a different token opens.
 */
export function applyComposerTriggerDismissal(
  dismissed: ComposerTrigger | null,
  candidate: ComposerTrigger | null,
): { trigger: ComposerTrigger | null; dismissed: ComposerTrigger | null } {
  const trigger = resolveDismissedComposerTrigger(dismissed, candidate);
  return {
    trigger,
    dismissed: candidate === null || trigger !== null ? null : dismissed,
  };
}

/** True when both name the same token: same trigger family and same start. */
export function isSameComposerTriggerToken(
  a: ComposerTrigger | null,
  b: ComposerTrigger | null,
): boolean {
  return (
    a !== null &&
    b !== null &&
    composerTriggerFamily(a) === composerTriggerFamily(b) &&
    a.rangeStart === b.rangeStart
  );
}

/**
 * Applies the trigger at the caret after the caret moved without an edit. A move can keep the
 * open menu (the caret stays in its token) or close it, but never opens one, so arrowing or
 * clicking onto an existing `/command` or `@path` does not pop suggestions over the text.
 */
export function followComposerTriggerCaret(
  active: ComposerTrigger | null,
  dismissed: ComposerTrigger | null,
  candidate: ComposerTrigger | null,
): { trigger: ComposerTrigger | null; dismissed: ComposerTrigger | null } {
  return {
    trigger: isSameComposerTriggerToken(active, candidate) ? candidate : null,
    dismissed: isSameComposerTriggerToken(dismissed, candidate) ? dismissed : null,
  };
}

/**
 * Composer trigger state with Escape dismissal. `setTrigger` is for triggers detected from
 * text edits, `followCaret` for caret-only moves (they never open a menu), `resetTrigger` for
 * programmatic prompt replacements (thread switch, sends, inserted items) that should forget a
 * dismissal.
 */
export function useComposerTriggerState(initialTrigger: () => ComposerTrigger | null) {
  const [trigger, setActiveTrigger] = useState(initialTrigger);
  // Key handlers read this before React commits the state.
  const activeTriggerRef = useRef(trigger);
  const dismissedTriggerRef = useRef<ComposerTrigger | null>(null);

  const activate = useCallback((next: ComposerTrigger | null) => {
    const kept = keepEquivalentComposerTrigger(activeTriggerRef.current, next);
    activeTriggerRef.current = kept;
    setActiveTrigger(kept);
  }, []);

  /** The trigger at the caret when its menu is the open one, otherwise null. */
  const resolveTrigger = useCallback(
    (candidate: ComposerTrigger | null) =>
      isSameComposerTriggerToken(activeTriggerRef.current, candidate) ? candidate : null,
    [],
  );

  const setTrigger = useCallback(
    (candidate: ComposerTrigger | null) => {
      const next = applyComposerTriggerDismissal(dismissedTriggerRef.current, candidate);
      dismissedTriggerRef.current = next.dismissed;
      activate(next.trigger);
    },
    [activate],
  );

  const followCaret = useCallback(
    (candidate: ComposerTrigger | null) => {
      const next = followComposerTriggerCaret(
        activeTriggerRef.current,
        dismissedTriggerRef.current,
        candidate,
      );
      dismissedTriggerRef.current = next.dismissed;
      activate(next.trigger);
    },
    [activate],
  );

  const dismissTrigger = useCallback(
    (candidate: ComposerTrigger | null) => {
      dismissedTriggerRef.current = candidate;
      activate(null);
    },
    [activate],
  );

  const resetTrigger = useCallback(
    (candidate: ComposerTrigger | null) => {
      dismissedTriggerRef.current = null;
      activate(candidate);
    },
    [activate],
  );

  return { trigger, setTrigger, followCaret, resolveTrigger, dismissTrigger, resetTrigger };
}
