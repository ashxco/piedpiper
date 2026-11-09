import { resolveMarkdownBareFileName, resolveMarkdownFileLinkTarget } from "./markdown-links";

const POSITION_SUFFIX_PATTERN = /(?::\d+){1,2}$/;
// Closing punctuation that should wrap together with the chip before it.
const TRAILING_PUNCTUATION_PATTERN = /^[.,;:!?)\]}'"…]+/;

export interface MarkdownFileChipMeta {
  /** Absolute path with any `:line:column` suffix, as the editor opens it. */
  readonly targetPath: string;
  /** Absolute path without the position suffix. */
  readonly filePath: string;
  readonly basename: string;
  /** `:12` or `:12:3`, or empty. */
  readonly position: string;
  /** Path relative to the workspace (with position), or null outside it. */
  readonly relativePath: string | null;
  /** True for a link that names only a file (`ChatView.tsx`), which is looked up in the workspace. */
  readonly isBareFileName: boolean;
}

function basenameOfPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

function normalizeSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function relativePathInside(filePath: string, cwd: string | undefined): string | null {
  if (!cwd) return null;
  const root = normalizeSeparators(cwd).replace(/\/+$/, "");
  const path = normalizeSeparators(filePath);
  // Windows paths compare case-insensitively.
  const caseFold = /^[A-Za-z]:\//.test(root);
  const comparablePath = caseFold ? path.toLowerCase() : path;
  const comparableRoot = caseFold ? root.toLowerCase() : root;
  if (!comparablePath.startsWith(`${comparableRoot}/`)) return null;
  const relative = path.slice(root.length + 1);
  return relative.length > 0 ? relative : null;
}

export function resolveMarkdownFileChipMeta(
  href: string | undefined,
  cwd: string | undefined,
): MarkdownFileChipMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
  if (!targetPath) return null;
  const position = targetPath.match(POSITION_SUFFIX_PATTERN)?.[0] ?? "";
  const filePath = targetPath.slice(0, targetPath.length - position.length);
  const relative = relativePathInside(filePath, cwd);
  return {
    targetPath,
    filePath,
    basename: basenameOfPath(filePath),
    position,
    relativePath: relative === null ? null : `${relative}${position}`,
    isBareFileName: resolveMarkdownBareFileName(href, cwd) !== null,
  };
}

function parentSegments(path: string): string[] {
  return normalizeSeparators(path)
    .split("/")
    .filter((segment) => segment.length > 0)
    .slice(0, -1);
}

/**
 * For files that share a basename, the fewest trailing parent folders (at least two when
 * available) that tell them apart. Files with a unique basename get no entry.
 */
export function buildFileChipParentSuffixByPath(filePaths: Iterable<string>): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    const basename = basenameOfPath(filePath);
    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(filePath);
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.size < 2) continue;
    const segmentsByPath = new Map([...group].map((path) => [path, parentSegments(path)]));
    for (const [filePath, segments] of segmentsByPath) {
      if (segments.length === 0) continue;
      let depth = 1;
      for (; depth < segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");
        const collides = [...segmentsByPath].some(
          ([otherPath, otherSegments]) =>
            otherPath !== filePath && otherSegments.slice(-depth).join("/") === candidate,
        );
        if (!collides) break;
      }
      const suffixDepth = Math.min(segments.length, Math.max(depth, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join("/"));
    }
  }
  return suffixByPath;
}

/** True when the link text just spells the path, so the chip may show its own compact label. */
export function isPathLikeLinkLabel(
  label: string,
  href: string | undefined,
  meta: Pick<MarkdownFileChipMeta, "basename" | "targetPath" | "position">,
): boolean {
  const text = label.trim().replace(/^`|`$/g, "");
  if (text.length === 0) return true;
  if (text === href?.trim() || text === meta.targetPath) return true;
  const withoutPosition = normalizeSeparators(
    text.replace(/#L\d+.*$/, "").replace(POSITION_SUFFIX_PATTERN, ""),
  ).replace(/\/+$/, "");
  if (withoutPosition === meta.basename) return true;
  // Prose with a slash (`read/write helpers`) stays authored; only a single path token is replaced.
  return !/\s/.test(text) && withoutPosition.endsWith(`/${meta.basename}`);
}

export function markdownLinkDestination(href: string): string {
  return /[\s()<>]/.test(href) ? `<${href.replaceAll(">", "%3E")}>` : href;
}

/** The Markdown a file chip stands for, used when the chip is copied. */
export function fileChipMarkdown(label: string, href: string): string {
  const text = label.replace(/[[\]\\]/g, (match) => `\\${match}`);
  return `[${text}](${markdownLinkDestination(href)})`;
}

export const FILE_CHIP_SUFFIX_PROPERTY = "data-file-chip-suffix";
export const FILE_CHIP_TRAILING_PROPERTY = "data-file-chip-trailing";

interface MdNode {
  type: string;
  url?: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>;
}

function collectLinks(node: MdNode, links: MdNode[]): void {
  if (!node.children) return;
  for (const child of node.children) {
    if (child.type === "link") links.push(child);
    collectLinks(child, links);
  }
}

function attachTrailingPunctuation(parent: MdNode): void {
  const children = parent.children;
  if (!children) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    const next = children[index + 1];
    const hProperties = child.data?.hProperties;
    if (
      child.type === "link" &&
      hProperties?.[FILE_CHIP_SUFFIX_PROPERTY] !== undefined &&
      next?.type === "text" &&
      typeof next.value === "string"
    ) {
      const punctuation = TRAILING_PUNCTUATION_PATTERN.exec(next.value)?.[0];
      if (punctuation) {
        hProperties[FILE_CHIP_TRAILING_PROPERTY] = punctuation;
        next.value = next.value.slice(punctuation.length);
      }
    }
    attachTrailingPunctuation(child);
  }
}

/**
 * Marks links that resolve to local files with the parent-folder suffix their chip needs to be
 * told apart from same-named files in the message, and moves closing punctuation after a chip
 * onto it so the punctuation never wraps onto its own line. Reads the parsed tree, so links in
 * code are ignored and the work stays linear in the message size.
 */
export function remarkMarkdownFileChips(options: {
  readonly cwd: string | undefined;
  /** Files named elsewhere in the message, when this tree holds only part of it. */
  readonly messageFilePaths?: readonly string[] | undefined;
}) {
  return (tree: MdNode) => {
    const links: MdNode[] = [];
    collectLinks(tree, links);
    const metaByLink = new Map<MdNode, MarkdownFileChipMeta>();
    for (const link of links) {
      const meta = resolveMarkdownFileChipMeta(link.url, options.cwd);
      if (meta) metaByLink.set(link, meta);
    }
    if (metaByLink.size === 0) return;
    const suffixByPath = buildFileChipParentSuffixByPath([
      ...[...metaByLink.values()].map((meta) => meta.filePath),
      ...(options.messageFilePaths ?? []),
    ]);
    for (const [link, meta] of metaByLink) {
      link.data ??= {};
      link.data.hProperties = {
        ...link.data.hProperties,
        [FILE_CHIP_SUFFIX_PROPERTY]: suffixByPath.get(meta.filePath) ?? "",
      };
    }
    attachTrailingPunctuation(tree);
  };
}
