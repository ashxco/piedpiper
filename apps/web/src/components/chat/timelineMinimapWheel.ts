import { getSmoothScrollBehavior, isScrollContainerNearBottom } from "../../chat-scroll";

const MOUSE_WHEEL_GLIDE_MS = 150;
const LINE_HEIGHT_PX = 16;
// Chromium's trackpad deltas keep `wheelDeltaY` at -1x (Linux, Windows) or -3x (macOS) `deltaY`.
const PRECISE_WHEEL_DELTA_RATIOS = [1, 3];

interface WheelGlide {
  from: number;
  to: number;
  start: number;
  written: number;
  frame: number;
  interruptions: AbortController;
}

const glides = new WeakMap<HTMLElement, WheelGlide>();

function isPreciseWheel(event: WheelEvent): boolean {
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return false;
  const { wheelDeltaY } = event as WheelEvent & { wheelDeltaY?: number };
  return (
    wheelDeltaY === undefined ||
    PRECISE_WHEEL_DELTA_RATIOS.some((ratio) => Math.abs(wheelDeltaY + ratio * event.deltaY) < 1)
  );
}

function wheelDistancePx(event: WheelEvent, timeline: HTMLElement): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * LINE_HEIGHT_PX;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * timeline.clientHeight;
  return event.deltaY;
}

function takeGlide(timeline: HTMLElement): WheelGlide | undefined {
  const glide = glides.get(timeline);
  if (!glide) return undefined;
  cancelAnimationFrame(glide.frame);
  glide.interruptions.abort();
  glides.delete(timeline);
  return glide;
}

export function stopTimelineWheelGlide(timeline: HTMLElement): void {
  takeGlide(timeline);
}

/** Starts a glide, or extends the running one so quick notches add up. Returns its target. */
function glideBy(timeline: HTMLElement, distance: number): number {
  const current = takeGlide(timeline);
  const scrollTop = timeline.scrollTop;
  const base = current ? current.to + scrollTop - current.written : scrollTop;
  const maxScrollTop = timeline.scrollHeight - timeline.clientHeight;
  const glide: WheelGlide = {
    from: scrollTop,
    to: Math.max(0, Math.min(maxScrollTop, base + distance)),
    start: performance.now(),
    written: scrollTop,
    frame: 0,
    interruptions: new AbortController(),
  };
  for (const type of ["pointerdown", "keydown"]) {
    window.addEventListener(type, () => stopTimelineWheelGlide(timeline), {
      capture: true,
      signal: glide.interruptions.signal,
    });
  }
  const step = (time: number) => {
    if (!timeline.isConnected) {
      stopTimelineWheelGlide(timeline);
      return;
    }
    // Rows re-measuring or stick-to-bottom moved the list: carry the remaining glide along.
    const drift = timeline.scrollTop - glide.written;
    glide.from += drift;
    glide.to += drift;
    const progress = Math.min(1, Math.max(0, (time - glide.start) / MOUSE_WHEEL_GLIDE_MS));
    timeline.scrollTop = glide.from + (glide.to - glide.from) * (1 - (1 - progress) ** 3);
    glide.written = timeline.scrollTop;
    if (progress < 1) {
      glide.frame = requestAnimationFrame(step);
    } else {
      stopTimelineWheelGlide(timeline);
    }
  };
  glide.frame = requestAnimationFrame(step);
  glides.set(timeline, glide);
  return glide.to;
}

/**
 * Scrolls the timeline for a wheel over the minimap, which sits outside the scroll element.
 * Trackpads and reduced motion scroll directly; mouse wheel notches glide. A glide's first frames
 * stay inside the follow-to-bottom zone, where streaming would snap each of them back, so
 * `onLeaveBottom` fires up front when an upward glide will end outside that zone.
 */
export function forwardWheelToTimeline(
  event: WheelEvent,
  timeline: HTMLElement,
  onLeaveBottom?: () => void,
): void {
  if (event.defaultPrevented || event.ctrlKey || event.deltaY === 0) return;
  const distance = wheelDistancePx(event, timeline);
  if (isPreciseWheel(event) || getSmoothScrollBehavior() === "auto") {
    stopTimelineWheelGlide(timeline);
    timeline.scrollBy({ top: distance, left: 0 });
    return;
  }
  const target = glideBy(timeline, distance);
  if (
    distance < 0 &&
    !isScrollContainerNearBottom({
      scrollTop: target,
      clientHeight: timeline.clientHeight,
      scrollHeight: timeline.scrollHeight,
    })
  ) {
    onLeaveBottom?.();
  }
}
