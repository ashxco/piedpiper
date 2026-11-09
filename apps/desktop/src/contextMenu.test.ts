import { describe, expect, it, vi } from "vitest";

import {
  buildEditContextMenuTemplate,
  type EditContextMenuParams,
  resolveContextMenuPopupPosition,
} from "./contextMenu";

const params: EditContextMenuParams = {
  misspelledWord: "",
  dictionarySuggestions: [],
  mediaType: "none",
  x: 12,
  y: 34,
  editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
};

const makeActions = (safeLinkUrl: string | null = null) => ({
  safeLinkUrl,
  replaceMisspelling: vi.fn(),
  copyText: vi.fn(),
  copyImageAt: vi.fn(),
});

describe("buildEditContextMenuTemplate", () => {
  it("shows only the edit roles for plain content", () => {
    const template = buildEditContextMenuTemplate(params, makeActions());
    expect(template.map((item) => item.role)).toEqual(["cut", "copy", "paste", "selectAll"]);
  });

  it("adds Copy Link for a safe link and copies its URL", () => {
    const actions = makeActions("https://example.com/a");
    const template = buildEditContextMenuTemplate(params, actions);
    expect(template[0]?.label).toBe("Copy Link");
    expect(template[1]?.type).toBe("separator");
    template[0]?.click?.({} as never, undefined, {} as never);
    expect(actions.copyText).toHaveBeenCalledWith("https://example.com/a");
  });

  it("adds Copy Image for images and copies at the click position", () => {
    const actions = makeActions();
    const template = buildEditContextMenuTemplate({ ...params, mediaType: "image" }, actions);
    expect(template.map((item) => item.label ?? item.type ?? item.role).slice(0, 2)).toEqual([
      "Copy Image",
      "separator",
    ]);
    template[0]?.click?.({} as never, undefined, {} as never);
    expect(actions.copyImageAt).toHaveBeenCalledWith(12, 34);
  });

  it("keeps spelling suggestions first", () => {
    const actions = makeActions("https://example.com");
    const template = buildEditContextMenuTemplate(
      { ...params, misspelledWord: "teh", dictionarySuggestions: ["the"] },
      actions,
    );
    expect(template.slice(0, 4).map((item) => item.label ?? item.type)).toEqual([
      "the",
      "separator",
      "Copy Link",
      "separator",
    ]);
  });
});

describe("resolveContextMenuPopupPosition", () => {
  it("scales CSS pixels by the zoom factor before flooring", () => {
    expect(resolveContextMenuPopupPosition({ x: 10.8, y: 20.2 }, 2)).toEqual({ x: 21, y: 40 });
    expect(resolveContextMenuPopupPosition({ x: 100, y: 50 }, 0.5)).toEqual({ x: 50, y: 25 });
  });

  it("falls back to an unscaled position for an invalid zoom factor", () => {
    expect(resolveContextMenuPopupPosition({ x: 10.8, y: 20.2 }, Number.NaN)).toEqual({
      x: 10,
      y: 20,
    });
    expect(resolveContextMenuPopupPosition({ x: 3, y: 4 }, 0)).toEqual({ x: 3, y: 4 });
  });

  it("returns null for missing, negative or non-finite positions", () => {
    expect(resolveContextMenuPopupPosition(undefined, 1)).toBeNull();
    expect(resolveContextMenuPopupPosition({ x: -1, y: 4 }, 1)).toBeNull();
    expect(resolveContextMenuPopupPosition({ x: Number.POSITIVE_INFINITY, y: 4 }, 1)).toBeNull();
  });
});
