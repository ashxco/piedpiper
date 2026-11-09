import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_COMPRESSIBLE_SOURCE_BYTES } from "~/lib/imageCompression";
import {
  isComposerImageFile,
  isHeicImageFile,
  prepareComposerImageAttachment,
} from "./ChatView.heicImage";

const mocks = vi.hoisted(() => ({ heicTo: vi.fn() }));

vi.mock("heic-to/csp", () => ({ heicTo: mocks.heicTo }));

function makeHeicFile(options?: {
  name?: string;
  type?: string;
  width?: number;
  height?: number;
  lastModified?: number;
}): File {
  const encoder = new TextEncoder();
  const makeBox = (name: string, ...contents: Uint8Array[]) => {
    const bytes = new Uint8Array(8 + contents.reduce((size, content) => size + content.length, 0));
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    bytes.set(encoder.encode(name), 4);
    let offset = 8;
    for (const content of contents) {
      bytes.set(content, offset);
      offset += content.length;
    }
    return bytes;
  };
  const dimensions = new Uint8Array(12);
  const view = new DataView(dimensions.buffer);
  view.setUint32(4, options?.width ?? 4000);
  view.setUint32(8, options?.height ?? 3000);
  const properties = makeBox("iprp", makeBox("ipco", makeBox("ispe", dimensions)));
  return new File(
    [
      makeBox("ftyp", encoder.encode("heic"), new Uint8Array(4)),
      makeBox("meta", new Uint8Array(4), properties),
    ],
    options?.name ?? "photo.heic",
    {
      type: options?.type ?? "image/heic",
      ...(options?.lastModified !== undefined ? { lastModified: options.lastModified } : {}),
    },
  );
}

afterEach(() => {
  mocks.heicTo.mockReset();
});

describe("isHeicImageFile", () => {
  it("recognizes HEIC/HEIF MIME types and extensions on untyped files", () => {
    expect(isHeicImageFile({ name: "photo.bin", type: "image/heic" })).toBe(true);
    expect(isHeicImageFile({ name: "photo.bin", type: "image/heif" })).toBe(true);
    expect(isHeicImageFile({ name: "burst.heic", type: "image/heic-sequence" })).toBe(true);
    expect(isHeicImageFile({ name: "live.heif", type: "image/HEIF-sequence" })).toBe(true);
    expect(isHeicImageFile({ name: "photo.heic", type: "image/heic-other" })).toBe(false);
    expect(isHeicImageFile({ name: "IMG_1234.HEIC", type: "" })).toBe(true);
    expect(isHeicImageFile({ name: "photo.heif", type: "application/octet-stream" })).toBe(true);
    expect(isHeicImageFile({ name: "photo.heic", type: "image/png" })).toBe(false);
    expect(isHeicImageFile({ name: "notes.txt", type: "" })).toBe(false);
  });

  it("treats untyped HEIC files as composer images", () => {
    expect(isComposerImageFile({ name: "IMG_1.HEIC", type: "" })).toBe(true);
    expect(isComposerImageFile({ name: "shot.png", type: "image/png" })).toBe(true);
    expect(isComposerImageFile({ name: "notes.txt", type: "text/plain" })).toBe(false);
  });
});

describe("prepareComposerImageAttachment", () => {
  it("converts a HEIC photo with no MIME type into a named JPEG", async () => {
    const original = makeHeicFile({ name: "IMG_1234.HEIC", type: "", lastModified: 123 });
    mocks.heicTo.mockResolvedValueOnce(new Blob([new Uint8Array([4, 5, 6, 7])]));

    const result = await prepareComposerImageAttachment(original, 1024);

    expect(mocks.heicTo).toHaveBeenCalledWith({
      blob: original,
      type: "image/jpeg",
      quality: 0.92,
    });
    expect(result.ok && result.file.name).toBe("IMG_1234.jpg");
    expect(result.ok && result.file.type).toBe("image/jpeg");
    expect(result.ok && result.file.size).toBe(4);
    expect(result.ok && result.file.lastModified).toBe(123);
    expect(result.ok && result.recompressed).toBe(true);
  });

  it("accepts a 48 MP photo", async () => {
    mocks.heicTo.mockResolvedValueOnce(new Blob(["jpeg"]));
    const result = await prepareComposerImageAttachment(
      makeHeicFile({ width: 8064, height: 6048 }),
      1024,
    );
    expect(result.ok && result.file.type).toBe("image/jpeg");
  });

  it("refuses oversized dimensions before loading the decoder", async () => {
    const result = await prepareComposerImageAttachment(
      makeHeicFile({ width: 16_000, height: 4001 }),
      1024,
    );
    expect(result).toEqual({ ok: false, reason: "too-many-pixels" });
    expect(mocks.heicTo).not.toHaveBeenCalled();
  });

  it("re-encodes at lower quality when the JPEG lands over the source ceiling", async () => {
    const oversized = new Blob(["big"]);
    Object.defineProperty(oversized, "size", { value: MAX_COMPRESSIBLE_SOURCE_BYTES + 1 });
    mocks.heicTo
      .mockResolvedValueOnce(oversized)
      .mockResolvedValueOnce(new Blob([new Uint8Array([1, 2])]));

    const result = await prepareComposerImageAttachment(makeHeicFile(), 1024);

    expect(mocks.heicTo).toHaveBeenCalledTimes(2);
    expect(mocks.heicTo.mock.calls[1]?.[0]).toMatchObject({ quality: 0.7 });
    expect(result.ok && result.file.size).toBe(2);
  });

  it("refuses a JPEG still over the source ceiling after the fallback", async () => {
    const oversized = new Blob(["big"]);
    Object.defineProperty(oversized, "size", { value: MAX_COMPRESSIBLE_SOURCE_BYTES + 1 });
    mocks.heicTo.mockResolvedValue(oversized);

    expect(await prepareComposerImageAttachment(makeHeicFile(), 1024)).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(mocks.heicTo).toHaveBeenCalledTimes(2);
  });

  it("refuses an oversized source before reading it", async () => {
    const original = new File(["photo"], "large.heic", { type: "image/heic" });
    Object.defineProperty(original, "size", { value: MAX_COMPRESSIBLE_SOURCE_BYTES + 1 });
    expect(await prepareComposerImageAttachment(original, 1024)).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(mocks.heicTo).not.toHaveBeenCalled();
  });

  it("reports unreadable metadata or a failed decode", async () => {
    const broken = new File([new Uint8Array([1, 2, 3])], "broken.heic", { type: "image/heic" });
    expect(await prepareComposerImageAttachment(broken, 1024)).toEqual({
      ok: false,
      reason: "unreadable",
    });
    mocks.heicTo.mockRejectedValueOnce(new Error("Invalid HEIC image"));
    expect(await prepareComposerImageAttachment(makeHeicFile(), 1024)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("passes other images straight to the usual fitting", async () => {
    const png = new File([new Uint8Array(10)], "shot.png", { type: "image/png" });
    const result = await prepareComposerImageAttachment(png, 1024);
    expect(result).toEqual({ ok: true, file: png, recompressed: false });
    expect(mocks.heicTo).not.toHaveBeenCalled();
  });
});
