import { directiveFromMarkdown } from "mdast-util-directive";
import { directive } from "micromark-extension-directive";
import {
  markdownLineEnding,
  unicodePunctuation,
  unicodeWhitespace,
} from "micromark-util-character";
import type { Construct, Extension, Tokenizer } from "micromark-util-types";
import remarkParse from "remark-parse";
import { unified, type Processor } from "unified";

import { codexFileCitationMarkdown, resolveCodexFileCitationLink } from "./codexFileCitations";

export {
  codexFileCitationMarkdown,
  resolveCodexFileCitationLink,
  type CodexFileCitationAttributes,
  type CodexFileCitationLink,
} from "./codexFileCitations";

const COLON = 58;
const DASH = 45;
const UNDERSCORE = 95;
const CODEX_FILE_CITATION_NAME = "codex-file-citation";
const CODEX_FOLLOW_UP_NAME = "codex-followup";

interface MarkdownPosition {
  readonly start: { readonly offset?: number };
  readonly end: { readonly offset?: number };
}

interface MarkdownAstNode {
  type?: string;
  name?: string;
  value?: string;
  url?: string;
  attributes?: Readonly<Record<string, string | null>>;
  position?: MarkdownPosition;
  data?: {
    codexFileCitationMarkdown?: string;
    codexFollowUp?: true;
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
}

interface MarkdownFile {
  readonly value: unknown;
}

function asConstruct(value: Construct | Construct[] | undefined): Construct {
  const construct = Array.isArray(value) ? value[0] : value;
  if (!construct) throw new Error("Missing text directive construct");
  return construct;
}

function directiveNameEnds(code: number | null): boolean {
  return (
    code === null ||
    markdownLineEnding(code) ||
    unicodeWhitespace(code) ||
    (unicodePunctuation(code) && code !== DASH && code !== UNDERSCORE)
  );
}

// Only `:<name>` passes, so other colon syntax (times, `:::note`, other directives) stays text.
function directiveNameGate(name: string): Construct {
  const tokenize: Tokenizer = (effects, ok, nok) => {
    let nameIndex = 0;

    return marker;

    function marker(code: number | null) {
      if (code !== COLON) return nok(code);
      effects.enter("data");
      effects.consume(code);
      return nameCharacter;
    }

    function nameCharacter(code: number | null) {
      if (code !== name.charCodeAt(nameIndex)) return nok(code);
      effects.consume(code);
      nameIndex += 1;
      return nameIndex === name.length ? afterName : nameCharacter;
    }

    function afterName(code: number | null) {
      effects.exit("data");
      return directiveNameEnds(code) ? ok(code) : nok(code);
    }
  };

  return { partial: true, tokenize };
}

function restrictedDirective(construct: Construct, name: string): Construct {
  const gate = directiveNameGate(name);
  return {
    ...construct,
    tokenize(effects, ok, nok) {
      return effects.check(gate, construct.tokenize.call(this, effects, ok, nok), nok);
    },
  };
}

function codexDirectiveSyntax(): Extension {
  const textDirective = asConstruct(directive().text?.[COLON]);
  return {
    text: {
      [COLON]: [
        restrictedDirective(textDirective, CODEX_FILE_CITATION_NAME),
        restrictedDirective(textDirective, CODEX_FOLLOW_UP_NAME),
      ],
    },
  };
}

const CODEX_DIRECTIVE_SYNTAX = codexDirectiveSyntax();
const CODEX_DIRECTIVE_FROM_MARKDOWN = directiveFromMarkdown();

function sourceForNode(node: MarkdownAstNode, source: string): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? "" : source.slice(start, end);
}

function textContent(node: MarkdownAstNode): string {
  return node.value ?? (node.children ?? []).map(textContent).join("");
}

function sourceForDirective(node: MarkdownAstNode, source: string): string {
  const prefix = `:${node.name ?? ""}`;
  const slicedSource = sourceForNode(node, source);
  if (slicedSource.startsWith(prefix)) return slicedSource;

  const label = node.children?.length ? `[${textContent(node)}]` : "";
  const attributes = Object.entries(node.attributes ?? {}).map(([name, value]) =>
    value === null ? name : `${name}=${JSON.stringify(value)}`,
  );
  return `${prefix}${label}${attributes.length === 0 ? "" : `{${attributes.join(" ")}}`}`;
}

// A malformed directive goes back to the exact text the model wrote.
function restoreTextDirective(node: MarkdownAstNode, source: string): void {
  node.type = "text";
  node.value = sourceForDirective(node, source);
  delete node.name;
  delete node.attributes;
  delete node.url;
  delete node.data;
  delete node.children;
}

