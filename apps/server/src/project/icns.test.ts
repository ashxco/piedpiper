import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { extractIcnsPng, isIcnsPath, readIcnsFaviconPng } from "./icns.ts";

function pngHeader(size: number): Uint8Array {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, size);
  new DataView(png.buffer).setUint32(20, size);
  return png;
}

function icns(...entries: ReadonlyArray<readonly [type: string, data: Uint8Array]>): Uint8Array {
  const length = 8 + entries.reduce((total, [, data]) => total + 8 + data.length, 0);
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("icns"));
  view.setUint32(4, length);
  let offset = 8;
  for (const [type, data] of entries) {
    bytes.set(new TextEncoder().encode(type), offset);
    view.setUint32(offset + 4, 8 + data.length);
    bytes.set(data, offset + 8);
    offset += 8 + data.length;
  }
  return bytes;
}

const widthOf = (png: Uint8Array | null) =>
  png ? new DataView(png.buffer, png.byteOffset).getUint32(16) : null;

describe("extractIcnsPng", () => {
  it("picks the smallest PNG that covers the requested size", () => {
    const file = icns(
      ["TOC ", new Uint8Array(16)],
      ["ic09", pngHeader(512)],
      ["icp5", pngHeader(32)],
      ["ic07", pngHeader(128)],
      ["ic08", pngHeader(256)],
    );

    expect(widthOf(extractIcnsPng(file, 96))).toBe(128);
  });

  it("falls back to the largest PNG when none covers the requested size", () => {
    const file = icns(["icp4", pngHeader(16)], ["icp5", pngHeader(32)]);

    expect(widthOf(extractIcnsPng(file, 96))).toBe(32);
  });

  it("returns null for files without a PNG entry or with a foreign header", () => {
    expect(extractIcnsPng(icns(["it32", new Uint8Array(64)]), 96)).toBeNull();
    expect(extractIcnsPng(pngHeader(128), 96)).toBeNull();
    expect(extractIcnsPng(new Uint8Array(3), 96)).toBeNull();
  });

  it("stops at an entry whose length runs past the file", () => {
    const file = icns(["ic07", pngHeader(128)], ["ic08", pngHeader(256)]);
    new DataView(file.buffer).setUint32(8 + 8 + 24 + 4, 4096);

    expect(widthOf(extractIcnsPng(file, 200))).toBe(128);
  });

  it("returns a copy that does not share the source buffer", () => {
    const file = icns(["ic07", pngHeader(128)]);
    const png = extractIcnsPng(file, 96);

    expect(png?.buffer).not.toBe(file.buffer);
    expect(png).toEqual(pngHeader(128));
  });
});

describe("isIcnsPath", () => {
  it("matches the .icns extension case-insensitively", () => {
    expect(isIcnsPath("/p/Resources/AppIcon.icns")).toBe(true);
    expect(isIcnsPath("/p/AppIcon.ICNS")).toBe(true);
    expect(isIcnsPath("/p/favicon.png")).toBe(false);
  });
});

it.layer(NodeServices.layer)("readIcnsFaviconPng", (it) => {
  it.effect("reads the embedded PNG and returns null for unreadable files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "piedpiper-icns-" });
      const iconPath = path.join(dir, "AppIcon.icns");
      yield* fileSystem.writeFile(iconPath, icns(["ic07", pngHeader(128)]));

      expect(widthOf(yield* readIcnsFaviconPng(iconPath))).toBe(128);
      expect(yield* readIcnsFaviconPng(path.join(dir, "missing.icns"))).toBeNull();
    }),
  );
});
