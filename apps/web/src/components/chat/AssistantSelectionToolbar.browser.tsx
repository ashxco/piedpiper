import "../../index.css";

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ASSISTANT_QUOTE_MAX_CHARS } from "~/lib/assistantTextSelection";

import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";

function Timeline({ onQuote, longText }: { onQuote: (text: string) => void; longText?: string }) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  return (
    <div>
      <div id="viewport" ref={setViewport} style={{ height: 300, overflow: "auto" }}>
        <div data-message-role="user">
          <p id="user-text">A user prompt</p>
        </div>
        <div data-message-role="assistant">
          <div className="chat-markdown">
            <p id="first">First paragraph</p>
            <p id="second">
              Second <strong>bold</strong> paragraph
            </p>
            <pre>
              <code id="code">const a = 1;</code>
            </pre>
            {longText ? <p id="long">{longText}</p> : null}
          </div>
          <div id="footer">Footer text</div>
        </div>
        <div data-message-role="assistant">
          <div className="chat-markdown">
            <p id="other">Other reply</p>
          </div>
        </div>
        <div style={{ height: 2000 }} />
      </div>
      <button id="outside" type="button">
        Outside
      </button>
      <AssistantSelectionToolbar viewport={viewport} onQuote={onQuote} />
    </div>
  );
}

function textNode(id: string): Text {
  const node = document.getElementById(id)?.firstChild;
  if (!node) throw new Error(`Missing text node for ${id}`);
  return node as Text;
}

function select(anchor: Text, anchorOffset: number, focus: Text, focusOffset: number) {
  window.getSelection()?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
}

function releaseMouse(target: Element, detail = 1) {
  target.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true }),
  );
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, detail }));
}

function quoteButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    "button[aria-label='Quote selection in composer'], button[aria-label='Selection is too long to quote']",
  );
}

