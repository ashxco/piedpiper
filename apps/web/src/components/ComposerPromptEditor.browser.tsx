import "../index.css";

import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { COMPOSER_INLINE_CHIP_CLASS_NAME } from "./composerInlineChip";

const LONG_LINE = "wrap ".repeat(60).trim();

async function mountEditor(
  value: string,
  handlers: {
    onCommandKeyDown?: (key: string, event: KeyboardEvent) => boolean;
    onPageScroll?: (direction: "up" | "down") => void;
  } = {},
  a11y: { ariaLabel?: string; suggestionListId?: string; activeSuggestionId?: string } = {},
) {
  const ref = createRef<ComposerPromptEditorHandle>();
  await render(
    <div style={{ width: "160px" }}>
      <ComposerPromptEditor
        ref={ref}
        value={value}
        cursor={value.length}
        terminalContexts={[]}
        disabled={false}
        placeholder="Ask anything"
        onRemoveTerminalContext={vi.fn()}
        onChange={vi.fn()}
        onPaste={vi.fn()}
        {...a11y}
        {...(handlers.onCommandKeyDown ? { onCommandKeyDown: handlers.onCommandKeyDown } : {})}
        {...(handlers.onPageScroll ? { onPageScroll: handlers.onPageScroll } : {})}
      />
    </div>,
  );
  const root = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  if (!root || !ref.current) throw new Error("composer editor did not mount");
  return { editor: ref.current, root };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

function pressKey(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("ComposerPromptEditor", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reports the caret's visual edge across soft wraps", async () => {
    const { editor, root } = await mountEditor(LONG_LINE);
    await vi.waitFor(() => expect(root.textContent).toBe(LONG_LINE));

    editor.focusAt(0);
    await settle();
    expect(editor.isCaretOnVisualEdge("start")).toBe(true);
    expect(editor.isCaretOnVisualEdge("end")).toBe(false);

    editor.focusAt(LONG_LINE.length);
    await settle();
    expect(editor.isCaretOnVisualEdge("start")).toBe(false);
    expect(editor.isCaretOnVisualEdge("end")).toBe(true);
  });

  it("shows a mention chip's full path on hover", async () => {
    const { root } = await mountEditor("see @src/lib/index.ts now");
    await vi.waitFor(() => expect(root.querySelector("[title='src/lib/index.ts']")).not.toBeNull());
    expect(root.querySelector("[title='src/lib/index.ts']")?.textContent).toBe("index.ts");
  });

  it("treats an empty composer as both edges", async () => {
    const { editor } = await mountEditor("");
    expect(editor.isCaretOnVisualEdge("start")).toBe(true);
    expect(editor.isCaretOnVisualEdge("end")).toBe(true);
  });

  it("hands Escape to the command key handler", async () => {
    const onCommandKeyDown = vi.fn(() => true);
    const { editor, root } = await mountEditor("hi @src", { onCommandKeyDown });
    editor.focusAtEnd();
    await settle();

    const event = pressKey(root, "Escape", { keyCode: 27 });
    expect(onCommandKeyDown).toHaveBeenCalledWith("Escape", expect.any(KeyboardEvent));
    expect(event.defaultPrevented).toBe(true);
  });

  it("pages the timeline for PageUp/PageDown unless a modifier is held", async () => {
    const onPageScroll = vi.fn();
    const { editor, root } = await mountEditor("short", { onPageScroll });
    editor.focusAtEnd();
    await settle();

    expect(pressKey(root, "PageDown", { keyCode: 34 }).defaultPrevented).toBe(true);
    expect(onPageScroll).toHaveBeenLastCalledWith("down");
    pressKey(root, "PageUp", { keyCode: 33 });
    expect(onPageScroll).toHaveBeenLastCalledWith("up");
    pressKey(root, "PageUp", { keyCode: 33, shiftKey: true });
    expect(onPageScroll).toHaveBeenCalledTimes(2);
  });

  it("labels the editor as a multiline textbox with list autocomplete", async () => {
    const { root } = await mountEditor(
      "@src",
      {},
      {
        ariaLabel: "Message",
        suggestionListId: "composer-suggestions",
      },
    );
    expect(root.getAttribute("role")).toBe("textbox");
    expect(root.getAttribute("aria-multiline")).toBe("true");
    expect(root.getAttribute("aria-label")).toBe("Message");
    expect(root.getAttribute("aria-autocomplete")).toBe("list");
    expect(root.getAttribute("aria-haspopup")).toBe("listbox");
    expect(root.hasAttribute("aria-controls")).toBe(false);
    expect(root.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("points aria-activedescendant at the highlighted suggestion", async () => {
    const active = await mountEditor(
      "@src",
      {},
      {
        suggestionListId: "composer-suggestions",
        activeSuggestionId: "composer-suggestions-option",
      },
    );
    expect(active.root.getAttribute("aria-controls")).toBe("composer-suggestions");
    expect(active.root.getAttribute("aria-activedescendant")).toBe("composer-suggestions-option");
  });
});

function SurroundHarness(props: { initialValue: string; onValue: (value: string) => void }) {
  const [value, setValue] = useState(props.initialValue);
  // Like ChatView, the cursor prop only moves for programmatic changes, not while typing.
  const [cursor] = useState(props.initialValue.length);
  return (
    <ComposerPromptEditor
      value={value}
      cursor={cursor}
      terminalContexts={[]}
      disabled={false}
      placeholder="Ask anything"
      onRemoveTerminalContext={vi.fn()}
      onChange={(next) => {
        setValue(next);
        props.onValue(next);
      }}
      onPaste={vi.fn()}
    />
  );
}

async function mountSurroundEditor(initialValue: string) {
  let latest = initialValue;
  await render(
    <SurroundHarness
      initialValue={initialValue}
      onValue={(value) => {
        latest = value;
      }}
    />,
  );
  const root = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  if (!root) throw new Error("composer editor did not mount");
  return { root, value: () => latest };
}

/** Selects by offsets into the editor's rendered text (a mention chip counts as its label). */
async function selectRenderedText(
  root: HTMLElement,
  start: number,
  end: number,
  direction: "forward" | "backward" = "forward",
) {
  root.focus();
  const resolve = (target: number) => {
    let traversed = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (target <= traversed + length) return { node, offset: target - traversed };
      traversed += length;
    }
    throw new Error(`offset ${target} is outside the editor text`);
  };
  const from = resolve(start);
  const to = resolve(end);
  const selection = window.getSelection()!;
  if (direction === "backward") {
    selection.setBaseAndExtent(to.node, to.offset, from.node, from.offset);
  } else {
    selection.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
  }
  await settle();
}

async function typeCharacter(root: HTMLElement, key: string) {
  const keydown = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  root.dispatchEvent(keydown);
  const beforeInput = new InputEvent("beforeinput", {
    data: key,
    inputType: "insertText",
    bubbles: true,
    cancelable: true,
  });
  root.dispatchEvent(beforeInput);
  if (!beforeInput.defaultPrevented) document.execCommand("insertText", false, key);
  await settle();
  return beforeInput;
}

function pressUndo(root: HTMLElement) {
  const isApple = /Mac|iPhone|iPad/.test(navigator.platform);
  root.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "z",
      code: "KeyZ",
      metaKey: isApple,
      ctrlKey: !isApple,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("ComposerPromptEditor interface font size", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("font-size");
    document.body.innerHTML = "";
  });

  it.each([
    { rootSize: null, editor: "14px", chip: "12px", maxHeight: "200px" },
    { rootSize: "12px", editor: "10.5px", chip: "9px", maxHeight: "150px" },
    { rootSize: "20px", editor: "17.5px", chip: "15px", maxHeight: "250px" },
  ])("scales with a root size of $rootSize", async ({ rootSize, editor, chip, maxHeight }) => {
    if (rootSize) document.documentElement.style.fontSize = rootSize;

    const { root } = await mountEditor("see @src/lib/index.ts now");
    const mention = await vi.waitFor(() => {
      const element = root.querySelector<HTMLElement>("[title='src/lib/index.ts']");
      if (!element) throw new Error("mention chip did not render");
      return element;
    });

    expect(getComputedStyle(root).fontSize).toBe(editor);
    expect(getComputedStyle(root).maxHeight).toBe(maxHeight);
    expect(getComputedStyle(mention).fontSize).toBe(chip);
  });

  it("scales the placeholder like the editor", async () => {
    document.documentElement.style.fontSize = "20px";
    await mountEditor("");
    const placeholder = await vi.waitFor(() => {
      const element = [...document.querySelectorAll("div")].find(
        (candidate) => candidate.textContent === "Ask anything" && candidate.children.length === 0,
      );
      if (!element) throw new Error("placeholder did not render");
      return element;
    });
    expect(getComputedStyle(placeholder).fontSize).toBe("17.5px");
  });

  it("keeps a chip at 12px by default outside the 14px editor", async () => {
    await render(
      <div style={{ fontSize: "16px" }}>
        <span data-testid="outside-chip" className={COMPOSER_INLINE_CHIP_CLASS_NAME}>
          chip
        </span>
      </div>,
    );
    const chip = document.querySelector<HTMLElement>('[data-testid="outside-chip"]');
    expect(chip && getComputedStyle(chip).fontSize).toBe("12px");
  });
});

