import { isMacPlatform } from "./lib/utils";

export type TerminalLinkKind = "url" | "path";

export interface TerminalLinkMatch {
  kind: TerminalLinkKind;
  text: string;
  start: number;
  end: number;
}

export interface TerminalLinkBufferPosition {
  x: number;
  y: number;
}

export interface TerminalLinkBufferRange {
  start: TerminalLinkBufferPosition;
  end: TerminalLinkBufferPosition;
}

export interface TerminalBufferCellLike {
  getChars(): string;
  getWidth(): number;
}

export interface TerminalBufferLineLike {
  readonly isWrapped?: boolean;
  readonly length?: number;
  translateToString(trimRight?: boolean): string;
  getCell?(x: number): TerminalBufferCellLike | undefined;
}

// First and last cell (0-based) of each UTF-16 unit in a segment's text.
export interface WrappedTerminalLinkSegmentCells {
  starts: ReadonlyArray<number>;
  ends: ReadonlyArray<number>;
}

export interface WrappedTerminalLinkLineSegment {
  bufferLineNumber: number;
  text: string;
  startIndex: number;
  endIndex: number;
  // Absent when UTF-16 units and cells line up one to one.
  cells?: WrappedTerminalLinkSegmentCells;
}

export interface WrappedTerminalLinkLine {
  text: string;
  segments: ReadonlyArray<WrappedTerminalLinkLineSegment>;
}

