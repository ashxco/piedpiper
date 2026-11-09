import { describe, expect, it } from "vitest";

import {
  composerSuggestionEmptyMessage,
  composerSuggestionOptionId,
  composerSuggestionStatusMessage,
} from "./composerSuggestionA11y";

describe("composerSuggestionOptionId", () => {
  it("keeps whitespace, escape-like paths, and malformed UTF-16 distinct", () => {
    const paths = [
      "docs/my file.md",
      "docs/my_file.md",
      "docs/my%20file.md",
      "docs/my\tfile.md",
      "docs/\ud800.md",
      "docs/\ud801.md",
      "docs/\udc00.md",
      "docs/�.md",
      "docs/\\ud800.md",
      "docs/🚀.md",
    ];
    const ids = paths.map((path) => composerSuggestionOptionId("suggestions", `path:${path}`));

    expect(new Set(ids).size).toBe(paths.length);
    for (const id of ids) expect(id).not.toMatch(/\s|[\ud800-\udfff]/u);
    expect(composerSuggestionOptionId("other-composer", paths[0]!)).not.toBe(
      composerSuggestionOptionId("suggestions", paths[0]!),
    );
  });
});

describe("composerSuggestionStatusMessage", () => {
  it("announces nothing while the menu is closed or has results", () => {
    expect(
      composerSuggestionStatusMessage({
        menuOpen: false,
        itemCount: 0,
        triggerKind: "path",
        isLoading: true,
      }),
    ).toBe("");
    expect(
      composerSuggestionStatusMessage({
        menuOpen: true,
        itemCount: 2,
        triggerKind: "path",
        isLoading: false,
      }),
    ).toBe("");
  });

  it("announces searching and empty results", () => {
    expect(
      composerSuggestionStatusMessage({
        menuOpen: true,
        itemCount: 0,
        triggerKind: "path",
        isLoading: true,
      }),
    ).toBe("Searching workspace files...");
    expect(composerSuggestionEmptyMessage("path", false)).toBe("No matching files or folders.");
    expect(composerSuggestionEmptyMessage("slash-model", false)).toBe("No matching command.");
  });
});
