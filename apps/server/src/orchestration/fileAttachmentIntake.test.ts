import { describe, expect, it } from "vitest";
import { decodeUploadedFile } from "./fileAttachmentIntake";

const textUpload = (bytes: Buffer) => ({
  type: "file" as const,
  name: "source.ts",
  mimeType: "text/plain" as const,
  sizeBytes: bytes.length,
  dataUrl: `data:text/plain;base64,${bytes.toString("base64")}`,
});
describe("text file intake", () => {
  it("keeps UTF-8 source bytes intact", () => {
    const bytes = Buffer.from("const greeting = 'こんにちは';\n");
    expect(decodeUploadedFile(textUpload(bytes))).toEqual({ ok: true, bytes });
  });
  it("rejects binary, invalid UTF-8, empty and mismatched payloads", () => {
    for (const bytes of [Buffer.from([0, 1]), Buffer.from([0xff]), Buffer.alloc(0)]) {
      expect(decodeUploadedFile(textUpload(bytes)).ok).toBe(false);
    }
    expect(
      decodeUploadedFile({
        ...textUpload(Buffer.from("hello")),
        dataUrl: "data:application/pdf;base64,aGVsbG8=",
      }).ok,
    ).toBe(false);
  });
  it("retains PDF validation", () => {
    expect(
      decodeUploadedFile({ ...textUpload(Buffer.from("hello")), mimeType: "application/pdf" }).ok,
    ).toBe(false);
  });
});
