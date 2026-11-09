import type { CSSProperties } from "react";

import { appendAuthToken } from "./rpc/authToken";
import { resolveServerUrl } from "./lib/utils";
import { markdownLinkDestination } from "./markdown-file-chip";
import { inlineMarkdownMarker, wrapInlineCode, wrapInlineMarker } from "./markdown-inline-markers";
import {
  isLocalFileMarkdownHref,
  isNetworkPath,
  isWindowsAbsolutePath,
  normalizeWindowsDrivePath,
  rewriteMarkdownFileUriHref,
  safeDecode,
  stripSearchAndHash,
} from "./markdown-links";
import { resolvePathLinkTarget } from "./terminal-links";

export const WORKSPACE_IMAGE_ROUTE_PATH = "/api/workspace-image";

export type MarkdownImageSource =
  | { readonly _tag: "Direct"; readonly uri: string }
  | { readonly _tag: "WorkspaceFile"; readonly path: string }
  | { readonly _tag: "Blocked" };

const BLOCKED: MarkdownImageSource = { _tag: "Blocked" };
const DIRECT_IMAGE_SOURCE_PATTERN = /^(?:https?:\/\/|data:image\/|blob:)/i;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * How an image source loads. Filesystem paths only ever load through the server, which checks them
 * against the thread's workspace. Network paths never load, since Windows would sign in to the host.
 */
export function classifyMarkdownImageSource(
  value: string | null | undefined,
  cwd: string | null | undefined,
): MarkdownImageSource {
  const source = value?.trim();
  if (!source || source.startsWith("#") || source.startsWith("?")) return BLOCKED;
  if (DIRECT_IMAGE_SOURCE_PATTERN.test(source)) return { _tag: "Direct", uri: source };

  const location = /^file:/i.test(source) ? rewriteMarkdownFileUriHref(source) : source;
  if (location === null) return BLOCKED;
  const path = normalizeWindowsDrivePath(safeDecode(stripSearchAndHash(location).path));
  if (path.length === 0 || isNetworkPath(path)) return BLOCKED;
  if (path.startsWith("/") || isWindowsAbsolutePath(path)) return { _tag: "WorkspaceFile", path };
  if (URI_SCHEME_PATTERN.test(path) || path.startsWith("~/") || path.startsWith("~\\")) {
    return BLOCKED;
  }
  return cwd ? { _tag: "WorkspaceFile", path: resolvePathLinkTarget(path, cwd) } : BLOCKED;
}

/** Sources react-markdown's default URL sanitizer would blank but the image renderer classifies. */
export function isPreservedMarkdownImageSource(url: string): boolean {
  return /^(?:data:image\/|blob:)/i.test(url.trim()) || isLocalFileMarkdownHref(url);
}

/** `<img>` requests cannot set headers and desktop mode has no auth cookie, so the token is a query. */
export function workspaceImageUrl(threadId: string, path: string): string {
  const url = new URL(
    resolveServerUrl({ pathname: WORKSPACE_IMAGE_ROUTE_PATH, searchParams: { threadId, path } }),
  );
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return appendAuthToken(url.toString());
}

