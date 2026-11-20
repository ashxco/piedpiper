import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectConfigFile, ProjectWriteFileInput, ProjectWriteFileResult } from "./project";

const decode = Schema.decodeUnknownExit(ProjectConfigFile);

describe("ProjectConfigFile", () => {
  it("trims fields and keeps optional script settings", () => {
    const result = decode({
      $schema: "./schema.json",
      iconPath: " assets/icon.svg ",
      scripts: [{ name: " Test ", command: " bun test ", icon: "test" }],
    });
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.value.iconPath).toBe("assets/icon.svg");
      expect(result.value.scripts).toEqual([{ name: "Test", command: "bun test", icon: "test" }]);
    }
  });

  it("rejects blank commands and unknown icons", () => {
    expect(decode({ scripts: [{ name: "Dev", command: "  " }] })._tag).toBe("Failure");
    expect(decode({ scripts: [{ name: "Dev", command: "x", icon: "rocket" }] })._tag).toBe(
      "Failure",
    );
  });
});

describe("ProjectWriteFileInput", () => {
  it("keeps whitespace at the ends of a file name", () => {
    const result = Schema.decodeUnknownExit(ProjectWriteFileInput)({
      cwd: " /repo ",
      relativePath: " notes .md ",
      contents: "",
    });
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.value.cwd).toBe("/repo");
      expect(result.value.relativePath).toBe(" notes .md ");
    }
    const written = Schema.decodeUnknownExit(ProjectWriteFileResult)({ relativePath: " a.md" });
    expect(written._tag === "Success" && written.value.relativePath).toBe(" a.md");
  });

  it("rejects an empty file name", () => {
    expect(
      Schema.decodeUnknownExit(ProjectWriteFileInput)({
        cwd: "/repo",
        relativePath: "",
        contents: "",
      })._tag,
    ).toBe("Failure");
  });
});
