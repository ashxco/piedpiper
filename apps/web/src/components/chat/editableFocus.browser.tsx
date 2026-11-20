import { afterEach, expect, it } from "vitest";
import { isEditableFocused, preventMiddleClickPasteOutsideEditable } from "../../lib/editableFocus";

const elements: Element[] = [];
afterEach(() => elements.splice(0).forEach((element) => element.remove()));

it("recognizes descendants of editable elements and focused shadow inputs", () => {
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  const child = document.createElement("span");
  editor.append(child);
  document.body.append(editor);
  elements.push(editor);
  expect(isEditableFocused(child)).toBe(true);
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  const input = document.createElement("input");
  root.append(input);
  document.body.append(host);
  elements.push(host);
  input.focus();
  expect(document.activeElement).toBe(host);
  expect(isEditableFocused()).toBe(true);
  expect(isEditableFocused(document.body)).toBe(false);
});

it("cancels a middle-click mouseup outside editables so Linux does not paste PRIMARY", () => {
  const column = document.createElement("div");
  column.addEventListener("mouseup", preventMiddleClickPasteOutsideEditable);
  const empty = document.createElement("div");
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  const terminal = document.createElement("div");
  terminal.className = "xterm";
  const terminalScreen = document.createElement("canvas");
  terminal.append(terminalScreen);
  column.append(empty, editor, terminal);
  document.body.append(column);
  elements.push(column);
  const mouseUp = (target: Element, button: number) => {
    const event = new MouseEvent("mouseup", { button, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(mouseUp(empty, 1)).toBe(true);
  expect(mouseUp(editor, 1)).toBe(false);
  expect(mouseUp(terminalScreen, 1)).toBe(false);
  expect(mouseUp(empty, 0)).toBe(false);
});
