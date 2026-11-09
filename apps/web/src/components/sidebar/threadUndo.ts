import { toastManager } from "../ui/toast";

const THREAD_UNDO_TOAST_TIMEOUT_MS = 5_000;

// Undo toasts still on screen, oldest first, so the `thread.undo` shortcut runs the newest one.
const liveUndos: Array<() => Promise<void> | null> = [];

/** Runs the newest live Undo; false when there is nothing left to undo. */
export function undoLatestThreadAction(): boolean {
  while (liveUndos.length > 0) {
    if (liveUndos[liveUndos.length - 1]?.() != null) return true;
  }
  return false;
}

/** Shows a success toast whose single-use Undo action is also reachable through `thread.undo`. */
export function showThreadUndoToast(input: {
  title: string;
  description?: string;
  failureTitle: string;
  undo: () => Promise<void>;
}): void {
  let undoStarted = false;
  let toastId: string | undefined;
  const forget = () => {
    const index = liveUndos.indexOf(run);
    if (index !== -1) liveUndos.splice(index, 1);
  };
  const run = (): Promise<void> | null => {
    forget();
    if (undoStarted) return null;
    undoStarted = true;
    if (toastId !== undefined) toastManager.close(toastId);
    return input.undo().catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: input.failureTitle,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };
  liveUndos.push(run);
  toastId = toastManager.add({
    type: "success",
    title: input.title,
    description: input.description,
    timeout: THREAD_UNDO_TOAST_TIMEOUT_MS,
    actionProps: {
      children: "Undo",
      onClick: () => {
        void run();
      },
    },
    onClose: forget,
  });
}

const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");

/** Whether a text-editing element owns the keyboard, so mod+z must stay the editor's own undo. */
export function isEditableFocused(
  target: EventTarget | null = typeof document === "undefined" ? null : document.activeElement,
): boolean {
  return (
    typeof Element !== "undefined" &&
    target instanceof Element &&
    target.closest(EDITABLE_SELECTOR) !== null
  );
}

/**
 * Whether mod+z belongs to a focused editor: one with text in it. An empty field (the fresh
 * composer focused after archiving the open thread) has nothing of its own worth undoing.
 */
export function isEditorUndoFocused(
  target: EventTarget | null = typeof document === "undefined" ? null : document.activeElement,
): boolean {
  if (!isEditableFocused(target)) return false;
  const editable = (target as Element).closest(EDITABLE_SELECTOR);
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    return editable.value.length > 0;
  }
  if (editable instanceof HTMLSelectElement) return false;
  return (editable?.textContent ?? "").length > 0;
}
