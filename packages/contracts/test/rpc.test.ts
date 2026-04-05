import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ToolInputPreviewEvent, WS_METHODS } from "../src/rpc";

const decodeToolInputPreviewEvent = Schema.decodeUnknownSync(ToolInputPreviewEvent);
const encodeToolInputPreviewEvent = Schema.encodeUnknownSync(ToolInputPreviewEvent);

describe("ToolInputPreviewEvent", () => {
  it("round-trips a typical streaming event with filePath", () => {
    const input = {
      threadId: "thread-1",
      itemId: "tool-use-abc",
      toolName: "Write",
      fieldName: "content",
      filePath: "src/app.ts",
      delta: "const x = 1;",
    };

    const decoded = decodeToolInputPreviewEvent(input);
    expect(decoded.threadId).toBe("thread-1");
    expect(decoded.itemId).toBe("tool-use-abc");
    expect(decoded.toolName).toBe("Write");
    expect(decoded.fieldName).toBe("content");
    expect(decoded.filePath).toBe("src/app.ts");
    expect(decoded.delta).toBe("const x = 1;");

    const reEncoded = encodeToolInputPreviewEvent(decoded);
    expect(reEncoded).toEqual(input);
  });

  it("round-trips a streaming event without filePath", () => {
    const input = {
      threadId: "thread-2",
      itemId: "tool-use-xyz",
      toolName: "Bash",
      fieldName: "command",
      delta: "ls -la",
    };

    const decoded = decodeToolInputPreviewEvent(input);
    expect(decoded.filePath).toBeUndefined();

    const reEncoded = encodeToolInputPreviewEvent(decoded);
    expect(reEncoded).toEqual(input);
  });
});

describe("WS_METHODS.subscribeToolInputPreview", () => {
  it("uses the documented method name", () => {
    expect(WS_METHODS.subscribeToolInputPreview).toBe("subscribeToolInputPreview");
  });
});
