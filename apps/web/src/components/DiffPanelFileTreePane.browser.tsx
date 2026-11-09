import "../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { DiffPanelFileTree } from "./DiffPanelFileTree";
import { DIFF_FILE_TREE_WIDTH_STORAGE_KEY, DiffPanelFileTreePane } from "./DiffPanelFileTreePane";

const separator = () => page.getByRole("separator", { name: "Resize file tree" });
const handleElement = () => separator().element() as HTMLElement;
const paneWidth = () => handleElement().parentElement!.style.width;
const storedWidth = () => localStorage.getItem(DIFF_FILE_TREE_WIDTH_STORAGE_KEY);

function firePointer(type: string, clientX: number, pointerId = 1) {
  handleElement().dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX,
      pointerId,
      pointerType: "mouse",
    }),
  );
}

describe("DiffPanelFileTreePane", () => {
  beforeEach(() => {
    localStorage.clear();
    // Synthetic drags have no active browser pointer to capture.
    vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "releasePointerCapture").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("starts at the default width and exposes its bounds", async () => {
    await render(<DiffPanelFileTreePane bodyWidth={1000}>tree</DiffPanelFileTreePane>);

    expect(paneWidth()).toBe("224px");
    await expect.element(separator()).toHaveAttribute("aria-valuenow", "224");
    await expect.element(separator()).toHaveAttribute("aria-valuemin", "160");
    await expect.element(separator()).toHaveAttribute("aria-valuemax", "560");
    expect(storedWidth()).toBeNull();
  });

  it("restores the saved width, clamping it at render without overwriting it", async () => {
    localStorage.setItem(DIFF_FILE_TREE_WIDTH_STORAGE_KEY, "500");
    const view = await render(<DiffPanelFileTreePane bodyWidth={640}>tree</DiffPanelFileTreePane>);

    expect(paneWidth()).toBe("384px");
    expect(storedWidth()).toBe("500");

    await view.rerender(<DiffPanelFileTreePane bodyWidth={1000}>tree</DiffPanelFileTreePane>);
    expect(paneWidth()).toBe("500px");
  });

  it("does not persist a stationary click", async () => {
    await render(<DiffPanelFileTreePane bodyWidth={1000}>tree</DiffPanelFileTreePane>);

    firePointer("pointerdown", 300);
    expect(document.body.style.cursor).toBe("col-resize");
    firePointer("pointerup", 300);

    expect(storedWidth()).toBeNull();
    expect(paneWidth()).toBe("224px");
    expect(document.body.style.cursor).toBe("");
  });

  it("writes CSS during a drag and persists once on release", async () => {
    await render(<DiffPanelFileTreePane bodyWidth={1000}>tree</DiffPanelFileTreePane>);

    firePointer("pointerdown", 300);
    firePointer("pointermove", 340);
    expect(paneWidth()).toBe("264px");
    expect(storedWidth()).toBeNull();
    expect(document.body.style.userSelect).toBe("none");

    firePointer("pointerup", 400);
    expect(storedWidth()).toBe("324");
    await expect.element(separator()).toHaveAttribute("aria-valuenow", "324");
    expect(paneWidth()).toBe("324px");
    expect(document.body.style.userSelect).toBe("");
  });

  it("clamps a drag to the min and max", async () => {
    await render(<DiffPanelFileTreePane bodyWidth={640}>tree</DiffPanelFileTreePane>);

    firePointer("pointerdown", 300);
    firePointer("pointermove", 0);
    expect(paneWidth()).toBe("160px");
    firePointer("pointermove", 900);
    expect(paneWidth()).toBe("384px");
    firePointer("pointerup", 900);
    expect(storedWidth()).toBe("384");
  });

  it("restores the start width when a drag returns to where it began", async () => {
    await render(<DiffPanelFileTreePane bodyWidth={1000}>tree</DiffPanelFileTreePane>);

    firePointer("pointerdown", 300);
    firePointer("pointermove", 340);
    firePointer("pointerup", 300);

    expect(storedWidth()).toBeNull();
    expect(paneWidth()).toBe("224px");
  });

  it("puts the width of the current render back when the bounds shrank during a still press", async () => {
    localStorage.setItem(DIFF_FILE_TREE_WIDTH_STORAGE_KEY, "500");
    const view = await render(<DiffPanelFileTreePane bodyWidth={1000}>tree</DiffPanelFileTreePane>);

    firePointer("pointerdown", 300);
    await view.rerender(<DiffPanelFileTreePane bodyWidth={640}>tree</DiffPanelFileTreePane>);
    window.dispatchEvent(new Event("blur"));

    expect(paneWidth()).toBe("384px");
    expect(storedWidth()).toBe("500");
  });

  it("narrows a tree whose rows have long names", async () => {
    localStorage.setItem(DIFF_FILE_TREE_WIDTH_STORAGE_KEY, "160");
    const path = `${"long-file-name-".repeat(8)}.ts`;
    await render(
      <DiffPanelFileTreePane bodyWidth={1000}>
        <DiffPanelFileTree
          entries={[{ path, status: "modified", additions: 1, deletions: 1 }]}
          activeFilePath={null}
          resolvedTheme="light"
          onSelectFile={() => undefined}
        />
      </DiffPanelFileTreePane>,
    );

    const pane = handleElement().parentElement!;
    const tree = pane.firstElementChild!;
    expect(pane.getBoundingClientRect().width).toBe(160);
    expect(tree.getBoundingClientRect().width).toBeLessThanOrEqual(160);
  });

  it("ends the drag on blur, ignoring later moves and a second pointerdown mid-drag", async () => {
    await render(<DiffPanelFileTreePane bodyWidth={1000}>tree</DiffPanelFileTreePane>);

    firePointer("pointerdown", 300);
    firePointer("pointerdown", 500);
    firePointer("pointermove", 320);
    window.dispatchEvent(new Event("blur"));
    expect(storedWidth()).toBe("244");
    expect(document.body.style.cursor).toBe("");

    firePointer("pointermove", 400);
    expect(paneWidth()).toBe("244px");
  });

  it("commits once when capture is lost", async () => {
    await render(<DiffPanelFileTreePane bodyWidth={1000}>tree</DiffPanelFileTreePane>);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    firePointer("pointerdown", 300);
    firePointer("pointermove", 320);
    firePointer("lostpointercapture", 320);
    firePointer("lostpointercapture", 320);

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(document.body.style.cursor).toBe("");
  });

  it("leaves nothing behind when capture throws", async () => {
    vi.mocked(HTMLElement.prototype.setPointerCapture).mockImplementation(() => {
      throw new DOMException("No active pointer", "NotFoundError");
    });
    await render(<DiffPanelFileTreePane bodyWidth={1000}>tree</DiffPanelFileTreePane>);

    firePointer("pointerdown", 300);
    firePointer("pointermove", 340);
    window.dispatchEvent(new Event("blur"));

    expect(document.body.style.cursor).toBe("");
    expect(paneWidth()).toBe("224px");
    expect(storedWidth()).toBeNull();
  });

  it("clears the body styles when unmounted mid-drag", async () => {
    const view = await render(<DiffPanelFileTreePane bodyWidth={1000}>tree</DiffPanelFileTreePane>);

    firePointer("pointerdown", 300);
    expect(document.body.style.cursor).toBe("col-resize");
    await view.unmount();

    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(storedWidth()).toBeNull();
  });

  it("resizes with the arrow keys, Home and End", async () => {
    await render(<DiffPanelFileTreePane bodyWidth={1000}>tree</DiffPanelFileTreePane>);
    handleElement().focus();

    await userEvent.keyboard("{ArrowRight}");
    await expect.element(separator()).toHaveAttribute("aria-valuenow", "240");
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    await expect.element(separator()).toHaveAttribute("aria-valuenow", "208");
    await userEvent.keyboard("{End}");
    await expect.element(separator()).toHaveAttribute("aria-valuenow", "560");
    await userEvent.keyboard("{Home}");
    await expect.element(separator()).toHaveAttribute("aria-valuenow", "160");
    expect(storedWidth()).toBe("160");
  });

  it("keeps a wider saved width when a key has nowhere to go", async () => {
    localStorage.setItem(DIFF_FILE_TREE_WIDTH_STORAGE_KEY, "500");
    await render(<DiffPanelFileTreePane bodyWidth={640}>tree</DiffPanelFileTreePane>);
    handleElement().focus();

    await userEvent.keyboard("{End}");
    expect(storedWidth()).toBe("500");
    await expect.element(separator()).toHaveAttribute("aria-valuenow", "384");
  });
});