async function mount(onQuote: (text: string) => void, longText?: string) {
  const screen = await render(<Timeline onQuote={onQuote} {...(longText ? { longText } : {})} />);
  await expect.poll(() => document.getElementById("viewport")).toBeTruthy();
  return () => screen.unmount();
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("AssistantSelectionToolbar", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it("opens on release for a selection in one reply and quotes its Markdown", async () => {
    const onQuote = vi.fn();
    const unmount = await mount(onQuote);
    try {
      select(textNode("first"), 0, textNode("first"), 5);
      releaseMouse(document.getElementById("first")!);
      await expect.poll(quoteButton).toBeTruthy();
      quoteButton()?.click();
      expect(onQuote).toHaveBeenCalledWith("First");
      await expect.poll(quoteButton).toBeNull();
      expect(window.getSelection()?.isCollapsed).toBe(true);
    } finally {
      await unmount();
    }
  });

  it("handles a backward selection across blocks, keeping Markdown", async () => {
    const onQuote = vi.fn();
    const unmount = await mount(onQuote);
    try {
      const second = document.getElementById("second")!;
      select(second.lastChild as Text, 10, textNode("first"), 6);
      releaseMouse(second);
      await expect.poll(quoteButton).toBeTruthy();
      quoteButton()?.click();
      expect(onQuote.mock.calls[0]?.[0]).toBe("paragraph\n\nSecond **bold** paragraph");
    } finally {
      await unmount();
    }
  });

  it("accepts a triple-click range that ends at offset 0 of the block after the reply", async () => {
    const onQuote = vi.fn();
    const unmount = await mount(onQuote);
    try {
      select(textNode("code"), 0, textNode("footer"), 0);
      releaseMouse(document.getElementById("code")!);
      await expect.poll(quoteButton).toBeTruthy();
      quoteButton()?.click();
      expect(onQuote).toHaveBeenCalledWith("const a = 1;");
    } finally {
      await unmount();
    }
  });

  it("rejects a selection running out of the reply's Markdown", async () => {
    const unmount = await mount(vi.fn());
    try {
      select(textNode("first"), 0, textNode("footer"), 3);
      releaseMouse(document.getElementById("first")!);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(quoteButton()).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("rejects selections across rows and in user messages", async () => {
    const unmount = await mount(vi.fn());
    try {
      select(textNode("first"), 0, textNode("other"), 3);
      releaseMouse(document.getElementById("first")!);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(quoteButton()).toBeNull();

      select(textNode("user-text"), 0, textNode("user-text"), 4);
      releaseMouse(document.getElementById("user-text")!);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(quoteButton()).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("waits for a multi-click to finish before opening", async () => {
    const unmount = await mount(vi.fn());
    try {
      select(textNode("first"), 0, textNode("first"), 5);
      releaseMouse(document.getElementById("first")!, 2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(quoteButton()).toBeNull();
      await expect.poll(quoteButton, { timeout: 1_500 }).toBeTruthy();
    } finally {
      await unmount();
    }
  });

  it("opens for a keyboard selection and focuses the button on Tab", async () => {
    const unmount = await mount(vi.fn());
    try {
      select(textNode("first"), 0, textNode("first"), 5);
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      await expect.poll(quoteButton).toBeTruthy();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      expect(document.activeElement).toBe(quoteButton());
    } finally {
      await unmount();
    }
  });

  it("dismisses on Escape, scroll and an outside press", async () => {
    const unmount = await mount(vi.fn());
    const open = async () => {
      select(textNode("first"), 0, textNode("first"), 5);
      releaseMouse(document.getElementById("first")!);
      await expect.poll(quoteButton).toBeTruthy();
    };
    try {
      await open();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await expect.poll(quoteButton).toBeNull();

      await open();
      document.getElementById("viewport")!.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
      await expect.poll(quoteButton).toBeNull();

      await open();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
      await expect.poll(quoteButton).toBeNull();

      await open();
      document
        .getElementById("outside")!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true }));
      await expect.poll(quoteButton).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("stays dismissed when a key is released over the same selection", async () => {
    const unmount = await mount(vi.fn());
    try {
      select(textNode("first"), 0, textNode("first"), 5);
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      await expect.poll(quoteButton).toBeTruthy();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      await settle();
      expect(quoteButton()).toBeNull();

      select(textNode("first"), 0, textNode("first"), 3);
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      await expect.poll(quoteButton).toBeTruthy();

      // Shift+Tab leaves the button, and the released Shift must not bring it back to trap Tab.
      quoteButton()?.focus();
      document.getElementById("outside")!.focus();
      await expect.poll(quoteButton).toBeNull();
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      await settle();
      expect(quoteButton()).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("follows the selection through an auto-scroll until the text leaves the viewport", async () => {
    const unmount = await mount(vi.fn());
    try {
      const viewport = document.getElementById("viewport")!;
      select(textNode("code"), 0, textNode("code"), 5);
      releaseMouse(document.getElementById("code")!);
      await expect.poll(quoteButton).toBeTruthy();
      const before = quoteButton()!.getBoundingClientRect().top;

      viewport.scrollTop += 20;
      await expect.poll(() => quoteButton()?.getBoundingClientRect().top).toBeLessThan(before);

      viewport.scrollTop = 1500;
      await expect.poll(quoteButton).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("disables the button past the length cap", async () => {
    const onQuote = vi.fn();
    const unmount = await mount(onQuote, "x".repeat(ASSISTANT_QUOTE_MAX_CHARS + 1));
    try {
      select(textNode("long"), 0, textNode("long"), ASSISTANT_QUOTE_MAX_CHARS + 1);
      releaseMouse(document.getElementById("long")!);
      await expect.poll(quoteButton).toBeTruthy();
      expect(quoteButton()?.disabled).toBe(true);
      expect(quoteButton()?.textContent).toContain("Selection too long");
    } finally {
      await unmount();
    }
  });
});