describe("ComposerPromptEditor surround selection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("wraps the selection and keeps it selected for repeated wrapping", async () => {
    const { root, value } = await mountSurroundEditor("selected");
    await vi.waitFor(() => expect(root.textContent).toBe("selected"));
    await selectRenderedText(root, 0, "selected".length);

    expect((await typeCharacter(root, "(")).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(value()).toBe("(selected)"));
    await typeCharacter(root, "`");
    await vi.waitFor(() => expect(value()).toBe("(`selected`)"));
    expect(window.getSelection()?.toString()).toBe("selected");
  });

  it("wraps a backward selection with symmetric quotes", async () => {
    const { root, value } = await mountSurroundEditor("backward");
    await vi.waitFor(() => expect(root.textContent).toBe("backward"));
    await selectRenderedText(root, 0, "backward".length, "backward");
    await typeCharacter(root, '"');
    await vi.waitFor(() => expect(value()).toBe('"backward"'));
  });

  it("types normally at a collapsed caret and for non-surround symbols", async () => {
    const { root, value } = await mountSurroundEditor("word");
    await vi.waitFor(() => expect(root.textContent).toBe("word"));
    await selectRenderedText(root, 4, 4);
    expect((await typeCharacter(root, "(")).defaultPrevented).toBe(false);
    await vi.waitFor(() => expect(value()).toBe("word("));

    await selectRenderedText(root, 0, 4);
    expect((await typeCharacter(root, "*")).defaultPrevented).toBe(false);
    await vi.waitFor(() => expect(value()).toBe("*("));
  });

  it("wraps text after a mention using expanded prompt offsets", async () => {
    const { root, value } = await mountSurroundEditor("hi @package.json there");
    await vi.waitFor(() => expect(root.textContent).toBe("hi package.json there"));
    await selectRenderedText(root, "hi package.json ".length, "hi package.json there".length);
    await typeCharacter(root, "[");
    await vi.waitFor(() => expect(value()).toBe("hi @package.json [there]"));
  });

  it("leaves selections that include a mention or its delimiting space alone", async () => {
    const { root, value } = await mountSurroundEditor("say hi @package.json now");
    await vi.waitFor(() => expect(root.textContent).toBe("say hi package.json now"));
    await selectRenderedText(root, "say ".length, "say hi ".length);
    await typeCharacter(root, "(");
    await vi.waitFor(() => expect(value()).toBe("say (@package.json now"));
  });

  it("replaces a selection that spans a mention chip", async () => {
    const { root, value } = await mountSurroundEditor("hi @package.json there");
    await vi.waitFor(() => expect(root.textContent).toBe("hi package.json there"));
    await selectRenderedText(root, 0, "hi package.json there".length);
    await typeCharacter(root, "(");
    await vi.waitFor(() => expect(value()).toBe("("));
  });

  it("wraps when a dead key resolves to another surround symbol", async () => {
    const { root, value } = await mountSurroundEditor("quoted");
    await vi.waitFor(() => expect(root.textContent).toBe("quoted"));
    await selectRenderedText(root, 0, "quoted".length);
    root.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Dead", bubbles: true, cancelable: true }),
    );
    root.dispatchEvent(
      new InputEvent("beforeinput", {
        data: "'",
        inputType: "insertCompositionText",
        bubbles: true,
        cancelable: true,
      }),
    );
    const resolved = new InputEvent("beforeinput", {
      data: "'",
      inputType: "insertText",
      bubbles: true,
      cancelable: true,
    });
    root.dispatchEvent(resolved);
    expect(resolved.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(value()).toBe("'quoted'"));
    await settle();

    pressUndo(root);
    await vi.waitFor(() => expect(value()).toBe("quoted"));
  });

  it("wraps once a dead-key backtick composition commits", async () => {
    const { root, value } = await mountSurroundEditor("code");
    await vi.waitFor(() => expect(root.textContent).toBe("code"));
    await selectRenderedText(root, 0, "code".length);
    root.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Dead", bubbles: true, cancelable: true }),
    );
    root.dispatchEvent(
      new InputEvent("beforeinput", {
        data: "`",
        inputType: "insertCompositionText",
        bubbles: true,
        cancelable: true,
      }),
    );
    // The browser commits the composed backtick in place of the selection.
    document.execCommand("insertText", false, "`");
    root.dispatchEvent(new CompositionEvent("compositionend", { data: "`", bubbles: true }));
    await vi.waitFor(() => expect(value()).toBe("`code`"));
    await settle();

    // The wrap merges into the backtick's history entry, so one undo restores the original.
    pressUndo(root);
    await vi.waitFor(() => expect(value()).toBe("code"));
  });

  it("wraps with option-produced guillemets", async () => {
    const { root, value } = await mountSurroundEditor("quoted");
    await vi.waitFor(() => expect(root.textContent).toBe("quoted"));
    await selectRenderedText(root, 0, "quoted".length);
    await typeCharacter(root, "«");
    await vi.waitFor(() => expect(value()).toBe("«quoted»"));
  });

  it("wraps the live selection, not one left over from an earlier keydown", async () => {
    const { root, value } = await mountSurroundEditor("foo bar");
    await vi.waitFor(() => expect(root.textContent).toBe("foo bar"));
    await selectRenderedText(root, 0, "foo".length);
    root.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Shift", bubbles: true, cancelable: true }),
    );
    // The selection moves without a keydown (mouse), then "(" arrives without one (Character Viewer).
    await selectRenderedText(root, "foo ".length, "foo bar".length);
    const beforeInput = new InputEvent("beforeinput", {
      data: "(",
      inputType: "insertText",
      bubbles: true,
      cancelable: true,
    });
    root.dispatchEvent(beforeInput);
    expect(beforeInput.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(value()).toBe("foo (bar)"));
  });

  it("undoes a typed run in one step", async () => {
    const { root, value } = await mountSurroundEditor("");
    root.focus();
    await userEvent.type(root, "hello world");
    await vi.waitFor(() => expect(value()).toBe("hello world"));
    await settle();

    pressUndo(root);
    await vi.waitFor(() => expect(value()).toBe(""));
  });
});

