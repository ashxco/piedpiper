import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { COMPOSER_ATTACH_IMAGE_ACCEPT, ComposerAttachButton } from "./ComposerAttachButton";

function attachInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('[data-testid="composer-attach-input"]');
  if (!input) throw new Error("attach input not mounted");
  return input;
}

function pick(input: HTMLInputElement, files: File[]): void {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("ComposerAttachButton", () => {
  it("accepts several images and PDFs, HEIC included, from a hidden input", async () => {
    const screen = await render(<ComposerAttachButton onFiles={() => {}} />);
    try {
      const input = attachInput();
      expect(input.multiple).toBe(true);
      expect(input.hidden).toBe(true);
      expect(COMPOSER_ATTACH_IMAGE_ACCEPT).toContain("image/heic");
      expect(COMPOSER_ATTACH_IMAGE_ACCEPT).toContain(".heic");
      expect(input.accept.split(",")).toEqual(expect.arrayContaining(["application/pdf", ".pdf"]));
    } finally {
      await screen.unmount();
    }
  });

  it("hands over a copy of the files and lets the same file be picked twice", async () => {
    const onFiles = vi.fn();
    const screen = await render(<ComposerAttachButton onFiles={onFiles} />);
    try {
      const input = attachInput();
      const file = new File(["x"], "a.png", { type: "image/png" });
      pick(input, [file]);
      expect(input.value).toBe("");
      pick(input, [file]);
      expect(onFiles).toHaveBeenCalledTimes(2);
      expect(onFiles.mock.calls[0]?.[0]).toEqual([file]);
      expect(onFiles.mock.calls[1]?.[0]).toEqual([file]);
    } finally {
      await screen.unmount();
    }
  });

  it("ignores a cancelled pick", async () => {
    const onFiles = vi.fn();
    const screen = await render(<ComposerAttachButton onFiles={onFiles} />);
    try {
      pick(attachInput(), []);
      expect(onFiles).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("opens the picker without taking focus, and is disabled while connecting", async () => {
    const screen = await render(<ComposerAttachButton onFiles={() => {}} />);
    try {
      const button = page.getByRole("button", { name: "Attach files" });
      const click = vi.spyOn(attachInput(), "click").mockImplementation(() => {});
      const pointerDown = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
      button.element().dispatchEvent(pointerDown);
      expect(pointerDown.defaultPrevented).toBe(true);
      await button.click();
      expect(click).toHaveBeenCalledTimes(1);
      await screen.rerender(<ComposerAttachButton disabled onFiles={() => {}} />);
      await expect.element(button).toBeDisabled();
    } finally {
      await screen.unmount();
    }
  });
});
