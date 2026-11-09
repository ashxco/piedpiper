import { CircleAlertIcon, XIcon } from "lucide-react";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { cn } from "~/lib/utils";
import {
  type PreparingComposerImage,
  removePreparingComposerImages,
} from "../ChatView.preparingImages";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";

/**
 * One list with one element shape, so a tile keeps its DOM nodes when its fit ends: the thumbnail
 * cannot flash, and focus or a press on its X survives.
 */
export function ComposerImageTiles(props: {
  readonly threadId: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly preparingImages: ReadonlyArray<PreparingComposerImage>;
  readonly nonPersistedImageIds: ReadonlySet<string>;
  readonly onRemoveImage: (imageId: string) => void;
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
}) {
  const { threadId, images, preparingImages, nonPersistedImageIds } = props;
  if (images.length === 0 && preparingImages.length === 0) return null;
  const tiles = [
    ...images.map((image) => ({ image, isPreparing: false })),
    ...preparingImages.map((image) => ({ image, isPreparing: true })),
  ];
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {tiles.map(({ image, isPreparing }) => (
        <div
          key={image.id}
          {...(isPreparing ? { role: "status", "aria-label": `Preparing ${image.name}` } : {})}
          className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
        >
          {image.previewUrl ? (
            <button
              type="button"
              disabled={isPreparing}
              className={cn("h-full w-full", !isPreparing && "cursor-zoom-in")}
              {...(isPreparing ? {} : { "aria-label": `Preview ${image.name}` })}
              onClick={() => {
                const preview = buildExpandedImagePreview(images, image.id);
                if (preview) props.onExpandImage(preview);
              }}
            >
              <img
                src={image.previewUrl}
                alt={image.name}
                decoding="async"
                className={cn(
                  "h-full w-full transform-gpu object-cover",
                  isPreparing && "opacity-60",
                )}
              />
            </button>
          ) : (
            <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
              {image.name}
            </div>
          )}
          {isPreparing ? (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Spinner className="size-4 text-foreground/80" />
            </span>
          ) : null}
          {!isPreparing && nonPersistedImageIds.has(image.id) && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label="Draft attachment may not persist"
                    className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                  >
                    <CircleAlertIcon className="size-3" />
                  </span>
                }
              />
              <TooltipPopup side="top" className="max-w-64 whitespace-normal leading-tight">
                Draft attachment could not be saved locally and may be lost on navigation.
              </TooltipPopup>
            </Tooltip>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
            onClick={() => {
              // Removing a preparing tile drops the image when its fit ends.
              if (isPreparing) removePreparingComposerImages(threadId, new Set([image.id]));
              else props.onRemoveImage(image.id);
            }}
            aria-label={`Remove ${image.name}`}
          >
            <XIcon />
          </Button>
        </div>
      ))}
    </div>
  );
}
