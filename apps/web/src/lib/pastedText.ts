export const PASTED_TEXT_ATTACHMENT_BYTES = 32 * 1024;

export function shouldAttachPastedText(text: string, bypass: boolean): boolean {
  return (
    !bypass &&
    text.length > PASTED_TEXT_ATTACHMENT_BYTES / 4 &&
    new TextEncoder().encode(text).byteLength > PASTED_TEXT_ATTACHMENT_BYTES
  );
}

/**
 * Paste as Text keeps the text even when the source also put an image of it on the clipboard
 * (Word, Excel and browsers copy a rendered picture next to the text).
 */
export function shouldPasteClipboardFilesAsText(text: string, bypass: boolean): boolean {
  return bypass && text.length > 0;
}

export function nextPastedTextFileName(names: ReadonlyArray<string>): string {
  const used = new Set(names);
  let name = "pasted-text.txt";
  for (let suffix = 2; used.has(name); suffix++) name = `pasted-text-${suffix}.txt`;
  return name;
}
