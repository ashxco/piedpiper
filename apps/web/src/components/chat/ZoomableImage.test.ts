import { describe, expect, it } from "vitest";

import {
  ZOOMABLE_IMAGE_MAX_ZOOM,
  clampImageZoom,
  computeImageFitScale,
  wheelZoomMultiplier,
  zoomableImageMaxHeight,
} from "./ZoomableImage";

describe("clampImageZoom", () => {
  it("keeps zoom between fit and the maximum", () => {
    expect(clampImageZoom(0.5)).toBe(1);
    expect(clampImageZoom(3)).toBe(3);
    expect(clampImageZoom(100)).toBe(ZOOMABLE_IMAGE_MAX_ZOOM);
    expect(clampImageZoom(Number.NaN)).toBe(1);
  });
});

describe("computeImageFitScale", () => {
  const windowSize = { width: 1000, height: 1000 };

  it("never upscales small images", () => {
    expect(computeImageFitScale({ width: 100, height: 100 }, windowSize)).toBe(1);
  });

  it("fits wide and tall images inside the window", () => {
    expect(computeImageFitScale({ width: 1840, height: 100 }, windowSize)).toBeCloseTo(0.5);
    expect(computeImageFitScale({ width: 100, height: 1720 }, windowSize)).toBeCloseTo(0.5);
  });

  it("leaves room for the caption on short windows", () => {
    expect(zoomableImageMaxHeight(1000)).toBe(860);
    expect(zoomableImageMaxHeight(300)).toBe(220);
    expect(zoomableImageMaxHeight(10)).toBe(1);
  });
});

describe("wheelZoomMultiplier", () => {
  it("zooms in when scrolling up and out when scrolling down", () => {
    const base = { deltaMode: 0, ctrlKey: false, pageHeight: 500 };
    expect(wheelZoomMultiplier({ ...base, deltaY: -100 })).toBeGreaterThan(1);
    expect(wheelZoomMultiplier({ ...base, deltaY: 100 })).toBeLessThan(1);
  });

  it("scales line and page deltas and speeds up pinch gestures", () => {
    const pixel = wheelZoomMultiplier({
      deltaY: -16,
      deltaMode: 0,
      ctrlKey: false,
      pageHeight: 500,
    });
    const line = wheelZoomMultiplier({ deltaY: -1, deltaMode: 1, ctrlKey: false, pageHeight: 500 });
    const page = wheelZoomMultiplier({ deltaY: -1, deltaMode: 2, ctrlKey: false, pageHeight: 16 });
    const pinch = wheelZoomMultiplier({
      deltaY: -16,
      deltaMode: 0,
      ctrlKey: true,
      pageHeight: 500,
    });
    expect(line).toBeCloseTo(pixel);
    expect(page).toBeCloseTo(pixel);
    expect(pinch).toBeGreaterThan(pixel);
  });
});
