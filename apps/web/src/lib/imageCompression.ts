/**
 * Fits pasted or dropped images before they are attached. A PNG or JPEG longer than
 * `IMAGE_ATTACHMENT_MAX_EDGE` on a side is scaled to that edge in its own format (so PNG
 * transparency survives), and anything still over the byte cap is re-encoded (WebP, else
 * JPEG), stepping quality down and then resolution, instead of being rejected.
 */

/**
 * Longest edge a PNG or JPEG attachment keeps. Anthropic rejects an image over 2000px on a side
 * once a request holds many images, and Claude Code resends earlier images on every turn, so one
 * large paste would break every later request in that thread.
 */
export const IMAGE_ATTACHMENT_MAX_EDGE = 2000;
/** Sources over this are refused: decoding hundreds of megapixels can run the tab out of memory. */
export const MAX_COMPRESSIBLE_SOURCE_BYTES = 50 * 1024 * 1024;
/** Small encoded files can still decode huge (a flat 20000px PNG is ~1.6GB of RGBA), so cap pixels too. */
export const MAX_DECODABLE_SOURCE_PIXELS = 100_000_000;
/** Enough header for a JPEG whose frame sits behind a few 64 KiB metadata segments. */
export const IMAGE_DIMENSIONS_HEADER_BYTES = 256 * 1024;
/** Tried in order until the encoding fits; below the floor resolution drops instead. */
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
const FALLBACK_SCALE_STEPS = [0.75, 0.55] as const;

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export type ImageCompressionFailureReason = "too-large" | "unreadable";

export type FitImageResult =
  | { ok: true; file: File; recompressed: boolean; imageSize?: ImageSize }
  | { ok: false; reason: ImageCompressionFailureReason };

type DownscalableImageMimeType = "image/png" | "image/jpeg";

export function downscalableImageMimeType(mimeType: string): DownscalableImageMimeType | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  return null;
}

/** The size that brings the long edge down to `IMAGE_ATTACHMENT_MAX_EDGE`, or null when it fits. */
export function fitImageAttachmentSize(size: ImageSize): ImageSize | null {
  const longestEdge = Math.max(size.width, size.height);
  if (longestEdge <= IMAGE_ATTACHMENT_MAX_EDGE) return null;
  const scale = IMAGE_ATTACHMENT_MAX_EDGE / longestEdge;
  return {
    width: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(size.width * scale))),
    height: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(size.height * scale))),
  };
}

/** Reads PNG or JPEG pixel dimensions from header bytes; null for other or malformed files. */
export function readImageDimensions(bytes: Uint8Array): ImageSize | null {
  const dimensions = readPngDimensions(bytes) ?? readJpegDimensions(bytes);
  return dimensions && dimensions.width > 0 && dimensions.height > 0 ? dimensions : null;
}

/** Like readImageDimensions, plus GIF and WebP, for the decode guard; null when unknown. */
export function readDecodeDimensions(bytes: Uint8Array): ImageSize | null {
  const dimensions =
    readImageDimensions(bytes) ?? readGifDimensions(bytes) ?? readWebpDimensions(bytes);
  return dimensions && dimensions.width > 0 && dimensions.height > 0 ? dimensions : null;
}

/** True when decoding an image of this size would allocate more than the pixel cap. */
export function exceedsDecodablePixels(size: ImageSize | null): boolean {
  return size !== null && size.width * size.height > MAX_DECODABLE_SOURCE_PIXELS;
}

const asciiAt = (bytes: Uint8Array, offset: number, text: string) =>
  Array.from(text).every((char, index) => bytes[offset + index] === char.charCodeAt(0));

function readGifDimensions(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 10 || !asciiAt(bytes, 0, "GIF8")) return null;
  const data = dataView(bytes);
  return { width: data.getUint16(6, true), height: data.getUint16(8, true) };
}

