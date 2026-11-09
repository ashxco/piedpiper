import { resolvePathLinkTarget } from "./terminal-links";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;
const NETWORK_PATH_PATTERN = /^[\\/]{2}/;
// Two leading separators with at least one backslash; `//host` stays a scheme-relative web link.
const BACKSLASH_NETWORK_PATH_PATTERN = /^(?:\\[\\/]|\/\\)/;
const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
// Any script and routing punctuation (`posts.$id.tsx`, `(group)/[id]/+page.svelte`); a folder may end in `/`.
const RELATIVE_FILE_PATH_PATTERN =
  /^(?:[\p{L}\p{M}\p{N}._$+@()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+@()[\]-]+)*\/)+(?:[\p{L}\p{M}\p{N}._$+@()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+@()[\]-]+)*(?::\d+){0,2})?$/u;
// No `@` here: `me@example.com` is an address, not a file.
const RELATIVE_FILE_NAME_PATTERN =
  /^[\p{L}\p{M}\p{N}._$+()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+()[\]-]+)*\.[\p{L}\p{M}\p{N}_-]+(?::\d+){0,2}$/u;
const SLASH_PREFIXED_DRIVE_PATH_PATTERN = /^\/[A-Za-z]:[\\/]/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
const SHELL_VARIABLE_SEGMENT_PATTERN = /^\$[A-Za-z_][A-Za-z0-9_]*$/;
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/lib/",
  "/lib64/",
  "/srv/",
  "/dev/",
  "/proc/",
  "/sys/",
  "/run/",
  "/boot/",
  "/media/",
  "/workspace/",
  "/workspaces/",
] as const;

/** True for a Windows drive path (`C:\x`, `C:/x`) or a UNC path (`\\server\share`). */
export function isWindowsAbsolutePath(value: string): boolean {
  return WINDOWS_DRIVE_PATH_PATTERN.test(value) || WINDOWS_UNC_PATH_PATTERN.test(value);
}

/**
 * Windows treats `/` and `\` alike, so any two leading separators name a UNC or device path.
 * Opening one makes Windows sign in to that host with the user's NTLM credentials.
 */
export function isNetworkPath(value: string): boolean {
  return NETWORK_PATH_PATTERN.test(value);
}

function normalizeNetworkPathForComparison(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function isPathInsideNetworkCwd(path: string, cwd: string | undefined): boolean {
  if (!cwd || !isNetworkPath(cwd)) return false;
  const root = normalizeNetworkPathForComparison(cwd);
  const target = normalizeNetworkPathForComparison(path);
  if (target !== root && !target.startsWith(`${root}/`)) return false;
  return !target
    .slice(root.length)
    .split("/")
    .some((segment) => segment === ".." || segment === ".");
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function stripSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const rawHash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  const path = queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch;
  return { path, hash: rawHash };
}

// File URLs and some agents spell "C:/foo" as "/C:/foo".
export function normalizeWindowsDrivePath(path: string): string {
  return SLASH_PREFIXED_DRIVE_PATH_PATTERN.test(path) ? path.slice(1) : path;
}

function parseFileUrlHref(
  href: string,
  options?: { readonly decodePath?: boolean },
): { path: string; hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;

    const rawPath = parsed.pathname;
    if (rawPath.length === 0) return null;

    // A host (`file://server/share`) names a UNC path; keep it so the network-path guard sees it.
    const normalizedPath = parsed.host
      ? `//${parsed.host}${rawPath}`
      : normalizeWindowsDrivePath(rawPath);

    return {
      path: options?.decodePath === false ? normalizedPath : safeDecode(normalizedPath),
      hash: parsed.hash,
    };
  } catch {
    return null;
  }
}

/** Turns a `file://` href into the plain path (still percent-encoded) plus its hash. */
export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(href.trim(), { decodePath: false });
  if (!target) return null;
  return `${target.path}${target.hash}`;
}

/**
 * True for `file:`, Windows drive-path and relative `name.ts:12` hrefs, which react-markdown's
 * default URL sanitizer would blank (it reads `C:` or `name.ts:` as a scheme).
 */
