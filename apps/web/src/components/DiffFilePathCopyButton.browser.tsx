import "../index.css";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { DiffFilePathCopyButton } from "./DiffFilePathCopyButton";

describe("DiffFilePathCopyButton", () => {
  let writeText: MockInstance<Clipboard["writeText"]>;

  beforeEach(() => {
    writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  });

  afterEach(() => {
    writeText.mockRestore();
  });

  it.each([
    ["a forward-slash drive path", "C:/repo/src/a.ts", String.raw`src\a.ts`],
    ["a backslash drive path", String.raw`C:\repo\src\a.ts`, String.raw`src\a.ts`],
    ["a UNC path", "//server/share/repo/src/a.ts", String.raw`src\a.ts`],
    ["a POSIX path", "/repo/src/a.ts", "src/a.ts"],
    ["no host path", undefined, "src/a.ts"],
  ])("copies the relative path in the style of %s", async (_name, hostPath, expected) => {
    const screen = await render(<DiffFilePathCopyButton filePath="src/a.ts" hostPath={hostPath} />);
    try {
      await page.getByRole("button", { name: "Copy file path" }).click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(expected));
    } finally {
      await screen.unmount();
    }
  });
});
