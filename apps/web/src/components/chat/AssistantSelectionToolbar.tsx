import { QuoteIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  ASSISTANT_QUOTE_MAX_CHARS,
  captureAssistantTextSelection,
  type CapturedAssistantSelection,
  resolveSelectionToolbarPosition,
} from "~/lib/assistantTextSelection";

import { Button } from "../ui/button";

const MULTI_CLICK_WAIT_MS = 500;
const SELECTION_KEYS = new Set([
  "Shift",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "a",
]);
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);

type SelectionPoints = Pick<Selection, "anchorNode" | "anchorOffset" | "focusNode" | "focusOffset">;

function readSelectionPoints(): SelectionPoints | null {
  const selection = window.getSelection();
  if (!selection) return null;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  return { anchorNode, anchorOffset, focusNode, focusOffset };
}

function isSameSelection(a: SelectionPoints | null, b: SelectionPoints | null): boolean {
  return (
    a?.anchorNode === b?.anchorNode &&
    a?.anchorOffset === b?.anchorOffset &&
    a?.focusNode === b?.focusNode &&
    a?.focusOffset === b?.focusOffset
  );
}

/** A "Quote" button next to text selected in an assistant reply. */
export function AssistantSelectionToolbar({
  viewport,
  onQuote,
}: {
  viewport: HTMLElement | null;
  onQuote: (text: string) => void;
}) {
  const [selection, setSelection] = useState<CapturedAssistantSelection | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button || !selection) return;
    const { width, height } = button.getBoundingClientRect();
    const position = resolveSelectionToolbarPosition({
      rect: selection.rect,
      toolbar: { width, height },
      window: { width: window.innerWidth, height: window.innerHeight },
    });
    button.style.left = `${position.left}px`;
    button.style.top = `${position.top}px`;
  }, [selection]);

  useEffect(() => {
    if (!viewport) return;
    let primaryButtonDown = false;
    let timer: number | null = null;
    // A released key reopens the button only for a selection it has not already answered.
    let settledSelection = readSelectionPoints();
    const cancelPending = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const dismiss = () => {
      cancelPending();
      settledSelection = readSelectionPoints();
      setSelection(null);
    };
    const schedule = (delayMs: number) => {
      cancelPending();
      timer = window.setTimeout(() => {
        timer = null;
        settledSelection = readSelectionPoints();
        setSelection(captureAssistantTextSelection(viewport, window.getSelection()));
      }, delayMs);
    };
    const isToolbarTarget = (target: EventTarget | null) =>
      target instanceof Node && (buttonRef.current?.contains(target) ?? false);

    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || isToolbarTarget(event.target)) return;
      dismiss();
      primaryButtonDown =
        event.button === 0 && event.target instanceof Node && viewport.contains(event.target);
    };
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 0 || !primaryButtonDown) return;
      primaryButtonDown = false;
      // A double-click may still become a triple-click, and ChatMarkdown widens its selection late.
      schedule(event.detail >= 2 ? MULTI_CLICK_WAIT_MS : 0);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
        return;
      }
      if (SCROLL_KEYS.has(event.key) && !event.shiftKey && !isToolbarTarget(event.target)) {
        dismiss();
        return;
      }
      const button = buttonRef.current;
      if (
        event.key === "Tab" &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        button &&
        !button.disabled &&
        !isToolbarTarget(event.target)
      ) {
        event.preventDefault();
        button.focus({ preventScroll: true });
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (primaryButtonDown || !SELECTION_KEYS.has(event.key)) return;
      if (!isSameSelection(settledSelection, readSelectionPoints())) schedule(0);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!primaryButtonDown && !isToolbarTarget(event.target)) dismiss();
    };

    // Auto-scroll fires these too while a reply streams, so the button follows until text leaves.
    const onScroll = () => {
      if (!buttonRef.current) return;
      const next = captureAssistantTextSelection(viewport, window.getSelection());
      const bounds = viewport.getBoundingClientRect();
      if (next && next.rect.bottom > bounds.top && next.rect.top < bounds.bottom) {
        setSelection(next);
      } else {
        dismiss();
      }
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("focusin", onFocusIn);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("wheel", dismiss, { passive: true });
    viewport.addEventListener("touchmove", dismiss, { passive: true });
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      cancelPending();
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("focusin", onFocusIn);
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", dismiss);
      viewport.removeEventListener("touchmove", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [viewport]);

  if (!selection) return null;
  const tooLong = selection.text.length > ASSISTANT_QUOTE_MAX_CHARS;
  return createPortal(
    <Button
      ref={buttonRef}
      type="button"
      size="xs"
      variant="outline"
      disabled={tooLong}
      aria-label={tooLong ? "Selection is too long to quote" : "Quote selection in composer"}
      className="fixed z-50 rounded-full px-2.5 shadow-sm"
      style={{ left: selection.rect.right, top: selection.rect.bottom }}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        onQuote(selection.text);
        window.getSelection()?.removeAllRanges();
        setSelection(null);
      }}
    >
      <QuoteIcon aria-hidden="true" className="size-3.5" />
      {tooLong ? "Selection too long" : "Quote"}
    </Button>,
    document.body,
  );
}
