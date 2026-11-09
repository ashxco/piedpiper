import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forwardWheelToTimeline } from "./timelineMinimapWheel";

const timelines: HTMLElement[] = [];

function mountTimeline(): HTMLDivElement {
  const timeline = document.createElement("div");
  timeline.style.cssText = "height: 200px; overflow-y: auto;";
  const content = document.createElement("div");
  content.style.height = "2000px";
  timeline.append(content);
  document.body.append(timeline);
  timelines.push(timeline);
  return timeline;
}

function wheel(deltaY: number, wheelDeltaY: number, init: WheelEventInit = {}): WheelEvent {
  const fullInit = { cancelable: true, deltaY, wheelDeltaY, ...init };
  return new WheelEvent("wheel", fullInit);
}

describe("forwardWheelToTimeline", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const timeline of timelines.splice(0)) timeline.remove();
  });

  it.each([
    ["macOS", -360],
    ["Linux and Windows", -120],
  ])("scrolls %s trackpad deltas immediately", (_platform, wheelDeltaY) => {
    const timeline = mountTimeline();
    forwardWheelToTimeline(wheel(120, wheelDeltaY), timeline);
    expect(timeline.scrollTop).toBe(120);
  });

  it("glides mouse wheel notches and accumulates them", () => {
    const timeline = mountTimeline();
    forwardWheelToTimeline(wheel(100, -120), timeline);
    forwardWheelToTimeline(wheel(100, -120), timeline);
    expect(timeline.scrollTop).toBe(0);
    vi.advanceTimersByTime(75);
    expect(timeline.scrollTop).toBeGreaterThan(0);
    expect(timeline.scrollTop).toBeLessThan(200);
    vi.advanceTimersByTime(120);
    expect(timeline.scrollTop).toBe(200);
  });

  it("converts line and page delta modes", () => {
    const timeline = mountTimeline();
    forwardWheelToTimeline(wheel(3, -120, { deltaMode: WheelEvent.DOM_DELTA_LINE }), timeline);
    vi.advanceTimersByTime(200);
    expect(timeline.scrollTop).toBe(48);
    forwardWheelToTimeline(wheel(1, -120, { deltaMode: WheelEvent.DOM_DELTA_PAGE }), timeline);
    vi.advanceTimersByTime(200);
    expect(timeline.scrollTop).toBe(248);
  });

  it("carries the glide along when the list moves under it", () => {
    const timeline = mountTimeline();
    forwardWheelToTimeline(wheel(100, -120), timeline);
    vi.advanceTimersByTime(48);
    timeline.scrollTop += 500;
    vi.advanceTimersByTime(200);
    expect(timeline.scrollTop).toBe(600);
  });

  it.each([
    ["pointerdown", () => new PointerEvent("pointerdown")],
    ["keydown", () => new KeyboardEvent("keydown", { key: "ArrowDown" })],
  ])("stops gliding on %s", (_name, makeEvent) => {
    const timeline = mountTimeline();
    forwardWheelToTimeline(wheel(100, -120), timeline);
    vi.advanceTimersByTime(48);
    timeline.scrollTop = 1000;
    window.dispatchEvent(makeEvent());
    vi.advanceTimersByTime(200);
    expect(timeline.scrollTop).toBe(1000);
  });

  it("scrolls directly under reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const timeline = mountTimeline();
    forwardWheelToTimeline(wheel(100, -120), timeline);
    expect(timeline.scrollTop).toBe(100);
  });

  it.each([
    ["ctrl-wheel zooms", wheel(100, -120, { ctrlKey: true })],
    ["zero delta", wheel(0, 0)],
  ])("ignores %s", (_name, event) => {
    const timeline = mountTimeline();
    const onLeaveBottom = vi.fn();
    forwardWheelToTimeline(event, timeline, onLeaveBottom);
    vi.advanceTimersByTime(200);
    expect(timeline.scrollTop).toBe(0);
    expect(onLeaveBottom).not.toHaveBeenCalled();
  });

  describe("leaving the follow-to-bottom zone", () => {
    const atBottom = () => {
      const timeline = mountTimeline();
      timeline.scrollTop = timeline.scrollHeight;
      return timeline;
    };

    it("reports an upward notch that ends outside the zone before the glide moves", () => {
      const timeline = atBottom();
      const bottom = timeline.scrollTop;
      const onLeaveBottom = vi.fn();
      forwardWheelToTimeline(wheel(-100, 120), timeline, onLeaveBottom);
      expect(onLeaveBottom).toHaveBeenCalledTimes(1);
      expect(timeline.scrollTop).toBe(bottom);
    });

    it("waits until accumulated notches leave the zone", () => {
      const timeline = atBottom();
      const onLeaveBottom = vi.fn();
      forwardWheelToTimeline(wheel(-50, 120), timeline, onLeaveBottom);
      expect(onLeaveBottom).not.toHaveBeenCalled();
      forwardWheelToTimeline(wheel(-50, 120), timeline, onLeaveBottom);
      expect(onLeaveBottom).toHaveBeenCalledTimes(1);
    });

    it("does not report downward notches", () => {
      const timeline = mountTimeline();
      const onLeaveBottom = vi.fn();
      forwardWheelToTimeline(wheel(100, -120), timeline, onLeaveBottom);
      expect(onLeaveBottom).not.toHaveBeenCalled();
    });
  });
});