function escapeMarkdownLabel(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

export function markdownImageCopy(alt: string, src: string): string {
  return `![${escapeMarkdownLabel(alt)}](${src})`;
}

export interface MarkdownImageGallery {
  images: { src: string; name: string }[];
  index: number;
}

/** Marks an `<img>` that opens the preview; a linked image keeps its link instead. */
export const MARKDOWN_IMAGE_EXPANDABLE_PROPERTY = "data-markdown-image-expandable";

/** The images of the message holding `image`, in reading order, with `image` selected. */
export function markdownImageGallery(image: HTMLImageElement): MarkdownImageGallery {
  const scope = image.closest(".chat-markdown");
  const candidates = scope?.querySelectorAll<HTMLImageElement>(
    `img[${MARKDOWN_IMAGE_EXPANDABLE_PROPERTY}]`,
  );
  const elements = candidates && candidates.length > 0 ? [...candidates] : [image];
  return {
    images: elements.map((element) => ({
      src: element.currentSrc || element.src,
      name: element.alt.trim() || "image",
    })),
    index: Math.max(0, elements.indexOf(image)),
  };
}

export interface MarkdownImageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Bounds a loaded image by what the author set, within the 30rem cap. With both sides known the
 * height cap has to fold into the width: max-height alone leaves a box wider than its picture.
 */
export function markdownImageBoxStyle(
  width: number | undefined,
  height: number | undefined,
): CSSProperties | undefined {
  if (width !== undefined && height !== undefined) {
    return {
      width,
      height: "auto",
      aspectRatio: `${width} / ${height}`,
      maxWidth: `min(100%, 30rem, ${(30 * width) / height}rem)`,
    };
  }
  if (width !== undefined) return { width, maxWidth: "min(100%, 30rem)" };
  if (height !== undefined) return { width: "auto", height: `min(30rem, ${height}px)` };
  return undefined;
}

/** Holds the room an image will take: what the author set, completed by a size seen before. */
export function markdownImagePlaceholderStyle(
  width: number | undefined,
  height: number | undefined,
  natural: MarkdownImageSize | null,
): CSSProperties | undefined {
  if (natural) {
    const ratio = natural.width / natural.height;
    const knownWidth = width ?? (height === undefined ? natural.width : height * ratio);
    return markdownImageBoxStyle(knownWidth, height ?? knownWidth / ratio);
  }
  if (height !== undefined && width === undefined) return { height: `min(30rem, ${height}px)` };
  return markdownImageBoxStyle(width, height);
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** True when an image sits anywhere inside `node`, such as a link wrapping a screenshot. */
export function hastHasImage(node: HastNode): boolean {
  return node.tagName === "img" || (node.children ?? []).some(hastHasImage);
}

function hastText(node: HastNode): string {
  return node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(hastText).join("");
}

function linkLabelCopy(node: HastNode): string {
  if (node.type === "text") return escapeMarkdownLabel(node.value ?? "");
  if (node.tagName === "img") {
    return markdownImageCopy(
      String(node.properties?.alt ?? ""),
      String(node.properties?.src ?? ""),
    );
  }
  if (node.tagName === "code") return wrapInlineCode(hastText(node));
  const content = (node.children ?? []).map(linkLabelCopy).join("");
  const marker = inlineMarkdownMarker(node.tagName ?? "");
  return marker ? wrapInlineMarker(content, marker) : content;
}

/** The Markdown for a file link holding an image, written from the authored image source. */
export function linkedImageCopy(link: HastNode, href: string): string {
  return `[${linkLabelCopy(link).trim()}](${markdownLinkDestination(href)})`;
}

/** Set on an `<img>` with a line of its own, which reserves room while it loads; a badge does not. */
export const MARKDOWN_IMAGE_STANDALONE_PROPERTY = "dataMarkdownImageStandalone";

const LINE_BOUNDARY_TAGS: ReadonlySet<string> = new Set(
  "blockquote br details div h1 h2 h3 h4 h5 h6 hr ol p pre summary table ul".split(" "),
);
const isBlankText = (node: HastNode) => node.type === "text" && !/\S/.test(node.value ?? "");
const isLineBoundary = (node: HastNode | undefined) =>
  node === undefined || LINE_BOUNDARY_TAGS.has(node.tagName ?? "");

function imageOfLineItem(node: HastNode | undefined): HastNode | null {
  if (node?.tagName === "img") return node;
  if (node?.tagName !== "a") return null;
  const content = (node.children ?? []).filter((child) => !isBlankText(child));
  return content.length === 1 && content[0]?.tagName === "img" ? content[0] : null;
}

function markStandaloneImages(parent: HastNode): void {
  const children = (parent.children ?? []).filter((child) => !isBlankText(child));
  children.forEach((child, index) => {
    const image = imageOfLineItem(child);
    if (image && isLineBoundary(children[index - 1]) && isLineBoundary(children[index + 1])) {
      image.properties = { ...image.properties, [MARKDOWN_IMAGE_STANDALONE_PROPERTY]: true };
    }
    if (!image) markStandaloneImages(child);
  });
}

/** Marks the images that sit alone on their line, directly or as the whole of a link. */
export function rehypeMarkStandaloneImages() {
  return (tree: HastNode): void => {
    markStandaloneImages(tree);
  };
}

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

const isImageNode = (node: MdNode | undefined): boolean =>
  node?.type === "image" ||
  node?.type === "imageReference" ||
  ((node?.type === "link" || node?.type === "linkReference") &&
    node.children?.length === 1 &&
    isImageNode(node.children[0]));
const endsLine = (node: MdNode | undefined) =>
  node === undefined ||
  node.type === "break" ||
  (node.type === "text" && /\n[ \t]*$/.test(node.value ?? ""));
const startsLine = (node: MdNode | undefined) =>
  node === undefined ||
  node.type === "break" ||
  (node.type === "text" && /^[ \t]*\n/.test(node.value ?? ""));

function breakLinesAroundImages(paragraph: MdNode): void {
  const children = paragraph.children ?? [];
  if (!children.some(isImageNode)) return;
  const ownsLine = (index: number) =>
    isImageNode(children[index]) &&
    endsLine(children[index - 1]) &&
    startsLine(children[index + 1]);
  paragraph.children = children.flatMap((child, index): MdNode[] => {
    if (child.type !== "text") return [child];
    const afterImage = ownsLine(index - 1);
    const beforeImage = ownsLine(index + 1);
    if (!afterImage && !beforeImage) return [child];
    const parts: MdNode[] = [];
    let value = child.value ?? "";
    if (afterImage) {
      value = value.replace(/^[ \t]*\n/, "");
      parts.push({ type: "break" });
    }
    const breakAfter = beforeImage && /\n[ \t]*$/.test(value);
    if (breakAfter) value = value.replace(/[ \t]*\n[ \t]*$/, "");
    if (value) parts.push({ type: "text", value });
    if (breakAfter) parts.push({ type: "break" });
    return parts;
  });
}

/**
 * Agents label screenshots with a line right above the image, which CommonMark joins into one
 * paragraph. An image alone on its source line keeps that line; inline badges still wrap.
 */
export function remarkBreakAroundImageLines() {
  return (tree: MdNode) => {
    const visit = (node: MdNode) => {
      if (node.type === "paragraph") breakLinesAroundImages(node);
      else node.children?.forEach(visit);
    };
    visit(tree);
  };
}
