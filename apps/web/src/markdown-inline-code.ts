import { resolveMarkdownFileChipMeta } from "./markdown-file-chip";
import { inlineCodeFilePathCandidate } from "./markdown-links";
import { resolvePathLinkTarget } from "./terminal-links";

/** Set on inline code elements, so double-click can tell them from fenced code. */
export const INLINE_CODE_PROPERTY = "data-inline-code";
/** Set on a link made from an inline code span; holds the span's text so copy keeps it as code. */
export const INLINE_CODE_LINK_PROPERTY = "data-inline-code-link";

const BARE_EXTENSIONLESS_POSITION_PATTERN = /^[A-Za-z0-9_-]+(?::\d+){1,2}$/;
const POSITION_SUFFIX_PATTERN = /(?::\d+){1,2}$/;
// `name:digits` also matches `error:1` and `port:3000`, so only conventional names link.
const EXTENSIONLESS_FILE_NAMES = new Set([
  "Makefile",
  "makefile",
  "GNUmakefile",
  "Dockerfile",
  "Containerfile",
  "Justfile",
  "justfile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Brewfile",
  "Caddyfile",
  "Vagrantfile",
  "Jenkinsfile",
  "Podfile",
  "Fastfile",
  "BUILD",
  "WORKSPACE",
  "LICENSE",
  "LICENCE",
  "COPYING",
  "NOTICE",
  "AUTHORS",
  "CONTRIBUTORS",
  "CHANGELOG",
  "README",
  "CODEOWNERS",
]);

/** The href a file link made from an inline code span opens, or null when it names no file. */
export function resolveInlineCodeFileHref(
  codeText: string,
  cwd: string | undefined,
): string | null {
  const candidate = inlineCodeFilePathCandidate(codeText);
  if (!candidate) return null;
  if (resolveMarkdownFileChipMeta(candidate, cwd)) return candidate;
  // `Makefile:12` fails the generic link shapes, but its :line suffix marks a file reference.
  if (
    cwd &&
    BARE_EXTENSIONLESS_POSITION_PATTERN.test(candidate) &&
    EXTENSIONLESS_FILE_NAMES.has(candidate.replace(POSITION_SUFFIX_PATTERN, ""))
  ) {
    const target = resolvePathLinkTarget(candidate, cwd);
    return resolveMarkdownFileChipMeta(target, cwd) ? target : null;
  }
  return null;
}

interface MdNode {
  type: string;
  url?: string;
  title?: string | null;
  value?: string;
  children?: MdNode[];
  position?: unknown;
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>;
}

function visit(parent: MdNode, cwd: string | undefined, insideLink: boolean): void {
  const children = parent.children;
  if (!children) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    if (child.type !== "inlineCode") {
      visit(child, cwd, insideLink || child.type === "link" || child.type === "linkReference");
      continue;
    }
    child.data ??= {};
    child.data.hProperties = { ...child.data.hProperties, [INLINE_CODE_PROPERTY]: "true" };
    const href = insideLink ? null : resolveInlineCodeFileHref(child.value ?? "", cwd);
    if (!href) continue;
    children[index] = {
      type: "link",
      url: href,
      title: null,
      children: [child],
      position: child.position,
      data: { hProperties: { [INLINE_CODE_LINK_PROPERTY]: child.value ?? "" } },
    };
  }
}

/**
 * Marks inline code spans, and turns spans that clearly name a file (`src/app.ts:12`) into
 * file links, so they render as file chips. Spans inside link labels are left alone.
 * Run it before `remarkMarkdownFileChips`.
 */
export function remarkInlineCode(options: { readonly cwd: string | undefined }) {
  return (tree: MdNode) => {
    visit(tree, options.cwd, false);
  };
}