const ASCII_ONLY_PATTERN = /^\p{ASCII}*$/u;
const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/giu;
// The default PowerShell prompt delimits its unquoted path with `PS ` and `>`.
const POWERSHELL_PROMPT_PATH_PATTERN = /^PS ((?:[A-Za-z]:[\\/]|\\\\|\/)[^>\r\n]*)>/u;
// Bare relative paths start only at a segment boundary (lookbehind) so Unicode names stay whole
// and separator-free output is not rescanned at every suffix.
// Brackets must pair so a bare path cannot absorb a run of `]`.
// Parentheses count only before a slash, so `src/foo.ts(3,10)` stays a compiler location.
const FILE_PATH_PATTERN =
  /(?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+|(?<![\p{L}\p{M}\p{N}._-])[\p{L}\p{M}\p{N}._-]+(?:[\\/](?:[\p{L}\p{M}\p{N}._$+@-]|\[{1,2}[\p{L}\p{M}\p{N}._-]+\]{1,2}|\([\p{L}\p{M}\p{N}._-]+\)(?=[\\/]))+)+(?::\d+){0,2}/gu;
// Quoted paths may contain spaces; a `:line:col` position may follow the closing quote.
const QUOTED_FILE_PATH_PATTERN =
  /(["'`])(?<path>(?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\|[\p{L}\p{M}\p{N}._ -]+[\\/])[^\r\n]*?|[\p{L}\p{M}\p{N}._ -]+\.[\p{L}\p{M}\p{N}_-]+(?::\d+){0,2})\1(?<position>(?::\d+){0,2})/gu;
const TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/;
// Paths also drop a trailing colon: compilers end `file:line:col:` with one.
const TRAILING_PATH_PUNCTUATION_PATTERN = /[.,;:!?]+$/;
// A question mark is legal in filenames; only exclude query-bearing request targets.
const REQUEST_ROUTE_PATTERN =
  /(?:^|[\s"'`])(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE|proxying)\s+["'`]?(?:\/|[A-Za-z0-9_-]+\/)[^\s?]*\?\S*/g;
// The tail of `redis://host/0` or `file:///a.mjs` is not a path; one-letter schemes stay drives.
const SCHEME_URL_PATTERN = /(?<![A-Za-z\d+.-])[+-]?[A-Za-z][A-Za-z\d+.-]+:\/\/[^\s"'`<>]+/gu;

function trimClosingDelimiters(value: string, kind: TerminalLinkKind): string {
  let output = value.replace(
    kind === "path" ? TRAILING_PATH_PUNCTUATION_PATTERN : TRAILING_PUNCTUATION_PATTERN,
    "",
  );
  if (output.length === 0) return output;

  const trimUnbalanced = (open: string, close: string) => {
    const opens = output.split(open).length - 1;
    let closes = output.split(close).length - 1;
    let end = output.length;
    // Count once and trim by index: recounting per character is quadratic on long `]]]` runs.
    while (closes > opens && output[end - 1] === close) {
      end -= 1;
      closes -= 1;
    }
    output = output.slice(0, end);
  };

  trimUnbalanced("(", ")");
  trimUnbalanced("[", "]");
  trimUnbalanced("{", "}");
  return output;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function collectMatches(
  line: string,
  kind: TerminalLinkKind,
  pattern: RegExp,
  existing: TerminalLinkMatch[],
): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  pattern.lastIndex = 0;

  for (const rawMatch of line.matchAll(pattern)) {
    if (rawMatch.index === undefined) continue;
    const quotedPath = rawMatch.groups?.path;
    const position = rawMatch.groups?.position ?? "";
    const raw = quotedPath === undefined ? rawMatch[0] : quotedPath + position;
    const start = rawMatch.index + (quotedPath === undefined ? 0 : 1);
    if (raw.length === 0) continue;

    const trimmed = quotedPath === undefined ? trimClosingDelimiters(raw, kind) : raw;
    if (trimmed.length === 0) continue;
    if (kind === "path" && isTerminalUrl(trimmed)) continue;

    const candidate: TerminalLinkMatch = {
      kind,
      text: trimmed,
      start,
      // A position outside the quotes spans the closing quote in the terminal buffer.
      end: start + trimmed.length + (position.length > 0 ? 1 : 0),
    };

    const collides = [...existing, ...matches].some((other) => overlaps(candidate, other));
    if (collides) continue;

    matches.push(candidate);
  }

  return matches;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

function isWindowsPathStyle(value: string): boolean {
  return isWindowsAbsolutePath(value) || /[A-Za-z]:\\/.test(value);
}

function joinPath(base: string, next: string, separator: "/" | "\\"): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  if (separator === "\\") {
    return `${cleanBase}\\${next.replaceAll("/", "\\")}`;
  }
  return `${cleanBase}/${next.replace(/^\/+/, "")}`;
}

function inferHomeFromCwd(cwd: string): string | undefined {
  const posixUser = cwd.match(/^\/Users\/([^/]+)/);
  if (posixUser?.[1]) {
    // macOS's shared folder belongs to nobody, so the server expands ~ for such a cwd.
    return posixUser[1] === "Shared" ? undefined : `/Users/${posixUser[1]}`;
  }

  const posixHome = cwd.match(/^\/home\/([^/]+)/);
  if (posixHome?.[1]) {
    return `/home/${posixHome[1]}`;
  }

  const windowsUser = cwd.match(/^([A-Za-z]:[\\/]Users[\\/][^\\/]+)/i);
  if (windowsUser?.[1]) {
    return windowsUser[1];
  }

  return undefined;
}

function splitPathAndPosition(value: string): {
  path: string;
  line: string | undefined;
  column: string | undefined;
} {
  let path = value;
  let column: string | undefined;
  let line: string | undefined;

  const columnMatch = path.match(/:(\d+)$/);
  if (!columnMatch?.[1]) {
    return { path, line: undefined, column: undefined };
  }

  column = columnMatch[1];
  path = path.slice(0, -columnMatch[0].length);

  const lineMatch = path.match(/:(\d+)$/);
  if (lineMatch?.[1]) {
    line = lineMatch[1];
    path = path.slice(0, -lineMatch[0].length);
  } else {
    line = column;
    column = undefined;
  }

  return { path, line, column };
}

export function extractTerminalLinks(line: string): TerminalLinkMatch[] {
  const nonPathRanges = Array.from(
    [...line.matchAll(REQUEST_ROUTE_PATTERN), ...line.matchAll(SCHEME_URL_PATTERN)],
    (match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }),
  );
  const promptPath = POWERSHELL_PROMPT_PATH_PATTERN.exec(line)?.[1];
  const promptMatches: TerminalLinkMatch[] = promptPath
    ? [{ kind: "path", text: promptPath, start: 3, end: 3 + promptPath.length }]
    : [];
  const urlMatches = collectMatches(line, "url", URL_PATTERN, promptMatches);
  const quotedMatches = collectMatches(line, "path", QUOTED_FILE_PATH_PATTERN, [
    ...promptMatches,
    ...urlMatches,
  ]);
  const pathMatches = collectMatches(line, "path", FILE_PATH_PATTERN, [
    ...promptMatches,
    ...urlMatches,
    ...quotedMatches,
  ]);
  return [...promptMatches, ...urlMatches, ...quotedMatches, ...pathMatches]
    .filter(
      (match) => match.kind === "url" || !nonPathRanges.some((range) => overlaps(match, range)),
    )
    .toSorted((a, b) => a.start - b.start);
}

export function isTerminalUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

export const MAX_WRAPPED_TERMINAL_LINK_ROWS_AROUND_ANCHOR = 32;

// A wide character wrapped early leaves an empty last cell that translates to a link-splitting space.
function endsInWideCharacterPad(
  line: TerminalBufferLineLike,
  nextLine: TerminalBufferLineLike,
): boolean {
  if (line.length === undefined || nextLine.getCell?.(0)?.getWidth() !== 2) return false;
  const lastCell = line.getCell?.(line.length - 1);
  return lastCell?.getWidth() === 1 && lastCell.getChars() === "";
}

function mapSegmentCells(
  line: TerminalBufferLineLike,
  text: string,
): WrappedTerminalLinkSegmentCells | undefined {
  if (!line.getCell || ASCII_ONLY_PATTERN.test(text)) return undefined;
  const starts: number[] = [];
  const ends: number[] = [];
  let column = 0;
  while (starts.length < text.length) {
    const cell = line.getCell(column);
    if (!cell) break;
    const width = cell.getWidth();
    // Width 0 is the tail of the wide character before it, which translateToString also skips.
    if (width > 0) {
      // An empty cell translates to one space; a combined cell holds several units.
      const unitCount = Math.max(cell.getChars().length, 1);
      for (let unit = 0; unit < unitCount; unit += 1) {
        starts.push(column);
        ends.push(column + width - 1);
      }
    }
    column += Math.max(width, 1);
  }
  return { starts, ends };
}

// Joins a soft-wrapped logical line (xterm marks continuation rows with isWrapped) so links
// spanning rows are extracted whole; bufferLineNumber is 1-based like xterm's link provider.
export function collectWrappedTerminalLinkLine(
  bufferLineNumber: number,
  getLine: (bufferLineIndex: number) => TerminalBufferLineLike | null | undefined,
  maxRowsAroundAnchor = MAX_WRAPPED_TERMINAL_LINK_ROWS_AROUND_ANCHOR,
): WrappedTerminalLinkLine | null {
  const anchorLine = getLine(bufferLineNumber - 1);
  if (!anchorLine) return null;

  // Bound the walk so hovering a huge soft-wrapped line doesn't rescan the whole scrollback.
  const minBufferLineNumber = Math.max(1, bufferLineNumber - maxRowsAroundAnchor);
  const maxBufferLineNumber = bufferLineNumber + maxRowsAroundAnchor;

  let startBufferLineNumber = bufferLineNumber;
  let startLine = anchorLine;
  while (startBufferLineNumber > minBufferLineNumber && startLine.isWrapped) {
    const previousLine = getLine(startBufferLineNumber - 2);
    if (!previousLine) break;
    startBufferLineNumber -= 1;
    startLine = previousLine;
  }

  const segments: WrappedTerminalLinkLineSegment[] = [];
  let nextStartIndex = 0;
  let currentBufferLineNumber = startBufferLineNumber;
  let currentLine: TerminalBufferLineLike | null | undefined = startLine;

  while (currentLine) {
    const nextLine =
      currentBufferLineNumber < maxBufferLineNumber ? getLine(currentBufferLineNumber) : undefined;
    const hasWrappedContinuation = nextLine?.isWrapped === true;
    // Only the final row is right-trimmed; inner padding keeps offsets aligned with columns.
    const translated = currentLine.translateToString(!hasWrappedContinuation);
    const text =
      hasWrappedContinuation && endsInWideCharacterPad(currentLine, nextLine)
        ? translated.slice(0, -1)
        : translated;
    const cells = mapSegmentCells(currentLine, text);

    segments.push({
      bufferLineNumber: currentBufferLineNumber,
      text,
      startIndex: nextStartIndex,
      endIndex: nextStartIndex + text.length,
      ...(cells ? { cells } : {}),
    });
    nextStartIndex += text.length;

    if (!hasWrappedContinuation) break;
    currentBufferLineNumber += 1;
    currentLine = nextLine;
  }

  return {
    text: segments.map((segment) => segment.text).join(""),
    segments,
  };
}

function resolveCharacterPosition(
  segments: ReadonlyArray<WrappedTerminalLinkLineSegment>,
  characterIndex: number,
  edge: "starts" | "ends",
): TerminalLinkBufferPosition {
  for (const segment of segments) {
    if (characterIndex < segment.endIndex) {
      const offset = characterIndex - segment.startIndex;
      return {
        x: (segment.cells?.[edge][offset] ?? offset) + 1,
        y: segment.bufferLineNumber,
      };
    }
  }

  const lastSegment = segments[segments.length - 1];
  return {
    x: Math.max((lastSegment?.cells?.ends.at(-1) ?? (lastSegment?.text.length ?? 0) - 1) + 1, 1),
    y: lastSegment?.bufferLineNumber ?? 1,
  };
}

export function resolveWrappedTerminalLinkRange(
  wrappedLine: WrappedTerminalLinkLine,
  match: Pick<TerminalLinkMatch, "start" | "end">,
): TerminalLinkBufferRange {
  return {
    start: resolveCharacterPosition(wrappedLine.segments, match.start, "starts"),
    end: resolveCharacterPosition(wrappedLine.segments, match.end - 1, "ends"),
  };
}

export function wrappedTerminalLinkRangeIntersectsBufferLine(
  range: TerminalLinkBufferRange,
  bufferLineNumber: number,
): boolean {
  return range.start.y <= bufferLineNumber && bufferLineNumber <= range.end.y;
}

export function isTerminalLinkActivation(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (platform.length === 0) return false;
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export type TerminalHyperlinkTarget =
  | { kind: "external"; url: string }
  | { kind: "editor"; path: string };

// Target of an OSC 8 hyperlink. `ls --hyperlink` names the local machine as the file URL's host, so
// the host is always ignored; a UNC link (file://server/share/x) is not supported and opens /share/x.
export function resolveTerminalHyperlinkTarget(uri: string): TerminalHyperlinkTarget | null {
  try {
    const url = new URL(uri);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { kind: "external", url: url.href };
    }
    if (url.protocol !== "file:" || url.pathname === "/") return null;
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.includes("\0")) return null;
    return {
      kind: "editor",
      path: /^\/[A-Za-z]:(?:\/|$)/.test(decoded) ? decoded.slice(1) : decoded,
    };
  } catch {
    return null;
  }
}

export function resolvePathLinkTarget(rawPath: string, cwd: string): string {
  const { path, line, column } = splitPathAndPosition(rawPath);

  let resolvedPath = path;
  if (path.startsWith("~/") || (isWindowsPathStyle(cwd) && path.startsWith("~\\"))) {
    const home = inferHomeFromCwd(cwd);
    if (home) {
      const separator: "/" | "\\" = isWindowsPathStyle(home) ? "\\" : "/";
      resolvedPath = joinPath(home, path.slice(2), separator);
    }
  } else if (!isAbsolutePath(path)) {
    const separator: "/" | "\\" = isWindowsPathStyle(cwd) ? "\\" : "/";
    resolvedPath = joinPath(cwd, path, separator);
  }

  if (!line) return resolvedPath;
  return `${resolvedPath}:${line}${column ? `:${column}` : ""}`;
}

export interface TerminalLinkDecorationsLike {
  pointerCursor: boolean;
  underline: boolean;
}

export interface TerminalLinkWithDecorations {
  decorations?: TerminalLinkDecorationsLike;
}

export interface TerminalLinkModifierState {
  isActive(): boolean;
  createDecorations(): TerminalLinkDecorationsLike;
  hover(link: TerminalLinkWithDecorations): void;
  leave(link: TerminalLinkWithDecorations): void;
  update(event: Pick<MouseEvent, "metaKey" | "ctrlKey">): void;
  reset(): void;
}

// Links look clickable only while the activation modifier is held, since plain clicks do nothing.
export function createTerminalLinkModifierState(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): TerminalLinkModifierState {
  let active = false;
  let hoveredLink: TerminalLinkWithDecorations | null = null;

  const syncHoveredLink = () => {
    // xterm swaps link.decorations for a repainting proxy on hover, so write through the link.
    const decorations = hoveredLink?.decorations;
    if (!decorations) return;
    decorations.pointerCursor = active;
    decorations.underline = active;
  };
  const setActive = (next: boolean) => {
    if (next === active) return;
    active = next;
    syncHoveredLink();
  };

  return {
    isActive: () => active,
    createDecorations: () => ({ pointerCursor: active, underline: active }),
    hover: (link) => {
      hoveredLink = link;
      // xterm installs the proxy right after calling hover; sync once it exists.
      queueMicrotask(() => {
        if (hoveredLink === link) syncHoveredLink();
      });
    },
    leave: (link) => {
      if (hoveredLink === link) hoveredLink = null;
    },
    update: (event) => setActive(isTerminalLinkActivation(event, platform)),
    reset: () => setActive(false),
  };
}
