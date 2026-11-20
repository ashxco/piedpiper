import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ResolvedKeybindingsConfig } from "./keybindings";

describe("ResolvedKeybindingsConfig", () => {
  it("round-trips resolved Space shortcuts", () => {
    const codec = Schema.fromJsonString(ResolvedKeybindingsConfig);
    const rules = [
      {
        command: "composer.effort" as const,
        shortcut: {
          key: " ",
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: false,
        },
      },
    ];
    const encoded = Schema.encodeSync(codec)(rules);
    expect(Schema.decodeUnknownSync(codec)(encoded)).toEqual(rules);
  });

  it("rejects an empty shortcut key", () => {
    const result = Schema.decodeUnknownExit(ResolvedKeybindingsConfig)([
      {
        command: "composer.effort",
        shortcut: {
          key: "",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: false,
        },
      },
    ]);
    expect(result._tag).toBe("Failure");
  });
});
