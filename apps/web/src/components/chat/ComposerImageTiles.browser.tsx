import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import {
  addPreparingComposerImages,
  countPreparingComposerImages,
  readPreparingComposerImages,
  removePreparingComposerImages,
} from "../ChatView.preparingImages";
import { ComposerImageTiles } from "./ComposerImageTiles";

const THREAD = "tiles-thread";
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==";

function readyImage(id: string, name: string, previewUrl = PIXEL): ComposerImageAttachment {
  return {
    type: "image",
    id,
    name,
    mimeType: "image/png",
    sizeBytes: 1,
    previewUrl,
    file: new File(["x"], name, { type: "image/png" }),
  };
}

function tilesProps(overrides: Partial<Parameters<typeof ComposerImageTiles>[0]> = {}) {
  return {
    threadId: THREAD,
    images: [],
    preparingImages: [],
    nonPersistedImageIds: new Set<string>(),
    onRemoveImage: vi.fn(),
    onExpandImage: vi.fn(),
    ...overrides,
  };
}

describe("ComposerImageTiles", () => {
  afterEach(() => {
    removePreparingComposerImages(
      THREAD,
      new Set(readPreparingComposerImages(THREAD).map((image) => image.id)),
    );
    document.body.innerHTML = "";
  });

  it("renders nothing without images", async () => {
    const screen = await render(<ComposerImageTiles {...tilesProps()} />);
    try {
      expect(screen.container.textContent).toBe("");
      expect(screen.container.querySelector("div.flex")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the same thumbnail and remove button when a fit ends", async () => {
    const preparing = { id: "shot", name: "shot.png", previewUrl: `${PIXEL}#source` };
    const props = tilesProps();
    const screen = await render(<ComposerImageTiles {...props} preparingImages={[preparing]} />);
    try {
      const tile = page.getByRole("status", { name: "Preparing shot.png" }).element();
      const img = tile.querySelector("img") as HTMLImageElement;
      const remove = page.getByRole("button", { name: "Remove shot.png" }).element() as HTMLElement;
      remove.focus();

      await screen.rerender(
        <ComposerImageTiles
          {...props}
          images={[readyImage("shot", "shot.png", `${PIXEL}#fitted`)]}
          preparingImages={[]}
        />,
      );

      expect(document.querySelector("[role=status]")).toBeNull();
      expect(document.querySelector("img")).toBe(img);
      expect(img.isConnected).toBe(true);
      expect(img.getAttribute("src")).toBe(`${PIXEL}#fitted`);
      expect(page.getByRole("button", { name: "Remove shot.png" }).element()).toBe(remove);
      expect(document.activeElement).toBe(remove);
      await expect.element(page.getByRole("button", { name: "Preview shot.png" })).toBeEnabled();
    } finally {
      await screen.unmount();
    }
  });

  it("lists ready images first and marks only preparing ones as busy", async () => {
    const screen = await render(
      <ComposerImageTiles
        {...tilesProps()}
        images={[readyImage("a", "a.png")]}
        preparingImages={[{ id: "b", name: "b.png", previewUrl: PIXEL }]}
      />,
    );
    try {
      const names = Array.from(document.querySelectorAll("img")).map((img) => img.alt);
      expect(names).toEqual(["a.png", "b.png"]);
      expect(document.querySelector('[aria-label="Preparing a.png"]')).toBeNull();
      const preparingTile = page.getByRole("status", { name: "Preparing b.png" }).element();
      expect(preparingTile.querySelector("img")?.className).toContain("opacity-60");
      expect(document.querySelector("img")?.className).not.toContain("opacity-60");
    } finally {
      await screen.unmount();
    }
  });

  it("shows the name when there is no thumbnail and removes a preparing tile from the store", async () => {
    const image = { id: "heic", name: "photo.heic", previewUrl: null };
    addPreparingComposerImages(THREAD, [image]);
    const props = tilesProps();
    const screen = await render(<ComposerImageTiles {...props} preparingImages={[image]} />);
    try {
      await expect
        .element(page.getByRole("status", { name: "Preparing photo.heic" }))
        .toBeVisible();
      await expect.element(page.getByText("photo.heic")).toBeVisible();
      await page.getByRole("button", { name: "Remove photo.heic" }).click();
      expect(countPreparingComposerImages(THREAD)).toBe(0);
      expect(props.onRemoveImage).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("only previews and removes a ready image through the composer's handlers", async () => {
    const props = tilesProps();
    const image = readyImage("a", "a.png");
    const screen = await render(<ComposerImageTiles {...props} images={[image]} />);
    try {
      await page.getByRole("button", { name: "Preview a.png" }).click();
      expect(props.onExpandImage).toHaveBeenCalledWith({
        images: [{ src: PIXEL, name: "a.png" }],
        index: 0,
      });
      await page.getByRole("button", { name: "Remove a.png" }).click();
      expect(props.onRemoveImage).toHaveBeenCalledWith("a");
    } finally {
      await screen.unmount();
    }
  });

  it("does not offer a preview of a preparing image", async () => {
    const props = tilesProps();
    const screen = await render(
      <ComposerImageTiles
        {...props}
        preparingImages={[{ id: "b", name: "b.png", previewUrl: PIXEL }]}
      />,
    );
    try {
      const preview = document.querySelector<HTMLButtonElement>("[role=status] button:disabled");
      expect(preview?.querySelector("img")).not.toBeNull();
      preview?.click();
      expect(props.onExpandImage).not.toHaveBeenCalled();
      expect(document.querySelector('[aria-label="Preview b.png"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("warns about an unsaved draft image only once it is ready", async () => {
    const props = tilesProps({ nonPersistedImageIds: new Set(["a", "b"]) });
    const screen = await render(
      <ComposerImageTiles
        {...props}
        images={[readyImage("a", "a.png")]}
        preparingImages={[{ id: "b", name: "b.png", previewUrl: PIXEL }]}
      />,
    );
    try {
      expect(
        document.querySelectorAll('[aria-label="Draft attachment may not persist"]'),
      ).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });
});
