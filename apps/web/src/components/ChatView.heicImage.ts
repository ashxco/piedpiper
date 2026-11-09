import {
  fitImageForAttachment,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
  type FitImageResult,
  type ImageCompressionFailureReason,
} from "~/lib/imageCompression";

/** Decoding allocates full RGBA buffers, so larger photos are refused before the decoder loads. */
export const MAX_HEIC_DECODE_PIXELS = 64_000_000;
const MAX_HEIC_METADATA_BYTES = 1024 * 1024;
const HEIC_JPEG_QUALITY = 0.92;
/** Retried when a detailed photo's JPEG lands over the compressor's source ceiling. */
const HEIC_FALLBACK_JPEG_QUALITY = 0.7;
// The -sequence types (bursts, Live Photo exports) decode to their primary image.
const HEIC_IMAGE_MIME_TYPE = /^image\/hei(?:c|f)(?:-sequence)?$/i;
const HEIC_IMAGE_EXTENSION = /\.(?:heic|heif)$/i;
const BOX_META = 0x6d657461;
const BOX_IPRP = 0x69707270;
const BOX_IPCO = 0x6970636f;
const BOX_ISPE = 0x69737065;

/** "too-many-pixels" is a HEIC over the decode pixel cap, which can be a small file. */
export type HeicImageFailureReason = ImageCompressionFailureReason | "too-many-pixels";

export type ComposerImageAttachmentResult =
  | Extract<FitImageResult, { ok: true }>
  | { ok: false; reason: HeicImageFailureReason };

/** Finder and some browsers omit the MIME type when dragging HEIC photos. */
export function isHeicImageFile(file: Pick<File, "name" | "type">): boolean {
  if (HEIC_IMAGE_MIME_TYPE.test(file.type)) return true;
  return (
    (file.type === "" || file.type.toLowerCase() === "application/octet-stream") &&
    HEIC_IMAGE_EXTENSION.test(file.name)
  );
}

/** Whether a pasted or dropped file goes down the image attach path. */
export function isComposerImageFile(file: Pick<File, "name" | "type">): boolean {
  return file.type.startsWith("image/") || isHeicImageFile(file);
}

interface IsoBox {
  readonly payloadOffset: number;
  readonly endOffset: number;
}

function findBox(view: DataView, startOffset: number, endOffset: number, type: number) {
  let offset = startOffset;
  while (offset + 8 <= endOffset) {
    let size = view.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > endOffset) return null;
      const extendedSize = view.getBigUint64(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(extendedSize);
      headerSize = 16;
    } else if (size === 0) {
      size = endOffset - offset;
    }
    if (size < headerSize || size > endOffset - offset) return null;
    if (view.getUint32(offset + 4) === type) {
      return { payloadOffset: offset + headerSize, endOffset: offset + size } satisfies IsoBox;
    }
    offset += size;
  }
  return null;
}

/** Reads every `ispe` size from the header; null when they fit the decode cap. */
export async function checkHeicImageDimensions(file: Blob): Promise<HeicImageFailureReason | null> {
  const view = new DataView(await file.slice(0, MAX_HEIC_METADATA_BYTES).arrayBuffer());
  const meta = findBox(view, 0, view.byteLength, BOX_META);
  // `meta` is a full box: 4 bytes of version and flags precede its children.
  if (!meta || meta.payloadOffset + 4 > meta.endOffset) return "unreadable";
  const properties = findBox(view, meta.payloadOffset + 4, meta.endOffset, BOX_IPRP);
  if (!properties) return "unreadable";
  const containers = findBox(view, properties.payloadOffset, properties.endOffset, BOX_IPCO);
  if (!containers) return "unreadable";

  let offset = containers.payloadOffset;
  let found = false;
  while (offset < containers.endOffset) {
    const image = findBox(view, offset, containers.endOffset, BOX_ISPE);
    if (!image) break;
    if (image.payloadOffset + 12 > image.endOffset) return "unreadable";
    const width = view.getUint32(image.payloadOffset + 4);
    const height = view.getUint32(image.payloadOffset + 8);
    if (width === 0 || height === 0) return "unreadable";
    if (width > MAX_HEIC_DECODE_PIXELS / height) return "too-many-pixels";
    found = true;
    offset = image.endOffset;
  }
  return found ? null : "unreadable";
}

function jpegFileName(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return `${dotIndex > 0 ? name.slice(0, dotIndex) : name}.jpg`;
}

/** Decodes a HEIC/HEIF photo to JPEG with a lazily loaded decoder (it bundles a large WASM). */
export async function convertHeicImageToJpeg(
  file: File,
): Promise<{ ok: true; file: File } | { ok: false; reason: HeicImageFailureReason }> {
  if (file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) return { ok: false, reason: "too-large" };
  try {
    const dimensionError = await checkHeicImageDimensions(file);
    if (dimensionError) return { ok: false, reason: dimensionError };
    const { heicTo } = await import("heic-to/csp");
    let converted = await heicTo({ blob: file, type: "image/jpeg", quality: HEIC_JPEG_QUALITY });
    if (converted.size > MAX_COMPRESSIBLE_SOURCE_BYTES) {
      converted = await heicTo({
        blob: file,
        type: "image/jpeg",
        quality: HEIC_FALLBACK_JPEG_QUALITY,
      });
      if (converted.size > MAX_COMPRESSIBLE_SOURCE_BYTES) return { ok: false, reason: "too-large" };
    }
    return {
      ok: true,
      file: new File([converted], jpegFileName(file.name || "image"), {
        type: "image/jpeg",
        lastModified: file.lastModified,
      }),
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/** Converts HEIC/HEIF to JPEG first, then applies the usual edge and byte fitting. */
export async function prepareComposerImageAttachment(
  file: File,
  maxBytes: number,
): Promise<ComposerImageAttachmentResult> {
  if (!isHeicImageFile(file)) return fitImageForAttachment(file, maxBytes);
  const converted = await convertHeicImageToJpeg(file);
  if (!converted.ok) return converted;
  const fitted = await fitImageForAttachment(converted.file, maxBytes);
  return fitted.ok ? { ...fitted, recompressed: true } : fitted;
}
