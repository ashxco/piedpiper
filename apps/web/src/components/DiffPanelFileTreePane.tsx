import * as Schema from "effect/Schema";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
} from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import {
  clampDiffFileTreeWidth,
  DIFF_FILE_TREE_DEFAULT_WIDTH,
  DIFF_FILE_TREE_MIN_WIDTH,
  resolveDiffFileTreeMaxWidth,
} from "./DiffPanelFileTree.logic";

export const DIFF_FILE_TREE_WIDTH_STORAGE_KEY = "piedpiper:diff-file-tree-width";
const KEYBOARD_STEP = 16;

interface TreeResizeDrag {
  readonly pointerId: number;
  readonly handle: HTMLElement;
  readonly host: HTMLElement;
  readonly startX: number;
  readonly startWidth: number;
  width: number;
}

function clearDragBodyStyles() {
  document.body.style.removeProperty("cursor");
  document.body.style.removeProperty("user-select");
}

function paintDragWidth(drag: TreeResizeDrag, width: number) {
  drag.width = width;
  drag.host.style.width = `${width}px`;
  drag.handle.setAttribute("aria-valuenow", String(width));
}

/** The diff file tree's column: the saved width is clamped at render so narrowing the panel keeps it. */
export function DiffPanelFileTreePane(props: { bodyWidth: number; children: ReactNode }) {
  const { bodyWidth, children } = props;
  const [storedWidth, setStoredWidth] = useLocalStorage(
    DIFF_FILE_TREE_WIDTH_STORAGE_KEY,
    DIFF_FILE_TREE_DEFAULT_WIDTH,
    Schema.Finite,
  );
  const width = clampDiffFileTreeWidth(storedWidth, bodyWidth);
  const maxWidth = resolveDiffFileTreeMaxWidth(bodyWidth);
  const dragRef = useRef<TreeResizeDrag | null>(null);

  const finishDrag = useEffectEvent(() => {
    const drag = dragRef.current;
    if (!drag) return;
    // Cleared before releasing capture, whose lostpointercapture event lands back here.
    dragRef.current = null;
    clearDragBodyStyles();
    try {
      drag.handle.releasePointerCapture(drag.pointerId);
    } catch {
      // The browser already dropped the capture.
    }
    // React skips an unchanged style, so the DOM must be put back on the width of this render.
    if (drag.width === drag.startWidth) {
      paintDragWidth(drag, width);
      return;
    }
    paintDragWidth(drag, clampDiffFileTreeWidth(drag.width, bodyWidth));
    setStoredWidth(drag.width);
  });

  useEffect(() => {
    const handleBlur = () => finishDrag();
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("blur", handleBlur);
      if (dragRef.current) {
        dragRef.current = null;
        clearDragBodyStyles();
      }
    };
  }, []);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragRef.current) return;
    const handle = event.currentTarget;
    const host = handle.parentElement;
    if (!host) return;
    event.preventDefault();
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is no longer active, so no drag can follow.
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      handle,
      host,
      startX: event.clientX,
      startWidth: width,
      width,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const paintPointerWidth = (drag: TreeResizeDrag, clientX: number) => {
    paintDragWidth(
      drag,
      clampDiffFileTreeWidth(drag.startWidth + clientX - drag.startX, bodyWidth),
    );
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    paintPointerWidth(drag, event.clientX);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    paintPointerWidth(drag, event.clientX);
    finishDrag();
  };

  const handlePointerAbort = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) finishDrag();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || dragRef.current) return;
    let nextWidth: number;
    switch (event.key) {
      case "ArrowLeft":
        nextWidth = width - KEYBOARD_STEP;
        break;
      case "ArrowRight":
        nextWidth = width + KEYBOARD_STEP;
        break;
      case "Home":
        nextWidth = DIFF_FILE_TREE_MIN_WIDTH;
        break;
      case "End":
        nextWidth = maxWidth;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const clamped = clampDiffFileTreeWidth(nextWidth, bodyWidth);
    // Pressing at a limit must not overwrite a wider saved width that only the panel size caps.
    if (clamped !== width) setStoredWidth(clamped);
  };

  return (
    <aside
      className="relative flex shrink-0 border-r border-border/60"
      style={{ width: `${width}px` }}
    >
      {children}
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize file tree"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={DIFF_FILE_TREE_MIN_WIDTH}
        aria-valuemax={maxWidth}
        className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors hover:after:bg-border focus-visible:after:bg-ring"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerAbort}
        onLostPointerCapture={handlePointerAbort}
        onKeyDown={handleKeyDown}
      />
    </aside>
  );
}
