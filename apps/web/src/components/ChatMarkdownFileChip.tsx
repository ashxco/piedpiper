import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { openInPreferredEditor } from "../editorPreferences";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { useTheme } from "../hooks/useTheme";
import {
  resolveMarkdownFileLinkOpenTarget,
  unverifiedRepeatedPrefixPath,
} from "../markdown-basename-lookup";
import { fileChipMarkdown, type MarkdownFileChipMeta } from "../markdown-file-chip";
import { fileChipClipboardPath, fileChipMenuItems } from "../markdown-file-chip-menu";
import { readNativeApi } from "../nativeApi";
import { getServerConfig } from "../rpc/serverState";
import { getWsRpcClient } from "../wsRpcClient";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { toastManager } from "./ui/toast";

function errorDescription(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

/** Where the native menu opens; keyboard-opened menus report 0,0, so anchor them under the chip. */
function contextMenuPosition(event: { clientX: number; clientY: number; currentTarget: Element }): {
  x: number;
  y: number;
} {
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY };
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

// A later click took over, so this copy ends without a toast.
const SUPERSEDED_COPY = new Error("Superseded by a later click.");

/** Starts the write before a server lookup finishes, so Safari keeps the user gesture. */
function writeLookedUpTextToClipboard(value: Promise<string>): Promise<void> {
  if (typeof navigator.clipboard?.write !== "function" || typeof ClipboardItem === "undefined") {
    return value.then(writeTextToClipboard);
  }
  return navigator.clipboard.write([
    new ClipboardItem({
      "text/plain": value.then((text) => new Blob([text], { type: "text/plain" })),
    }),
  ]);
}

export interface ChatMarkdownFileChipProps {
  href: string;
  cwd: string | undefined;
  meta: MarkdownFileChipMeta;
  /** Parent folders shown after the name to tell same-named files apart. */
  parentSuffix: string;
  /** Closing punctuation kept on the chip's line. */
  trailing: string | undefined;
  /** The link text the agent wrote; null when it only spelled the path. */
  authoredLabel: ReactNode | null;
  authoredText: string;
  /** Markdown copied for the chip instead of a link, e.g. the inline code it was made from. */
  copyMarkdown?: string | undefined;
  /** Shows only the authored label as a plain link, for content a pill cannot hold like an image. */
  bareLabel?: boolean | undefined;
  className?: string | undefined;
}

/** A file link rendered as a compact chip: icon, name, full-path tooltip and a context menu. */
export function ChatMarkdownFileChip({
  href,
  cwd,
  meta,
  parentSuffix,
  trailing,
  authoredLabel,
  authoredText,
  copyMarkdown,
  bareLabel = false,
  className,
}: ChatMarkdownFileChipProps) {
  const { resolvedTheme } = useTheme();
  const repeatedPrefixPath = unverifiedRepeatedPrefixPath(href, cwd);

  const resolveTarget = async (): Promise<string | null> => {
    const api = readNativeApi();
    return resolveMarkdownFileLinkOpenTarget({
      href,
      targetPath: meta.targetPath,
      cwd,
      searchEntries: api ? (input) => api.projects.searchEntries(input) : undefined,
      statPath: (path) =>
        getWsRpcClient()
          .projects.statPath({ path })
          .then((result) => result.kind),
    });
  };

  const openFile = () => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({ type: "error", title: "Open in editor is unavailable" });
      return;
    }
    void resolveTarget()
      .then((openTarget) => (openTarget ? openInPreferredEditor(api, openTarget) : undefined))
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Unable to open file",
          description: errorDescription(error),
        });
      });
  };

  const revealFile = () => {
    const api = readNativeApi();
    if (!api) return;
    // The target may keep its :line:col suffix; the server strips it.
    void resolveTarget()
      .then((target) =>
        target ? api.shell.openInEditor(target, "file-manager", { reveal: true }) : undefined,
      )
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Unable to reveal file",
          description: errorDescription(error),
        });
      });
  };

  const copyPath = (kind: "relative" | "full") => {
    const title = kind === "relative" ? "Relative path" : "Full path";
    const value = resolveTarget().then((target) => {
      if (!target) throw SUPERSEDED_COPY;
      return fileChipClipboardPath(target, kind, cwd);
    });
    // Only these two ask the server where the file is; the rest settle within the gesture anyway.
    const needsLookup = meta.isBareFileName || repeatedPrefixPath !== null;
    const write = needsLookup
      ? writeLookedUpTextToClipboard(value)
      : value.then(writeTextToClipboard);
    void Promise.all([write, value])
      .then(([, text]) => {
        toastManager.add({ type: "success", title: `${title} copied`, description: text });
      })
      .catch((error: unknown) => {
        if (error === SUPERSEDED_COPY) return;
        toastManager.add({
          type: "error",
          title: `Failed to copy ${title.toLowerCase()}`,
          description: errorDescription(error),
        });
      });
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    const api = readNativeApi();
    if (!api) return;
    event.preventDefault();
    event.stopPropagation();
    // Read on right-click so each chip does not subscribe to the server config.
    const items = fileChipMenuItems({
      canCopyRelative: meta.relativePath !== null || (meta.isBareFileName && Boolean(cwd)),
      availableEditors: getServerConfig()?.availableEditors ?? [],
      platform: navigator.platform,
    });
    void api.contextMenu
      .show(items, contextMenuPosition(event))
      .then((clicked) => {
        if (clicked === "open") openFile();
        else if (clicked === "reveal") revealFile();
        else if (clicked === "copy-relative") copyPath("relative");
        else if (clicked === "copy-full") copyPath("full");
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Unable to open file menu",
          description: errorDescription(error),
        });
      });
  };

  const tooltip = meta.isBareFileName
    ? `${meta.basename}${meta.position}`
    : (repeatedPrefixPath ?? meta.targetPath);
  const chip = (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={href}
            dir="ltr"
            className={[
              bareLabel
                ? "chat-markdown-file-link rounded-lg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                : "chat-markdown-file-link relative top-px inline-flex max-w-full items-center gap-1 rounded-md border border-border/90 bg-muted px-1.5 py-px align-text-bottom font-mono text-xs leading-tight text-foreground no-underline! hover:bg-muted/70 hover:opacity-100! focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              className ?? "",
            ].join(" ")}
            data-markdown-copy={copyMarkdown ?? fileChipMarkdown(authoredText, href)}
            data-markdown-heading-text={authoredText}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openFile();
            }}
            onContextMenu={handleContextMenu}
          />
        }
      >
        {bareLabel ? (
          authoredLabel
        ) : (
          <>
            <VscodeEntryIcon
              pathValue={meta.filePath}
              kind={meta.filePath.endsWith("/") ? "directory" : "file"}
              theme={resolvedTheme}
              className="size-3.5 shrink-0 opacity-70"
            />
            {authoredLabel !== null ? (
              <span className="min-w-0 truncate font-sans">{authoredLabel}</span>
            ) : (
              <span className="min-w-0 truncate">
                {meta.basename}
                {meta.position}
                {parentSuffix ? (
                  <span className="ml-1 text-muted-foreground">{parentSuffix}</span>
                ) : null}
              </span>
            )}
          </>
        )}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-[min(40rem,calc(100vw-2rem))]">
        <div className="overflow-x-auto font-mono text-[11px] leading-tight whitespace-nowrap">
          {tooltip}
        </div>
      </TooltipPopup>
    </Tooltip>
  );

  if (!trailing) return chip;
  // A bare label holds running text and images, which have to wrap with the paragraph.
  if (bareLabel) {
    return (
      <>
        {chip}
        {trailing}
      </>
    );
  }
  return (
    <span className="whitespace-nowrap">
      {chip}
      {trailing}
    </span>
  );
}
