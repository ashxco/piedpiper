import { afterEach, describe, expect, it } from "vitest";

import { isEditableFocused, isEditorUndoFocused } from "./threadUndo";

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

describe("isEditableFocused", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("detects inputs, textareas and contenteditable descendants", () => {
    const host = mount(
      '<input id="i" /><textarea id="t"></textarea><div contenteditable="true"><p id="p">x</p></div><button id="b">b</button>',
    );
    expect(isEditableFocused(host.querySelector("#i"))).toBe(true);
    expect(isEditableFocused(host.querySelector("#t"))).toBe(true);
    expect(isEditableFocused(host.querySelector("#p"))).toBe(true);
    expect(isEditableFocused(host.querySelector("#b"))).toBe(false);
  });

  it("reads document.activeElement by default", () => {
    const host = mount('<input id="i" />');
    host.querySelector<HTMLInputElement>("#i")!.focus();
    expect(isEditableFocused()).toBe(true);
  });
});

describe("isEditorUndoFocused", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("leaves mod+z to an editor only while it has text", () => {
    const host = mount(
      '<input id="i" /><div id="ce" contenteditable="true"><p><br></p></div><button id="b">b</button>',
    );
    const input = host.querySelector<HTMLInputElement>("#i")!;
    const editor = host.querySelector<HTMLElement>("#ce")!;

    expect(isEditorUndoFocused(input)).toBe(false);
    expect(isEditorUndoFocused(editor)).toBe(false);
    expect(isEditorUndoFocused(host.querySelector("#b"))).toBe(false);

    input.value = "draft";
    editor.querySelector("p")!.textContent = "hello";
    expect(isEditorUndoFocused(input)).toBe(true);
    expect(isEditorUndoFocused(editor)).toBe(true);
  });
});
