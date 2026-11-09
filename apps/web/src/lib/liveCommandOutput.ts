import { type ToolInputStream } from "../types";

/**
 * Preview field carrying a running command's output on the tool-input preview stream. The server
 * sets it in `apps/server/src/provider/Layers/ClaudeTaskOutputTail.ts`.
 */
export const LIVE_COMMAND_OUTPUT_FIELD = "live_output";

/** Only the tail is displayed, so a chatty command cannot grow the store without bound. */
export const LIVE_COMMAND_OUTPUT_MAX_CHARS = 64 * 1024;

/** Appends raw output, keeping the latest text from a whole line on when the cap cuts it. */
export function appendLiveCommandOutput(existing: string, delta: string): string {
  const text = `${existing}${delta}`;
  if (text.length <= LIVE_COMMAND_OUTPUT_MAX_CHARS) return text;
  const tail = text.slice(-LIVE_COMMAND_OUTPUT_MAX_CHARS);
  const firstLineEnd = tail.indexOf("\n");
  if (firstLineEnd !== -1 && firstLineEnd + 1 < tail.length) return tail.slice(firstLineEnd + 1);
  const first = tail.charCodeAt(0);
  // No newline to cut at; a cut pair would render as a replacement character.
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/* oxlint-disable no-control-regex -- these patterns exist to match terminal control characters. */
// Stops at a newline, so a stray ESC ] cannot swallow every line up to a later BEL.
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)/g;
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OTHER_ESCAPE = /\u001b[ -/]*[0-~]/g;
// A sequence the next chunk will finish; the store keeps it raw, so it resolves on that render.
const UNFINISHED_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b\n]*|[ -/]*)$/;
const OTHER_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/* oxlint-enable no-control-regex */

/** Plain text for display: no ANSI, and a `\r`-rewritten line shows only its latest version. */
export function sanitizeLiveCommandOutput(raw: string): string {
  const withoutEscapes = raw
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(UNFINISHED_ESCAPE, "")
    .replace(OTHER_ESCAPE, "");
  return withoutEscapes
    .split("\n")
    .map((line) => {
      const content = line.replace(/\r+$/, "");
      return content.slice(content.lastIndexOf("\r") + 1).replace(OTHER_CONTROL, "");
    })
    .join("\n");
}

/** The live output of the running command among a row's entries, latest entry first. */
export function findLiveCommandOutput(
  entries: ReadonlyArray<{ readonly inProgress?: boolean; readonly providerItemId?: string }>,
  previews: Readonly<Record<string, ToolInputStream>>,
): ToolInputStream | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry?.inProgress || !entry.providerItemId) continue;
    const stream = previews[entry.providerItemId];
    if (stream?.fieldName === LIVE_COMMAND_OUTPUT_FIELD && stream.text.length > 0) return stream;
  }
  return undefined;
}
