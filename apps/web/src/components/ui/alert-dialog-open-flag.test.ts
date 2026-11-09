import { assert, describe, it } from "vitest";

import { acquireAlertDialogOpenFlag, ALERT_DIALOG_OPEN_ATTRIBUTE } from "./alert-dialog-open-flag";

function createTarget() {
  const attributes = new Map<string, string>();
  return {
    attributes,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  };
}

describe("acquireAlertDialogOpenFlag", () => {
  it("sets the flag while a dialog is open and clears it on release", () => {
    const target = createTarget();
    const release = acquireAlertDialogOpenFlag(target);
    assert.isTrue(target.attributes.has(ALERT_DIALOG_OPEN_ATTRIBUTE));
    release();
    assert.isFalse(target.attributes.has(ALERT_DIALOG_OPEN_ATTRIBUTE));
  });

  it("keeps the flag until every stacked dialog has released", () => {
    const target = createTarget();
    const releaseOuter = acquireAlertDialogOpenFlag(target);
    const releaseInner = acquireAlertDialogOpenFlag(target);
    releaseInner();
    assert.isTrue(target.attributes.has(ALERT_DIALOG_OPEN_ATTRIBUTE));
    releaseOuter();
    assert.isFalse(target.attributes.has(ALERT_DIALOG_OPEN_ATTRIBUTE));
  });

  it("ignores repeated releases from the same dialog", () => {
    const target = createTarget();
    const releaseOuter = acquireAlertDialogOpenFlag(target);
    const releaseInner = acquireAlertDialogOpenFlag(target);
    releaseInner();
    releaseInner();
    assert.isTrue(target.attributes.has(ALERT_DIALOG_OPEN_ATTRIBUTE));
    releaseOuter();
    assert.isFalse(target.attributes.has(ALERT_DIALOG_OPEN_ATTRIBUTE));
  });
});
