import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import {
  areTimelineMinimapIndicesEqual,
  isTimelineMinimapScrollAtEnd,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapHighlightedIndices,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapNavigationIndex,
  resolveTimelineMinimapNeighborIndices,
  resolveTimelineMinimapPreview,
  resolveTimelineMinimapTopPercent,
  TIMELINE_MINIMAP_MIN_ITEMS,
  type TimelineMinimapItem,
  type TimelineMinimapItemBounds,
} from "./MessagesTimeline.minimap.logic";
import { forwardWheelToTimeline, stopTimelineWheelGlide } from "./timelineMinimapWheel";

const EMPTY_INDICES: ReadonlyArray<number> = [];

interface MessagesTimelineMinimapProps {
  /** The messages scroll element; the rail renders over its positioned parent. */
  scrollContainer: HTMLDivElement | null;
  /** The centered content column; the rail needs room beside it and re-checks rows when it resizes. */
  contentElement: HTMLElement | null;
  items: ReadonlyArray<TimelineMinimapItem>;
  /** Viewport-relative bounds of an item's user message row, or null when unknown. */
  resolveItemBounds: (item: TimelineMinimapItem) => TimelineMinimapItemBounds | null;
  onSelect: (item: TimelineMinimapItem) => void;
  /** An upward wheel glide is headed out of the follow-to-bottom zone. */
  onLeaveBottom?: (() => void) | undefined;
}

/** Calls `onRelease` once no mouse button is held; a release outside the window can skip `mouseup`. */
function onMouseButtonsReleased(onRelease: () => void): () => void {
  const check = (event: globalThis.MouseEvent) => {
    if (event.buttons !== 0) return;
    stop();
    onRelease();
  };
  const stop = () => {
    window.removeEventListener("mouseup", check);
    window.removeEventListener("mousemove", check);
  };
  window.addEventListener("mouseup", check);
  window.addEventListener("mousemove", check);
  return stop;
}

