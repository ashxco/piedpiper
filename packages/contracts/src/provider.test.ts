import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderSendTurnInput, ProviderSessionStartInput } from "./provider";

describe("ProviderSessionStartInput", () => {
  const decode = Schema.decodeUnknownSync(ProviderSessionStartInput);

  it("carries an optional thread title", () => {
    const decoded = decode({
      threadId: "thread-1",
      runtimeMode: "full-access",
      title: "Fix login",
    });
    expect(decoded.title).toBe("Fix login");
  });

  it("decodes without a title", () => {
    const decoded = decode({ threadId: "thread-1", runtimeMode: "full-access" });
    expect(decoded.title).toBeUndefined();
  });
});

const image = (index: number, sizeBytes: number) => ({
  type: "image",
  id: `image-${index}`,
  name: `image-${index}.png`,
  mimeType: "image/png",
  sizeBytes,
});

describe("ProviderSendTurnInput attachments", () => {
  const decode = Schema.decodeUnknownExit(ProviderSendTurnInput);
  const attachments = (count: number, sizeBytes: number) =>
    Array.from({ length: count }, (_, index) => image(index, sizeBytes));

  it("accepts up to 100 attachments", () => {
    expect(decode({ threadId: "thread-1", attachments: attachments(100, 1024) })._tag).toBe(
      "Success",
    );
  });

  it("rejects more than 100 attachments", () => {
    expect(decode({ threadId: "thread-1", attachments: attachments(101, 1024) })._tag).toBe(
      "Failure",
    );
  });

  it("rejects attachments that exceed the total image budget", () => {
    const exit = decode({ threadId: "thread-1", attachments: attachments(9, 10 * 1024 * 1024) });
    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("64 MiB");
  });
});
