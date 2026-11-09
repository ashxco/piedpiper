const WCO_CLASS_NAME = "wco";

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  addEventListener(type: "geometrychange", listener: EventListener): void;
  removeEventListener(type: "geometrychange", listener: EventListener): void;
}

function getWindowControlsOverlay(): WindowControlsOverlayLike | null {
  if (typeof navigator === "undefined") return null;
  const candidate = navigator as Navigator & {
    readonly windowControlsOverlay?: WindowControlsOverlayLike;
  };
  return candidate.windowControlsOverlay ?? null;
}

/** Mirrors the native window-controls overlay onto `<html class="wco">` for the `wco:` variant. */
export function syncDocumentWindowControlsOverlayClass(): () => void {
  if (typeof document === "undefined") return () => undefined;

  const overlay = getWindowControlsOverlay();
  const update = () => {
    document.documentElement.classList.toggle(WCO_CLASS_NAME, overlay?.visible === true);
  };

  update();
  if (!overlay) return () => undefined;
  overlay.addEventListener("geometrychange", update);
  return () => {
    overlay.removeEventListener("geometrychange", update);
  };
}
