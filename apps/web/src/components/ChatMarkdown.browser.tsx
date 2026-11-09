import "../index.css";

import type { ProjectSearchEntriesResult, ProjectStatPathKind } from "@piedpiper/contracts";
import DOMPurify from "dompurify";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { contextMenuShowMock, openInPreferredEditorMock, searchEntriesMock, statPathMock } =
  vi.hoisted(() => ({
    contextMenuShowMock: vi.fn(async (): Promise<string | null> => null),
    openInPreferredEditorMock: vi.fn(async () => "vscode"),
    statPathMock: vi.fn(
      async (_input: { path: string }): Promise<{ kind: ProjectStatPathKind }> => ({
        kind: "missing",
      }),
    ),
    searchEntriesMock: vi.fn(
      async (): Promise<ProjectSearchEntriesResult> => ({ entries: [], truncated: false }),
    ),
  }));

vi.mock("~/editorPreferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../editorPreferences")>()),
  openInPreferredEditor: openInPreferredEditorMock,
}));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  readNativeApi: () => ({
    contextMenu: { show: contextMenuShowMock },
    projects: { searchEntries: searchEntriesMock },
  }),
}));

vi.mock("~/wsRpcClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wsRpcClient")>()),
  getWsRpcClient: () => ({ projects: { statPath: statPathMock } }),
}));

import ChatMarkdown, { getHighlighterPromise } from "./ChatMarkdown";
import { THREAD_FIND_REVEAL_EVENT } from "./chat/threadFindHighlights";
import { getVscodeIconUrlForEntry } from "../vscode-icons";

const CWD = "/repo/project";

// The highlight cache is module-level; a nonce per test keeps each test's cache state explicit.
function codeMarkdown(nonce: string): string {
  return `\`\`\`ts\nconst answer = 42; // ${nonce}\n\`\`\``;
}

function markdownWithTrailingParagraph(nonce: string, paragraph: string): string {
  return `${codeMarkdown(nonce)}\n\n${paragraph}`;
}

function renderMarkdown(nonce: string, paragraph: string) {
  return render(
    <ChatMarkdown
      text={markdownWithTrailingParagraph(nonce, paragraph)}
      cwd={CWD}
      isStreaming={false}
    />,
  );
}

async function waitForHighlightedBlock(container: HTMLElement): Promise<HTMLElement> {
  let element: HTMLElement | null = null;
  await vi.waitFor(
    () => {
      element = container.querySelector<HTMLElement>(".chat-markdown-shiki");
      expect(element, "Expected Shiki to render the code block.").toBeTruthy();
    },
    { timeout: 20_000, interval: 50 },
  );
  return element as unknown as HTMLElement;
}

// Fills the highlight cache for a nonce by rendering it once and unmounting.
async function warmHighlightCache(nonce: string): Promise<void> {
  const screen = await renderMarkdown(nonce, "warm");
  await waitForHighlightedBlock(screen.container as HTMLElement);
  await screen.unmount();
}

function fallbackPre(container: HTMLElement): Element | null {
  return container.querySelector(".chat-markdown-codeblock > pre");
}

describe("ChatMarkdown code highlighting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps one code block instance working as it moves between cached and uncached code", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await warmHighlightCache("switch-cached");
    const rerenderWithNonce = (nonce: string, paragraph: string) =>
      screen.rerender(
        <ChatMarkdown
          text={markdownWithTrailingParagraph(nonce, paragraph)}
          cwd={CWD}
          isStreaming={false}
        />,
      );

    // Mounts on the cache-hit path, then the same instance's code changes to an uncached snippet.
    // React 19 tolerated the old single component's 0 <-> N hook switch; this guards the split paths.
    const screen = await renderMarkdown("switch-cached", "one");
    const container = screen.container as HTMLElement;
    const codeBlock = container.querySelector(".chat-markdown-codeblock");
    expect(container.querySelector(".chat-markdown-shiki")?.textContent).toContain("switch-cached");

    await rerenderWithNonce("switch-uncached", "two");
    await vi.waitFor(() => {
      expect(container.querySelector(".chat-markdown-shiki")?.textContent).toContain(
        "switch-uncached",
      );
    });

    // And back onto the cache-hit path from the uncached path.
    await rerenderWithNonce("switch-cached", "three");
    await vi.waitFor(() => {
      expect(container.querySelector(".chat-markdown-shiki")?.textContent).toContain(
        "switch-cached",
      );
    });

    expect(container.querySelector(".chat-markdown-codeblock")).toBe(codeBlock);
    expect(fallbackPre(container)).toBeNull();
    const hookErrors = consoleErrorSpy.mock.calls.filter((call) =>
      call.some((arg) => /fewer hooks|more hooks|order of Hooks/i.test(String(arg))),
    );
    expect(hookErrors).toEqual([]);
  });

  it("renders a warm-cache block immediately and sanitizes it once", async () => {
    await warmHighlightCache("warm");
    const sanitizeSpy = vi.spyOn(DOMPurify, "sanitize");

    const screen = await renderMarkdown("warm", "one");
    const container = screen.container as HTMLElement;

    // No waiting: the cache-hit path renders synchronously, without the Suspense fallback.
    const highlighted = container.querySelector(".chat-markdown-shiki");
    expect(highlighted?.textContent).toContain("const answer = 42;");
    expect(fallbackPre(container)).toBeNull();
    expect(sanitizeSpy).toHaveBeenCalledTimes(1);

    await screen.rerender(
      <ChatMarkdown
        text={markdownWithTrailingParagraph("warm", "two")}
        cwd={CWD}
        isStreaming={false}
      />,
    );

    expect(container.querySelector(".chat-markdown-shiki")).toBe(highlighted);
    expect(container.textContent).toContain("two");
    expect(sanitizeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not re-sanitize unchanged highlighted html on a same-props code block re-render", async () => {
    const screen = await renderMarkdown("cold", "one");
    const container = screen.container as HTMLElement;
    const highlighted = await waitForHighlightedBlock(container);
    const sanitizeSpy = vi.spyOn(DOMPurify, "sanitize");

    // Only the trailing text changes, so the code block re-renders with identical props.
    await screen.rerender(
      <ChatMarkdown
        text={markdownWithTrailingParagraph("cold", "two")}
        cwd={CWD}
        isStreaming={false}
      />,
    );
    const afterRerender = await waitForHighlightedBlock(container);

    expect(afterRerender).toBe(highlighted);
    expect(afterRerender.textContent).toContain("const answer = 42;");
    expect(container.textContent).toContain("two");
    expect(sanitizeSpy).not.toHaveBeenCalled();
  });
});

