import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { buildToolInputDiff } from "./toolInputDiff";

const edit = {
  toolName: "Edit",
  fieldName: "new_string",
  filePath: "/repo/a b.ts",
  oldString: "before",
  text: "after",
  updatedAt: 0,
};
describe("buildToolInputDiff", () => {
  it("builds a parseable fragment with quoted paths and missing final newlines", () => {
    const patch = buildToolInputDiff(edit, "/repo")!;
    expect(patch).toContain('"a/a b.ts"');
    expect(patch).toContain("\\ No newline at end of file");
    expect(parsePatchFiles(patch).flatMap((file) => file.files)).toHaveLength(1);
  });
  it("handles deletion, new content and hidden whitespace without inventing changes", () => {
    expect(buildToolInputDiff({ ...edit, text: "" }, "/repo")).toContain("+0,0");
    expect(
      buildToolInputDiff(
        {
          toolName: "Write",
          fieldName: "content",
          filePath: "/repo/new.ts",
          text: "new\n",
          updatedAt: 0,
        },
        "/repo",
      ),
    ).toContain("--- /dev/null");
    expect(buildToolInputDiff({ ...edit, oldString: "a b", text: "ab" }, "/repo", true)).toBe("");
    expect(buildToolInputDiff({ ...edit, fieldName: "command" }, "/repo")).toBeNull();
  });
});
