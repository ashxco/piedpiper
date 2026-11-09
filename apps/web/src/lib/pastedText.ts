export const PASTED_TEXT_ATTACHMENT_BYTES = 32 * 1024;

export function shouldAttachPastedText(text: string, bypass: boolean): boolean {
  return (
    !bypass &&
    text.length > PASTED_TEXT_ATTACHMENT_BYTES / 4 &&
    new TextEncoder().encode(text).byteLength > PASTED_TEXT_ATTACHMENT_BYTES
  );
}

export function nextPastedTextFileName(names: ReadonlyArray<string>): string {
  const used = new Set(names);
  let name = "pasted-text.txt";
  for (let suffix = 2; used.has(name); suffix++) name = `pasted-text-${suffix}.txt`;
  return name;
}
