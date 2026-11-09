import "../index.css";

import { useRef } from "react";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  ComposerMenuFocusContext,
  type ComposerMenuFocusTarget,
  shouldFocusComposerAfterMenuClose,
  useComposerMenuFinalFocus,
} from "./ChatView.composerMenuFocus";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

function ComposerMenu(props: { modal: boolean }) {
  const finalFocus = useComposerMenuFinalFocus();
  return (
    <Menu modal={props.modal}>
      <MenuTrigger data-testid="trigger">Open</MenuTrigger>
      <MenuPopup finalFocus={finalFocus}>
        <MenuItem>Pick me</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function Harness(props: { withProvider: boolean; modal?: boolean }) {
  const modal = props.modal ?? true;
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const targetRef = useRef<ComposerMenuFocusTarget>({
    focusAtEnd: () => editorRef.current?.focus(),
  });
  return (
    <div>
      <textarea aria-label="editor" ref={editorRef} />
      <input aria-label="other" />
      {props.withProvider ? (
        <ComposerMenuFocusContext value={targetRef}>
          <ComposerMenu modal={modal} />
        </ComposerMenuFocusContext>
      ) : (
        <ComposerMenu modal={modal} />
      )}
    </div>
  );
}

async function expectFocused(label: string): Promise<void> {
  await vi.waitFor(() => {
    expect(document.activeElement?.getAttribute("aria-label")).toBe(label);
  });
}

async function openMenu(): Promise<void> {
  await page.getByTestId("trigger").click();
  await expect.element(page.getByRole("menuitem", { name: "Pick me" })).toBeVisible();
}

describe("shouldFocusComposerAfterMenuClose on a trigger", () => {
  it.each(["menu-trigger", "combobox-trigger"])(
    "takes focus from a closed %s but not from one whose popup is open",
    (slot) => {
      const trigger = document.createElement("button");
      trigger.setAttribute("data-slot", slot);
      expect(shouldFocusComposerAfterMenuClose(trigger, document.body)).toBe(true);
      trigger.setAttribute("data-popup-open", "");
      expect(shouldFocusComposerAfterMenuClose(trigger, document.body)).toBe(false);
    },
  );

  it("reads the open state a real menu trigger exposes", async () => {
    const screen = await render(<Harness withProvider modal={false} />);
    try {
      const trigger = page.getByTestId("trigger").element();
      expect(shouldFocusComposerAfterMenuClose(trigger, document.body)).toBe(true);
      await openMenu();
      expect(shouldFocusComposerAfterMenuClose(trigger, document.body)).toBe(false);
    } finally {
      await screen.unmount();
    }
  });
});

describe("useComposerMenuFinalFocus", () => {
  it("returns focus to the prompt on Escape", async () => {
    const screen = await render(<Harness withProvider />);
    try {
      await openMenu();
      await userEvent.keyboard("{Escape}");
      await expectFocused("editor");
    } finally {
      await screen.unmount();
    }
  });

  it("returns focus to the prompt on an Escape before the popup took focus", async () => {
    const screen = await render(<Harness withProvider modal={false} />);
    try {
      await openMenu();
      page.getByTestId("trigger").element().focus();
      expect(document.activeElement?.getAttribute("data-testid")).toBe("trigger");
      await userEvent.keyboard("{Escape}");
      await expectFocused("editor");
    } finally {
      await screen.unmount();
    }
  });

  it("returns focus to the prompt after a pick", async () => {
    const screen = await render(<Harness withProvider />);
    try {
      await openMenu();
      await page.getByRole("menuitem", { name: "Pick me" }).click();
      await expectFocused("editor");
    } finally {
      await screen.unmount();
    }
  });

  it("does not steal focus the user moved to another field", async () => {
    const screen = await render(<Harness withProvider modal={false} />);
    try {
      await openMenu();
      await page.getByRole("textbox", { name: "other" }).click();
      await expectFocused("other");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps trigger focus without a composer, as in settings", async () => {
    const screen = await render(<Harness withProvider={false} />);
    try {
      await openMenu();
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.activeElement?.getAttribute("data-testid")).toBe("trigger");
      });
    } finally {
      await screen.unmount();
    }
  });
});
