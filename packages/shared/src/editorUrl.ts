// Only local-file handlers are allowed; extension commands and remote authorities stay blocked.
const LOCAL_EDITOR_SCHEMES = new Set([
  "cursor:",
  "vscode:",
  "vscode-insiders:",
  "vscodium:",
  "trae:",
  "antigravity:",
  "kiro:",
]);
export function isLocalEditorFileUrl(url: URL): boolean {
  return (
    LOCAL_EDITOR_SCHEMES.has(url.protocol) &&
    url.host === "file" &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.pathname.length > 1
  );
}
export function isLocalEditorFileHref(href: string): boolean {
  try {
    return isLocalEditorFileUrl(new URL(href));
  } catch {
    return false;
  }
}
