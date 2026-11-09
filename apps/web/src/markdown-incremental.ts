import type { Options as ReactMarkdownOptions } from "react-markdown";

type RemarkPlugin = Extract<
  NonNullable<ReactMarkdownOptions["remarkPlugins"]>[number],
  (...args: never[]) => unknown
>;
type MarkdownProcessor = ThisParameterType<RemarkPlugin>;
type MarkdownParser = NonNullable<MarkdownProcessor["parser"]>;
type ParseFile = Parameters<MarkdownParser>[1];

interface MdPoint {
  line: number;
  column: number;
  offset?: number | undefined;
}

interface MdNode {
  type: string;
  position?: { start: MdPoint; end: MdPoint } | undefined;
  children?: MdNode[];
}

interface MdRoot extends MdNode {
  children: MdNode[];
}

type RootParser = (source: string, file: ParseFile) => MdRoot;

interface ParsedPrefix {
  source: string;
  offset: number;
  line: number;
  children: MdNode[];
}

/** Matches a fence opener anywhere in the text; only fenced replies benefit from caching. */
export const MARKDOWN_FENCE_PATTERN = /(?:^|\n) {0,3}(?:`{3}|~{3})/;

function hasDefinitions(node: MdNode): boolean {
  return (
    node.type === "definition" ||
    node.type === "footnoteDefinition" ||
    (node.children?.some((child) => hasDefinitions(child)) ?? false)
  );
}

function shiftPositions(node: MdNode, offset: number, lines: number): void {
  if (node.position) {
    for (const point of [node.position.start, node.position.end]) {
      if (point.offset !== undefined) point.offset += offset;
      point.line += lines;
    }
  }
  if (node.children) {
    for (const child of node.children) shiftPositions(child, offset, lines);
  }
}

/**
 * Avoids re-parsing a completed, code-heavy prefix on every streamed token. A closed top-level
 * fence followed by a blank line is a parsing boundary. Definitions are document-wide, so any
 * document containing one is parsed in full.
 */
function createIncrementalMarkdownParser(parse: RootParser): RootParser {
  let cached: ParsedPrefix | undefined;

  return (source, file) => {
    // A streamed CR can become half of a CRLF, and a BOM at the suffix start would be stripped.
    if (source.includes("\r") || source.includes("﻿")) return parse(source, file);

    const prefix = cached && source.startsWith(cached.source) ? cached : undefined;
    let root: MdRoot;
    if (prefix) {
      root = parse(source.slice(prefix.offset), file);
      if (hasDefinitions(root)) return parse(source, file);
      shiftPositions(root, prefix.offset, prefix.line - 1);
      if (root.position) root.position.start = { line: 1, column: 1, offset: 0 };
      // Remark transforms mutate their input, so the cache keeps pristine nodes.
      root.children.unshift(...structuredClone(prefix.children));
    } else {
      root = parse(source, file);
      if (hasDefinitions(root)) return root;
    }

    for (let index = root.children.length - 1; index >= 0; index--) {
      const node = root.children[index];
      if (node?.type !== "code") continue;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined || !node.position) continue;
      if (prefix && end < prefix.offset) break;
      const value = source.slice(start, end);
      const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(value)?.[1];
      if (!opening) continue;
      const lastLine = value.slice(value.lastIndexOf("\n") + 1);
      const closing = new RegExp(`^ {0,3}${opening[0]}{${opening.length},}[ \\t]*$`);
      const separator = /^\n[ \t]*\n/.exec(source.slice(end))?.[0];
      if (!closing.test(lastLine) || !separator) continue;
      const offset = end + separator.length;
      cached = {
        source: source.slice(0, offset),
        offset,
        line: node.position.end.line + 2,
        children: structuredClone(root.children.slice(0, index + 1)),
      };
      break;
    }
    return root;
  };
}

/** One cache per streaming renderer; create a fresh plugin per message. */
export function createIncrementalMarkdownPlugin(): RemarkPlugin {
  let parser: RootParser | undefined;
  let currentParse: MarkdownParser | undefined;
  return function (this: MarkdownProcessor) {
    const original = this.parser;
    if (!original) return;
    currentParse = original;
    parser ??= createIncrementalMarkdownParser(
      (source, file) => currentParse!(source, file) as unknown as MdRoot,
    );
    const parseDocument = parser;
    // ReactMarkdown creates a processor per render whose first parse is the document; any later
    // parse on the same processor is synthetic and must not touch the document cache.
    let documentParsed = false;
    this.parser = (source, file) => {
      if (documentParsed) return original(source, file);
      documentParsed = true;
      return parseDocument(source, file) as unknown as ReturnType<MarkdownParser>;
    };
  };
}
