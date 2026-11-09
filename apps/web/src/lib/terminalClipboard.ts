export async function readTextFromClipboard(): Promise<string> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
    throw new Error("Clipboard is unavailable in this browser.");
  }
  return navigator.clipboard.readText();
}