const selectedChips = (root: HTMLElement) => root.querySelectorAll("[data-composer-chip-selected]");

describe("ComposerPromptEditor chip selection highlight", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const TEXT = "hi package.json there";

  async function mountWithChip() {
    const mounted = await mountSurroundEditor("hi @package.json there");
    await vi.waitFor(() => expect(mounted.root.textContent).toBe(TEXT));
    mounted.root.focus();
    await settle();
    return mounted;
  }

  it("paints a highlight on chips in a range selection and clears it on collapse", async () => {
    const { root } = await mountWithChip();
    expect(selectedChips(root)).toHaveLength(0);

    await selectRenderedText(root, 0, TEXT.length);
    await vi.waitFor(() => expect(selectedChips(root)).toHaveLength(1));
    const chip = selectedChips(root)[0]!;
    expect(chip.textContent).toBe("package.json");
    const overlay = getComputedStyle(chip, "::after");
    expect(overlay.position).toBe("absolute");
    expect(overlay.opacity).toBe("0.3");

    await selectRenderedText(root, 1, 1);
    await vi.waitFor(() => expect(selectedChips(root)).toHaveLength(0));
  });

  it("leaves chips outside the selection unmarked", async () => {
    const { root } = await mountWithChip();
    await selectRenderedText(root, 0, 2);
    await settle();
    expect(window.getSelection()?.toString()).toBe("hi");
    expect(selectedChips(root)).toHaveLength(0);
  });

  it("clears on blur and restores on refocus", async () => {
    const { root } = await mountWithChip();
    await selectRenderedText(root, 0, TEXT.length);
    await vi.waitFor(() => expect(selectedChips(root)).toHaveLength(1));

    root.dispatchEvent(new FocusEvent("blur"));
    await vi.waitFor(() => expect(selectedChips(root)).toHaveLength(0));

    root.dispatchEvent(new FocusEvent("focus"));
    await vi.waitFor(() => expect(selectedChips(root)).toHaveLength(1));
  });

  it("drops the mark when the selected chip is deleted", async () => {
    const { root, value } = await mountWithChip();
    await selectRenderedText(root, 0, TEXT.length);
    await vi.waitFor(() => expect(selectedChips(root)).toHaveLength(1));

    await typeCharacter(root, "x");
    await vi.waitFor(() => expect(value()).toBe("x"));
    expect(selectedChips(root)).toHaveLength(0);
  });
});
