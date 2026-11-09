import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { Suspense } from "react";

import { useExpandedImageStore } from "../ChatView.expandedImage";
import { MermaidDiagram } from "./MermaidDiagram";

const SOURCE = "flowchart LR\n  A[Start] --> B[Done]";

async function renderDiagram(source = SOURCE) {
  const screen = await render(
    <Suspense fallback={<p>loading</p>}>
      <MermaidDiagram source={source} fallback={<pre data-testid="fallback">{source}</pre>} />
    </Suspense>,
  );
  return screen;
}

const EXPAND_SELECTOR = '[role="button"][aria-label="Expand flowchart diagram"]';

async function waitForExpandButton(container: Element): Promise<HTMLElement> {
  await vi.waitFor(() => {
    expect(container.querySelector(`${EXPAND_SELECTOR} svg`)).toBeTruthy();
  });
  return container.querySelector(EXPAND_SELECTOR) as HTMLElement;
}

function openedSrc(): string {
  const src = useExpandedImageStore.getState().preview?.images[0]?.src;
  if (!src) throw new Error("No preview is open.");
  return src;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("The diagram image failed to load.")));
    image.src = src;
  });
}

describe("MermaidDiagram expand", () => {
  afterEach(() => {
    useExpandedImageStore.getState().close();
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("opens the diagram as a blob image with a real natural size", async () => {
    const { container, unmount } = await renderDiagram();
    try {
      await userEvent.click(await waitForExpandButton(container));

      const src = openedSrc();
      expect(src.startsWith("blob:")).toBe(true);
      const image = await loadImage(src);
      expect(image.naturalWidth).toBeGreaterThan(0);
      expect(image.naturalHeight).toBeGreaterThan(0);
    } finally {
      await unmount();
    }
  });

  it("inlines resolved theme colors, since an image cannot inherit them", async () => {
    const { container, unmount } = await renderDiagram();
    try {
      await userEvent.click(await waitForExpandButton(container));

      const markup = await (await fetch(openedSrc())).text();
      const style = new DOMParser()
        .parseFromString(markup, "image/svg+xml")
        .documentElement.getAttribute("style");
      expect(style).toMatch(/--pele-fg:\s*(?!var\()\S/);
      expect(style).toMatch(/--pele-bg:\s*(?!var\()\S/);
      expect(style).not.toContain("var(--foreground)");
      expect(style).not.toContain("var(--contrast-foreground)");
    } finally {
      await unmount();
    }
  });

  it("keeps the copy attributes on the outer wrapper", async () => {
    const { container, unmount } = await renderDiagram();
    try {
      const button = await waitForExpandButton(container);
      const wrapper = button.parentElement as HTMLElement;
      expect(wrapper.classList.contains("chat-markdown-mermaid")).toBe(true);
      expect(wrapper.getAttribute("data-markdown-copy")).toContain("```mermaid");
      expect(wrapper.getAttribute("data-markdown-diagram-source")).toBe(SOURCE);
      expect(button.hasAttribute("data-markdown-copy")).toBe(false);
    } finally {
      await unmount();
    }
  });

  it("lets a mouse drag select label text without opening the preview", async () => {
    const { container, unmount } = await renderDiagram();
    try {
      const button = await waitForExpandButton(container);
      const labels = button.querySelectorAll("text");
      await userEvent.dragAndDrop(labels[0] as SVGTextElement, labels[1] as SVGTextElement);

      expect(window.getSelection()?.toString()).toContain("Do");
      expect(useExpandedImageStore.getState().preview).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("ignores a click that ends a selection inside it, unless it is not from a pointer", async () => {
    const { container, unmount } = await renderDiagram();
    try {
      const button = await waitForExpandButton(container);
      window.getSelection()?.selectAllChildren(button.querySelector("text") as SVGTextElement);
      expect(window.getSelection()?.isCollapsed).toBe(false);

      button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      expect(useExpandedImageStore.getState().preview).toBeNull();

      button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
      expect(useExpandedImageStore.getState().preview).not.toBeNull();
    } finally {
      await unmount();
    }
  });

  it("opens on click while text outside the diagram stays selected", async () => {
    const outside = document.createElement("p");
    outside.textContent = "Selected chat text";
    document.body.append(outside);
    const { container, unmount } = await renderDiagram();
    try {
      const button = await waitForExpandButton(container);
      window.getSelection()?.selectAllChildren(outside);

      button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

      expect(window.getSelection()?.isCollapsed).toBe(false);
      expect(useExpandedImageStore.getState().preview).not.toBeNull();
    } finally {
      await unmount();
    }
  });

  it.each(["{Enter}", " "])("opens from the keyboard with %j", async (key) => {
    const { container, unmount } = await renderDiagram();
    try {
      const button = await waitForExpandButton(container);
      await vi.waitFor(() => expect(button.tabIndex).toBe(0));
      button.focus();

      await userEvent.keyboard(key);

      expect(useExpandedImageStore.getState().preview).not.toBeNull();
    } finally {
      await unmount();
    }
  });

  it("names the diagram type in the preview", async () => {
    const { container, unmount } = await renderDiagram();
    try {
      await userEvent.click(await waitForExpandButton(container));

      expect(useExpandedImageStore.getState().preview?.images[0]?.name).toBe(
        "Mermaid flowchart diagram",
      );
    } finally {
      await unmount();
    }
  });

  it("revokes the previous blob URL when another diagram opens", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const { container, unmount } = await renderDiagram();
    try {
      const button = await waitForExpandButton(container);
      await userEvent.click(button);
      const first = openedSrc();

      button.click();

      expect(revoke).toHaveBeenCalledWith(first);
      expect(openedSrc()).not.toBe(first);
    } finally {
      await unmount();
    }
  });

  it("has no expand button when the fallback shows", async () => {
    const { container, unmount } = await renderDiagram("not a diagram at all");
    try {
      await expect.element(page.getByTestId("fallback")).toBeInTheDocument();
      expect(container.querySelector('[role="button"]')).toBeNull();
    } finally {
      await unmount();
    }
  });
});
