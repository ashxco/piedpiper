import { assert, describe, it } from "vitest";
import {
  buildVisibleToastLayout,
  resolveCopyableToastErrorText,
  shouldHideCollapsedToastContent,
} from "./toast.logic";

describe("shouldHideCollapsedToastContent", () => {
  it("keeps a single visible toast readable", () => {
    assert.equal(shouldHideCollapsedToastContent(0, 1), false);
  });

  it("keeps the front-most toast readable in a visible stack", () => {
    assert.equal(shouldHideCollapsedToastContent(0, 3), false);
  });

  it("hides non-front toasts until the stack is expanded", () => {
    assert.equal(shouldHideCollapsedToastContent(1, 3), true);
  });
});

describe("resolveCopyableToastErrorText", () => {
  it("offers the description of an error toast", () => {
    assert.equal(resolveCopyableToastErrorText({ type: "error", description: "Boom" }), "Boom");
  });

  it("hides the button when the toast opts out", () => {
    assert.equal(
      resolveCopyableToastErrorText({
        type: "error",
        description: "Thread title",
        data: { hideCopyButton: true },
      }),
      null,
    );
  });

  it("offers nothing for other toast types", () => {
    assert.equal(resolveCopyableToastErrorText({ type: "warning", description: "Boom" }), null);
  });

  it("offers nothing when the description is not text", () => {
    assert.equal(resolveCopyableToastErrorText({ type: "error", description: { a: 1 } }), null);
    assert.equal(resolveCopyableToastErrorText({ type: "error" }), null);
  });
});

describe("buildVisibleToastLayout", () => {
  it("computes indices and offsets from the visible subset", () => {
    const visibleToasts = [
      { id: "a", height: 48 },
      { id: "b", height: 72 },
      { id: "c", height: 24 },
    ];

    const layout = buildVisibleToastLayout(visibleToasts);

    assert.equal(layout.frontmostHeight, 48);
    assert.deepEqual(
      layout.items.map(({ toast, visibleIndex, offsetY }) => ({
        id: toast.id,
        visibleIndex,
        offsetY,
      })),
      [
        { id: "a", visibleIndex: 0, offsetY: 0 },
        { id: "b", visibleIndex: 1, offsetY: 48 },
        { id: "c", visibleIndex: 2, offsetY: 120 },
      ],
    );
  });

  it("treats missing heights as zero", () => {
    const layout = buildVisibleToastLayout([
      { id: "a" },
      { id: "b", height: undefined },
      { id: "c", height: 30 },
    ]);

    assert.equal(layout.frontmostHeight, 0);
    assert.deepEqual(
      layout.items.map(({ toast, offsetY }) => ({
        id: toast.id,
        offsetY,
      })),
      [
        { id: "a", offsetY: 0 },
        { id: "b", offsetY: 0 },
        { id: "c", offsetY: 0 },
      ],
    );
  });
});
