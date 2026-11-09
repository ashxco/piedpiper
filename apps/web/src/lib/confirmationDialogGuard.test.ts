import { afterEach, describe, expect, it, vi } from "vitest";

import { ALERT_DIALOG_OPEN_ATTRIBUTE } from "../components/ui/alert-dialog-open-flag";
import { isInsideConfirmationDialog } from "./confirmationDialogGuard";

describe("isInsideConfirmationDialog", () => {
  it("matches a target within an alertdialog", () => {
    const target = {
      closest: (selector: string) => (selector === '[role="alertdialog"]' ? {} : null),
    };
    expect(isInsideConfirmationDialog(target)).toBe(true);
  });

  it("ignores targets outside one, plain dialogs and non-elements", () => {
    expect(isInsideConfirmationDialog({ closest: () => null })).toBe(false);
    expect(isInsideConfirmationDialog(null)).toBe(false);
    expect(isInsideConfirmationDialog(undefined)).toBe(false);
    expect(isInsideConfirmationDialog({})).toBe(false);
  });

  describe("with focus outside the popup", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const stubRootFlag = (present: boolean) =>
      vi.stubGlobal("document", {
        documentElement: {
          hasAttribute: (name: string) => present && name === ALERT_DIALOG_OPEN_ATTRIBUTE,
        },
      });

    it("matches any target while a confirmation is open", () => {
      stubRootFlag(true);
      expect(isInsideConfirmationDialog({ closest: () => null })).toBe(true);
      expect(isInsideConfirmationDialog(null)).toBe(true);
    });

    it("does not match once none is open", () => {
      stubRootFlag(false);
      expect(isInsideConfirmationDialog({ closest: () => null })).toBe(false);
    });
  });
});
