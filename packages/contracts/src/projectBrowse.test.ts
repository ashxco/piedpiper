import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PROJECT_BROWSE_PATH_MAX_LENGTH, ProjectBrowseDirectoriesInput } from "./projectBrowse";

describe("ProjectBrowseDirectoriesInput", () => {
  const decode = Schema.decodeUnknownSync(ProjectBrowseDirectoriesInput);

  it("trims the typed path", () => {
    expect(decode({ partialPath: "  ~/code " })).toEqual({ partialPath: "~/code" });
  });

  it("rejects empty and oversized paths", () => {
    expect(() => decode({ partialPath: "   " })).toThrow();
    expect(() =>
      decode({ partialPath: `/${"a".repeat(PROJECT_BROWSE_PATH_MAX_LENGTH)}` }),
    ).toThrow();
  });
});
