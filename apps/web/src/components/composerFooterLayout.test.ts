import { describe, expect, it } from "vitest";

import {
  COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX,
  resolveComposerFooterBlockStates,
  resolveComposerFooterContentWidth,
  resolveComposerFooterControlsLayout,
  shouldUseCompactComposerPrimaryActions,
} from "./composerFooterLayout";

describe("shouldUseCompactComposerPrimaryActions", () => {
  it("compacts wide action states below the breakpoint", () => {
    expect(
      shouldUseCompactComposerPrimaryActions(COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX - 1, {
        hasWideActions: true,
      }),
    ).toBe(true);
    expect(
      shouldUseCompactComposerPrimaryActions(COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX, {
        hasWideActions: true,
      }),
    ).toBe(false);
  });

  it("never compacts ordinary actions or an unmeasured composer", () => {
    expect(shouldUseCompactComposerPrimaryActions(200)).toBe(false);
    expect(shouldUseCompactComposerPrimaryActions(null, { hasWideActions: true })).toBe(false);
  });
});

describe("resolveComposerFooterControlsLayout", () => {
  const measurement = {
    fixedWidth: 140,
    gap: 4,
    blockWidths: [80, 140],
    iconOnlyBlockWidths: [40, 60],
    overflowWidth: 24,
  };

  it("removes trailing labels before moving controls into the menu", () => {
    for (const [availableWidth, iconOnlyCount, hiddenCount] of [
      [368, 0, 0],
      [367, 1, 0],
      [288, 1, 0],
      [287, 2, 0],
      [248, 2, 0],
      [247, 2, 1],
      [212, 2, 1],
      [211, 2, 2],
      [0, 2, 2],
    ] as const) {
      expect(resolveComposerFooterControlsLayout({ ...measurement, availableWidth })).toEqual({
        iconOnlyCount,
        hiddenCount,
      });
    }
  });

  it("demotes immediately but restores only with a pixel of slack", () => {
    for (const [availableWidth, previous, promoted] of [
      [368, { iconOnlyCount: 1, hiddenCount: 0 }, { iconOnlyCount: 0, hiddenCount: 0 }],
      [288, { iconOnlyCount: 2, hiddenCount: 0 }, { iconOnlyCount: 1, hiddenCount: 0 }],
      [248, { iconOnlyCount: 2, hiddenCount: 1 }, { iconOnlyCount: 2, hiddenCount: 0 }],
    ] as const) {
      expect(
        resolveComposerFooterControlsLayout({ ...measurement, availableWidth, previous }),
      ).toEqual(previous);
      expect(
        resolveComposerFooterControlsLayout({
          ...measurement,
          availableWidth: availableWidth + 1,
          previous,
        }),
      ).toEqual(promoted);
    }
    expect(
      resolveComposerFooterControlsLayout({
        ...measurement,
        availableWidth: 367,
        previous: { iconOnlyCount: 0, hiddenCount: 0 },
      }),
    ).toEqual({ iconOnlyCount: 1, hiddenCount: 0 });
  });

  it("settles when label widths jitter by a fraction of a pixel at each threshold", () => {
    for (const availableWidth of [368, 288, 248, 212]) {
      let previous = resolveComposerFooterControlsLayout({ ...measurement, availableWidth });
      for (let render = 0; render < 10; render += 1) {
        const next = resolveComposerFooterControlsLayout({
          ...measurement,
          availableWidth,
          previous,
          fixedWidth: 140 + (render % 2) * 0.5,
        });
        if (render > 1) expect(next).toEqual(previous);
        previous = next;
      }
    }
  });

  it("clamps a previous layout when the block list shrinks", () => {
    expect(
      resolveComposerFooterControlsLayout({
        ...measurement,
        availableWidth: 1000,
        previous: { iconOnlyCount: 4, hiddenCount: 4 },
      }),
    ).toEqual({ iconOnlyCount: 0, hiddenCount: 0 });
  });

  it("handles an empty block list", () => {
    expect(
      resolveComposerFooterControlsLayout({
        ...measurement,
        blockWidths: [],
        iconOnlyBlockWidths: [],
        availableWidth: 10,
      }),
    ).toEqual({ iconOnlyCount: 0, hiddenCount: 0 });
  });
});

describe("resolveComposerFooterBlockStates", () => {
  const blocks = ["traits", "mode", "access", "plan"] as const;

  it("takes hidden and icon-only blocks from the end", () => {
    expect(resolveComposerFooterBlockStates(blocks, { iconOnlyCount: 0, hiddenCount: 0 })).toEqual({
      hidden: [],
      iconOnly: [],
    });
    expect(resolveComposerFooterBlockStates(blocks, { iconOnlyCount: 2, hiddenCount: 0 })).toEqual({
      hidden: [],
      iconOnly: ["access", "plan"],
    });
    expect(resolveComposerFooterBlockStates(blocks, { iconOnlyCount: 4, hiddenCount: 1 })).toEqual({
      hidden: ["plan"],
      iconOnly: blocks,
    });
  });
});

describe("resolveComposerFooterContentWidth", () => {
  it("subtracts horizontal padding from the measured footer width", () => {
    expect(
      resolveComposerFooterContentWidth({
        footerWidth: 500,
        paddingLeft: 10,
        paddingRight: 10,
      }),
    ).toBe(480);
  });

  it("clamps negative widths to zero", () => {
    expect(
      resolveComposerFooterContentWidth({
        footerWidth: 10,
        paddingLeft: 8,
        paddingRight: 8,
      }),
    ).toBe(0);
  });

  it("returns null when measurements are incomplete", () => {
    expect(
      resolveComposerFooterContentWidth({
        footerWidth: null,
        paddingLeft: 8,
        paddingRight: 8,
      }),
    ).toBeNull();
  });
});
