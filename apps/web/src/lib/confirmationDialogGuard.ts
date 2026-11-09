import { ALERT_DIALOG_OPEN_ATTRIBUTE } from "../components/ui/alert-dialog-open-flag";

/**
 * True when a key event must not act behind a confirmation: it came from inside one, or one is open
 * while focus sits elsewhere, as after a click on the backdrop, which does not close an alert dialog.
 * Duck-typed, so stub targets work in unit tests.
 */
export function isInsideConfirmationDialog(target: unknown): boolean {
  if (
    typeof document !== "undefined" &&
    document.documentElement.hasAttribute(ALERT_DIALOG_OPEN_ATTRIBUTE)
  ) {
    return true;
  }
  const closest = (target as { closest?: unknown } | null | undefined)?.closest;
  return (
    typeof closest === "function" &&
    (target as { closest: (selector: string) => unknown }).closest('[role="alertdialog"]') != null
  );
}