describe("ChatMarkdown file links", () => {
  afterEach(() => {
    openInPreferredEditorMock.mockClear();
    searchEntriesMock.mockReset();
    searchEntriesMock.mockImplementation(async () => ({ entries: [], truncated: false }));
  });

  it("rewrites file uri hrefs into paths and opens them with their line", async () => {
    const filePath = "/Users/me/repo/src/app.ts";
    const screen = await render(
      <ChatMarkdown text={`[app.ts:3](file://${filePath}#L3)`} cwd={CWD} />,
    );
    try {
      const link = page.getByRole("link", { name: "app.ts:3" });
      await expect.element(link).toHaveAttribute("href", `${filePath}#L3`);
      await link.click();
      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), `${filePath}:3`);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps Windows drive-path hrefs clickable", async () => {
    const screen = await render(
      <ChatMarkdown text={"[main.ts](C:\\repo\\src\\main.ts)"} cwd={"C:\\repo"} />,
    );
    try {
      await page.getByRole("link", { name: "main.ts" }).click();
      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          "C:\\repo\\src\\main.ts",
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("renders rejected file hrefs inert instead of as web links", async () => {
    const screen = await render(
      <ChatMarkdown
        text={
          "[share](file://attacker.test/share/x.md) and [bad](javascript:alert(1)) and [unc](\\\\attacker.test\\share\\x.md)"
        }
        cwd={CWD}
      />,
    );
    try {
      const container = screen.container as HTMLElement;
      const anchors = [...container.querySelectorAll("a")];
      expect(anchors.find((anchor) => anchor.textContent === "share")?.hasAttribute("href")).toBe(
        false,
      );
      const unc = anchors.find((anchor) => anchor.textContent === "unc");
      expect(unc?.hasAttribute("href")).toBe(false);
      expect(unc?.hasAttribute("target")).toBe(false);
      expect(container.innerHTML).not.toContain("javascript:");
      expect(container.innerHTML).not.toContain("attacker.test");
    } finally {
      await screen.unmount();
    }
  });

  it("opens the workspace file a bare filename names", async () => {
    searchEntriesMock.mockImplementation(async () => ({
      entries: [
        { path: "src/components/ChatView.test.tsx", kind: "file" },
        { path: "src/components/ChatView.tsx", kind: "file" },
      ],
      truncated: false,
    }));
    const screen = await render(
      <ChatMarkdown text="[ChatView.tsx:42](ChatView.tsx:42)" cwd={CWD} />,
    );
    try {
      await page.getByRole("link", { name: "ChatView.tsx:42" }).click();
      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          `${CWD}/src/components/ChatView.tsx:42`,
        );
      });
      expect(searchEntriesMock).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: CWD, query: "ChatView.tsx" }),
      );
    } finally {
      await screen.unmount();
    }
  });
});

const runButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Run in terminal"]');

// Wrapped first lines must stop before every action button, which overlay the pre.
function expectPreTextClearOf(container: HTMLElement, button: HTMLElement) {
  const pre = container.querySelector("pre") as HTMLElement;
  const textRight =
    pre.getBoundingClientRect().right - parseFloat(getComputedStyle(pre).paddingRight);
  expect(textRight).toBeLessThanOrEqual(button.getBoundingClientRect().left);
}

describe("ChatMarkdown code block actions", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("toggles line wrapping for one code block", async () => {
    const screen = await render(<ChatMarkdown text={codeMarkdown("wrap-toggle")} cwd={CWD} />);
    try {
      const container = screen.container as HTMLElement;
      await waitForHighlightedBlock(container);
      const pre = () => container.querySelector("pre") as HTMLElement;
      expect(getComputedStyle(pre()).whiteSpace).toBe("pre");

      await page.getByRole("button", { name: "Wrap lines" }).click();
      await expect
        .element(page.getByRole("button", { name: "Disable line wrap" }))
        .toHaveAttribute("aria-pressed", "true");
      expect(getComputedStyle(pre()).whiteSpace).toBe("pre-wrap");
      expectPreTextClearOf(
        container,
        container.querySelector('button[aria-pressed="true"]') as HTMLElement,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("starts wrapped when the code block wrapping setting is on", async () => {
    localStorage.setItem(
      "piedpiper:client-settings:v1",
      JSON.stringify({ chatCodeWordWrap: true }),
    );
    const screen = await render(<ChatMarkdown text={codeMarkdown("wrap-default")} cwd={CWD} />);
    try {
      await expect
        .element(page.getByRole("button", { name: "Disable line wrap" }))
        .toHaveAttribute("aria-pressed", "true");
    } finally {
      await screen.unmount();
    }
  });

  it("renders over-indented list items as list text, not code", async () => {
    const screen = await render(<ChatMarkdown text={"-       Fixed the bug"} cwd={CWD} />);
    try {
      const container = screen.container as HTMLElement;
      expect(container.querySelector("pre")).toBeNull();
      expect(container.querySelector("li")?.textContent).toBe("Fixed the bug");
    } finally {
      await screen.unmount();
    }
  });

  it("offers Run in terminal only for complete single-line shell blocks", async () => {
    const onRunShellCommand = vi.fn();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        text={text}
        cwd={CWD}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    const screen = await render(message("```bash\necho hello\n```", true));
    try {
      const container = screen.container as HTMLElement;
      expect(runButton(container)).toBeNull();

      await screen.rerender(message("```bash\necho hello\n```"));
      await waitForHighlightedBlock(container);
      expectPreTextClearOf(container, runButton(container) as HTMLElement);
      runButton(container)?.click();
      expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

      for (const text of [
        "~~~bash\necho tilde\n~~~",
        "> ```bash\n> echo quote\n> ```",
        "````bash\necho four\n````",
      ]) {
        await screen.rerender(message(text));
        expect(runButton(container), text).not.toBeNull();
      }

      for (const text of [
        "```bash\necho one\necho two\n```",
        "```typescript\necho hello\n```",
        "```bash\n\n```",
        "```bash\necho hello\n\n```",
        "```bash\necho hello\\\n```",
        "```bash\necho safe \u202e#\n```",
        "```bash\necho incomplete",
        "~~~bash\necho incomplete",
        "````bash\necho incomplete\n```",
      ]) {
        await screen.rerender(message(text));
        expect(runButton(container), text).toBeNull();
      }
    } finally {
      await screen.unmount();
    }
  });
});

describe("ChatMarkdown tables and copying", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.getSelection()?.removeAllRanges();
  });

  it("puts a wide table in its own horizontal scroll area and copies it as CSV", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue({
      writeText,
    } as unknown as Clipboard);
    const wideCell = "x".repeat(400);
    const screen = await render(
      <div style={{ width: 320 }}>
        <ChatMarkdown text={`| a | b |\n| --- | --- |\n| \`${wideCell}\` | c, d |`} cwd={CWD} />
      </div>,
    );
    try {
      const container = screen.container as HTMLElement;
      const scroller = container.querySelector(".chat-markdown-table-scroll") as HTMLElement;
      expect(scroller.querySelector("table")).toBeTruthy();
      expect(getComputedStyle(scroller).overflowX).toBe("auto");

      await page.getByRole("button", { name: "Copy table" }).click();
      await page.getByRole("menuitem", { name: "Copy as CSV" }).click();
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(`a,b\n${wideCell},"c, d"`);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows the file a code fence names as a header", async () => {
    const screen = await render(
      <ChatMarkdown text={'```ts title="src/a.ts"\nconst a = 1;\n```'} cwd={CWD} />,
    );
    try {
      const container = screen.container as HTMLElement;
      expect(container.querySelector(".chat-markdown-codeblock-header")?.textContent).toBe(
        "src/a.ts",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("copies a selection as Markdown with code fences and list numbers", async () => {
    const screen = await render(
      <ChatMarkdown
        text={
          "1. First\n2. Second\n\n```ts\nconst copied = true;\n```\n\nSee [docs](https://example.com)."
        }
        cwd={CWD}
      />,
    );
    try {
      const container = screen.container as HTMLElement;
      await waitForHighlightedBlock(container);
      const root = container.querySelector(".chat-markdown") as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(root);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);

      const clipboardData = new DataTransfer();
      root.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, clipboardData }));

      expect(clipboardData.getData("text/plain")).toBe(
        "1. First\n2. Second\n\n```ts\nconst copied = true;\n```\n\nSee [docs](https://example.com).",
      );
      expect(clipboardData.getData("text/html")).toContain("<ol>");
      expect(clipboardData.getData("text/html")).not.toContain("<button");
    } finally {
      await screen.unmount();
    }
  });

  it.each(["nasm", "assembly", "s", "S", "ASM", "gitignore"])(
    "copies a %s fence under the name it was written with",
    async (language) => {
      const source = `Intro\n\n\`\`\`${language}\nmov eax, 1 ; ${language} comment\n\`\`\``;
      const screen = await render(<ChatMarkdown text={source} cwd={CWD} />);
      try {
        const container = screen.container as HTMLElement;
        await waitForHighlightedBlock(container);
        const root = container.querySelector(".chat-markdown") as HTMLElement;
        window.getSelection()?.selectAllChildren(root);
        const clipboardData = new DataTransfer();
        root.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, clipboardData }));
        window.getSelection()?.removeAllRanges();
        expect(clipboardData.getData("text/plain")).toBe(source);
      } finally {
        await screen.unmount();
      }
    },
  );

  it("hands React one promise for a language Shiki lacks, so the block does not suspend forever", async () => {
    const first = getHighlighterPromise("not-a-shiki-language");
    await first;
    expect(getHighlighterPromise("not-a-shiki-language")).toBe(first);
  });

  it("highlights a nasm fence with the asm grammar", async () => {
    const screen = await render(
      <ChatMarkdown text={"```nasm\nmov eax, 1 ; nasm-grammar\n```"} cwd={CWD} />,
    );
    try {
      const container = screen.container as HTMLElement;
      await waitForHighlightedBlock(container);
      await expect
        .poll(() => container.querySelectorAll(".chat-markdown-shiki .line span").length)
        .toBeGreaterThan(1);
    } finally {
      await screen.unmount();
    }
  });
});