function useHasPersistentGutter(
  scrollContainer: HTMLDivElement | null,
  contentElement: HTMLElement | null,
): boolean {
  const [hasPersistentGutter, setHasPersistentGutter] = useState(false);
  useEffect(() => {
    if (!scrollContainer || !contentElement) return;
    const measure = () => {
      setHasPersistentGutter(
        resolveTimelineMinimapHasPersistentGutter({
          containerLeft: scrollContainer.getBoundingClientRect().left,
          contentLeft: contentElement.getBoundingClientRect().left,
        }),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scrollContainer);
    observer.observe(contentElement);
    return () => observer.disconnect();
  }, [contentElement, scrollContainer]);
  return Boolean(scrollContainer && contentElement) && hasPersistentGutter;
}

const FINE_POINTER_QUERY = "(pointer: fine)";

function useHasFinePointer(): boolean {
  const [hasFinePointer, setHasFinePointer] = useState(
    () => typeof window.matchMedia !== "function" || window.matchMedia(FINE_POINTER_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(FINE_POINTER_QUERY);
    const update = () => setHasFinePointer(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return hasFinePointer;
}

function useViewportPosition(
  scrollContainer: HTMLDivElement | null,
  contentElement: HTMLElement | null,
  items: ReadonlyArray<TimelineMinimapItem>,
  resolveItemBounds: MessagesTimelineMinimapProps["resolveItemBounds"],
  enabled: boolean,
): { highlighted: ReadonlyArray<number>; currentIndex: number | null; scrollAtEnd: boolean } {
  const [highlighted, setHighlighted] = useState<ReadonlyArray<number>>(EMPTY_INDICES);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [scrollAtEnd, setScrollAtEnd] = useState(false);
  useEffect(() => {
    if (!scrollContainer || !enabled) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const viewport = scrollContainer.getBoundingClientRect();
      const itemBounds = items.map(resolveItemBounds);
      const viewportRange = { viewportTop: viewport.top, viewportBottom: viewport.bottom };
      const next = resolveTimelineMinimapHighlightedIndices({ ...viewportRange, itemBounds });
      setHighlighted((current) => (areTimelineMinimapIndicesEqual(current, next) ? current : next));
      setCurrentIndex(resolveTimelineMinimapNavigationIndex({ ...viewportRange, itemBounds }));
      setScrollAtEnd(isTimelineMinimapScrollAtEnd(scrollContainer));
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    schedule();
    scrollContainer.addEventListener("scroll", schedule, { passive: true });
    // Rows that expand, load images or get re-measured move messages without a scroll event.
    const observer =
      contentElement && typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (contentElement) observer?.observe(contentElement);
    return () => {
      scrollContainer.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [contentElement, enabled, items, resolveItemBounds, scrollContainer]);
  return enabled
    ? { highlighted, currentIndex, scrollAtEnd }
    : { highlighted: EMPTY_INDICES, currentIndex: null, scrollAtEnd: false };
}

function TurnNavigationButton(props: {
  direction: "previous" | "next";
  disabled: boolean;
  passThrough: boolean;
  scrollContainer: HTMLDivElement | null;
  onLeaveBottom: (() => void) | undefined;
  onSelect: () => void;
}) {
  const previous = props.direction === "previous";
  const label = previous ? "Previous turn" : "Next turn";
  const Icon = previous ? ChevronUpIcon : ChevronDownIcon;
  // The wrapper takes the wheel and mouse events. aria-disabled rather than disabled, as a button
  // disabled by its own press would drop keyboard focus out of the rail.
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "absolute left-0 inline-flex size-6",
              previous ? "bottom-full mb-1" : "top-full mt-1",
              props.passThrough ? "pointer-events-none" : "pointer-events-auto",
            )}
            onMouseDown={(event) => event.preventDefault()}
            onWheel={(event) => {
              if (!props.scrollContainer) return;
              forwardWheelToTimeline(event.nativeEvent, props.scrollContainer, props.onLeaveBottom);
            }}
          />
        }
      >
        <button
          aria-label={label}
          aria-disabled={props.disabled || undefined}
          className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 aria-disabled:cursor-default aria-disabled:text-muted-foreground/20"
          data-minimap-turn-button={props.direction}
          onClick={() => {
            if (!props.disabled) props.onSelect();
          }}
          type="button"
        >
          <Icon aria-hidden="true" className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** A rail of ticks, one per user message, for jumping around long threads. */
export function MessagesTimelineMinimap({
  scrollContainer,
  contentElement,
  items,
  resolveItemBounds,
  onSelect,
  onLeaveBottom,
}: MessagesTimelineMinimapProps) {
  const hasPersistentGutter = useHasPersistentGutter(scrollContainer, contentElement);
  const hasFinePointer = useHasFinePointer();
  const visible =
    hasPersistentGutter && hasFinePointer && items.length >= TIMELINE_MINIMAP_MIN_ITEMS;
  const { highlighted, currentIndex, scrollAtEnd } = useViewportPosition(
    scrollContainer,
    contentElement,
    items,
    resolveItemBounds,
    visible,
  );
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // A drag that started elsewhere is a text selection: let it pass under the rail until release.
  const pressedOnRailRef = useRef(false);
  const [passThrough, setPassThrough] = useState(false);

  useEffect(() => {
    if (!passThrough) return;
    return onMouseButtonsReleased(() => setPassThrough(false));
  }, [passThrough]);

  useEffect(() => {
    if (!scrollContainer) return;
    return () => stopTimelineWheelGlide(scrollContainer);
  }, [scrollContainer]);

  const portalTarget = scrollContainer?.parentElement ?? null;
  if (!visible || !portalTarget) return null;

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null);
  const activePreview = activeItem ? resolveTimelineMinimapPreview(activeItem) : null;
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length);
  const activeTooltipTranslate =
    resolvedActiveIndex === 0 ? "0%" : resolvedActiveIndex === items.length - 1 ? "-100%" : "-50%";

  const indexFromPointer = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return resolveTimelineMinimapIndexFromPointer({
      itemCount: items.length,
      railTop: rect.top,
      railHeight: rect.height,
      pointerY: event.clientY,
    });
  };
  const moveActiveIndex = (delta: number) => {
    setActiveIndex((current) => Math.max(0, Math.min(items.length - 1, (current ?? 0) + delta)));
  };
  const neighbors = resolveTimelineMinimapNeighborIndices(currentIndex, items.length, scrollAtEnd);
  const selectIndex = (index: number | null) => {
    const item = index === null ? null : (items[index] ?? null);
    if (item) onSelect(item);
  };

  return createPortal(
    <div
      className="pointer-events-none absolute inset-y-0 left-0 z-20 hidden w-12 [@media(pointer:fine)]:block"
      data-testid="timeline-minimap"
    >
      <div
        className="absolute top-1/2 left-2 w-9 -translate-y-1/2"
        style={{ height: resolveTimelineMinimapHeightStyle(items.length) }}
      >
        <TurnNavigationButton
          direction="previous"
          disabled={neighbors.previous === null}
          passThrough={passThrough}
          scrollContainer={scrollContainer}
          onLeaveBottom={onLeaveBottom}
          onSelect={() => selectIndex(neighbors.previous)}
        />
        <button
          aria-label={`Jump to message: ${activePreview?.userText ?? "User message"}`}
          className={cn(
            "absolute inset-0 cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            passThrough ? "pointer-events-none" : "pointer-events-auto",
          )}
          onBlur={() => setActiveIndex(null)}
          onClick={(event) => {
            selectIndex(event.detail === 0 ? resolvedActiveIndex : indexFromPointer(event));
            if (event.detail !== 0) event.currentTarget.blur();
          }}
          onFocus={() => setActiveIndex((current) => current ?? currentIndex ?? 0)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActiveIndex(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActiveIndex(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              setActiveIndex(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setActiveIndex(items.length - 1);
            }
          }}
          onMouseDown={(event) => {
            // Keep focus (and any composer selection) where it is when clicking a tick.
            event.preventDefault();
            if (pressedOnRailRef.current) return;
            pressedOnRailRef.current = true;
            onMouseButtonsReleased(() => {
              pressedOnRailRef.current = false;
            });
          }}
          onMouseLeave={() => setActiveIndex(null)}
          onMouseMove={(event) => {
            if (event.buttons !== 0 && !pressedOnRailRef.current) {
              setActiveIndex(null);
              setPassThrough(true);
              return;
            }
            setActiveIndex(indexFromPointer(event));
          }}
          onWheel={(event) => {
            if (scrollContainer) {
              forwardWheelToTimeline(event.nativeEvent, scrollContainer, onLeaveBottom);
            }
          }}
          type="button"
        >
          <span aria-hidden="true" className="absolute top-0 left-3 h-full w-px bg-border/15" />
          {items.map((item, index) => {
            const activeDistance =
              resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
            return (
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute left-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150 data-[in-view=true]:bg-foreground/90",
                  activeDistance === 0
                    ? "w-6 bg-muted-foreground/75"
                    : activeDistance === 1
                      ? "w-4"
                      : activeDistance === 2
                        ? "w-2.5"
                        : "w-2",
                )}
                data-in-view={highlighted.includes(index) ? "true" : "false"}
                data-minimap-tick
                key={item.id}
                style={{ top: `${resolveTimelineMinimapTopPercent(index, items.length)}%` }}
              />
            );
          })}
          {activePreview ? (
            <span
              className="pointer-events-none absolute left-8 w-80 rounded-xl border border-border/70 bg-popover/95 p-3 text-left text-popover-foreground shadow-xl shadow-black/25 backdrop-blur"
              data-minimap-preview
              style={{
                top: `${activeTopPercent}%`,
                transform: `translateY(${activeTooltipTranslate})`,
              }}
            >
              <span className="block max-w-full truncate text-sm font-medium leading-5">
                {activePreview.userText ?? "User message"}
              </span>
              {activePreview.assistantText ? (
                <span className="mt-1 line-clamp-3 text-sm leading-5 text-muted-foreground">
                  {activePreview.assistantText}
                </span>
              ) : null}
            </span>
          ) : null}
        </button>
        <TurnNavigationButton
          direction="next"
          disabled={neighbors.next === null}
          passThrough={passThrough}
          scrollContainer={scrollContainer}
          onLeaveBottom={onLeaveBottom}
          onSelect={() => selectIndex(neighbors.next)}
        />
      </div>
    </div>,
    portalTarget,
  );
}
