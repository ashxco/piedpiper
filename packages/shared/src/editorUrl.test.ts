import { describe, expect, it } from "vitest";
import { isLocalEditorFileHref } from "./editorUrl";
describe("editor file links", () => {
  it.each([
    "vscode://file/Users/me/code.ts:2:4",
    "cursor://file/C:/work/main.ts",
    "vscode-insiders://file/tmp/a%20b.ts",
  ])("allows %s", (href) => expect(isLocalEditorFileHref(href)).toBe(true));
  it.each([
    "vscode://file",
    "vscode://remote/path",
    "vscode://file:123/path",
    "vscode://user:pass@file/path",
    "vscode://extension/run",
    "javascript:alert(1)",
    "https://file/path",
    "bad url",
  ])("rejects %s", (href) => expect(isLocalEditorFileHref(href)).toBe(false));
});