describe("ChatMarkdown streaming code highlighting", () => {
  it("keeps completed line DOM while a block streams and does not remount it when streaming ends", async () => {
    const prefix = "Intro\n\n```ts\nconst first = 1; // streaming-lines\n";
    const screen = await render(<ChatMarkdown text={`${prefix}const sec`} cwd={CWD} isStreaming />);
    try {
      const container = screen.container as HTMLElement;
      await waitForHighlightedBlock(container);
      const lines = () => [...container.querySelectorAll(".chat-markdown-shiki .line")];
      await vi.waitFor(() => expect(lines()[1]?.textContent).toBe("const sec"));
      const firstLine = lines()[0];
      const codeBlock = container.querySelector(".chat-markdown-codeblock");

      await screen.rerender(
        <ChatMarkdown text={`${prefix}const second = 2;\n`} cwd={CWD} isStreaming />,
      );
      await vi.waitFor(() => expect(lines()[1]?.textContent).toBe("const second = 2;"));
      expect(lines()[0]).toBe(firstLine);

      await screen.rerender(
        <ChatMarkdown text={`${prefix}const second = 2;\n\`\`\``} cwd={CWD} isStreaming={false} />,
      );
      await vi.waitFor(() => expect(lines()[1]?.textContent).toBe("const second = 2;"));
      expect(container.querySelector(".chat-markdown-codeblock")).toBe(codeBlock);
      expect(lines()[0]).toBe(firstLine);
    } finally {
      await screen.unmount();
    }
  });
});