function readWebpDimensions(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30 || !asciiAt(bytes, 0, "RIFF") || !asciiAt(bytes, 8, "WEBP")) return null;
  const data = dataView(bytes);
  if (asciiAt(bytes, 12, "VP8X")) {
    const width = 1 + (data.getUint16(24, true) | (bytes[26]! << 16));
    const height = 1 + (data.getUint16(27, true) | (bytes[29]! << 16));
    return { width, height };
  }
  if (asciiAt(bytes, 12, "VP8L")) {
    const bits = data.getUint32(21, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (asciiAt(bytes, 12, "VP8 ")) {
    return { width: data.getUint16(26, true) & 0x3fff, height: data.getUint16(28, true) & 0x3fff };
  }
  return null;
}

async function readFileHeader(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, IMAGE_DIMENSIONS_HEADER_BYTES).arrayBuffer());
}

const dataView = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function readPngDimensions(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47];
  if (signature.some((byte, index) => bytes[index] !== byte)) return null;
  // IHDR must be the first chunk.
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null;
  }
  const data = dataView(bytes);
  return { width: data.getUint32(16), height: data.getUint32(20) };
}

function readJpegDimensions(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const data = dataView(bytes);
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Start-of-frame markers, minus DHT/JPG/DAC which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: data.getUint16(offset + 7), height: data.getUint16(offset + 5) };
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    offset += 2 + data.getUint16(offset + 2);
  }
  return null;
}

function canRecompress(): boolean {
  return (
    typeof createImageBitmap === "function" &&
    (typeof OffscreenCanvas === "function" || typeof document !== "undefined")
  );
}

interface Canvas2D {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

function createCanvas(width: number, height: number): Canvas2D | null {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    return context ? { canvas, context } : null;
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  return context ? { canvas, context } : null;
}

/** A browser that cannot encode `mimeType` hands back another type; treat that as unsupported. */
async function encodeCanvas(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
  mimeType: string,
): Promise<Blob | null> {
  const blob =
    typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement
      ? await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality))
      : await (canvas as OffscreenCanvas).convertToBlob({ type: mimeType, quality });
  return blob?.type === mimeType ? blob : null;
}

let webpEncodeSupport: Promise<boolean> | null = null;

/** Probed once on a 1x1 canvas; browsers without a WebP encoder hand back PNG. */
function supportsWebpEncoding(): Promise<boolean> {
  webpEncodeSupport ??= (async () => {
    const probe = createCanvas(1, 1);
    if (!probe) return false;
    try {
      return (await encodeCanvas(probe.canvas, QUALITY_STEPS[0], "image/webp")) !== null;
    } catch {
      return false;
    }
  })();
  return webpEncodeSupport;
}

/** Test hook: forgets the cached WebP probe. */
export function resetWebpEncodeSupportForTests(): void {
  webpEncodeSupport = null;
}

function fileNameForMimeType(name: string, mimeType: string): string {
  const extension = mimeType === "image/webp" ? ".webp" : ".jpg";
  const dotIndex = name.lastIndexOf(".");
  return `${dotIndex > 0 ? name.slice(0, dotIndex) : name}${extension}`;
}

