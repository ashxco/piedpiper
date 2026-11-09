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

/**
 * Composer trigger state with Escape dismissal. `setTrigger` is for triggers detected
 * from typing or caret moves, `resetTrigger` for programmatic prompt replacements
 * (thread switch, sends, inserted items) that should forget a dismissal.
 */
export function useComposerTriggerState(initialTrigger: () => ComposerTrigger | null) {
  const [trigger, setActiveTrigger] = useState(initialTrigger);
  const dismissedTriggerRef = useRef<ComposerTrigger | null>(null);

  const resolveTrigger = useCallback(
    (candidate: ComposerTrigger | null) =>
      resolveDismissedComposerTrigger(dismissedTriggerRef.current, candidate),
    [],
  );

  const setTrigger = useCallback((candidate: ComposerTrigger | null) => {
    const next = applyComposerTriggerDismissal(dismissedTriggerRef.current, candidate);
    dismissedTriggerRef.current = next.dismissed;
    setActiveTrigger((previous) => keepEquivalentComposerTrigger(previous, next.trigger));
  }, []);

  const dismissTrigger = useCallback((candidate: ComposerTrigger | null) => {
    dismissedTriggerRef.current = candidate;
    setActiveTrigger(null);
  }, []);

  const resetTrigger = useCallback((candidate: ComposerTrigger | null) => {
    dismissedTriggerRef.current = null;
    setActiveTrigger((previous) => keepEquivalentComposerTrigger(previous, candidate));
  }, []);

  return { trigger, setTrigger, resolveTrigger, dismissTrigger, resetTrigger };
}
