import { afterEach, expect, it } from "vitest";
import { isEditableFocused } from "../../lib/editableFocus";

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
