import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";

export const ZOOMABLE_IMAGE_MAX_ZOOM = 8;
const ZOOMABLE_IMAGE_PAN_STEP_PX = 40;

export interface ZoomableImageHandle {
  /** Pans the zoomed image for an arrow key; false when not zoomed, not an arrow, or that axis cannot scroll. */
  pan: (key: string) => boolean;
}

export function clampImageZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(ZOOMABLE_IMAGE_MAX_ZOOM, Math.max(1, zoom));
}

/** Largest height the image may take: 86% of the window, leaving room for the caption. */
export function zoomableImageMaxHeight(windowHeight: number): number {
  return Math.max(1, Math.min(windowHeight * 0.86, windowHeight - 80));
}

/** Scale that fits the image inside 92vw by the max height, never upscaling. */
export function computeImageFitScale(
  naturalSize: { width: number; height: number },
  windowSize: { width: number; height: number },
): number {
  return Math.min(
    1,
    (windowSize.width * 0.92) / (naturalSize.width || 1),
    zoomableImageMaxHeight(windowSize.height) / (naturalSize.height || 1),
  );
}

/** Zoom multiplier for a wheel event; pinch gestures arrive as ctrl+wheel and zoom faster. */
export function wheelZoomMultiplier(input: {
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  pageHeight: number;
}): number {
  const unit = input.deltaMode === 1 ? 16 : input.deltaMode === 2 ? input.pageHeight : 1;
  return Math.exp(-input.deltaY * unit * (input.ctrlKey ? 0.01 : 0.002));
}

/** Zooms around the pointer and keeps the whole image reachable by dragging or scrolling. */
export function ZoomableImage({
  src,
  name,
  onError,
  ref,
}: {
  src: string;
  name: string;
  onError?: () => void;
  ref?: Ref<ZoomableImageHandle>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [windowSize, setWindowSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const anchorRef = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const maxHeight = zoomableImageMaxHeight(windowSize.height);
  const fit = computeImageFitScale(naturalSize, windowSize);
  const width = naturalSize.width * fit * zoom;
  const height = naturalSize.height * fit * zoom;

  useImperativeHandle(
    ref,
    () => ({
      pan(key) {
        const viewport = viewportRef.current;
        if (!viewport || zoomRef.current <= 1) return false;
        // A zoomed image that still fits cannot pan, so let the dialog step images instead.
        const canScrollX = viewport.scrollWidth > viewport.clientWidth;
        const canScrollY = viewport.scrollHeight > viewport.clientHeight;
        if ((key === "ArrowLeft" || key === "ArrowRight") && !canScrollX) return false;
        if ((key === "ArrowUp" || key === "ArrowDown") && !canScrollY) return false;
        switch (key) {
          case "ArrowLeft":
            viewport.scrollLeft -= ZOOMABLE_IMAGE_PAN_STEP_PX;
            break;
          case "ArrowRight":
            viewport.scrollLeft += ZOOMABLE_IMAGE_PAN_STEP_PX;
            break;
          case "ArrowUp":
            viewport.scrollTop -= ZOOMABLE_IMAGE_PAN_STEP_PX;
            break;
          case "ArrowDown":
            viewport.scrollTop += ZOOMABLE_IMAGE_PAN_STEP_PX;
            break;
          default:
            return false;
        }
        return true;
      },
    }),
    [],
  );

  const changeZoom = useCallback((next: number, point?: { x: number; y: number }) => {
    const viewport = viewportRef.current;
    const previous = zoomRef.current;
    const clamped = clampImageZoom(next);
    if (!viewport || previous === clamped) return;
    const bounds = viewport.getBoundingClientRect();
    const x = point ? point.x - bounds.left : viewport.clientWidth / 2;
    const y = point ? point.y - bounds.top : viewport.clientHeight / 2;
    anchorRef.current = {
      x: (viewport.scrollLeft + x) / previous,
      y: (viewport.scrollTop + y) / previous,
      clientX: bounds.left + x,
      clientY: bounds.top + y,
    };
    zoomRef.current = clamped;
    setZoom(clamped);
  }, []);

  // Keep the point under the pointer fixed after the zoomed layout is committed.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const anchor = anchorRef.current;
    if (!viewport || !anchor) return;
    const bounds = viewport.getBoundingClientRect();
    viewport.scrollLeft = anchor.x * zoom - (anchor.clientX - bounds.left);
    viewport.scrollTop = anchor.y * zoom - (anchor.clientY - bounds.top);
    anchorRef.current = null;
  }, [zoom]);

  useEffect(() => {
    const resize = () => {
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
      changeZoom(1);
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [changeZoom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // React's onWheel is passive, so preventDefault needs a native listener.
    const wheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const multiplier = wheelZoomMultiplier({
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        pageHeight: viewport.clientHeight,
      });
      changeZoom(zoomRef.current * multiplier, { x: event.clientX, y: event.clientY });
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [changeZoom]);

  return (
    <div className="min-w-0">
      <div
        ref={viewportRef}
        role="region"
        aria-label={`${name}, zoomable image`}
        aria-description="Click to zoom in or return to fit. Scroll to zoom, drag to pan. Use Enter to toggle zoom, plus or minus to zoom, and 0 to fit."
        tabIndex={0}
        className="max-w-[92vw] overflow-auto overscroll-contain rounded-lg bg-background ring-1 ring-border/70 shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{
          width: width || undefined,
          height: height || undefined,
          maxHeight,
          cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
        }}
        onClick={(event) => {
          // Pointer capture still produces a click after a drag; leave the image zoomed.
          if (suppressClickRef.current || event.detail > 1) return;
          changeZoom(zoomRef.current > 1 ? 1 : 2, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!event.repeat) changeZoom(zoomRef.current > 1 ? 1 : 2);
          } else if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            changeZoom(zoomRef.current * 1.5);
          } else if (event.key === "-") {
            event.preventDefault();
            changeZoom(zoomRef.current / 1.5);
          } else if (event.key === "0") {
            event.preventDefault();
            changeZoom(1);
          }
        }}
        onPointerDown={(event) => {
          if (dragRef.current) return;
          suppressClickRef.current = false;
          if (event.pointerType !== "mouse" || event.button !== 0 || zoomRef.current <= 1) return;
          const viewport = event.currentTarget;
          const bounds = viewport.getBoundingClientRect();
          // Leave presses on the scrollbars to the browser.
          if (
            event.clientX - bounds.left >= viewport.clientWidth ||
            event.clientY - bounds.top >= viewport.clientHeight
          ) {
            return;
          }
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: viewport.scrollLeft,
            top: viewport.scrollTop,
          };
          viewport.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) {
            suppressClickRef.current = true;
          }
          event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x);
          event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y);
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          dragRef.current = null;
          setDragging(false);
        }}
        onLostPointerCapture={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          setDragging(false);
        }}
      >
        <img
          src={src}
          alt={name}
          draggable={false}
          className="block max-w-none select-none"
          style={naturalSize.width ? { width, height } : { maxWidth: "92vw", maxHeight }}
          onLoad={(event) => {
            setNaturalSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            });
          }}
          onError={onError}
        />
      </div>
      <span className="sr-only" aria-live="polite">
        {Math.round(zoom * 100)}% zoom
      </span>
    </div>
  );
}