export function isLocalFileMarkdownHref(href: string | undefined): boolean {
  if (!href) return false;
  const trimmed = href.trim();
  if (/^file:/i.test(trimmed)) return true;
  const path = safeDecode(stripSearchAndHash(trimmed).path);
  // A UNC share (`\\host\share`, often percent-encoded by the parser) is a file, not a web link.
  if (BACKSLASH_NETWORK_PATH_PATTERN.test(path)) return true;
  if (WINDOWS_DRIVE_PATH_PATTERN.test(path)) return true;
  return (
    POSITION_SUFFIX_PATTERN.test(path) &&
    (RELATIVE_FILE_PATH_PATTERN.test(path) || RELATIVE_FILE_NAME_PATTERN.test(path)) &&
    !hasNonFileFirstSegment(path)
  );
}

/** `example.com:8080`, `127.0.0.1:8080` and `$HOME/.zshrc` start with a host or variable, not a file. */
function hasNonFileFirstSegment(path: string): boolean {
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path) || path.startsWith("/")) return false;
  const firstSegment = path.replace(POSITION_SUFFIX_PATTERN, "").split("/")[0] ?? "";
  return SHELL_VARIABLE_SEGMENT_PATTERN.test(firstSegment) || looksLikeHostname(firstSegment, true);
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function appendLineColumnFromHash(path: string, hash: string): string {
  if (!hash || POSITION_SUFFIX_PATTERN.test(path)) return path;
  const match = hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  if (!match?.[1]) return path;
  const line = match[1];
  const column = match[2];
  return `${path}:${line}${column ? `:${column}` : ""}`;
}

function isLikelyPathCandidate(path: string): boolean {
  if (WINDOWS_DRIVE_PATH_PATTERN.test(path) || WINDOWS_UNC_PATH_PATTERN.test(path)) return true;
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(path);
  return (
    (RELATIVE_FILE_PATH_PATTERN.test(path) || RELATIVE_FILE_NAME_PATTERN.test(path)) &&
    !hasNonFileFirstSegment(path)
  );
}

function isRelativePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith("/") &&
      !WINDOWS_DRIVE_PATH_PATTERN.test(path) &&
      !WINDOWS_UNC_PATH_PATTERN.test(path))
  );
}

function hasExternalScheme(path: string): boolean {
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

// Returns the decoded path with any position suffix, before relative paths are joined to cwd.
function parseMarkdownFileLinkPath(href: string | undefined, cwd?: string): string | null {
  if (!href) return null;
  const rawHref = href.trim();
  if (rawHref.length === 0 || rawHref.startsWith("#")) return null;

  const fileUrlTarget = rawHref.toLowerCase().startsWith("file:")
    ? parseFileUrlHref(rawHref)
    : null;
  const source = fileUrlTarget ?? stripSearchAndHash(rawHref);
  const decodedPath = normalizeWindowsDrivePath(
    fileUrlTarget ? source.path.trim() : safeDecode(source.path.trim()),
  );
  const decodedHash = safeDecode(source.hash.trim());

  if (decodedPath.length === 0) return null;
  if (
    !WINDOWS_DRIVE_PATH_PATTERN.test(decodedPath) &&
    !WINDOWS_UNC_PATH_PATTERN.test(decodedPath) &&
    hasExternalScheme(decodedPath)
  ) {
    return null;
  }

  if (!isLikelyPathCandidate(decodedPath)) return null;

  // Only the project's own share may become a file link; anything else would leak NTLM creds.
  if (isNetworkPath(decodedPath) && !isPathInsideNetworkCwd(decodedPath, cwd)) return null;

  return appendLineColumnFromHash(decodedPath, decodedHash);
}

export function isMarkdownFragmentHref(href: string | undefined): boolean {
  return href?.trim().startsWith("#") ?? false;
}

function stripSanitizedFragmentPrefix(id: string): string {
  let stripped = id;
  while (stripped.startsWith("user-content-")) stripped = stripped.slice("user-content-".length);
  return stripped;
}

/** GitHub's heading anchors in document order: repeated slugs take `-1`, `-2` and so on. */
export function githubHeadingSlugs(headings: ReadonlyArray<string>): string[] {
  const occurrences = new Map<string, number>();
  return headings.map((heading) => {
    const base = heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    let slug = base;
    while (occurrences.has(slug)) {
      const count = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, count);
      slug = `${base}-${count}`;
    }
    occurrences.set(slug, 0);
    return slug;
  });
}