describe("ChatMarkdown file chips", () => {
  afterEach(() => {
    openInPreferredEditorMock.mockReset();
    openInPreferredEditorMock.mockImplementation(async () => "vscode");
  });

  it("labels chips with the file name, position and disambiguating folders", async () => {
    const screen = await render(
      <ChatMarkdown
        text={`See [${CWD}/apps/web/index.ts](${CWD}/apps/web/index.ts:4) and [index.ts](apps/server/index.ts), [the loader](src/load.ts).`}
        cwd={CWD}
      />,
    );
    try {
      const container = screen.container as HTMLElement;
      const chips = [...container.querySelectorAll<HTMLElement>(".chat-markdown-file-link")];
      expect(chips.map((chip) => chip.textContent)).toEqual([
        "index.ts:4apps/web",
        "index.tsapps/server",
        "the loader",
      ]);
      expect(chips[0]?.getAttribute("data-markdown-copy")).toBe(
        `[${CWD}/apps/web/index.ts](${CWD}/apps/web/index.ts:4)`,
      );
      // The closing punctuation wraps with the chip.
      expect(chips[2]?.parentElement?.textContent).toBe("the loader.");
    } finally {
      await screen.unmount();
    }
  });

  it("shows a repo-root path as written until a click has checked where it is", async () => {
    const screen = await render(
      <ChatMarkdown text="[a.ts](apps/web/src/a.ts:4)" cwd="/repo/apps/web" />,
    );
    try {
      await page.getByRole("link", { name: "a.ts" }).hover();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
          "apps/web/src/a.ts:4",
        );
      });
    } finally {
      await userEvent.unhover(page.getByRole("link", { name: "a.ts" }));
      await screen.unmount();
    }
  });

  it("starts the clipboard write before a repo-root path's lookup finishes", async () => {
    const cwd = "/repo/apps/web";
    const lookup: { finish?: (value: { kind: ProjectStatPathKind }) => void } = {};
    statPathMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          lookup.finish = resolve;
        }),
    );
    statPathMock.mockImplementation(async () => ({ kind: "file" }));
    const write = vi.spyOn(navigator.clipboard, "write").mockResolvedValue(undefined);
    const { toastManager } = await import("./ui/toast");
    const addToast = vi.spyOn(toastManager, "add");
    const screen = await render(<ChatMarkdown text="[a.ts](apps/web/src/a.ts:4)" cwd={cwd} />);
    try {
      const link = (screen.container as HTMLElement).querySelector(".chat-markdown-file-link");
      if (!link) throw new Error("Expected a file chip.");
      contextMenuShowMock.mockResolvedValueOnce("copy-relative");
      link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      expect(addToast).not.toHaveBeenCalled();

      lookup.finish?.({ kind: "missing" });
      const item = write.mock.calls[0]?.[0][0] as ClipboardItem;
      const blob = await item.getType("text/plain");
      expect(await blob.text()).toBe("src/a.ts:4");
      await vi.waitFor(() => {
        expect(addToast).toHaveBeenLastCalledWith(
          expect.objectContaining({ type: "success", description: "src/a.ts:4" }),
        );
      });
    } finally {
      write.mockRestore();
      addToast.mockRestore();
      statPathMock.mockReset();
      contextMenuShowMock.mockReset();
      await screen.unmount();
    }
  });

  it("opens a repo-root path below a subfolder project only when it is missing as written", async () => {
    const cwd = "/repo/apps/web";
    statPathMock.mockImplementation(async ({ path }) => ({
      kind: path === `${cwd}/src/a.ts` ? "file" : "missing",
    }));
    const screen = await render(<ChatMarkdown text="[a.ts](apps/web/src/a.ts:4)" cwd={cwd} />);
    try {
      await page.getByRole("link", { name: "a.ts" }).click();
      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          `${cwd}/src/a.ts:4`,
        );
      });

      // A real file at the literal path always wins.
      openInPreferredEditorMock.mockClear();
      statPathMock.mockImplementation(async () => ({ kind: "file" }));
      await page.getByRole("link", { name: "a.ts" }).click();
      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          `${cwd}/apps/web/src/a.ts:4`,
        );
      });
    } finally {
      statPathMock.mockReset();
      await screen.unmount();
    }
  });

  it.each([
    {
      name: "Windows drive paths",
      cwd: "C:/repo",
      href: "C:/repo/reports/Device Users.csv:12:3",
      full: String.raw`C:\repo\reports\Device Users.csv:12:3`,
      relative: String.raw`reports\Device Users.csv:12:3`,
    },
    {
      name: "UNC paths",
      cwd: String.raw`\\server\share\repo`,
      href: "file://server/share/repo/reports/report.csv",
      full: String.raw`\\server\share\repo\reports\report.csv`,
      relative: String.raw`reports\report.csv`,
    },
    {
      name: "POSIX paths",
      cwd: "/home/repo",
      href: "/home/repo/reports/report.csv",
      full: "/home/repo/reports/report.csv",
      relative: "reports/report.csv",
    },
  ])(
    "copies $name in the host's style and shows the copied text",
    async ({ cwd, href, full, relative }) => {
      const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
      const { toastManager } = await import("./ui/toast");
      const addToast = vi.spyOn(toastManager, "add");
      const screen = await render(<ChatMarkdown text={`[File](<${href}>)`} cwd={cwd} />);
      try {
        const link = (screen.container as HTMLElement).querySelector(".chat-markdown-file-link");
        if (!link) throw new Error("Expected a file chip.");
        for (const [action, expected] of [
          ["copy-full", full],
          ["copy-relative", relative],
        ] as const) {
          contextMenuShowMock.mockResolvedValueOnce(action);
          link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
          await vi.waitFor(() => {
            expect(writeText).toHaveBeenLastCalledWith(expected);
            expect(addToast).toHaveBeenLastCalledWith(
              expect.objectContaining({ type: "success", description: expected }),
            );
          });
        }
        // Only copied text changes style, not the link that opens the file.
        expect(link.getAttribute("href")).not.toContain("\\");
      } finally {
        writeText.mockRestore();
        addToast.mockRestore();
        contextMenuShowMock.mockReset();
        await screen.unmount();
      }
    },
  );

  it("shows a toast instead of failing silently when the file cannot be opened", async () => {
    openInPreferredEditorMock.mockImplementation(async () => {
      throw new Error("No editor configured");
    });
    const { toastManager } = await import("./ui/toast");
    const addToast = vi.spyOn(toastManager, "add");
    const screen = await render(<ChatMarkdown text="[a.ts](src/a.ts)" cwd={CWD} />);
    try {
      await page.getByRole("link", { name: "a.ts" }).click();
      await vi.waitFor(() => {
        expect(addToast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            title: "Unable to open file",
            description: "No editor configured",
          }),
        );
      });
    } finally {
      addToast.mockRestore();
      await screen.unmount();
    }
  });
});

