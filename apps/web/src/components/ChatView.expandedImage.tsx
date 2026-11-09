import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { ZoomableImage, type ZoomableImageHandle } from "./chat/ZoomableImage";
import { Button } from "./ui/button";

interface ExpandedImageStore {
  preview: ExpandedImagePreview | null;
  open: (preview: ExpandedImagePreview) => void;
  close: () => void;
  step: (direction: -1 | 1) => void;
}

export function stepExpandedImagePreview(
  preview: ExpandedImagePreview | null,
  direction: -1 | 1,
): ExpandedImagePreview | null {
  if (!preview || preview.images.length <= 1) return preview;
  const nextIndex = (preview.index + direction + preview.images.length) % preview.images.length;
  return nextIndex === preview.index ? preview : { ...preview, index: nextIndex };
}

/** Kept outside ChatView so opening or stepping the preview does not re-render the chat. */
export const useExpandedImageStore = create<ExpandedImageStore>((set) => ({
  preview: null,
  open: (preview) => set({ preview }),
  close: () => set((state) => (state.preview === null ? state : { preview: null })),
  step: (direction) =>
    set((state) => {
      const next = stepExpandedImagePreview(state.preview, direction);
      return next === state.preview ? state : { preview: next };
    }),
}));

export function isExpandedImageOpen(): boolean {
  return useExpandedImageStore.getState().preview !== null;
}

/** Rendered once by ChatView; owns the preview markup and its keyboard handling. */
export function ExpandedImageDialog() {
  const preview = useExpandedImageStore((state) => state.preview);
  // The store outlives the chat view, so leaving it must not leave a stale preview behind.
  useEffect(() => () => useExpandedImageStore.getState().close(), []);
  const item = preview ? preview.images[preview.index] : undefined;
  if (!preview || !item) return null;
  return (
    <ExpandedImageDialogContent
      imageCount={preview.images.length}
      index={preview.index}
      src={item.src}
      name={item.name}
    />
  );
}

function ExpandedImageDialogContent({
  imageCount,
  index,
  src,
  name,
}: {
  imageCount: number;
  index: number;
  src: string;
  name: string;
}) {
  const close = useExpandedImageStore((state) => state.close);
  const step = useExpandedImageStore((state) => state.step);
  const hasMultiple = imageCount > 1;
  const zoomableImageRef = useRef<ZoomableImageHandle>(null);

  // Put focus back on the opener (usually the composer) when the preview closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    // Swallow these keys so the composer and global shortcuts never see them.
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      // A zoomed image takes the arrow keys for panning before they step images.
      if (zoomableImageRef.current?.pan(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!hasMultiple) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      step(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, hasMultiple, step]);

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={close}
      />
      {hasMultiple && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => step(-1)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      )}
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="absolute right-2 top-2 z-10"
          onClick={close}
          aria-label="Close image preview"
        >
          <XIcon />
        </Button>
        <ZoomableImage ref={zoomableImageRef} key={`${index}:${src}`} src={src} name={name} />
        <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
          {name}
          {hasMultiple ? ` (${index + 1}/${imageCount})` : ""}
        </p>
      </div>
      {hasMultiple && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => step(1)}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </div>
  );
}
