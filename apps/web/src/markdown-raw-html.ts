import type { Options as ReactMarkdownOptions } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options } from "rehype-sanitize";

import { FILE_CHIP_SUFFIX_PROPERTY, FILE_CHIP_TRAILING_PROPERTY } from "./markdown-file-chip";
import { GITHUB_ALERT_KINDS } from "./markdown-github-alerts";
import { INLINE_CODE_LINK_PROPERTY, INLINE_CODE_PROPERTY } from "./markdown-inline-code";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  data?: { meta?: unknown };
  children?: HastNode[];
}

/** Tags an assistant message may use as HTML; any other tag, like `<string>`, stays readable text. */
const ALLOWED_RAW_HTML_TAGS: ReadonlySet<string> = new Set([
  "br",
  "del",
  "details",
  "img",
  "ins",
  "kbd",
  "mark",
  "sub",
  "summary",
  "sup",
]);

// One token per complete comment or tag, and any other `<`, so nothing the parser could enter survives.
const RAW_HTML_TOKEN =
  /<!--[\s\S]*?-->|<\/?([A-Za-z][A-Za-z0-9-]*)(?:[\s/](?:[^"'<>]|"[^"]*"|'[^']*')*)?>|</g;

/**
 * The raw HTML with disallowed tags escaped, or null when none of it is left as HTML. Comments are
 * removed, not parsed: the parser ends one early at `<!-->` or `--!>`, and tags after that are real.
 */
export function escapeDisallowedRawHtml(value: string): string | null {
  let kept = false;
  const escaped = value.replace(RAW_HTML_TOKEN, (token, tagName: string | undefined) => {
    if (token.startsWith("<!--")) {
      kept = true;
      return "";
    }
    if (ALLOWED_RAW_HTML_TAGS.has(tagName?.toLowerCase() ?? "")) {
      kept = true;
      return token;
    }
    return token.replaceAll("<", "&lt;");
  });
  return kept ? escaped : null;
}

/** Prose as an assistant message paints it: allowed tags and comments go, other tags stay text. */
export function stripAllowedRawHtml(text: string): string {
  return text.replace(RAW_HTML_TOKEN, (token, tagName: string | undefined) => {
    if (token.startsWith("<!--")) return "";
    const name = tagName?.toLowerCase() ?? "";
    if (!ALLOWED_RAW_HTML_TAGS.has(name)) return token;
    return name === "br" ? "\n" : "";
  });
}

function neutralizeRawHtml(parent: HastNode): void {
  for (const [index, child] of (parent.children ?? []).entries()) {
    if (child.type === "raw") {
      const escaped = escapeDisallowedRawHtml(child.value ?? "");
      if (escaped !== null) {
        child.value = escaped;
        continue;
      }
      const text: HastNode = { type: "text", value: child.value ?? "" };
      // A top-level HTML block has no paragraph of its own to give it spacing.
      parent.children![index] =
        parent.type === "root"
          ? { type: "element", tagName: "p", properties: {}, children: [text] }
          : text;
      continue;
    }
    neutralizeRawHtml(child);
  }
}

function literalRawHtmlNodes(value: string): HastNode[] {
  const nodes: HastNode[] = [];
  for (const [index, line] of value.split(/\r\n|\r|\n/).entries()) {
    if (index > 0) nodes.push({ type: "element", tagName: "br", properties: {}, children: [] });
    if (line) nodes.push({ type: "text", value: line });
  }
  return nodes;
}

function literalizeRawHtml(parent: HastNode): void {
  if (!parent.children) return;
  parent.children = parent.children.flatMap((child): HastNode[] => {
    if (child.type !== "raw") {
      literalizeRawHtml(child);
      return [child];
    }
    const nodes = literalRawHtmlNodes(child.value ?? "");
    // A top-level HTML block has no paragraph of its own to give it spacing.
    return parent.type === "root"
      ? [{ type: "element", tagName: "p", properties: {}, children: nodes }]
      : nodes;
  });
}

/** Shows all raw HTML as the text it was typed as, keeping its line breaks. */
export function rehypeLiteralRawHtml() {
  return (tree: HastNode): void => {
    literalizeRawHtml(tree);
  };
}

/** rehype-raw reparses the whole tree through an HTML parser, which most replies can skip. */
export function needsHtmlParser(node: HastNode): boolean {
  return node.type === "raw" || (node.children ?? []).some(needsHtmlParser);
}

// The parser drops `data`, where mdast-util-to-hast keeps a fence's meta.
function keepCodeMetaThroughParser(node: HastNode): void {
  if (node.tagName === "code" && typeof node.data?.meta === "string") {
    node.properties = { ...node.properties, dataCodeMeta: node.data.meta };
  }
  node.children?.forEach(keepCodeMetaThroughParser);
}

export function rehypeChatRawHtml() {
  const parse = rehypeRaw() as unknown as (tree: HastNode, file: unknown) => HastNode;
  return (tree: HastNode, file: unknown): HastNode | undefined => {
    neutralizeRawHtml(tree);
    if (!needsHtmlParser(tree)) return undefined;
    keepCodeMetaThroughParser(tree);
    return parse(tree, file);
  };
}

function camelCaseDataProperty(property: string): string {
  return property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

// Plugin properties keep their spelling unless the HTML parser ran, which camel-cases them.
const bothSpellings = (...properties: string[]) =>
  properties.flatMap((property) => [property, camelCaseDataProperty(property)]);

const SCHEMA_ATTRIBUTES = defaultSchema.attributes ?? {};

const CHAT_MARKDOWN_SANITIZE_SCHEMA: Options = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark"],
  // remark-rehype already prefixed footnote ids, and prefixing again would break their links.
  // Only tags raw HTML cannot produce may carry an id, so there is nothing else to clobber.
  clobber: [],
  clobberPrefix: "",
  attributes: {
    ...SCHEMA_ATTRIBUTES,
    "*": (SCHEMA_ATTRIBUTES["*"] ?? []).filter(
      (attribute) => attribute !== "id" && attribute !== "name",
    ),
    a: [
      ...(SCHEMA_ATTRIBUTES.a ?? []),
      "id",
      ...bothSpellings(
        FILE_CHIP_SUFFIX_PROPERTY,
        FILE_CHIP_TRAILING_PROPERTY,
        INLINE_CODE_LINK_PROPERTY,
      ),
    ],
    blockquote: [...(SCHEMA_ATTRIBUTES.blockquote ?? []), ["dataAlert", ...GITHUB_ALERT_KINDS]],
    code: [
      ["className", /^language-./, "math-inline", "math-display"],
      "dataCodeMeta",
      ...bothSpellings(INLINE_CODE_PROPERTY),
    ],
    h2: [...(SCHEMA_ATTRIBUTES.h2 ?? []), "id"],
    img: ["src"],
    li: [...(SCHEMA_ATTRIBUTES.li ?? []), "id"],
  },
  // Local and Windows paths read as schemes here; chatMarkdownUrlTransform runs last and decides URLs.
  protocols: {},
} satisfies Parameters<typeof rehypeSanitize>[0];

type RehypePlugins = NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

export const CHAT_MARKDOWN_RAW_HTML_REHYPE_PLUGINS: RehypePlugins = [
  rehypeChatRawHtml as RehypePlugins[number],
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
];
