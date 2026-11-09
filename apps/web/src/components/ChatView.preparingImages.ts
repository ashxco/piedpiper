import { create } from "zustand";

import { isHeicImageFile } from "./ChatView.heicImage";

export interface PreparingComposerImage {
  /** The id the fitted image takes in the draft. */
  readonly id: string;
  readonly name: string;
  /** Null shows the name instead: the browser can't decode the source, or it is too big to thumbnail. */
  readonly previewUrl: string | null;
}

/** Decoding a source this large for a tile that lasts moments would stall the composer. */
export const MAX_PREPARING_IMAGE_THUMBNAIL_BYTES = 20 * 1024 * 1024;

const NO_PREPARING_IMAGES: ReadonlyArray<PreparingComposerImage> = [];

/**
 * Images accepted into a thread's draft but still being fitted. They hold their attachment slots
 * and any send until the fitted image joins the draft or the tile is removed.
 */
const usePreparingComposerImageStore = create<{
  readonly byThreadId: Readonly<Record<string, ReadonlyArray<PreparingComposerImage>>>;
}>(() => ({ byThreadId: {} }));

export function usePreparingComposerImages(
  threadId: string | null,
): ReadonlyArray<PreparingComposerImage> {
  return usePreparingComposerImageStore((state) =>
    threadId === null ? NO_PREPARING_IMAGES : (state.byThreadId[threadId] ?? NO_PREPARING_IMAGES),
  );
}

export function readPreparingComposerImages(
  threadId: string,
): ReadonlyArray<PreparingComposerImage> {
  return usePreparingComposerImageStore.getState().byThreadId[threadId] ?? NO_PREPARING_IMAGES;
}

export function countPreparingComposerImages(threadId: string): number {
  return readPreparingComposerImages(threadId).length;
}

export function canThumbnailPreparingImage(file: Pick<File, "name" | "type" | "size">): boolean {
  return !isHeicImageFile(file) && file.size <= MAX_PREPARING_IMAGE_THUMBNAIL_BYTES;
}

export function createPreparingComposerImage(id: string, file: File): PreparingComposerImage {
  return {
    id,
    name: file.name || "image",
    previewUrl: canThumbnailPreparingImage(file) ? URL.createObjectURL(file) : null,
  };
}

export function addPreparingComposerImages(
  threadId: string,
  images: ReadonlyArray<PreparingComposerImage>,
): void {
  usePreparingComposerImageStore.setState((state) => ({
    byThreadId: {
      ...state.byThreadId,
      [threadId]: [...(state.byThreadId[threadId] ?? NO_PREPARING_IMAGES), ...images],
    },
  }));
}

/** Revokes the removed tiles' previews and returns the ids that were still preparing. */
export function removePreparingComposerImages(
  threadId: string,
  imageIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const current = readPreparingComposerImages(threadId);
  const removed = current.filter((image) => imageIds.has(image.id));
  if (removed.length === 0) return new Set();
  for (const image of removed) {
    if (image.previewUrl !== null) URL.revokeObjectURL(image.previewUrl);
  }
  const remaining = current.filter((image) => !imageIds.has(image.id));
  usePreparingComposerImageStore.setState((state) => {
    const byThreadId = { ...state.byThreadId };
    if (remaining.length > 0) byThreadId[threadId] = remaining;
    else delete byThreadId[threadId];
    return { byThreadId };
  });
  return new Set(removed.map((image) => image.id));
}

/** Keeps a fitted batch's entries whose tile was not removed, so a cancelled image reports nothing. */
export function keepStillPreparingImages<T extends { readonly id: string }>(
  batch: ReadonlyArray<T>,
  stillPreparingIds: ReadonlySet<string>,
): T[] {
  return batch.filter((entry) => stillPreparingIds.has(entry.id));
}
