import "../../index.css";

import type { EditorId, ResolvedKeybindingsConfig } from "@piedpiper/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const nativeApiHolder = vi.hoisted(() => ({ api: undefined as unknown }));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => nativeApiHolder.api,
  ensureNativeApi: () => nativeApiHolder.api,
}));

import { toastManager } from "../ui/toast";
import { OpenInPicker } from "./OpenInPicker";

const LAST_EDITOR_KEY = "piedpiper:last-editor";
const EDITORS: ReadonlyArray<EditorId> = ["cursor", "vscode"];
const KEYBINDINGS: ResolvedKeybindingsConfig = [
  {
    command: "editor.openFavorite",
    shortcut: {
      key: "o",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: true,
      modKey: false,
    },
  },
];

function renderPicker(openInCwd: string | null = "/repo") {
  return render(
    <OpenInPicker keybindings={KEYBINDINGS} availableEditors={EDITORS} openInCwd={openInCwd} />,
  );
}

async function chooseEditor(label: string) {
  await page.getByRole("button", { name: "Choose editor" }).click();
  await page.getByRole("menuitem", { name: label }).click();
}

describe("OpenInPicker", () => {
  const openInEditor = vi.fn((_cwd: string, _editor: string) => Promise.resolve());

  beforeEach(() => {
    localStorage.removeItem(LAST_EDITOR_KEY);
    openInEditor.mockClear();
    nativeApiHolder.api = { shell: { openInEditor } };
  });

  afterEach(() => {
    localStorage.removeItem(LAST_EDITOR_KEY);
  });

  it("names the default editor on the open button", async () => {
    const screen = await renderPicker();
    try {
      await expect
        .element(page.getByRole("button", { name: "Open in Cursor" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("saves the chosen editor without launching it, then opens it from the button", async () => {
    const screen = await renderPicker();
    try {
      await chooseEditor("VS Code");

      const openButton = page.getByRole("button", { name: "Open in VS Code" });
      await expect.element(openButton).toBeInTheDocument();
      expect(localStorage.getItem(LAST_EDITOR_KEY)).toBe('"vscode"');
      expect(openInEditor).not.toHaveBeenCalled();

      await openButton.click();
      expect(openInEditor).toHaveBeenCalledExactlyOnceWith("/repo", "vscode");
    } finally {
      await screen.unmount();
    }
  });

  it("announces the new default editor to screen readers", async () => {
    const screen = await renderPicker();
    try {
      await chooseEditor("VS Code");
      await vi.waitFor(() => {
        const regions = [...document.querySelectorAll("[data-announcer]")];
        expect(regions.map((region) => region.textContent)).toContain(
          "VS Code set as default editor",
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows one toast naming the editor when the Open button's open fails", async () => {
    const toastAdd = vi.spyOn(toastManager, "add");
    openInEditor.mockRejectedValueOnce(new Error("Editor not found"));
    const screen = await renderPicker();
    try {
      await page.getByRole("button", { name: "Open in Cursor" }).click();
      await vi.waitFor(() =>
        expect(toastAdd).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            type: "error",
            title: "Could not open in Cursor",
            description: "Editor not found",
          }),
        ),
      );
    } finally {
      toastAdd.mockRestore();
      await screen.unmount();
    }
  });

  it("ignores a held shortcut but still claims the key", async () => {
    const screen = await renderPicker();
    try {
      const event = new KeyboardEvent("keydown", {
        key: "o",
        shiftKey: true,
        altKey: true,
        repeat: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(openInEditor).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("opens the newly chosen editor from the shortcut", async () => {
    const screen = await renderPicker();
    try {
      await chooseEditor("VS Code");
      await expect
        .element(page.getByRole("button", { name: "Open in VS Code" }))
        .toBeInTheDocument();
      expect(openInEditor).not.toHaveBeenCalled();

      await userEvent.keyboard("{Shift>}{Alt>}o{/Alt}{/Shift}");
      expect(openInEditor).toHaveBeenCalledExactlyOnceWith("/repo", "vscode");
    } finally {
      await screen.unmount();
    }
  });

  it("swallows the shortcut inside a confirmation dialog", async () => {
    const screen = await renderPicker();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    const button = dialog.appendChild(document.createElement("button"));
    document.body.append(dialog);
    try {
      button.focus();
      const event = new KeyboardEvent("keydown", {
        key: "o",
        shiftKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      button.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(openInEditor).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
      await screen.unmount();
    }
  });

  it("still saves a choice when there is no folder to open", async () => {
    const screen = await renderPicker(null);
    try {
      await chooseEditor("VS Code");
      await expect.element(page.getByRole("button", { name: "Open in VS Code" })).toBeDisabled();
      expect(localStorage.getItem(LAST_EDITOR_KEY)).toBe('"vscode"');
      expect(openInEditor).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