function renderFileCitation(node: MarkdownAstNode, source: string, insideLink: boolean): void {
  const citation = resolveCodexFileCitationLink(node.attributes);
  if (!citation || insideLink) {
    restoreTextDirective(node, source);
    return;
  }

  node.type = "link";
  node.url = citation.href;
  node.children = [{ type: "text", value: citation.label }];
  node.data = { codexFileCitationMarkdown: codexFileCitationMarkdown(citation) };
  delete node.name;
  delete node.attributes;
  delete node.value;
}

function renderFollowUp(node: MarkdownAstNode, source: string): void {
  if (!node.attributes?.prompt?.trim() || !textContent(node).trim()) {
    restoreTextDirective(node, source);
    return;
  }

  node.data = { codexFollowUp: true, hName: "span" };
  delete node.name;
  delete node.attributes;
}

function transformCodexDirectives(node: MarkdownAstNode, source: string, insideLink = false): void {
  if (node.type === "textDirective" && node.name === CODEX_FILE_CITATION_NAME) {
    renderFileCitation(node, source, insideLink);
    return;
  }
  if (node.type === "textDirective" && node.name === CODEX_FOLLOW_UP_NAME) {
    renderFollowUp(node, source);
  }

  const childrenInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
  for (const child of node.children ?? []) {
    transformCodexDirectives(child, source, childrenInsideLink);
  }
}

function attachCodexDirectives(this: Processor) {
  const data = this.data();
  const micromarkExtensions = data.micromarkExtensions ?? (data.micromarkExtensions = []);
  const fromMarkdownExtensions = data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = []);
  micromarkExtensions.push(CODEX_DIRECTIVE_SYNTAX);
  fromMarkdownExtensions.push(CODEX_DIRECTIVE_FROM_MARKDOWN);

  return (tree: unknown, file: MarkdownFile) => {
    transformCodexDirectives(tree as MarkdownAstNode, String(file.value));
  };
}

/**
 * Remark plugin for Codex's two inline directives: a `:codex-file-citation{path=...}` becomes a
 * file link and a `:codex-followup[label]{prompt=...}` shows just its label. Any other colon
 * syntax is untouched, and malformed directives keep their original text.
 */
export const remarkCodexDirectives = attachCodexDirectives;

/** True when the text may contain a Codex directive, so callers can skip the plugin cheaply. */
export function mayContainCodexDirectives(markdown: string): boolean {
  return (
    markdown.includes(`:${CODEX_FILE_CITATION_NAME}`) ||
    markdown.includes(`:${CODEX_FOLLOW_UP_NAME}`)
  );
}

const directiveParser = unified().use(remarkParse).use(remarkCodexDirectives).freeze();

function parseCodexMarkdown(markdown: string): MarkdownAstNode {
  return directiveParser.runSync(directiveParser.parse(markdown), {
    value: markdown,
  }) as MarkdownAstNode;
}

interface DirectiveMatch {
  readonly start: number;
  readonly end: number;
  readonly markdown?: string;
  readonly labelRange?: readonly [start: number, end: number];
}

function collectDirectiveMatches(node: MarkdownAstNode, matches: DirectiveMatch[]): void {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start !== undefined && end !== undefined) {
    if (node.data?.codexFileCitationMarkdown !== undefined) {
      matches.push({ start, end, markdown: node.data.codexFileCitationMarkdown });
      return;
    }
    const labelStart = node.children?.[0]?.position?.start.offset;
    const labelEnd = node.children?.at(-1)?.position?.end.offset;
    if (node.data?.codexFollowUp && labelStart !== undefined && labelEnd !== undefined) {
      matches.push({ start, end, labelRange: [labelStart, labelEnd] });
      return;
    }
  }
  for (const child of node.children ?? []) collectDirectiveMatches(child, matches);
}

/**
 * Rewrites Codex inline directives as plain Markdown (citations as links, follow-ups as their
 * label), e.g. for the text an assistant message's Copy button copies.
 */
export function renderCodexInlineDirectivesAsMarkdown(markdown: string): string {
  if (!mayContainCodexDirectives(markdown)) return markdown;

  const matches: DirectiveMatch[] = [];
  collectDirectiveMatches(parseCodexMarkdown(markdown), matches);
  let rendered = markdown;
  for (const match of matches.toSorted((left, right) => right.start - left.start)) {
    const replacement = match.labelRange ? markdown.slice(...match.labelRange) : match.markdown;
    if (replacement !== undefined) {
      rendered = rendered.slice(0, match.start) + replacement + rendered.slice(match.end);
    }
  }
  return rendered;
}
