import "../index.css";

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ChatMarkdown from "./ChatMarkdown";
import { useExpandedImageStore } from "./ChatView.expandedImage";
import { revealThreadFindMatch } from "./chat/threadFindHighlights";

const CWD = "/repo/project";
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const BROKEN = "data:image/png;base64,AAAA";

/** The Markdown and HTML a copy of everything inside `node` puts on the clipboard. */
function copyChildrenOf(node: Element) {
  window.getSelection()?.selectAllChildren(node);
  const clipboardData = new DataTransfer();
  node.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, clipboardData }));
  window.getSelection()?.removeAllRanges();
  return { text: clipboardData.getData("text/plain"), html: clipboardData.getData("text/html") };
}

/** The Markdown and HTML a copy of the whole message puts on the clipboard. */
function copyAll(container: HTMLElement) {
  const root = container.querySelector(".chat-markdown") as HTMLElement;
  window.getSelection()?.selectAllChildren(root);
  const clipboardData = new DataTransfer();
  root.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, clipboardData }));
  window.getSelection()?.removeAllRanges();
  return { text: clipboardData.getData("text/plain"), html: clipboardData.getData("text/html") };
}

describe("ChatMarkdown raw HTML", () => {
  it("opens details, keeping the state while the text streams", async () => {
    const body = "<details>\n<summary>More</summary>\n\nHidden body";
    const screen = await render(<ChatMarkdown text={body} cwd={CWD} isStreaming />);
    try {
      const container = screen.container as HTMLElement;
      expect(container.textContent).toContain("More");
      expect(container.textContent).not.toContain("Hidden body");

      await page.getByRole("button", { name: "More" }).click();
      await expect.element(page.getByText("Hidden body")).toBeVisible();

      await screen.rerender(<ChatMarkdown text={`${body} grows`} cwd={CWD} isStreaming />);
      await expect.element(page.getByText("Hidden body grows")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("honors the open attribute and copies open details as HTML", async () => {
    const screen = await render(
      <ChatMarkdown
        text={"<details open>\n<summary>More</summary>\n\nBody **bold**\n\n</details>"}
        cwd={CWD}
      />,
    );
    try {
      await expect.element(page.getByText("Body")).toBeVisible();
      const copied = copyAll(screen.container as HTMLElement);
      expect(copied.text).toBe(
        "<details open>\n<summary>More</summary>\n\nBody **bold**\n\n</details>",
      );
      expect(copied.html).toContain('<details open=""><summary>More</summary>');
      expect(copied.html).toContain("<strong>bold</strong>");
      expect(copied.html).not.toContain("<button");
    } finally {
      await screen.unmount();
    }
  });

  it("copies closed details as their label", async () => {
    const screen = await render(
      <ChatMarkdown text={"<details><summary>More</summary>\n\nBody\n\n</details>"} cwd={CWD} />,
    );
    try {
      expect(copyAll(screen.container as HTMLElement).text).toBe("More");
    } finally {
      await screen.unmount();
    }
  });

  it("turns only the chevron when a summary holds its own icon", async () => {
    const screen = await render(
      <ChatMarkdown
        text={
          "<details open>\n<summary>\n\n![Gone](javascript:x)\n\n</summary>\n\nBody\n\n</details>"
        }
        cwd={CWD}
      />,
    );
    try {
      const trigger = (screen.container as HTMLElement).querySelector(
        "[data-markdown-details-summary]",
      ) as HTMLElement;
      const icons = [...trigger.querySelectorAll("svg")];
      expect(icons.length).toBe(2);
      await vi.waitFor(() => {
        expect(getComputedStyle(icons[0]!).rotate).toBe("90deg");
      });
      expect(getComputedStyle(icons[1]!).rotate).toBe("none");
    } finally {
      await screen.unmount();
    }
  });

  it("opens for thread find when a match sits inside a closed block", async () => {
    const screen = await render(
      <div data-timeline-row-id="row-1" data-thread-find-text>
        <ChatMarkdown
          text={"<details>\n<summary>More</summary>\n\nsecret line\n\n</details>"}
          cwd={CWD}
        />
      </div>,
    );
    try {
      const container = screen.container as HTMLElement;
      const fold = container.querySelector("[data-thread-find-fold]");
      expect(fold).toBeTruthy();
      expect(container.textContent).not.toContain("secret line");

      const stop = revealThreadFindMatch({
        container,
        scrollContainer: document.documentElement,
        position: { rowId: "row-1", occurrence: 0 },
        foldedQuery: "secret",
        scrollRowIntoWindow: () => undefined,
      });
      try {
        await expect.element(page.getByText("secret line")).toBeVisible();
      } finally {
        stop();
      }
      expect(container.querySelector("[data-thread-find-fold]")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("copies a line break in a table cell as the tag", async () => {
    const screen = await render(<ChatMarkdown text={"| a |\n| - |\n| x<br>y |"} cwd={CWD} />);
    try {
      const container = screen.container as HTMLElement;
      expect(container.querySelector("td br")).toBeTruthy();
      expect(copyAll(container).text).toContain("| x<br>y |");
    } finally {
      await screen.unmount();
    }
  });

  it("renders kbd, sub and sup while unknown tags stay text", async () => {
    const screen = await render(
      <ChatMarkdown
        text={"<kbd>Cmd</kbd> H<sub>2</sub>O x<sup>2</sup> Array<string> <script>x()</script>"}
        cwd={CWD}
      />,
    );
    try {
      const container = screen.container as HTMLElement;
      expect(container.querySelector("kbd")?.textContent).toBe("Cmd");
      expect(container.querySelector("sub")?.textContent).toBe("2");
      expect(container.querySelector("sup")?.textContent).toBe("2");
      expect(container.querySelector("script")).toBeNull();
      expect(container.textContent).toContain("Array<string>");
      expect(container.textContent).toContain("<script>x()</script>");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps file chips, a fence title and run button beside raw HTML", async () => {
    const screen = await render(
      <ChatMarkdown
        text={'See `src/a.ts`<br>now\n\n```sh title="a.sh"\nls\n```'}
        cwd={CWD}
        onRunShellCommand={() => undefined}
      />,
    );
    try {
      const container = screen.container as HTMLElement;
      expect(container.querySelector(".chat-markdown-file-link")).toBeTruthy();
      expect(container.querySelector(".chat-markdown-codeblock-header")?.textContent).toBe("a.sh");
      await expect.element(page.getByRole("button", { name: "Run in terminal" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("strips script URLs from a raw image", async () => {
    const screen = await render(
      <ChatMarkdown text={'<img src="javascript:alert(1)" alt="x" onerror="y()">'} cwd={CWD} />,
    );
    try {
      const container = screen.container as HTMLElement;
      expect(container.querySelector("img")).toBeNull();
      expect(container.innerHTML).not.toContain("javascript:");
      expect(container.innerHTML).not.toContain("onerror");
      expect(container.textContent).toContain("Image unavailable · x");
    } finally {
      await screen.unmount();
    }
  });
});

describe("ChatMarkdown GitHub alerts", () => {
  it("renders a labelled note and forwards its direction", async () => {
    const screen = await render(
      <ChatMarkdown text={"> [!WARNING]\n> هذا تحذير مهم جدا\n\n> just a quote"} cwd={CWD} />,
    );
    try {
      const container = screen.container as HTMLElement;
      const note = container.querySelector('[role="note"]');
      expect(note?.textContent).toContain("Warning");
      expect(note?.getAttribute("dir")).toBe("rtl");
      expect(container.textContent).not.toContain("[!WARNING]");
      expect(container.querySelectorAll("blockquote")).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("copies the alert with its marker", async () => {
    const screen = await render(<ChatMarkdown text={"> [!TIP]\n> Use it"} cwd={CWD} />);
    try {
      expect(copyAll(screen.container as HTMLElement).text).toBe("> [!TIP]\n> Use it");
    } finally {
      await screen.unmount();
    }
  });

  it("copies the alert to rich text as a labelled quote", async () => {
    const screen = await render(<ChatMarkdown text={"> [!WARNING]\n> Mind it"} cwd={CWD} />);
    try {
      const { html } = copyAll(screen.container as HTMLElement);
      const quote = new DOMParser().parseFromString(html, "text/html").querySelector("blockquote");
      expect(quote?.querySelector("p strong")?.textContent).toBe("Warning");
      expect(quote?.textContent).toContain("Mind it");
      expect(quote?.querySelectorAll("p")).toHaveLength(2);
      expect(html).not.toContain("data-alert");
      expect(html).not.toContain("<svg");
    } finally {
      await screen.unmount();
    }
  });
});

describe("ChatMarkdown images", () => {
  afterEach(() => {
    useExpandedImageStore.getState().close();
  });

  it("swaps the skeleton for the loaded image, capped and lazy", async () => {
    const screen = await render(<ChatMarkdown text={`![Pixel](${PIXEL})`} cwd={CWD} />);
    try {
      const container = screen.container as HTMLElement;
      const image = container.querySelector("img") as HTMLImageElement;
      expect(image.loading).toBe("lazy");
      await expect.element(page.getByRole("button", { name: "Preview Pixel" })).toBeVisible();
      expect(container.querySelector(".animate-pulse")).toBeNull();
      expect(getComputedStyle(image).maxHeight).toBe("480px");
      expect(getComputedStyle(image).objectFit).toBe("contain");
    } finally {
      await screen.unmount();
    }
  });

  it("opens the preview with the message's images, by click and by key", async () => {
    const screen = await render(
      <ChatMarkdown
        text={`![One](${PIXEL})\n\n![Two](${PIXEL}#2)\n\n[![Linked](${PIXEL}#3)](https://x.test)`}
        cwd={CWD}
      />,
    );
    try {
      await page.getByRole("button", { name: "Preview Two" }).click();
      const preview = useExpandedImageStore.getState().preview;
      expect(preview?.images.map((image) => image.name)).toEqual(["One", "Two"]);
      expect(preview?.index).toBe(1);

      useExpandedImageStore.getState().close();
      (await page.getByRole("button", { name: "Preview One" }).element()).focus();
      await userEvent.keyboard("{Enter}");
      expect(useExpandedImageStore.getState().preview?.index).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it("counts an image that has not loaded yet in the preview", async () => {
    const screen = await render(
      <ChatMarkdown
        text={`![One](${PIXEL})\n\n${"line\n\n".repeat(600)}![Far](http://127.0.0.1:9/far.png)`}
        cwd={CWD}
      />,
    );
    try {
      await page.getByRole("button", { name: "Preview One" }).click();
      const preview = useExpandedImageStore.getState().preview;
      expect(preview?.images.map((image) => image.name)).toEqual(["One", "Far"]);
      // Not interactive until it has loaded, though.
      expect(
        (screen.container as HTMLElement).querySelector('img[alt="Far"]')?.getAttribute("role"),
      ).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it.each<[string, string, { width?: string; height: string }]>([
    ["height alone", 'height="40"', { width: "40px", height: "40px" }],
    ["width alone", 'width="40"', { width: "40px", height: "40px" }],
    ["both", 'width="40" height="20"', { width: "40px", height: "20px" }],
    ["a height past the cap", 'height="100000"', { height: "480px" }],
  ])("sizes a loaded image by %s", async (_name, attributes, expected) => {
    const screen = await render(
      <ChatMarkdown text={`<img src="${PIXEL}" ${attributes}>`} cwd={CWD} />,
    );
    try {
      await expect.element(page.getByRole("button", { name: "Preview image" })).toBeVisible();
      const image = (screen.container as HTMLElement).querySelector("img") as HTMLImageElement;
      if (expected.width) expect(getComputedStyle(image).width).toBe(expected.width);
      expect(getComputedStyle(image).height).toBe(expected.height);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a tall image's box to the picture it draws", async () => {
    const screen = await render(
      <ChatMarkdown text={`<img src="${PIXEL}" width="1000" height="4000">`} cwd={CWD} />,
    );
    try {
      await expect.element(page.getByRole("button", { name: "Preview image" })).toBeVisible();
      const image = (screen.container as HTMLElement).querySelector("img") as HTMLImageElement;
      expect(getComputedStyle(image).width).toBe("120px");
      expect(getComputedStyle(image).height).toBe("480px");
    } finally {
      await screen.unmount();
    }
  });

  it("holds a seen image's size when its row mounts again", async () => {
    const bytes = Uint8Array.from(atob(PIXEL.split(",")[1] ?? ""), (char) => char.charCodeAt(0));
    const blob = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    const first = await render(<ChatMarkdown text={`![Seen](${blob})`} cwd={CWD} />);
    await expect.element(page.getByRole("button", { name: "Preview Seen" })).toBeVisible();
    await first.unmount();

    // Rendered synchronously, so this reads the placeholder before any load event can fire.
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      flushSync(() => root.render(<ChatMarkdown text={`![Seen](${blob})`} cwd={CWD} />));
      const placeholder = host.querySelector<HTMLElement>("span[aria-hidden]");
      // A 1px image, not the default 12rem by 6rem block.
      expect(placeholder?.style.aspectRatio).toBe("1 / 1");
      expect(placeholder?.style.width).toBe("1px");
    } finally {
      URL.revokeObjectURL(blob);
      root.unmount();
      host.remove();
    }
  });

  it("leaves a linked image as a link", async () => {
    const screen = await render(
      <ChatMarkdown text={`[![Linked](${PIXEL})](https://x.test)`} cwd={CWD} />,
    );
    try {
      const container = screen.container as HTMLElement;
      const image = container.querySelector("a img") as HTMLImageElement;
      await expect.poll(() => image.complete && image.naturalWidth > 0).toBe(true);
      expect(image.getAttribute("role")).toBeNull();
      expect(image.hasAttribute("tabindex")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("shows a linked local image inside its file link, keeping the source on the clipboard", async () => {
    const source = "[![Local](docs/shot.png)](docs/shot.png)";
    const screen = await render(<ChatMarkdown text={source} cwd={CWD} threadId="thread-1" />);
    try {
      const container = screen.container as HTMLElement;
      const link = container.querySelector("a") as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe("docs/shot.png");
      expect(link.classList.contains("bg-muted")).toBe(false);
      expect(link.querySelectorAll("img").length).toBe(1);
      expect(link.querySelector(".truncate")).toBeNull();

      const image = link.querySelector("img[data-markdown-image-source]") as HTMLImageElement;
      const url = new URL(image.getAttribute("src") ?? "");
      expect(url.pathname).toBe("/api/workspace-image");
      expect(url.searchParams.get("path")).toBe("/repo/project/docs/shot.png");
      expect(image.getAttribute("alt")).toBe("Local");
      expect(image.getAttribute("role")).toBeNull();
      expect(image.hasAttribute("data-markdown-image-expandable")).toBe(false);

      const copied = copyAll(container);
      expect(copied.text).toBe(source);
      expect(copied.html).not.toContain("/api/workspace-image");
      expect(copied.html).not.toContain("token=");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a local link's text beside its image", async () => {
    const source = "[![Local](shot.png) the [real] shot](docs/notes.md).";
    const screen = await render(<ChatMarkdown text={source} cwd={CWD} threadId="thread-1" />);
    try {
      const container = screen.container as HTMLElement;
      const link = container.querySelector("a") as HTMLAnchorElement;
      expect(link.querySelector("img[data-markdown-image-source]")).toBeTruthy();
      expect(link.textContent).toContain("the [real] shot");
      expect(copyAll(container).text).toBe(
        "[![Local](shot.png) the \\[real\\] shot](docs/notes.md).",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("copies a local link's inline formatting with its image", async () => {
    const source = "[**Bold** ![Local](shot.png) with `code[0]`](docs/notes.md)";
    const screen = await render(<ChatMarkdown text={source} cwd={CWD} threadId="thread-1" />);
    try {
      expect(copyAll(screen.container as HTMLElement).text).toBe(source);
    } finally {
      await screen.unmount();
    }
  });

  it("wraps a long local link label followed by punctuation", async () => {
    const label = "a long sentence of label text ".repeat(12).trim();
    const screen = await render(
      <div style={{ width: 240 }}>
        <ChatMarkdown
          text={`[![Local](${PIXEL}) ${label}](docs/notes.md).`}
          cwd={CWD}
          threadId="thread-1"
        />
      </div>,
    );
    try {
      const root = (screen.container as HTMLElement).querySelector(".chat-markdown") as HTMLElement;
      expect(root.textContent).toContain(`${label}.`);
      expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
    } finally {
      await screen.unmount();
    }
  });

  it("falls back to a chip on failure and recovers when the source changes", async () => {
    const screen = await render(<ChatMarkdown text={`![Broken](${BROKEN})`} cwd={CWD} />);
    try {
      const container = screen.container as HTMLElement;
      await expect.element(page.getByText("Image unavailable · Broken")).toBeVisible();
      expect(copyAll(container).text).toBe(`![Broken](${BROKEN})`);

      await screen.rerender(<ChatMarkdown text={`![Broken](${PIXEL})`} cwd={CWD} />);
      await expect.element(page.getByRole("button", { name: "Preview Broken" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("shows a chip for a local image with no thread to check it against", async () => {
    const screen = await render(<ChatMarkdown text={"![Local](shot.png)"} cwd={CWD} />);
    try {
      const container = screen.container as HTMLElement;
      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).toBe("Image unavailable · Local");
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    ["\\\\server\\share\\a.png", "<\\\\server\\share\\a.png>"],
    ["file://server/share/a.png", "file://server/share/a.png"],
    ["javascript:alert(1)", "javascript:alert(1)"],
  ])("never loads %s", async (_name, destination) => {
    const screen = await render(
      <ChatMarkdown text={`![Blocked](${destination})`} cwd={CWD} threadId="thread-1" />,
    );
    try {
      const container = screen.container as HTMLElement;
      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).toBe("Image unavailable · Blocked");
    } finally {
      await screen.unmount();
    }
  });

  it("loads a workspace image through the server and keeps its token off the clipboard", async () => {
    const screen = await render(
      <ChatMarkdown text={"![Local](docs/My%20Shot.png)"} cwd={CWD} threadId="thread-1" />,
    );
    try {
      const container = screen.container as HTMLElement;
      const image = container.querySelector("img") as HTMLImageElement;
      const url = new URL(image.getAttribute("src") ?? "");
      expect(url.pathname).toBe("/api/workspace-image");
      expect(url.protocol).toBe(window.location.protocol);
      expect(url.searchParams.get("threadId")).toBe("thread-1");
      expect(url.searchParams.get("path")).toBe("/repo/project/docs/My Shot.png");

      const copied = copyAll(container);
      expect(copied.text).toBe("![Local](docs/My%20Shot.png)");
      expect(copied.html).toContain('src="docs/My%20Shot.png"');
      expect(copied.html).not.toContain("/api/workspace-image");
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    ["with alt text", "![Local](shot.png)", "![Local](shot.png)"],
    ["without alt text", "![](shot.png)", "![](shot.png)"],
  ])(
    "keeps the token off the clipboard for a selection inside the image %s",
    async (_name, md, text) => {
      const screen = await render(<ChatMarkdown text={md} cwd={CWD} threadId="thread-1" />);
      try {
        const container = screen.container as HTMLElement;
        const wrapper = container.querySelector("img")?.parentElement as HTMLElement;
        const copied = copyChildrenOf(wrapper);
        expect(copied.text).toBe(text);
        expect(copied.text).not.toContain("/api/workspace-image");
        expect(copied.html).toContain('src="shot.png"');
        expect(copied.html).not.toContain("/api/workspace-image");
        expect(copied.html).not.toContain("token=");
      } finally {
        await screen.unmount();
      }
    },
  );
});