describe("ChatMarkdown mermaid diagrams", () => {
  const diagram = "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```";

  it("renders a closed mermaid fence as a sanitized diagram while the reply still streams", async () => {
    const screen = await render(
      <ChatMarkdown text={`${diagram}\n\nStill writing`} cwd={CWD} isStreaming />,
    );
    try {
      const container = screen.container as HTMLElement;
      await vi.waitFor(
        () => {
          expect(container.querySelector(".chat-markdown-mermaid svg")).toBeTruthy();
          // The toggle waits for the renderer to report the drawn diagram.
          expect(container.querySelector('button[aria-label="Show code"]')).toBeTruthy();
        },
        { timeout: 20_000 },
      );
      const wrapper = container.querySelector(".chat-markdown-mermaid") as HTMLElement;
      expect(wrapper.getAttribute("data-markdown-copy")).toBe(
        "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\n\n",
      );
      expect(wrapper.querySelector("script, a, foreignObject")).toBeNull();
      // Nothing to wrap while the diagram shows.
      expect(container.querySelector('button[aria-label="Wrap lines"]')).toBeNull();

      const toggleLeft = () =>
        (
          container.querySelector(
            'button[aria-label="Show code"], button[aria-label="Show diagram"]',
          ) as HTMLElement
        ).getBoundingClientRect().left;
      const leftWithDiagram = toggleLeft();
      await page.getByRole("button", { name: "Show code" }).click();
      await waitForHighlightedBlock(container);
      expect(container.querySelector(".chat-markdown-mermaid")).toBeNull();
      // A second click must land on the same control, not on the wrap button that appeared.
      expect(toggleLeft()).toBe(leftWithDiagram);
      expectPreTextClearOf(
        container,
        container.querySelector('button[aria-label="Wrap lines"]') as HTMLElement,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("keeps an unclosed streaming fence as code", async () => {
    const screen = await render(
      <ChatMarkdown text={"```mermaid\nflowchart LR\n  A --> B"} cwd={CWD} isStreaming />,
    );
    try {
      const container = screen.container as HTMLElement;
      await waitForHighlightedBlock(container);
      expect(container.querySelector(".chat-markdown-mermaid")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("falls back to the highlighted code block for an unsupported diagram", async () => {
    const screen = await render(
      <ChatMarkdown text={"```mermaid\nnot a diagram at all\n```"} cwd={CWD} />,
    );
    try {
      const container = screen.container as HTMLElement;
      const highlighted = await waitForHighlightedBlock(container);
      expect(highlighted.textContent).toContain("not a diagram at all");
      expect(container.querySelector(".chat-markdown-mermaid")).toBeNull();
      // The code is already on screen, so there is nothing to toggle.
      expect(container.querySelector('button[aria-label="Show code"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Wrap lines"]')).toBeTruthy();
    } finally {
      await screen.unmount();
    }
  });

  it("falls back to the highlighted code block for a malformed supported diagram", async () => {
    // The valid diagram proves the flowchart renderer loaded before checking the malformed one.
    const screen = await render(
      <ChatMarkdown
        text={`${diagram}\n\n\`\`\`mermaid\nflowchart LR\n  A -->\n\`\`\``}
        cwd={CWD}
      />,
    );
    try {
      const container = screen.container as HTMLElement;
      await vi.waitFor(
        () => {
          expect(container.querySelector(".chat-markdown-mermaid svg")).toBeTruthy();
          expect(container.querySelectorAll(".chat-markdown-mermaid")).toHaveLength(1);
          expect(container.querySelectorAll(".chat-markdown-shiki")).toHaveLength(1);
          expect(container.querySelectorAll('button[aria-label="Show code"]')).toHaveLength(1);
        },
        { timeout: 20_000 },
      );
      expect(container.querySelector('button[aria-label="Show diagram"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});

describe("ChatMarkdown Codex directives", () => {
  it("shows a file citation as a file chip and a follow-up as its label", async () => {
    const screen = await render(
      <ChatMarkdown
        text={
          'Updated :codex-file-citation{path="src/a.ts" line_range_start="3"}. Next: :codex-followup[Add tests]{prompt="Add tests"}'
        }
        cwd={CWD}
      />,
    );
    try {
      const container = screen.container as HTMLElement;
      expect(container.querySelector(".chat-markdown-file-link")?.textContent).toBe("a.ts:3");
      expect(container.textContent).toBe("Updated a.ts:3. Next: Add tests");
    } finally {
      await screen.unmount();
    }
  });

  it("tells same-named cited files apart across streamed blocks", async () => {
    const screen = await render(
      <ChatMarkdown
        text={
          'See :codex-file-citation{path="apps/web/src/index.ts"}.\n\nAnd :codex-file-citation{path="apps/server/src/index.ts"}.'
        }
        cwd={CWD}
        isStreaming
      />,
    );
    try {
      const container = screen.container as HTMLElement;
      const chips = [...container.querySelectorAll(".chat-markdown-file-link")];
      expect(chips.map((chip) => chip.textContent)).toEqual([
        "index.tsweb/src",
        "index.tsserver/src",
      ]);
    } finally {
      await screen.unmount();
    }
  });
});

describe("ChatMarkdown folder links", () => {
  it("shows a folder icon on a chip for a folder link", async () => {
    const screen = await render(<ChatMarkdown text={"See [patches](patches/)."} cwd={CWD} />);
    try {
      const container = screen.container as HTMLElement;
      const icon = container.querySelector<HTMLImageElement>(".chat-markdown-file-link img");
      const folderIcons = (["light", "dark"] as const).map((theme) =>
        getVscodeIconUrlForEntry(`${CWD}/patches/`, "directory", theme),
      );
      expect(folderIcons).toContain(icon?.getAttribute("src"));
    } finally {
      await screen.unmount();
    }
  });
});

describe("ChatMarkdown inline code", () => {
  afterEach(() => {
    openInPreferredEditorMock.mockClear();
    window.getSelection()?.removeAllRanges();
  });

  it("selects the whole inline code span on double-click, but only a word in fenced code", async () => {
    const screen = await render(
      <ChatMarkdown
        text={"Run `migration-gate --dry-run` first.\n\n```txt\nfenced-block word\n```"}
        cwd={CWD}
      />,
    );
    try {
      await userEvent.dblClick(page.getByText("migration-gate --dry-run"));
      expect(window.getSelection()?.toString()).toBe("migration-gate --dry-run");

      window.getSelection()?.removeAllRanges();
      const container = screen.container as HTMLElement;
      const fenced = await vi.waitFor(() => {
        const element = container.querySelector<HTMLElement>(".chat-markdown-codeblock pre");
        expect(element).toBeTruthy();
        return element!;
      });
      await userEvent.dblClick(fenced, { position: { x: 4, y: 4 } });
      expect(window.getSelection()?.toString()).not.toContain("fenced-block word");
    } finally {
      await screen.unmount();
    }
  });

  it("renders file-path inline code as a file chip that copies as code", async () => {
    const screen = await render(
      <ChatMarkdown
        text={"Edit `src/app.ts:12`, not `origin/main` or [`src/b.ts`](https://example.com)."}
        cwd={CWD}
      />,
    );
    try {
      const container = screen.container as HTMLElement;
      const chips = [...container.querySelectorAll<HTMLElement>(".chat-markdown-file-link")];
      expect(chips.map((chip) => chip.textContent)).toEqual(["app.ts:12"]);
      expect(chips[0]?.getAttribute("data-markdown-copy")).toBe("`src/app.ts:12`");
      expect(container.querySelector("code[data-inline-code]")?.textContent).toBe("origin/main");
      await chips[0]!.click();
      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          `${CWD}/src/app.ts:12`,
        );
      });
    } finally {
      await screen.unmount();
    }
  });
});

describe("ChatMarkdown web links", () => {
  it("keeps a bare URL's trailing underscore and a Windows dot-folder in link targets", async () => {
    const screen = await render(
      <ChatMarkdown
        text={"See https://x.com/name_ and [settings](C:\\repo\\.config\\a.json)."}
        cwd={"C:\\repo"}
      />,
    );
    try {
      const container = screen.container as HTMLElement;
      expect(container.querySelector('a[target="_blank"]')?.getAttribute("href")).toBe(
        "https://x.com/name_",
      );
      await page.getByRole("link", { name: "settings" }).click();
      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          "C:\\repo\\.config\\a.json",
        );
      });
    } finally {
      openInPreferredEditorMock.mockClear();
      await screen.unmount();
    }
  });
});

const tooltipText = () =>
  document.querySelector('[data-slot="tooltip-popup"]')?.textContent ?? null;

describe("ChatMarkdown web link tooltips", () => {
  it("shows the real destination in place of an authored title", async () => {
    const screen = await render(
      <ChatMarkdown
        text={'[bank](https://\u0430pple.com/login?next=1 "https://apple.com") then more'}
        cwd={CWD}
      />,
    );
    try {
      const link = (screen.container as HTMLElement).querySelector("a") as HTMLElement;
      expect(link.hasAttribute("title")).toBe(false);
      expect(link.getAttribute("target")).toBe("_blank");
      await page.getByRole("link", { name: "bank" }).hover();
      await vi.waitFor(() => {
        expect(tooltipText()).toBe("https://xn--pple-43d.com/login?next=1");
      });
    } finally {
      await userEvent.unhover(page.getByRole("link", { name: "bank" }));
      await screen.unmount();
    }
  });

  it("keeps the real host in sight behind a very long userinfo", async () => {
    const href = `https://accounts.google.com.${"a".repeat(800)}@evil.test/x`;
    const screen = await render(<ChatMarkdown text={`[bank](${href}) then more`} cwd={CWD} />);
    try {
      await page.getByRole("link", { name: "bank" }).hover();
      await vi.waitFor(() => {
        const host = document.querySelector<HTMLElement>("[data-markdown-link-host]");
        expect(host?.textContent).toBe("evil.test");
        const rect = host!.getBoundingClientRect();
        expect(rect.height).toBeGreaterThan(0);
        expect(rect.top).toBeGreaterThanOrEqual(0);
        const popup = document.querySelector('[data-slot="tooltip-popup"]') as HTMLElement;
        expect(rect.bottom).toBeLessThanOrEqual(popup.getBoundingClientRect().bottom);
      });
    } finally {
      await userEvent.unhover(page.getByRole("link", { name: "bank" }));
      await screen.unmount();
    }
  });

  it("gives a mailto link no tooltip and keeps its title", async () => {
    const screen = await render(
      <ChatMarkdown text={'[mail](mailto:me@example.com "Write to me")'} cwd={CWD} />,
    );
    try {
      const link = (screen.container as HTMLElement).querySelector("a") as HTMLElement;
      expect(link.getAttribute("title")).toBe("Write to me");
      expect(link.hasAttribute("data-slot")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("copies a hovered link without tooltip trigger attributes", async () => {
    const screen = await render(
      <ChatMarkdown text="See [docs](https://example.com/docs)." cwd={CWD} />,
    );
    try {
      await page.getByRole("link", { name: "docs" }).hover();
      await vi.waitFor(() => {
        expect(tooltipText()).toBe("https://example.com/docs");
      });
      const root = (screen.container as HTMLElement).querySelector(".chat-markdown") as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(root);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);

      const clipboardData = new DataTransfer();
      root.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, clipboardData }));

      expect(clipboardData.getData("text/plain")).toBe("See [docs](https://example.com/docs).");
      const copied = new DOMParser()
        .parseFromString(clipboardData.getData("text/html"), "text/html")
        .querySelector("a") as HTMLAnchorElement;
      expect(copied.getAttribute("href")).toBe("https://example.com/docs");
      expect(copied.getAttributeNames().toSorted()).toEqual(["href", "rel", "target"]);
    } finally {
      window.getSelection()?.removeAllRanges();
      await userEvent.unhover(page.getByRole("link", { name: "docs" }));
      await screen.unmount();
    }
  });
});

function clickLink(link: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  link.dispatchEvent(event);
  return event;
}

const message = (name: string) => `Claim[^1] from ${name}.\n\n[^1]: Note from ${name}.`;

describe("ChatMarkdown fragment links", () => {
  function linkNamed(container: HTMLElement, name: string): HTMLAnchorElement {
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent === name);
    expect(link, name).toBeTruthy();
    return link as HTMLAnchorElement;
  }

  function spyOnScroll() {
    return vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scrolls to the footnote in its own message when messages repeat ids", async () => {
    const scroll = spyOnScroll();
    const screen = await render(
      <>
        <ChatMarkdown text={message("first")} cwd={CWD} />
        <ChatMarkdown text={message("second")} cwd={CWD} />
      </>,
    );
    try {
      const roots = (screen.container as HTMLElement).querySelectorAll(".chat-markdown");
      const reference = roots[1]!.querySelector("sup a") as HTMLAnchorElement;
      expect(reference.hasAttribute("target")).toBe(false);
      expect(reference.hasAttribute("rel")).toBe(false);

      const hash = window.location.hash;
      expect(clickLink(reference).defaultPrevented).toBe(true);
      expect(window.location.hash).toBe(hash);
      const target = scroll.mock.contexts[0] as unknown as Element;
      expect(target.textContent).toContain("Note from second");
      expect(roots[1]!.contains(target)).toBe(true);

      // The back reference returns to the same message's citation.
      scroll.mockClear();
      clickLink(roots[1]!.querySelector("a[data-footnote-backref]")!);
      expect(scroll.mock.contexts[0]).toBe(reference);
    } finally {
      await screen.unmount();
    }
  });

  it("finds a heading by its GitHub slug, counting repeats and across stream blocks", async () => {
    const scroll = spyOnScroll();
    const screen = await render(
      <ChatMarkdown
        text={
          "[what](#whats-new) [second](#setup-1) [encoded](#caf%C3%A9-menu)\n\n" +
          "## What's New?\n\n## Setup\n\nFirst.\n\n## Setup\n\nSecond.\n\n## Café Menu\n"
        }
        cwd={CWD}
        isStreaming
      />,
    );
    try {
      const container = screen.container as HTMLElement;
      const headings = container.querySelectorAll("h2");
      for (const [name, heading] of [
        ["what", headings[0]],
        ["second", headings[2]],
        ["encoded", headings[3]],
      ] as const) {
        scroll.mockClear();
        clickLink(linkNamed(container, name));
        expect(scroll.mock.contexts[0], name).toBe(heading);
      }
      // No ids go into the DOM for this, so copied HTML stays as it was.
      expect(container.querySelector("h2[id]")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("finds a heading that holds a file chip or an image by its source text", async () => {
    const scroll = spyOnScroll();
    const screen = await render(
      <ChatMarkdown
        text={
          "[chip](#changes-in-srcats) [label](#see-the-loader) [image](#with--picture)\n\n" +
          "## Changes in `src/a.ts`\n\n## See [the loader](src/load.ts)\n\n" +
          '## With ![x](https://x.test/a.png "t") picture\n'
        }
        cwd={CWD}
      />,
    );
    try {
      const container = screen.container as HTMLElement;
      const headings = container.querySelectorAll("h2");
      expect(headings[0]?.querySelector(".chat-markdown-file-link")).toBeTruthy();
      for (const [name, heading] of [
        ["chip", headings[0]],
        ["label", headings[1]],
        ["image", headings[2]],
      ] as const) {
        scroll.mockClear();
        clickLink(linkNamed(container, name));
        expect(scroll.mock.contexts[0], name).toBe(heading);
      }
    } finally {
      await screen.unmount();
    }
  });

  it("opens a collapsed message instead of scrolling its clip", async () => {
    function Fold({ children }: { children: ReactNode }) {
      const [expanded, setExpanded] = useState(false);
      const clip = useRef<HTMLDivElement>(null);
      useEffect(() => {
        const element = clip.current;
        if (!element) return;
        const reveal = () => setExpanded(true);
        element.addEventListener(THREAD_FIND_REVEAL_EVENT, reveal);
        return () => element.removeEventListener(THREAD_FIND_REVEAL_EVENT, reveal);
      }, []);
      return (
        <div
          ref={clip}
          data-testid="clip"
          data-thread-find-fold={expanded ? undefined : ""}
          style={expanded ? undefined : { maxHeight: 100, overflow: "hidden" }}
        >
          {children}
        </div>
      );
    }
    const screen = await render(
      <Fold>
        <ChatMarkdown
          text={`[jump](#far)\n\n${"line\n\n".repeat(40)}## Far\n`}
          cwd={CWD}
          variant="user"
        />
      </Fold>,
    );
    try {
      const container = screen.container as HTMLElement;
      const clip = container.querySelector('[data-testid="clip"]') as HTMLElement;
      clickLink(linkNamed(container, "jump"));
      expect(clip.hasAttribute("data-thread-find-fold")).toBe(false);
      expect(clip.scrollTop).toBe(0);
      expect(clip.style.overflow).toBe("");
    } finally {
      await screen.unmount();
    }
  });

  it("moves focus to the target for a keyboard user, leaving the markup as it was", async () => {
    spyOnScroll();
    const screen = await render(<ChatMarkdown text={message("first")} cwd={CWD} />);
    try {
      const container = screen.container as HTMLElement;
      const reference = container.querySelector("sup a") as HTMLAnchorElement;
      reference.focus();
      await userEvent.keyboard("{Enter}");
      const footnote = container.querySelector("li[id]") as HTMLElement;
      expect(document.activeElement).toBe(footnote);

      (container.querySelector("a[data-footnote-backref]") as HTMLElement).focus();
      expect(footnote.hasAttribute("tabindex")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("leaves focus alone for a mouse click", async () => {
    spyOnScroll();
    const screen = await render(<ChatMarkdown text={message("first")} cwd={CWD} />);
    try {
      const container = screen.container as HTMLElement;
      const before = document.activeElement;
      (container.querySelector("sup a") as HTMLAnchorElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
      );
      expect(document.activeElement).toBe(before);
    } finally {
      await screen.unmount();
    }
  });

  it("stays on the route for a missing target, a malformed escape and an empty fragment", async () => {
    const scroll = spyOnScroll();
    const screen = await render(
      <ChatMarkdown text={"[gone](#nowhere) [bad](#%E0%A4%A) [empty](#)\n\n## Real"} cwd={CWD} />,
    );
    try {
      const container = screen.container as HTMLElement;
      const hash = window.location.hash;
      for (const name of ["gone", "bad", "empty"]) {
        expect(clickLink(linkNamed(container, name)).defaultPrevented, name).toBe(true);
      }
      expect(window.location.hash).toBe(hash);
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("treats a modified click like a plain one", async () => {
    const scroll = spyOnScroll();
    const screen = await render(<ChatMarkdown text={"[go](#real)\n\n## Real"} cwd={CWD} />);
    try {
      const container = screen.container as HTMLElement;
      const link = linkNamed(container, "go");
      for (const init of [
        { metaKey: true },
        { ctrlKey: true },
        { shiftKey: true },
        { altKey: true },
      ]) {
        scroll.mockClear();
        expect(clickLink(link, init).defaultPrevented).toBe(true);
        expect(scroll.mock.contexts[0]).toBe(container.querySelector("h2"));
      }
    } finally {
      await screen.unmount();
    }
  });
});

describe("ChatMarkdown streaming blocks", () => {
  it("keeps finished blocks while the last one grows and after streaming ends", async () => {
    const screen = await render(
      <ChatMarkdown text={"First [index.ts](apps/web/index.ts)\n\nSec"} cwd={CWD} isStreaming />,
    );
    try {
      const container = screen.container as HTMLElement;
      const first = container.querySelector("p");
      expect(first?.textContent).toContain("index.ts");

      await screen.rerender(
        <ChatMarkdown
          text={"First [index.ts](apps/web/index.ts)\n\nSecond [index.ts](apps/server/index.ts)"}
          cwd={CWD}
          isStreaming
        />,
      );
      expect(container.querySelector("p")).toBe(first);
      // Chips in different blocks still tell same-named files apart.
      expect(
        [...container.querySelectorAll(".chat-markdown-file-link")].map((chip) => chip.textContent),
      ).toEqual(["index.tsapps/web", "index.tsapps/server"]);

      await screen.rerender(
        <ChatMarkdown
          text={"First [index.ts](apps/web/index.ts)\n\nSecond [index.ts](apps/server/index.ts)"}
          cwd={CWD}
          isStreaming={false}
        />,
      );
      expect(container.querySelector("p")).toBe(first);
      expect(container.querySelectorAll("p")).toHaveLength(2);
    } finally {
      await screen.unmount();
    }
  });
});

function enableMath() {
  localStorage.setItem(
    "piedpiper:client-settings:v1",
    JSON.stringify({ mathRenderingEnabled: true }),
  );
}

describe("ChatMarkdown math", () => {
  afterEach(() => {
    localStorage.clear();
    window.getSelection()?.removeAllRanges();
  });

  it("leaves TeX as text while math rendering is off", async () => {
    const screen = await render(<ChatMarkdown text={"Runs in \\(O(n^2)\\) time"} cwd={CWD} />);
    try {
      const container = screen.container as HTMLElement;
      expect(container.querySelector("[data-markdown-math]")).toBeNull();
      expect(container.textContent).toContain("O(n^2)");
    } finally {
      await screen.unmount();
    }
  });

  it("typesets inline and display math and keeps prices as text", async () => {
    enableMath();
    const screen = await render(
      <ChatMarkdown
        text={"Costs $5 and $10, runs in \\(O(n^2)\\).\n\n$$\\sum_i x_i$$\n\n```math\na^2\n```"}
        cwd={CWD}
      />,
    );
    try {
      const container = screen.container as HTMLElement;
      await vi.waitFor(
        () => {
          expect(container.querySelectorAll(".katex")).toHaveLength(3);
        },
        { timeout: 20_000, interval: 50 },
      );
      expect(
        [...container.querySelectorAll("[data-markdown-math]")].map((math) =>
          math.getAttribute("data-markdown-math"),
        ),
      ).toEqual(["inline", "display", "display"]);
      expect(container.querySelector("p")?.textContent).toContain("Costs $5 and $10");
    } finally {
      await screen.unmount();
    }
  });

  it("shows the source of TeX that KaTeX cannot parse", async () => {
    enableMath();
    const screen = await render(<ChatMarkdown text={"$$\\frac{1}{$$"} cwd={CWD} />);
    try {
      const container = screen.container as HTMLElement;
      await vi.waitFor(() => {
        expect(container.querySelector("[data-markdown-math]")?.textContent).toBe(
          "$$\n\\frac{1}{\n$$",
        );
      });
      expect(container.querySelector(".katex")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("copies a selection inside a formula as its TeX", async () => {
    enableMath();
    const screen = await render(<ChatMarkdown text={"Area \\(\\pi r^2\\) here"} cwd={CWD} />);
    try {
      const container = screen.container as HTMLElement;
      let glyphs: Element | null = null;
      await vi.waitFor(
        () => {
          glyphs = container.querySelector(".katex-html");
          expect(glyphs).toBeTruthy();
        },
        { timeout: 20_000, interval: 50 },
      );
      const range = document.createRange();
      range.selectNodeContents(glyphs!);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const root = container.querySelector(".chat-markdown") as HTMLElement;
      const clipboardData = new DataTransfer();
      root.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, clipboardData }));
      expect(clipboardData.getData("text/plain")).toBe("$\\pi r^2$");

      range.selectNodeContents(root);
      selection.removeAllRanges();
      selection.addRange(range);
      const wholeData = new DataTransfer();
      root.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, clipboardData: wholeData }));
      expect(wholeData.getData("text/plain")).toBe("Area $\\pi r^2$ here");
      expect(wholeData.getData("text/html")).toContain("<code>$\\pi r^2$</code>");
    } finally {
      await screen.unmount();
    }
  });
});

describe("ChatMarkdown text direction and lists", () => {
  it("lays out Arabic blocks right to left beside English ones", async () => {
    const screen = await render(
      <ChatMarkdown
        text={"استخدم `useEffect` هنا للتأثير\n\n- عنصر أول\n- عنصر ثان\n\nEnglish paragraph"}
        cwd={CWD}
      />,
    );
    try {
      const container = screen.container as HTMLElement;
      const [arabic, english] = container.querySelectorAll("p");
      expect(arabic?.getAttribute("dir")).toBe("rtl");
      expect(arabic?.querySelector("code")?.getAttribute("dir")).toBe("ltr");
      expect(container.querySelector("ul")?.getAttribute("dir")).toBe("rtl");
      expect(english?.hasAttribute("dir")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("widens the marker gutter only for lists with multi-character markers", async () => {
    const longList = Array.from({ length: 3 }, (_, index) => `${index + 99}. item`).join("\n");
    const screen = await render(
      <ChatMarkdown text={`1. one\n2. two\n\ntext\n\n${longList}`} cwd={CWD} />,
    );
    try {
      const [short, long] = (screen.container as HTMLElement).querySelectorAll("ol");
      expect(short?.style.paddingInlineStart).toBe("");
      expect(long?.style.paddingInlineStart).toBe("5ch");
      expect(short?.className ?? "").not.toContain("tabular-nums");
      expect(long?.className).toContain("tabular-nums");
    } finally {
      await screen.unmount();
    }
  });

  it("sizes nested list gutters for their letter and roman markers", async () => {
    const alpha = Array.from({ length: 12 }, (_, index) => `   ${index + 1}. sub`).join("\n");
    const roman = Array.from({ length: 8 }, (_, index) => `      ${index + 1}. deep`).join("\n");
    const screen = await render(
      <ChatMarkdown text={`1. top\n${alpha}\n2. next\n   1. sub\n${roman}`} cwd={CWD} />,
    );
    try {
      const [top, alphaList, romanParent, romanList] = (
        screen.container as HTMLElement
      ).querySelectorAll("ol");
      expect(top?.style.paddingInlineStart).toBe("");
      expect(alphaList?.style.paddingInlineStart).toBe("");
      expect(romanParent?.style.paddingInlineStart).toBe("");
      expect(romanList?.style.paddingInlineStart).toBe("6ch");
    } finally {
      await screen.unmount();
    }
  });
});

describe("ChatMarkdown heading levels", () => {
  it("shifts the outline level of headings without changing the tag", async () => {
    const screen = await render(
      <ChatMarkdown text={"# H\n\n###### Deep"} cwd={CWD} headingLevelOffset={3} />,
    );
    try {
      const container = screen.container as HTMLElement;
      expect(container.querySelector("h1")?.getAttribute("aria-level")).toBe("4");
      expect(container.querySelector("h6")?.getAttribute("aria-level")).toBe("6");
    } finally {
      await screen.unmount();
    }
  });

  it("leaves headings alone without an offset", async () => {
    const screen = await render(<ChatMarkdown text="# H" cwd={CWD} />);
    try {
      const container = screen.container as HTMLElement;
      expect(container.querySelector("h1")?.hasAttribute("aria-level")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });
});

const breaks = (container: Element) => container.querySelectorAll(".chat-markdown br").length;

describe("ChatMarkdown line breaks", () => {
  it("keeps single newlines only with lineBreaks", async () => {
    const screen = await render(<ChatMarkdown text={"one\ntwo"} cwd={CWD} />);
    try {
      const container = screen.container as HTMLElement;
      expect(breaks(container)).toBe(0);
      await screen.rerender(<ChatMarkdown text={"one\ntwo"} cwd={CWD} lineBreaks />);
      expect(breaks(container)).toBe(1);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps rendered blocks mounted when lineBreaks flips during streaming", async () => {
    const text = "\u2605 Insight\n\nFirst block\n\none\ntwo";
    const screen = await render(<ChatMarkdown text={text} cwd={CWD} isStreaming />);
    try {
      const container = screen.container as HTMLElement;
      const blocks = [...container.querySelectorAll("p")];
      expect(blocks).toHaveLength(3);
      expect(breaks(container)).toBe(0);

      await screen.rerender(
        <ChatMarkdown text={`${text}\nthree`} cwd={CWD} isStreaming lineBreaks />,
      );
      expect([...container.querySelectorAll("p")]).toEqual(blocks);
      expect(breaks(container)).toBe(2);
    } finally {
      await screen.unmount();
    }
  });

  it("adds no extra break beside an image alone on its line", async () => {
    const screen = await render(
      <ChatMarkdown
        text={"label\n![shot](https://example.com/a.png)\nafter"}
        cwd={CWD}
        lineBreaks
      />,
    );
    try {
      expect(breaks(screen.container as HTMLElement)).toBe(2);
    } finally {
      await screen.unmount();
    }
  });
});

describe('ChatMarkdown variant="user"', () => {
  afterEach(() => {
    localStorage.removeItem("piedpiper:client-settings:v1");
  });

  async function renderUser(text: string) {
    const screen = await render(<ChatMarkdown text={text} cwd={CWD} variant="user" />);
    return { screen, container: screen.container as HTMLElement };
  }

  it("keeps a newline as a line break", async () => {
    const { screen, container } = await renderUser("a\nb");
    try {
      expect(container.querySelector("p")?.innerHTML).toBe("a<br>\nb");
    } finally {
      await screen.unmount();
    }
  });

  it("shows typed tags and comparisons literally", async () => {
    const { screen, container } = await renderUser(
      "<thinking>\nfoo\n</thinking>\n\nUse Array<string> when 2 < 3\n\n<details open>\n<summary>x</summary>",
    );
    try {
      expect(container.textContent).toContain("<thinking>");
      expect(container.textContent).toContain("</thinking>");
      expect(container.textContent).toContain("Use Array<string> when 2 < 3");
      expect(container.textContent).toContain("<details open>");
      expect(container.querySelector("thinking, details, summary")).toBeNull();
      expect(container.querySelector(".chat-markdown > p")?.querySelectorAll("br")).toHaveLength(2);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the copy button on a fence and offers no Run button without a handler", async () => {
    const { screen } = await renderUser("```sh\nls -la\n```");
    try {
      await expect.element(page.getByRole("button", { name: /copy/i })).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: /run/i })).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("leaves math and Codex directives as text", async () => {
    enableMath();
    const source = '$$x$$\n\n::code-comment{title="Note" body="Hi"}';
    const { screen, container } = await renderUser(source);
    try {
      expect(container.querySelector(".katex")).toBeNull();
      expect(container.textContent).toContain("$$x$$");
      expect(container.textContent).toContain("::code-comment{");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a math fence as a code block", async () => {
    enableMath();
    const { screen, container } = await renderUser("```math\nx^2\n```");
    try {
      expect(container.querySelector(".katex")).toBeNull();
      expect(container.querySelector("pre")?.textContent).toContain("x^2");
    } finally {
      await screen.unmount();
    }
  });

  it("still blanks unsafe link targets", async () => {
    const { screen, container } = await renderUser("[x](javascript:alert(1))");
    try {
      expect(container.querySelector("a")?.getAttribute("href") ?? "").not.toContain("javascript");
    } finally {
      await screen.unmount();
    }
  });
});

describe("ChatMarkdown contrast", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--appearance-contrast-boost");
  });

  it("starts at 80% opacity and reaches full opacity at the maximum boost", async () => {
    const screen = await render(<ChatMarkdown text="Hello" cwd={CWD} />);
    try {
      const root = (screen.container as HTMLElement).querySelector(".chat-markdown")!;
      const alpha = () => /\/\s*([\d.]+)\)$/.exec(getComputedStyle(root).color)?.[1] ?? "1";
      expect(Number(alpha())).toBeCloseTo(0.8);
      document.documentElement.style.setProperty("--appearance-contrast-boost", "100%");
      expect(Number(alpha())).toBeCloseTo(1);
    } finally {
      await screen.unmount();
    }
  });
});
