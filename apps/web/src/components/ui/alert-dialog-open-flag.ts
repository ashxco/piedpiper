export const ALERT_DIALOG_OPEN_ATTRIBUTE = "data-alert-dialog-open";

type FlagTarget = Pick<Element, "setAttribute" | "removeAttribute">;

const openCounts = new WeakMap<FlagTarget, number>();

/**
 * Marks the root element while any alert dialog is mounted, ref-counted so a
 * stacked dialog closing does not clear the flag for the one still open.
 * Returns a release function that is safe to call more than once.
 */
export function acquireAlertDialogOpenFlag(
  target: FlagTarget = document.documentElement,
): () => void {
  const nextCount = (openCounts.get(target) ?? 0) + 1;
  openCounts.set(target, nextCount);
  if (nextCount === 1) {
    target.setAttribute(ALERT_DIALOG_OPEN_ATTRIBUTE, "");
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (openCounts.get(target) ?? 1) - 1;
    if (remaining > 0) {
      openCounts.set(target, remaining);
      return;
    }
    openCounts.delete(target);
    target.removeAttribute(ALERT_DIALOG_OPEN_ATTRIBUTE);
  };
}