/**
 * A heading's text as written. Widgets draw something else: a chip only a file's basename, an image
 * chip a status label, a formula KaTeX's glyphs. So a table of contents' slug would miss them.
 */
function markdownHeadingSourceText(heading: Element): string {
  const widgets = "[data-markdown-heading-text], [data-markdown-math]";
  if (!heading.querySelector(widgets)) return heading.textContent ?? "";
  const copy = heading.cloneNode(true) as Element;
  for (const widget of copy.querySelectorAll(widgets)) {
    widget.replaceWith(
      widget.getAttribute("data-markdown-heading-text") ??
        widget.getAttribute("data-markdown-copy") ??
        "",
    );
  }
  return copy.textContent ?? "";
}

/** The element a `#fragment` link names inside `root`: a real id first, then a heading's slug. */
export function findMarkdownFragmentTarget(root: Element, href: string): Element | null {
  const id = stripSanitizedFragmentPrefix(safeDecode(href.trim().slice(1)));
  if (id.length === 0) return null;
  for (const element of root.querySelectorAll("[id]")) {
    if (stripSanitizedFragmentPrefix(element.id) === id) return element;
  }
  const headings = [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")];
  const index = githubHeadingSlugs(headings.map(markdownHeadingSourceText)).indexOf(id);
  return headings[index] ?? null;
}

/** The absolute http(s) URL a web link opens, with a lookalike host in punycode. */
export function resolveMarkdownWebLinkDestination(
  href: string | undefined,
  baseUrl: string,
): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// The longest real DNS name; anything longer could run past what the tooltip shows of a URL.
const MAX_HOST_LENGTH = 253;

/**
 * The host a web link's tooltip must show on its own, or null when the URL's start already shows it.
 * Userinfo comes first in a URL, so `https://apple.com%2Fx...@evil.test/` reads as the wrong site.
 */
export function markdownWebLinkProminentHost(destination: string): string | null {
  const url = new URL(destination);
  return url.username || url.password || url.host.length > MAX_HOST_LENGTH ? url.host : null;
}

export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
): string | null {
  const pathWithPosition = parseMarkdownFileLinkPath(href, cwd);
  if (!pathWithPosition) return null;
  if (!isRelativePath(pathWithPosition)) {
    return pathWithPosition;
  }

  if (!cwd) return null;
  return resolvePathLinkTarget(pathWithPosition, cwd);
}

/**
 * When a file link names only a file (`ChatView.tsx` or `ChatView.tsx:42`), returns that
 * name and its position suffix so the caller can look the file up in the workspace.
 */
export function resolveMarkdownBareFileName(
  href: string | undefined,
  cwd?: string,
): { name: string; position: string } | null {
  const pathWithPosition = parseMarkdownFileLinkPath(href, cwd);
  if (!pathWithPosition || !RELATIVE_FILE_NAME_PATTERN.test(pathWithPosition)) return null;
  const position = pathWithPosition.match(POSITION_SUFFIX_PATTERN)?.[0] ?? "";
  return { name: pathWithPosition.slice(0, pathWithPosition.length - position.length), position };
}

/** The path of a file link as written, when it is relative to the workspace (`src/a.ts:4`). */
export function resolveMarkdownRelativeFilePath(
  href: string | undefined,
  cwd?: string,
): { path: string; position: string } | null {
  const pathWithPosition = parseMarkdownFileLinkPath(href, cwd);
  if (!pathWithPosition || !isRelativePath(pathWithPosition)) return null;
  if (pathWithPosition.startsWith("~")) return null;
  const position = pathWithPosition.match(POSITION_SUFFIX_PATTERN)?.[0] ?? "";
  return { path: pathWithPosition.slice(0, pathWithPosition.length - position.length), position };
}

