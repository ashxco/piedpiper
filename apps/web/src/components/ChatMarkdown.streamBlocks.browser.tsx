import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { parsedSources } = vi.hoisted(() => ({ parsedSources: [] as string[] }));

// Records every source the remark pipeline parses, so the test sees which blocks re-parse.
vi.mock("~/markdown-windows-paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../markdown-windows-paths")>();
  function recordingPlugin(this: { data(): unknown }) {
    actual.remarkKeepWindowsPaths.call(this);
    return (_tree: unknown, file: { value: unknown }) => {
      parsedSources.push(String(file.value));
    };
  }
  return { ...actual, remarkKeepWindowsPaths: recordingPlugin };
});

import ChatMarkdown from "./ChatMarkdown";

const CWD = "/repo/project";

describe("ChatMarkdown streamed blocks", () => {
  afterEach(() => {
    parsedSources.length = 0;
  });

  it("parses only the growing last block while a reply streams", async () => {
    const first = "First [index.ts](apps/web/index.ts) and `code`.\n\n";
    const screen = await render(<ChatMarkdown text={`${first}Sec`} cwd={CWD} isStreaming />);
    try {
      const container = screen.container as HTMLElement;
      expect(parsedSources.some((source) => source.startsWith("First"))).toBe(true);
      const chip = container.querySelector(".chat-markdown-file-link");
      parsedSources.length = 0;

      await screen.rerender(<ChatMarkdown text={`${first}Second block`} cwd={CWD} isStreaming />);
      expect(container.textContent).toContain("Second block");
      expect(parsedSources).toEqual(expect.arrayContaining(["Second block"]));
      expect(parsedSources.filter((source) => source.includes("First"))).toEqual([]);
      expect(container.querySelector(".chat-markdown-file-link")).toBe(chip);
    } finally {
      await screen.unmount();
    }
  });

  it("parses the whole text at once for a reply that did not stream here", async () => {
    const screen = await render(<ChatMarkdown text={"First\n\nSecond"} cwd={CWD} />);
    try {
      expect(parsedSources).toEqual(["First\n\nSecond"]);
    } finally {
      await screen.unmount();
    }
  });
});
