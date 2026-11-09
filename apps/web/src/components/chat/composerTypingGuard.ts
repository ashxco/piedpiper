/** How long after the last keystroke a new approval or question may take over the composer. */
export const COMPOSER_TYPING_IDLE_MS = 1500;

export interface ComposerTypingGuardState {
  /** Request ids already seen, so a request is held at most once. */
  readonly seen: ReadonlySet<string>;
  /** Request ids that arrived mid-typing and are not shown yet. */
  readonly held: ReadonlySet<string>;
  readonly focused: boolean;
  /** True from a keystroke until the idle timeout, a blur or a send; the caller owns the timer. */
  readonly typing: boolean;
}

export type ComposerTypingGuardEvent =
  | { type: "requests"; requestIds: readonly string[] }
  | { type: "type" | "focus" | "blur" | "send" | "idle" };

export function createComposerTypingGuardState(): ComposerTypingGuardState {
  return { seen: new Set(), held: new Set(), focused: false, typing: false };
}

export function updateComposerTypingGuard(
  state: ComposerTypingGuardState,
  event: ComposerTypingGuardEvent,
): ComposerTypingGuardState {
  switch (event.type) {
    case "requests": {
      const seen = new Set(state.seen);
      const held = new Set([...state.held].filter((id) => event.requestIds.includes(id)));
      const typing = state.focused && state.typing;
      for (const id of event.requestIds) {
        if (!seen.has(id) && typing) {
          held.add(id);
        }
        seen.add(id);
      }
      return { ...state, seen, held };
    }
    case "type":
      return state.typing ? state : { ...state, typing: true };
    case "focus":
      return state.focused ? state : { ...state, focused: true };
    case "blur":
    case "send":
    case "idle": {
      const focused = event.type === "blur" ? false : state.focused;
      if (!state.typing && state.held.size === 0 && focused === state.focused) return state;
      return { ...state, held: new Set(), typing: false, focused };
    }
  }
}

/** Drops held requests so they do not take over the composer yet. */
export function withoutHeldComposerRequests<A extends ReadonlyArray<{ requestId: string }>>(
  requests: A,
  heldRequestIds: ReadonlySet<string>,
): A {
  if (heldRequestIds.size === 0) return requests;
  return requests.filter((request) => !heldRequestIds.has(request.requestId)) as unknown as A;
}
