import { useState } from "react";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ALERT_DIALOG_OPEN_ATTRIBUTE } from "./alert-dialog-open-flag";
import { AlertDialog, AlertDialogClose, AlertDialogPopup, AlertDialogTitle } from "./alert-dialog";
import { Dialog, DialogPopup, DialogTitle } from "./dialog";

function ClearingDialog() {
  const [message, setMessage] = useState("Draft message");
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setMessage("");
        }}
      >
        <DialogPopup>
          <DialogTitle>Commit</DialogTitle>
          <p data-testid="dialog-message">{message || "(empty)"}</p>
          <button type="button" onClick={() => setMessage("Updated message")}>
            Update
          </button>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function NestedAlertDialogs() {
  const [outerOpen, setOuterOpen] = useState(true);
  const [innerOpen, setInnerOpen] = useState(true);
  return (
    <>
      <AlertDialog open={outerOpen} onOpenChange={setOuterOpen}>
        <AlertDialogPopup>
          <AlertDialogTitle>Outer</AlertDialogTitle>
          <AlertDialogClose>Close outer</AlertDialogClose>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={innerOpen} onOpenChange={setInnerOpen}>
        <AlertDialogPopup>
          <AlertDialogTitle>Inner</AlertDialogTitle>
          <AlertDialogClose>Close inner</AlertDialogClose>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

// Tailwind is not loaded here, so Base UI's inert modal layer would cover the popup for pointer clicks.
async function clickButton(name: string) {
  const findButton = () =>
    Array.from(document.querySelectorAll("button")).find(
      (button) => (button.getAttribute("aria-label") ?? button.textContent) === name,
    );
  await expect.poll(findButton).toBeTruthy();
  findButton()?.click();
}

describe("Dialog content retention", () => {
  it("keeps showing live content while open", async () => {
    await render(<ClearingDialog />);
    await expect.element(page.getByTestId("dialog-message")).toHaveTextContent("Draft message");
    await clickButton("Update");
    await expect.element(page.getByTestId("dialog-message")).toHaveTextContent("Updated message");
  });

  it("keeps the last open content while the close animation plays", async () => {
    await render(<ClearingDialog />);
    await expect.element(page.getByTestId("dialog-message")).toHaveTextContent("Draft message");

    await clickButton("Close");
    const popup = document.querySelector('[data-slot="dialog-popup"]');
    expect(popup?.textContent).toContain("Draft message");
    expect(popup?.textContent).not.toContain("(empty)");

    await expect.poll(() => document.querySelector('[data-slot="dialog-popup"]')).toBeNull();
    await clickButton("Reopen");
    await expect.element(page.getByTestId("dialog-message")).toHaveTextContent("(empty)");
  });
});

describe("AlertDialog open flag", () => {
  it("flags the root element until every stacked alert dialog has closed", async () => {
    await render(<NestedAlertDialogs />);
    await expect
      .poll(() => document.documentElement.hasAttribute(ALERT_DIALOG_OPEN_ATTRIBUTE))
      .toBe(true);

    await clickButton("Close inner");
    await expect
      .poll(() => document.querySelectorAll('[data-slot="alert-dialog-backdrop"]').length)
      .toBe(1);
    expect(document.documentElement.hasAttribute(ALERT_DIALOG_OPEN_ATTRIBUTE)).toBe(true);

    await clickButton("Close outer");
    await expect
      .poll(() => document.documentElement.hasAttribute(ALERT_DIALOG_OPEN_ATTRIBUTE))
      .toBe(false);
  });
});
