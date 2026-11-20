import { describe, expect, it } from "vitest";

import { hydrateImagesFromPersisted } from "./composerAttachmentNormalization";
import { composerImageFingerprint, readComposerImageBytes } from "./composerImageFingerprint";

describe("composer image fingerprints", () => {
  it("tells files apart by their bytes once read, and matches repeats", async () => {
    const red = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
    const blue = new File([new Uint8Array([3, 2, 1])], "image.png", { type: "image/png" });
    const redAgain = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
    await Promise.all([red, blue, redAgain].map(readComposerImageBytes));
    expect(composerImageFingerprint(red)).not.toBe(composerImageFingerprint(blue));
    expect(composerImageFingerprint(red)).toBe(composerImageFingerprint(redAgain));
  });

  it("gives unread files one shared key, keeping name, type and size dedupe for them", () => {
    const first = new File(["a"], "doc.pdf", { type: "application/pdf" });
    const second = new File(["b"], "doc.pdf", { type: "application/pdf" });
    expect(composerImageFingerprint(first)).toBe(composerImageFingerprint(second));
  });

  it("fingerprints a hydrated image like the same bytes read from a paste", async () => {
    const [hydrated] = hydrateImagesFromPersisted([
      {
        id: "img-1",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,AQID",
      },
    ]);
    const pasted = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
    await readComposerImageBytes(pasted);
    expect(composerImageFingerprint(hydrated!.file)).toBe(composerImageFingerprint(pasted));
  });
});
