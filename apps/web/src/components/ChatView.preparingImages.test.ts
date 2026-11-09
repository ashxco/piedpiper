import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addPreparingComposerImages,
  canThumbnailPreparingImage,
  countPreparingComposerImages,
  createPreparingComposerImage,
  keepStillPreparingImages,
  MAX_PREPARING_IMAGE_THUMBNAIL_BYTES,
  readPreparingComposerImages,
  removePreparingComposerImages,
} from "./ChatView.preparingImages";

const THREAD = "thread-a";
const OTHER_THREAD = "thread-b";

describe("preparing composer images", () => {
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: (file: File) => `blob:${file.name}`,
      revokeObjectURL,
    });
  });

  afterEach(() => {
    removePreparingComposerImages(
      THREAD,
      new Set(readPreparingComposerImages(THREAD).map((image) => image.id)),
    );
    removePreparingComposerImages(
      OTHER_THREAD,
      new Set(readPreparingComposerImages(OTHER_THREAD).map((image) => image.id)),
    );
    revokeObjectURL.mockClear();
    vi.unstubAllGlobals();
  });

  it("keeps the count per thread", () => {
    addPreparingComposerImages(THREAD, [{ id: "a", name: "a.png", previewUrl: null }]);
    addPreparingComposerImages(THREAD, [{ id: "b", name: "b.png", previewUrl: null }]);
    addPreparingComposerImages(OTHER_THREAD, [{ id: "c", name: "c.png", previewUrl: null }]);
    expect(countPreparingComposerImages(THREAD)).toBe(2);
    expect(countPreparingComposerImages(OTHER_THREAD)).toBe(1);
    expect(countPreparingComposerImages("missing")).toBe(0);
  });

  it("reports only the ids still preparing, so a cancelled tile is told apart", () => {
    addPreparingComposerImages(THREAD, [
      { id: "a", name: "a.png", previewUrl: null },
      { id: "b", name: "b.png", previewUrl: null },
    ]);
    expect(removePreparingComposerImages(THREAD, new Set(["a"]))).toEqual(new Set(["a"]));
    expect(removePreparingComposerImages(THREAD, new Set(["a", "b"]))).toEqual(new Set(["b"]));
    expect(removePreparingComposerImages(THREAD, new Set(["a", "b"]))).toEqual(new Set());
    expect(countPreparingComposerImages(THREAD)).toBe(0);
  });

  it("revokes a preview once, when its tile goes", () => {
    addPreparingComposerImages(THREAD, [
      createPreparingComposerImage("a", new File(["x"], "a.png", { type: "image/png" })),
      { id: "b", name: "b.heic", previewUrl: null },
    ]);
    removePreparingComposerImages(THREAD, new Set(["a", "b"]));
    removePreparingComposerImages(THREAD, new Set(["a", "b"]));
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:a.png");
  });

  it("falls back to the name for HEIC and oversized sources, and names unnamed pastes", () => {
    const heic = createPreparingComposerImage(
      "h",
      new File(["x"], "p.heic", { type: "image/heic" }),
    );
    expect(heic).toEqual({ id: "h", name: "p.heic", previewUrl: null });
    expect(createPreparingComposerImage("n", new File(["x"], "", { type: "image/png" })).name).toBe(
      "image",
    );
    const png = { name: "a.png", type: "image/png" };
    expect(canThumbnailPreparingImage({ ...png, size: MAX_PREPARING_IMAGE_THUMBNAIL_BYTES })).toBe(
      true,
    );
    expect(
      canThumbnailPreparingImage({ ...png, size: MAX_PREPARING_IMAGE_THUMBNAIL_BYTES + 1 }),
    ).toBe(false);
  });

  it("drops fitted results whose tile was removed", () => {
    const batch = [{ id: "a" }, { id: "b" }];
    expect(keepStillPreparingImages(batch, new Set(["b"]))).toEqual([{ id: "b" }]);
    expect(keepStillPreparingImages(batch, new Set())).toEqual([]);
  });
});
