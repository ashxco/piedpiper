import { Effect, FileSystem } from "effect";

const ICNS_HEADER_BYTES = 8;
const ICNS_MAGIC = 0x69636e73; // "icns"
const PNG_MAGIC = 0x89504e47; // "\x89PNG"
const PNG_IHDR = 0x49484452; // "IHDR"
const PNG_IHDR_WIDTH_END = 20;
// Clients draw project icons from a 96px thumbnail at most.
export const PROJECT_FAVICON_ICNS_MIN_SIZE = 96;

export function isIcnsPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".icns");
}

function readPngWidth(png: Uint8Array): number | null {
  if (png.length < PNG_IHDR_WIDTH_END) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (view.getUint32(0) !== PNG_MAGIC || view.getUint32(12) !== PNG_IHDR) return null;
  const width = view.getUint32(16);
  return width > 0 ? width : null;
}

/**
 * Picks the smallest embedded PNG at least `minSize` wide, else the largest; null when there is none.
 * Returns a copy so the response does not pin the whole `.icns` buffer.
 */
export function extractIcnsPng(bytes: Uint8Array, minSize: number): Uint8Array | null {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < ICNS_HEADER_BYTES || data.getUint32(0) !== ICNS_MAGIC) return null;
  const end = Math.min(data.getUint32(4), bytes.length);
  let best: { readonly png: Uint8Array; readonly width: number } | null = null;
  for (let offset = ICNS_HEADER_BYTES; offset + ICNS_HEADER_BYTES <= end; ) {
    const length = data.getUint32(offset + 4);
    if (length < ICNS_HEADER_BYTES || offset + length > end) break;
    const width = readPngWidth(bytes.subarray(offset + ICNS_HEADER_BYTES, offset + length));
    if (width !== null) {
      const isBetter =
        best === null ||
        (best.width < minSize ? width > best.width : width >= minSize && width < best.width);
      if (isBetter) {
        best = { png: bytes.subarray(offset + ICNS_HEADER_BYTES, offset + length), width };
      }
    }
    offset += length;
  }
  return best?.png.slice() ?? null;
}

/** Reads an `.icns` app icon and returns its best embedded PNG, or null when it has none or cannot be read. */
export const readIcnsFaviconPng = Effect.fn("readIcnsFaviconPng")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const bytes = yield* fileSystem.readFile(filePath).pipe(
    Effect.tapError((cause) =>
      Effect.logDebug("failed to read project icns icon", { filePath, cause: String(cause) }),
    ),
    Effect.orElseSucceed(() => null),
  );
  return bytes ? extractIcnsPng(bytes, PROJECT_FAVICON_ICNS_MIN_SIZE) : null;
});
