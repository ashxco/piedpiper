import type { ToolInputStream } from "../types";

const lines = (text: string) => (text ? text.replace(/\n$/, "").split("\n") : []);
const body = (text: string, content: string[], prefix: string) =>
  content.map((line) => `${prefix}${line}\n`).join("") +
  (text && !text.endsWith("\n") ? "\\ No newline at end of file\n" : "");

/** Tool inputs describe fragments, so their patch line numbers are relative to the edit. */
export function buildToolInputDiff(
  stream: ToolInputStream,
  cwd?: string,
  ignoreWhitespace = false,
): string | null {
  if (!stream.filePath || (stream.fieldName !== "new_string" && stream.fieldName !== "content"))
    return null;
  const oldText = stream.oldString ?? "";
  if (ignoreWhitespace && oldText.replace(/\s/g, "") === stream.text.replace(/\s/g, "")) return "";
  if (oldText === stream.text) return "";
  const normalized = stream.filePath.replace(/\\/g, "/");
  const root = cwd?.replace(/\\/g, "/").replace(/\/$/, "");
  const file =
    root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
  const before = lines(oldText),
    after = lines(stream.text);
  const a = JSON.stringify(`a/${file}`),
    b = JSON.stringify(`b/${file}`);
  return `diff --git ${a} ${b}\n--- ${stream.oldString === undefined ? "/dev/null" : a}\n+++ ${b}\n@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@\n${body(oldText, before, "-")}${body(stream.text, after, "+")}`;
}