/** Scales a PNG/JPEG over the max edge down in its own format; null when it fits or cannot be read. */
async function fitImageToMaxEdge(
  file: File,
  header: ImageSize | null,
): Promise<{ file: File; imageSize: ImageSize } | null> {
  const mimeType = downscalableImageMimeType(file.type);
  if (!mimeType || !canRecompress() || file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) return null;
  let bitmap: ImageBitmap | undefined;
  try {
    if (!header || !fitImageAttachmentSize(header) || exceedsDecodablePixels(header)) return null;
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const imageSize = fitImageAttachmentSize(bitmap);
    if (!imageSize) return null;
    const target = createCanvas(imageSize.width, imageSize.height);
    if (!target) return null;
    target.context.imageSmoothingQuality = "high";
    target.context.drawImage(bitmap, 0, 0, imageSize.width, imageSize.height);
    const blob = await encodeCanvas(target.canvas, QUALITY_STEPS[0], mimeType);
    if (!blob) return null;
    return {
      file: new File([blob], file.name, { type: mimeType, lastModified: file.lastModified }),
      imageSize,
    };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

async function encodeWithinBytes(
  bitmap: ImageBitmap,
  maxDimension: number,
  maxBytes: number,
): Promise<{ blob: Blob; mimeType: string; imageSize: ImageSize } | null> {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const target = createCanvas(width, height);
  if (!target) return null;
  // WebP keeps alpha and is smaller; JPEG needs a white matte drawn first.
  const mimeType = (await supportsWebpEncoding()) ? "image/webp" : "image/jpeg";
  if (mimeType === "image/jpeg") {
    target.context.fillStyle = "#ffffff";
    target.context.fillRect(0, 0, width, height);
  }
  target.context.drawImage(bitmap, 0, 0, width, height);
  for (const quality of QUALITY_STEPS) {
    const encoded = await encodeCanvas(target.canvas, quality, mimeType);
    if (!encoded) break;
    if (encoded.size <= maxBytes) return { blob: encoded, mimeType, imageSize: { width, height } };
  }
  return null;
}

async function reencodeWithinBytes(
  file: File,
  maxBytes: number,
): Promise<
  | { ok: true; blob: Blob; mimeType: string; imageSize: ImageSize }
  | { ok: false; reason: ImageCompressionFailureReason }
> {
  if (!canRecompress()) return { ok: false, reason: "too-large" };
  let bitmap: ImageBitmap;
  try {
    if (exceedsDecodablePixels(readDecodeDimensions(await readFileHeader(file)))) {
      return { ok: false, reason: "too-large" };
    }
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    // Each pass shrinks from the capped source edge, so fallbacks reduce even small images.
    const baseDimension = Math.min(
      IMAGE_ATTACHMENT_MAX_EDGE,
      Math.max(bitmap.width, bitmap.height),
    );
    let encodeFailed = false;
    for (const dimensionScale of [1, ...FALLBACK_SCALE_STEPS]) {
      const targetDimension = Math.max(1, Math.round(baseDimension * dimensionScale));
      let encoded: Awaited<ReturnType<typeof encodeWithinBytes>>;
      try {
        encoded = await encodeWithinBytes(bitmap, targetDimension, maxBytes);
      } catch {
        // Canvas allocation can fail because the target is too big; a smaller pass may work.
        encodeFailed = true;
        continue;
      }
      encodeFailed = false;
      if (encoded) return { ok: true, ...encoded };
    }
    return { ok: false, reason: encodeFailed ? "unreadable" : "too-large" };
  } finally {
    bitmap.close();
  }
}

/**
 * Prepares an image for attaching: scales an oversized PNG/JPEG to the max edge, then shrinks
 * anything still over `maxBytes`. Images that already fit keep their exact bytes.
 */
export async function fitImageForAttachment(file: File, maxBytes: number): Promise<FitImageResult> {
  const header = downscalableImageMimeType(file.type)
    ? await readFileHeader(file)
        .then(readImageDimensions)
        .catch(() => null)
    : null;
  if (exceedsDecodablePixels(header)) return { ok: false, reason: "too-large" };
  const fitted = await fitImageToMaxEdge(file, header);
  if (fitted && fitted.file.size <= maxBytes) {
    return { ok: true, file: fitted.file, recompressed: true, imageSize: fitted.imageSize };
  }
  if (!fitted && file.size <= maxBytes) return { ok: true, file, recompressed: false };
  if (file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) return { ok: false, reason: "too-large" };
  const reencoded = await reencodeWithinBytes(fitted?.file ?? file, maxBytes);
  if (!reencoded.ok) return reencoded;
  return {
    ok: true,
    file: new File(
      [reencoded.blob],
      fileNameForMimeType(file.name || "image", reencoded.mimeType),
      { type: reencoded.mimeType, lastModified: file.lastModified },
    ),
    recompressed: true,
    imageSize: reencoded.imageSize,
  };
}
