import { ImageOffIcon } from "lucide-react";
import { useState, type KeyboardEvent as ReactKeyboardEvent, use, createContext } from "react";

import { LRUCache } from "~/lib/lruCache";
import { cn } from "~/lib/utils";
import {
  classifyMarkdownImageSource,
  MARKDOWN_IMAGE_EXPANDABLE_PROPERTY,
  markdownImageBoxStyle,
  markdownImageCopy,
  markdownImageGallery,
  markdownImagePlaceholderStyle,
  type MarkdownImageSize,
  workspaceImageUrl,
} from "../../markdown-images";
import { useExpandedImageStore } from "../ChatView.expandedImage";

/** True inside a markdown link, whose image keeps opening the link rather than the preview. */
export const MarkdownLinkContext = createContext(false);

// Virtualized rows remount as they scroll by; a seen size keeps the row's height across that.
const NATURAL_SIZE_CACHE_ENTRIES = 500;
const naturalSizes = new LRUCache<MarkdownImageSize>(
  NATURAL_SIZE_CACHE_ENTRIES,
  NATURAL_SIZE_CACHE_ENTRIES,
);

function authoredPixels(value: string | number | undefined): number | undefined {
  const pixels = Number(value);
  return Number.isFinite(pixels) && pixels > 0 ? pixels : undefined;
}

function openPreview(image: HTMLImageElement) {
  useExpandedImageStore.getState().open(markdownImageGallery(image));
}

function handlePreviewKeyDown(event: ReactKeyboardEvent<HTMLImageElement>) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openPreview(event.currentTarget);
}

/** Spans throughout, since a markdown image sits inside a paragraph. */
export function ChatMarkdownImage({
  src,
  alt = "",
  title,
  width,
  height,
  cwd,
  threadId,
  standalone = true,
}: {
  src: string | undefined;
  alt?: string | undefined;
  title?: string | undefined;
  width?: string | number | undefined;
  height?: string | number | undefined;
  cwd: string | undefined;
  /** The server checks a local image against this thread's workspace; without it they stay chips. */
  threadId: string | undefined;
  /** False for an image sharing its line, like a badge, which must not hold a large block. */
  standalone?: boolean | undefined;
}) {
  const linked = use(MarkdownLinkContext);
  // By URL, so a source that changes while streaming starts over instead of keeping an old failure.
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const source = classifyMarkdownImageSource(src, cwd);
  const url =
    source._tag === "Direct"
      ? source.uri
      : source._tag === "WorkspaceFile" && threadId
        ? workspaceImageUrl(threadId, source.path)
        : null;
  const copyMarkdown = markdownImageCopy(alt, src ?? "");

  if (url === null || failedUrl === url) {
    return (
      <span
        data-markdown-copy={copyMarkdown}
        data-markdown-heading-text=""
        data-thread-find-ignore=""
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/40 bg-muted/40 px-2 py-1 align-middle text-xs text-muted-foreground"
      >
        <ImageOffIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {["Image unavailable", alt].filter(Boolean).join(" · ")}
        </span>
      </span>
    );
  }

  const authoredWidth = authoredPixels(width);
  const authoredHeight = authoredPixels(height);
  const loaded = loadedUrl === url;
  const expandable = loaded && !linked;
  return (
    <span
      data-markdown-copy={copyMarkdown}
      data-markdown-heading-text=""
      className="relative inline-block max-w-full align-top"
    >
      {loaded ? null : (
        <span
          aria-hidden
          className={cn(
            "block max-h-[30rem] max-w-full rounded-lg",
            standalone ? "h-24 w-48 animate-pulse bg-muted/60" : "size-4",
          )}
          style={markdownImagePlaceholderStyle(
            authoredWidth,
            authoredHeight,
            naturalSizes.get(url),
          )}
        />
      )}
      <img
        src={url}
        alt={alt}
        title={title}
        loading="lazy"
        decoding="async"
        draggable={false}
        // The clipboard's HTML reads this rather than a URL holding the auth token.
        data-markdown-image-source={src}
        className={cn(
          "rounded-lg border border-border/40 object-contain",
          loaded
            ? "h-auto w-auto max-h-[30rem] max-w-[min(100%,30rem)]"
            : "absolute inset-0 size-full opacity-0",
          expandable && "cursor-zoom-in",
        )}
        style={loaded ? markdownImageBoxStyle(authoredWidth, authoredHeight) : undefined}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          // A data URL decodes at once, and as a key it would keep the whole image alive.
          if (naturalWidth > 0 && naturalHeight > 0 && !url.startsWith("data:")) {
            naturalSizes.set(url, { width: naturalWidth, height: naturalHeight }, 1);
          }
          setLoadedUrl(url);
          setFailedUrl(null);
        }}
        onError={() => setFailedUrl(url)}
        // In the gallery from the start: a lazy image may not have loaded when another one opens it.
        {...(linked ? {} : { [MARKDOWN_IMAGE_EXPANDABLE_PROPERTY]: "" })}
        {...(expandable
          ? {
              role: "button",
              tabIndex: 0,
              "aria-label": `Preview ${alt.trim() || "image"}`,
              onClick: (event: { currentTarget: HTMLImageElement }) =>
                openPreview(event.currentTarget),
              onKeyDown: handlePreviewKeyDown,
            }
          : {})}
      />
    </span>
  );
}
