import "../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";

import {
  ExpandedImageDialog,
  stepExpandedImagePreview,
  useExpandedImageStore,
} from "./ChatView.expandedImage";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PREVIEW = {
  images: [
    { src: PIXEL, name: "one.png" },
    { src: PIXEL, name: "two.png" },
  ],
  index: 0,
};

describe("stepExpandedImagePreview", () => {
  it("wraps around and leaves single images alone", () => {
    expect(stepExpandedImagePreview(PREVIEW, -1)?.index).toBe(1);
    expect(stepExpandedImagePreview({ ...PREVIEW, index: 1 }, 1)?.index).toBe(0);
    const single = { images: [PREVIEW.images[0]!], index: 0 };
    expect(stepExpandedImagePreview(single, 1)).toBe(single);
    expect(stepExpandedImagePreview(null, 1)).toBeNull();
  });
});

const pointOf = (testId: string) => {
  const rect = document.querySelector(`[data-testid='${testId}']`)!.getBoundingClientRect();
  return document.elementFromPoint(rect.left + 4, rect.top + 4);
};

describe("ExpandedImageDialog", () => {
  afterEach(() => {
    useExpandedImageStore.getState().close();
  });

  it("steps with arrow keys and closes on Escape, consuming the keys", async () => {
    const screen = await render(
      <div>
        <textarea aria-label="Composer" />
        <ExpandedImageDialog />
      </div>,
    );
    await screen.getByRole("textbox", { name: "Composer" }).click();
    useExpandedImageStore.getState().open(PREVIEW);

    await expect.element(screen.getByText("one.png (1/2)")).toBeInTheDocument();
    const seenKeys: Array<[string, boolean]> = [];
    const recordKey = (event: KeyboardEvent) => seenKeys.push([event.key, event.defaultPrevented]);
    window.addEventListener("keydown", recordKey);
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(screen.getByText("two.png (2/2)")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(useExpandedImageStore.getState().preview).toBeNull();
    window.removeEventListener("keydown", recordKey);
    expect(seenKeys).toEqual([
      ["ArrowRight", true],
      ["Escape", true],
    ]);
  });

  it("covers the sidebar toggle but stays under the connection banner", async () => {
    const screen = await render(
      <>
        <button
          type="button"
          data-testid="toggle"
          className="fixed top-2 left-2 z-50 size-7"
          aria-label="toggle"
        />
        <ExpandedImageDialog />
        <div data-testid="banner" className="fixed top-2 left-40 z-[60] size-7" />
      </>,
    );
    useExpandedImageStore.getState().open(PREVIEW);
    try {
      await expect
        .poll(() => document.querySelector("[aria-label='Expanded image preview']"))
        .toBeTruthy();
      expect(pointOf("toggle")?.getAttribute("data-testid")).not.toBe("toggle");
      expect(pointOf("banner")?.getAttribute("data-testid")).toBe("banner");
    } finally {
      await screen.unmount();
    }
  });

  it("drops the preview when the dialog host unmounts", async () => {
    const screen = await render(<ExpandedImageDialog />);
    useExpandedImageStore.getState().open(PREVIEW);
    await expect.element(screen.getByText("one.png (1/2)")).toBeInTheDocument();
    await screen.unmount();
    expect(useExpandedImageStore.getState().preview).toBeNull();
  });

  it("returns focus to the opener when closed with the close button", async () => {
    const screen = await render(
      <div>
        <textarea aria-label="Composer" />
        <ExpandedImageDialog />
      </div>,
    );
    const composer = screen.getByRole("textbox", { name: "Composer" });
    await composer.click();
    useExpandedImageStore.getState().open(PREVIEW);

    await screen.getByRole("button", { name: "Close image preview" }).last().click();
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(composer).toHaveFocus();
  });

  it("pans a zoomed image with arrow keys and steps images again once fit", async () => {
    const svg = encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='300'><rect width='400' height='300' fill='red'/></svg>",
    );
    const src = `data:image/svg+xml,${svg}`;
    const screen = await render(<ExpandedImageDialog />);
    useExpandedImageStore.getState().open({
      images: [
        { src, name: "one.svg" },
        { src, name: "two.svg" },
      ],
      index: 0,
    });

    const region = screen.getByRole("region", { name: "one.svg, zoomable image" });
    await expect.element(region).toBeInTheDocument();
    (region.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByText("200% zoom")).toBeInTheDocument();
    await userEvent.keyboard("{ArrowRight}");
    expect(useExpandedImageStore.getState().preview?.index).toBe(0);
    expect((region.element() as HTMLElement).scrollLeft).toBeGreaterThan(0);

    await userEvent.keyboard("0");
    await expect.element(screen.getByText("100% zoom")).toBeInTheDocument();
    const fitted = region.element() as HTMLElement;
    expect(fitted.scrollWidth).toBeLessThanOrEqual(fitted.clientWidth);
    expect(fitted.scrollHeight).toBeLessThanOrEqual(fitted.clientHeight);
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(screen.getByText("two.svg (2/2)")).toBeInTheDocument();
    await expect.element(screen.getByText("100% zoom")).toBeInTheDocument();
  });

  it("steps images with arrow keys when a zoomed image still fits the window", async () => {
    const svg = encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='30'><rect width='40' height='30' fill='red'/></svg>",
    );
    const src = `data:image/svg+xml,${svg}`;
    const screen = await render(<ExpandedImageDialog />);
    useExpandedImageStore.getState().open({
      images: [
        { src, name: "small-one.svg" },
        { src, name: "small-two.svg" },
      ],
      index: 0,
    });

    const region = screen.getByRole("region", { name: "small-one.svg, zoomable image" });
    await expect.element(region).toBeInTheDocument();
    (region.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByText("200% zoom")).toBeInTheDocument();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(screen.getByText("small-two.svg (2/2)")).toBeInTheDocument();
  });
});
