import "../../index.css";

import { useRef } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  ComposerMenuFocusContext,
  type ComposerMenuFocusTarget,
} from "../ChatView.composerMenuFocus";
import { ComposerRuntimeModePicker } from "./ComposerRuntimeModePicker";

function InComposer() {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const targetRef = useRef<ComposerMenuFocusTarget>({
    focusAtEnd: () => editorRef.current?.focus(),
  });
  return (
    <ComposerMenuFocusContext value={targetRef}>
      <textarea aria-label="editor" ref={editorRef} />
      <ComposerRuntimeModePicker runtimeMode="approval-required" onRuntimeModeChange={vi.fn()} />
    </ComposerMenuFocusContext>
  );
}

async function expectEditorFocused(): Promise<void> {
  await vi.waitFor(() => {
    expect(document.activeElement?.getAttribute("aria-label")).toBe("editor");
  });
}

async function openInComposer(): Promise<void> {
  await page.getByRole("button", { name: "Supervised" }).click();
  await vi.waitFor(() => {
    expect(document.activeElement?.closest('[data-slot="menu-popup"]')).not.toBeNull();
  });
}

describe("ComposerRuntimeModePicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("offers Supervised, Auto and Full access and reports the picked mode", async () => {
    const onRuntimeModeChange = vi.fn();
    const screen = await render(
      <ComposerRuntimeModePicker
        runtimeMode="approval-required"
        onRuntimeModeChange={onRuntimeModeChange}
        shortcutLabel="⇧⌘A"
      />,
    );

    const trigger = page.getByRole("button", { name: "Supervised" });
    await expect.element(trigger).toHaveAttribute("title", "Access: Supervised (⇧⌘A)");
    await trigger.click();
    await expect.poll(() => document.querySelectorAll('[role="menuitemradio"]').length).toBe(3);
    await expect
      .element(page.getByText("An AI reviewer approves routine actions; risky ones still ask."))
      .toBeVisible();

    await page.getByRole("menuitemradio", { name: /^Auto/ }).click();
    expect(onRuntimeModeChange).toHaveBeenCalledWith("auto");
    await screen.unmount();
  });

  it("returns focus to the prompt on Escape, a pick and a same-value re-pick", async () => {
    const screen = await render(<InComposer />);
    try {
      await openInComposer();
      await userEvent.keyboard("{Escape}");
      await expectEditorFocused();

      await openInComposer();
      await page.getByRole("menuitemradio", { name: /^Auto/ }).click();
      await expectEditorFocused();

      await openInComposer();
      await page.getByRole("menuitemradio", { name: /^Supervised/ }).click();
      await expectEditorFocused();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps trigger focus outside the composer", async () => {
    const screen = await render(
      <ComposerRuntimeModePicker runtimeMode="auto" onRuntimeModeChange={vi.fn()} />,
    );
    try {
      const trigger = page.getByRole("button", { name: "Auto" });
      await trigger.click();
      await vi.waitFor(() => {
        expect(document.activeElement?.closest('[data-slot="menu-popup"]')).not.toBeNull();
      });
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(trigger.element());
      });
    } finally {
      await screen.unmount();
    }
  });

  it("opens from the controlled open prop", async () => {
    const onOpenChange = vi.fn();
    const screen = await render(
      <ComposerRuntimeModePicker
        runtimeMode="auto"
        onRuntimeModeChange={vi.fn()}
        open
        onOpenChange={onOpenChange}
      />,
    );

    await expect
      .element(page.getByRole("menuitemradio", { name: /^Auto/ }))
      .toHaveAttribute("aria-checked", "true");
    await page.getByRole("menuitemradio", { name: /^Full access/ }).click();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await screen.unmount();
  });
});
