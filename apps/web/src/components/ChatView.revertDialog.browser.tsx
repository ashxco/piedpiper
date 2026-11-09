import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { RevertCheckpointDialog } from "./ChatView.revertDialog";

// Tailwind is not loaded here, so Base UI's inert modal layer would cover the popup for pointer clicks.
async function clickButton(name: string) {
  const findButton = () =>
    Array.from(document.querySelectorAll("button")).find((button) => button.textContent === name);
  await expect.poll(findButton).toBeTruthy();
  findButton()?.click();
}

describe("RevertCheckpointDialog", () => {
  it("offers restoring files or keeping file changes", async () => {
    const onConfirm = vi.fn();
    const screen = await render(
      <RevertCheckpointDialog
        state={{ turnCount: 3, open: true }}
        onCancel={vi.fn()}
        onClosed={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    try {
      await expect.element(page.getByText("Edit from here?")).toBeInTheDocument();
      await expect
        .element(page.getByText("text and images return to the composer", { exact: false }))
        .toBeInTheDocument();
      await clickButton("Keep file changes");
      expect(onConfirm).toHaveBeenLastCalledWith(false);
      await clickButton("Restore files");
      expect(onConfirm).toHaveBeenLastCalledWith(true);
    } finally {
      await screen.unmount();
    }
  });

  it("cancels without confirming", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const screen = await render(
      <RevertCheckpointDialog
        state={{ turnCount: 1, open: true }}
        onCancel={onCancel}
        onClosed={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    try {
      await clickButton("Cancel");
      expect(onCancel).toHaveBeenCalled();
      expect(onConfirm).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
