import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fitImageAttachmentSize,
  fitImageForAttachment,
  IMAGE_ATTACHMENT_MAX_EDGE,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
  readDecodeDimensions,
  readImageDimensions,
  resetWebpEncodeSupportForTests,
} from "./imageCompression";

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpegHeader(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment to skip, then SOF0 with height before width.
  const bytes = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03,
  ]);
  const view = new DataView(bytes.buffer);
  view.setUint16(13, height);
  view.setUint16(15, width);
  return bytes;
}

function imageFile(header: Uint8Array, sizeBytes: number, type: string, name = "shot.png"): File {
  const bytes = new Uint8Array(Math.max(sizeBytes, header.length)).fill(7);
  bytes.set(header);
  return new File([bytes], name, { type });
}

/**
 * Node has no canvas, so the bitmap and encoder are stubbed. The encoded size follows
 * `sizeFor(quality, width)`, the way a real encoder shrinks with quality and resolution.
 */
function stubCanvas(options: {
  bitmap: { width: number; height: number };
  sizeFor: (quality: number, width: number) => number;
  supportsWebp?: boolean;
}) {
  const close = vi.fn();
  const encodes: Array<{ type: string; quality: number; width: number }> = [];
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ ...options.bitmap, close })),
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn(), imageSmoothingQuality: "" };
      }
      async convertToBlob({ type, quality }: { type: string; quality: number }) {
        encodes.push({ type, quality, width: this.width });
        const resolvedType =
          type === "image/webp" && options.supportsWebp === false ? "image/png" : type;
        return new Blob([new Uint8Array(options.sizeFor(quality, this.width))], {
          type: resolvedType,
        });
      }
    },
  );
  return { close, encodes };
}

function gifHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function webpLosslessHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBPVP8L"), 8);
  bytes[20] = 0x2f;
  new DataView(bytes.buffer).setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return bytes;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetWebpEncodeSupportForTests();
});

