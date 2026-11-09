import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { openExternalMock, showContextMenuMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(async (_url: string) => undefined),
  showContextMenuMock: vi.fn(
    async (_items: unknown, _position?: { x: number; y: number }): Promise<string | null> => null,
  ),
}));

vi.mock("~/env", () => ({ isElectron: true }));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  readNativeApi: () => ({
    shell: { openExternal: openExternalMock },
    contextMenu: { show: showContextMenuMock },
  }),
}));

import ChatMarkdown from "./ChatMarkdown";
import { toastManager } from "./ui/toast";

/**
 * Dispatches a click and reports whether it bubbled past React's handler to the window. A
 * window listener blocks the navigation the test page would otherwise follow.
 */
function click(link: Element, altKey: boolean): { event: MouseEvent; reachedWindow: boolean } {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, altKey });
  let reachedWindow = false;
  const blockNavigation = (clickEvent: Event) => {
    reachedWindow = true;
    clickEvent.preventDefault();
  };
  window.addEventListener("click", blockNavigation);
  try {
    link.dispatchEvent(event);
  } finally {
    window.removeEventListener("click", blockNavigation);
  }
  return { event, reachedWindow };
}

describe("ChatMarkdown web links on desktop", () => {
  afterEach(() => {
    openExternalMock.mockClear();
  });

  it("opens an Option/Alt-clicked link in the system browser instead of downloading it", async () => {
    const screen = await render(
      <ChatMarkdown text="[docs](https://example.com/docs)" cwd="/repo" />,
    );
    try {
      const link = (screen.container as HTMLElement).querySelector("a")!;
      expect(click(link, false).reachedWindow).toBe(true);
      expect(openExternalMock).not.toHaveBeenCalled();

      const altClick = click(link, true);
      // Only the link's handler could have prevented this click: it never reached the window.
      expect(altClick.reachedWindow).toBe(false);
      expect(altClick.event.defaultPrevented).toBe(true);
      expect(openExternalMock).toHaveBeenCalledWith("https://example.com/docs");
    } finally {
      await screen.unmount();
    }
  });

  it("opens a relative link's resolved URL and leaves non-web links to the browser", async () => {
    const screen = await render(
      <ChatMarkdown text="[guide](/docs/guide) and [mail](mailto:me@example.com)" cwd="/repo" />,
    );
    try {
      const [guide, mail] = (screen.container as HTMLElement).querySelectorAll("a");
      expect(click(guide!, true).reachedWindow).toBe(false);
      expect(openExternalMock).toHaveBeenCalledWith(`${window.location.origin}/docs/guide`);

      openExternalMock.mockClear();
      expect(click(mail!, true).reachedWindow).toBe(true);
      expect(openExternalMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});

function contextMenu(chip: Element, clientX: number, clientY: number) {
  chip.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY }),
  );
}

describe("ChatMarkdown file chip context menu", () => {
  afterEach(() => {
    showContextMenuMock.mockReset();
    showContextMenuMock.mockImplementation(async () => null);
  });

  it("opens at the pointer, or under the chip when opened from the keyboard", async () => {
    const screen = await render(<ChatMarkdown text="See [a.ts](src/a.ts)." cwd="/repo" />);
    try {
      const chip = (screen.container as HTMLElement).querySelector(".chat-markdown-file-link")!;
      contextMenu(chip, 40, 12);
      expect(showContextMenuMock).toHaveBeenLastCalledWith(expect.any(Array), { x: 40, y: 12 });

      contextMenu(chip, 0, 0);
      const rect = chip.getBoundingClientRect();
      expect(showContextMenuMock).toHaveBeenLastCalledWith(expect.any(Array), {
        x: rect.left,
        y: rect.bottom,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows an error toast when the menu fails to open", async () => {
    showContextMenuMock.mockImplementation(async () => {
      throw new Error("bridge gone");
    });
    const addToast = vi.spyOn(toastManager, "add");
    const screen = await render(<ChatMarkdown text="See [a.ts](src/a.ts)." cwd="/repo" />);
    try {
      const chip = (screen.container as HTMLElement).querySelector(".chat-markdown-file-link")!;
      contextMenu(chip, 40, 12);
      await vi.waitFor(() => {
        expect(addToast).toHaveBeenCalledWith(
          expect.objectContaining({ type: "error", description: "bridge gone" }),
        );
      });
    } finally {
      addToast.mockRestore();
      await screen.unmount();
    }
  });
});
