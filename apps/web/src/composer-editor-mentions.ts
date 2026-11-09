import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "./lib/terminalContext";

export type ComposerPromptSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "mention";
      path: string;
      /** Length of the raw `@...` token in the prompt text, which may be quoted even when not needed. */
      tokenLength: number;
    }
  | {
      type: "terminal-context";
      context: TerminalContextDraft | null;
    };

const MENTION_TOKEN_REGEX = /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s@"]+))(?=\s)/g;
const SIMPLE_MENTION_PATH_REGEX = /^[^\s@"]+$/;
// Unquoted `@name(` tokens are pasted decorators (`@Injectable()`), not file mentions.
const DECORATOR_CALL_REFERENCE_REGEX = /^[\p{ID_Start}_$][\p{ID_Continue}.$\u200c\u200d]*\(/u;

/** Mention text for a path: bare when unambiguous, otherwise quoted with `\` and `"` escaped. */
export function serializeComposerMentionPath(path: string): string {
  if (SIMPLE_MENTION_PATH_REGEX.test(path) && !DECORATOR_CALL_REFERENCE_REGEX.test(path)) {
    return path;
  }
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function pushTextSegment(segments: ComposerPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

function splitPromptTextIntoComposerSegments(text: string): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  if (!text) {
    return segments;
  }

  let cursor = 0;
  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const quotedPath = match[2];
    const path = quotedPath !== undefined ? quotedPath.replace(/\\(.)/g, "$1") : (match[3] ?? "");
    const matchIndex = match.index ?? 0;
    const mentionStart = matchIndex + prefix.length;
    const mentionEnd = mentionStart + fullMatch.length - prefix.length;

    if (mentionStart > cursor) {
      pushTextSegment(segments, text.slice(cursor, mentionStart));
    }

    const isDecoratorCall = quotedPath === undefined && DECORATOR_CALL_REFERENCE_REGEX.test(path);
    if (path.length > 0 && !isDecoratorCall) {
      segments.push({ type: "mention", path, tokenLength: mentionEnd - mentionStart });
    } else {
      pushTextSegment(segments, text.slice(mentionStart, mentionEnd));
    }

    cursor = mentionEnd;
  }

  if (cursor < text.length) {
    pushTextSegment(segments, text.slice(cursor));
  }

  return segments;
}

export function splitPromptIntoComposerSegments(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft> = [],
): ComposerPromptSegment[] {
  if (!prompt) {
    return [];
  }

  const segments: ComposerPromptSegment[] = [];
  let textCursor = 0;
  let terminalContextIndex = 0;

  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      continue;
    }

    if (index > textCursor) {
      segments.push(...splitPromptTextIntoComposerSegments(prompt.slice(textCursor, index)));
    }
    segments.push({
      type: "terminal-context",
      context: terminalContexts[terminalContextIndex] ?? null,
    });
    terminalContextIndex += 1;
    textCursor = index + 1;
  }

  if (textCursor < prompt.length) {
    segments.push(...splitPromptTextIntoComposerSegments(prompt.slice(textCursor)));
  }

  return segments;
}

/** True when [start, end) covers the whitespace that delimits an `@` mention token. */
export function selectionTouchesMentionBoundary(
  prompt: string,
  start: number,
  end: number,
): boolean {
  if (!prompt || start >= end) {
    return false;
  }
  const coversWhitespaceAt = (index: number) =>
    index >= 0 &&
    index < prompt.length &&
    /\s/.test(prompt[index]!) &&
    start <= index &&
    index < end;

  let offset = 0;
  for (const segment of splitPromptIntoComposerSegments(prompt)) {
    if (segment.type === "mention") {
      const mentionEnd = offset + segment.tokenLength;
      if (coversWhitespaceAt(offset - 1) || coversWhitespaceAt(mentionEnd)) {
        return true;
      }
      offset = mentionEnd;
      continue;
    }
    offset += segment.type === "text" ? segment.text.length : 1;
    if (offset > end) {
      break;
    }
  }
  return false;
}