const INLINE_CODE_DISQUALIFIER_PATTERN = /[\s`]/;
const PATH_SEPARATOR_PATTERN = /[\\/]/;
// Agents shorten long paths with a `...` or `…` segment, which no file link can open.
const ELIDED_PATH_SEGMENT_PATTERN = /(?:^|[\\/])(?:\.{3,}|…)(?:[\\/]|$)/;
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9_-]+$/;
// A final dot between digits marks a version or model id (`glm-5.3`), not an extension.
const VERSION_SUFFIX_PATTERN = /\d\.\d[^.]*$/;
const NUMERIC_DOTTED_PATTERN = /^\d+(?:\.\d+)+$/;
const SINGLE_LABEL_HOSTNAMES = new Set(["localhost"]);
// Extensions that double as file suffixes (`sh`, `md`, `ts`, `rs`, `in`) are deliberately absent.
const GENERIC_HOSTNAME_TLDS = new Set([
  "com",
  "net",
  "org",
  "io",
  "dev",
  "app",
  "ai",
  "co",
  "edu",
  "gov",
  "mil",
  "info",
  "biz",
  "xyz",
  "me",
  "tv",
  "gg",
  "chat",
  "cloud",
  "site",
  "online",
  "tech",
  "store",
  "link",
]);
// Country codes collide with extensions (`.pl`, `.pt`, `.es`, `.cc`), so a :line suffix wins.
const COUNTRY_HOSTNAME_TLDS = new Set([
  "uk",
  "de",
  "fr",
  "nl",
  "se",
  "no",
  "fi",
  "dk",
  "pl",
  "ch",
  "at",
  "be",
  "es",
  "it",
  "pt",
  "eu",
  "us",
  "ca",
  "au",
  "nz",
  "jp",
  "kr",
  "cn",
  "br",
  "ru",
  "mx",
  "ie",
  "cz",
  "tr",
  "sg",
  "hk",
  "cc",
]);

/** `127.0.0.1`, `localhost`, `example.com`, `1.2.3`: hosts and versions, not files. */
function looksLikeHostname(segment: string, hasPosition: boolean): boolean {
  if (segment.startsWith(".")) return false;
  const lowered = segment.toLowerCase();
  if (SINGLE_LABEL_HOSTNAMES.has(lowered)) return true;
  if (NUMERIC_DOTTED_PATTERN.test(segment)) return true;
  const labels = lowered.split(".");
  const lastLabel = labels.at(-1);
  if (labels.length < 2 || lastLabel === undefined) return false;
  if (GENERIC_HOSTNAME_TLDS.has(lastLabel)) return true;
  return !hasPosition && COUNTRY_HOSTNAME_TLDS.has(lastLabel);
}

/** True for `example.com`, `localhost` and `127.0.0.1`; country-code TLDs are left to files. */
export function looksLikeGenericHostname(segment: string): boolean {
  return looksLikeHostname(segment, true);
}

/**
 * The path an inline code span names, or null when it reads as code, a ref, a host or a model id.
 * Inline code mostly holds identifiers and commands, so it needs stronger evidence than a
 * Markdown link: a path separator or `:line` suffix, plus an explicit path prefix, a file
 * extension or a position.
 */
export function inlineCodeFilePathCandidate(codeText: string): string | null {
  const trimmed = codeText.trim();
  if (trimmed.length === 0 || INLINE_CODE_DISQUALIFIER_PATTERN.test(trimmed)) return null;

  const windowsAbsolute = isWindowsAbsolutePath(trimmed);
  // A leading backslash reads as a regex or escape (`\w+\.json`), not a path from the root.
  if (!windowsAbsolute && trimmed.startsWith("\\")) return null;
  // Relative Windows-style paths become forward-slash paths the resolver understands.
  const candidate = windowsAbsolute ? trimmed : trimmed.replaceAll("\\", "/");
  const hasPosition = POSITION_SUFFIX_PATTERN.test(candidate);
  if (!hasPosition && !PATH_SEPARATOR_PATTERN.test(candidate)) return null;
  const withoutPosition = candidate.replace(POSITION_SUFFIX_PATTERN, "");
  if (ELIDED_PATH_SEGMENT_PATTERN.test(withoutPosition)) return null;

  const hasExplicitPathShape =
    RELATIVE_PATH_PREFIX_PATTERN.test(candidate) ||
    candidate.startsWith("/") ||
    isWindowsAbsolutePath(candidate);
  if (!hasExplicitPathShape) {
    // A trailing slash names a folder, which inline code does not link.
    if (withoutPosition.endsWith("/")) return null;
    const firstSegment = withoutPosition.split("/")[0] ?? withoutPosition;
    if (looksLikeHostname(firstSegment, hasPosition)) return null;
    const basename = withoutPosition.split("/").at(-1) ?? "";
    if (VERSION_SUFFIX_PATTERN.test(basename)) return null;
    if (!hasPosition && !FILE_EXTENSION_PATTERN.test(basename)) return null;
  }
  return candidate;
}
