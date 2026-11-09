import { afterEach, describe, expect, it, vi } from "vitest";

import { writeTextToClipboard } from "./useCopyToClipboard";

function stubFallbackDocument(execResult: "success" | "denied" | "throws") {
  const textarea = {
    focus: vi.fn(),
    remove: vi.fn(),
    select: vi.fn(),
    setAttribute: vi.fn(),
    setSelectionRange: vi.fn(),
    style: {} as Record<string, string>,
    value: "",
  };
  const restoreFocus = vi.fn();
  const appendChild = vi.fn();
  const execCommand = vi.fn(() => {
    if (execResult === "throws") throw new Error("copy command failed");
    return execResult === "success";
  });
  vi.stubGlobal("document", {
    activeElement: { focus: restoreFocus },
    body: { appendChild },
    createElement: vi.fn(() => textarea),
    execCommand,
  });
  return { appendChild, execCommand, restoreFocus, textarea };
}

describe("writeTextToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["success", "denied", "throws"] as const)(
    "falls back to execCommand without the Clipboard API and cleans up (%s)",
    async (result) => {
      vi.stubGlobal("navigator", {});
      const { appendChild, execCommand, restoreFocus, textarea } = stubFallbackDocument(result);

      const pending = writeTextToClipboard("remote command");
      // The fallback must run synchronously, inside the original user gesture.
      expect(execCommand).toHaveBeenCalledWith("copy");
      if (result === "success") {
        await expect(pending).resolves.toBeUndefined();
      } else {
        await expect(pending).rejects.toThrow("Clipboard API unavailable.");
      }

      expect(textarea.value).toBe("remote command");
      expect(appendChild).toHaveBeenCalledWith(textarea);
      expect(textarea.focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(textarea.setSelectionRange).toHaveBeenCalledWith(0, "remote command".length);
      expect(textarea.remove).toHaveBeenCalledOnce();
      expect(restoreFocus).toHaveBeenCalledOnce();
    },
  );

  it("uses the Clipboard API without touching the fallback when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { execCommand } = stubFallbackDocument("success");

    await expect(writeTextToClipboard("remote command")).resolves.toBeUndefined();

    expect(writeText).toHaveBeenCalledWith("remote command");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("rejects when neither the Clipboard API nor a document is available", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", undefined);

    await expect(writeTextToClipboard("text")).rejects.toThrow("Clipboard API unavailable.");
  });
});
