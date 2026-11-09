import { getSmoothScrollBehavior } from "../../chat-scroll";

export type ComposerPageScrollDirection = "up" | "down";

/** Fraction of the timeline viewport one PageUp/PageDown press scrolls. */
const COMPOSER_PAGE_SCROLL_VIEWPORT_FRACTION = 0.9;

export interface ComposerPageScrollKeyEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
  defaultPrevented: boolean;
}

/** Scroll metrics of the composer's own scroll container. */
export interface ComposerPageScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Returns the direction the chat timeline should page in, or null when the key
 * belongs to the editor: not a page key, a modifier held, IME composition, or the
 * composer itself can still scroll that way.
 */
export function resolveComposerPageScrollDirection(
  event: ComposerPageScrollKeyEvent,
  composer: ComposerPageScrollMetrics | null,
): ComposerPageScrollDirection | null {
  if (event.key !== "PageUp" && event.key !== "PageDown") return null;
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const direction: ComposerPageScrollDirection = event.key === "PageUp" ? "up" : "down";
  if (composer && composer.scrollHeight - composer.clientHeight > 1) {
    // Within a pixel of the edge counts as the edge (fractional scroll offsets).
    const canScrollUp = composer.scrollTop > 1;
    const canScrollDown = composer.scrollHeight - composer.clientHeight - composer.scrollTop > 1;
    if (direction === "up" ? canScrollUp : canScrollDown) return null;
  }
  return direction;
}

/** Signed pixel distance for one page step in a viewport of `clientHeight`. */
export function composerPageScrollDelta(
  direction: ComposerPageScrollDirection,
  clientHeight: number,
): number {
  const distance = Math.max(0, clientHeight * COMPOSER_PAGE_SCROLL_VIEWPORT_FRACTION);
  return direction === "up" ? -distance : distance;
}

/** Smoothly pages the chat timeline from the composer. */
/** Scrolls one page, jumping instead of animating when the OS asks for reduced motion. */
export function scrollTimelineByComposerPage(
  container: Pick<HTMLElement, "clientHeight" | "scrollBy">,
  direction: ComposerPageScrollDirection,
  behavior: ScrollBehavior = getSmoothScrollBehavior(),
): void {
  container.scrollBy({
    top: composerPageScrollDelta(direction, container.clientHeight),
    behavior,
  });
}