describe("readImageDimensions", () => {
  it("reads PNG and JPEG headers and rejects other bytes", () => {
    expect(readImageDimensions(pngHeader(3024, 1964))).toEqual({ width: 3024, height: 1964 });
    expect(readImageDimensions(jpegHeader(4000, 3000))).toEqual({ width: 4000, height: 3000 });
    expect(readImageDimensions(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull();
  });

  it("also reads GIF and WebP headers for the decode guard", () => {
    expect(readDecodeDimensions(gifHeader(640, 480))).toEqual({ width: 640, height: 480 });
    expect(readDecodeDimensions(webpLosslessHeader(12000, 9000))).toEqual({
      width: 12000,
      height: 9000,
    });
    expect(readDecodeDimensions(pngHeader(10, 20))).toEqual({ width: 10, height: 20 });
    expect(readDecodeDimensions(new Uint8Array(8))).toBeNull();
  });
});

describe("fitImageAttachmentSize", () => {
  it("scales the long edge to the max and keeps the aspect ratio", () => {
    expect(fitImageAttachmentSize({ width: 4000, height: 3000 })).toEqual({
      width: IMAGE_ATTACHMENT_MAX_EDGE,
      height: 1500,
    });
    expect(fitImageAttachmentSize({ width: 2000, height: 1200 })).toBeNull();
  });
});

describe("fitImageForAttachment", () => {
  const maxBytes = 1000;

  it("keeps an image that already fits byte for byte", async () => {
    const { encodes } = stubCanvas({ bitmap: { width: 800, height: 600 }, sizeFor: () => 10 });
    const file = imageFile(pngHeader(800, 600), 500, "image/png");

    const result = await fitImageForAttachment(file, maxBytes);

    expect(result).toEqual({ ok: true, file, recompressed: false });
    expect(encodes).toEqual([]);
  });

  it("scales an oversized PNG to the max edge as PNG", async () => {
    const { encodes, close } = stubCanvas({
      bitmap: { width: 4000, height: 3000 },
      sizeFor: () => 400,
    });
    const file = imageFile(pngHeader(4000, 3000), 600, "image/png");

    const result = await fitImageForAttachment(file, maxBytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.type).toBe("image/png");
    expect(result.file.name).toBe("shot.png");
    expect(result.imageSize).toEqual({ width: 2000, height: 1500 });
    expect(encodes).toEqual([{ type: "image/png", quality: 0.92, width: 2000 }]);
    expect(close).toHaveBeenCalled();
  });

  it("re-encodes an over-limit image, stepping quality down until it fits", async () => {
    const { encodes } = stubCanvas({
      bitmap: { width: 1200, height: 800 },
      sizeFor: (quality) => (quality > 0.8 ? 5000 : 900),
    });
    const file = imageFile(pngHeader(1200, 800), 5000, "image/png");

    const result = await fitImageForAttachment(file, maxBytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.type).toBe("image/webp");
    expect(result.file.name).toBe("shot.webp");
    expect(result.file.size).toBeLessThanOrEqual(maxBytes);
    expect(encodes.at(-1)).toEqual({ type: "image/webp", quality: 0.78, width: 1200 });
  });

  it("falls back to JPEG and lower resolution when quality alone is not enough", async () => {
    stubCanvas({
      bitmap: { width: 1200, height: 800 },
      sizeFor: (_quality, width) => (width > 700 ? 5000 : 900),
      supportsWebp: false,
    });
    const file = imageFile(new Uint8Array(), 5000, "image/gif", "anim.gif");

    const result = await fitImageForAttachment(file, maxBytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.type).toBe("image/jpeg");
    expect(result.file.name).toBe("anim.jpg");
    expect(result.imageSize).toEqual({ width: 660, height: 440 });
  });

  it("reports too-large when nothing fits and refuses huge sources without decoding", async () => {
    const { encodes } = stubCanvas({ bitmap: { width: 1200, height: 800 }, sizeFor: () => 5000 });
    expect(
      await fitImageForAttachment(imageFile(new Uint8Array(), 5000, "image/webp"), maxBytes),
    ).toEqual({ ok: false, reason: "too-large" });

    encodes.length = 0;
    const huge = imageFile(new Uint8Array(), 1, "image/webp");
    Object.defineProperty(huge, "size", { value: MAX_COMPRESSIBLE_SOURCE_BYTES + 1 });
    expect(await fitImageForAttachment(huge, maxBytes)).toEqual({ ok: false, reason: "too-large" });
    expect(encodes).toEqual([]);
  });

  it("reports unreadable when the image cannot be decoded", async () => {
    stubCanvas({ bitmap: { width: 1, height: 1 }, sizeFor: () => 1 });
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("decode failed");
      }),
    );
    expect(
      await fitImageForAttachment(imageFile(new Uint8Array(), 5000, "image/webp"), maxBytes),
    ).toEqual({ ok: false, reason: "unreadable" });
  });

  it("refuses a small file that would decode past the pixel cap, without decoding it", async () => {
    stubCanvas({ bitmap: { width: 20000, height: 20000 }, sizeFor: () => 10 });
    const flatPng = imageFile(pngHeader(20000, 20000), 500, "image/png");
    expect(await fitImageForAttachment(flatPng, maxBytes)).toEqual({
      ok: false,
      reason: "too-large",
    });

    const hugeWebp = imageFile(webpLosslessHeader(16000, 16000), 5000, "image/webp");
    expect(await fitImageForAttachment(hugeWebp, maxBytes)).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("probes WebP support once on a 1x1 canvas across passes and images", async () => {
    const { encodes } = stubCanvas({
      bitmap: { width: 1200, height: 800 },
      sizeFor: (_quality, width) => (width > 700 ? 5000 : 900),
    });
    await fitImageForAttachment(imageFile(new Uint8Array(), 5000, "image/gif", "a.gif"), maxBytes);
    await fitImageForAttachment(imageFile(new Uint8Array(), 5000, "image/gif", "b.gif"), maxBytes);

    expect(encodes.filter((encode) => encode.width === 1)).toEqual([
      { type: "image/webp", quality: 0.92, width: 1 },
    ]);
  });
});
