import { looksLikeGenericHostname } from "./markdown-links";

const FENCE_TITLE_ATTR_REGEX = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
// A letter-led extension, so versions (`v2.0.1`, `3.11`) are not taken for file names.
const FENCE_FILENAME_TOKEN_REGEX = /^[\w@][\w@./-]*\.[A-Za-z][A-Za-z0-9]*$/;

/** The file a fence names in its info string: ```ts title="src/a.ts"``` or ```ts src/a.ts```. */
export function extractFenceTitle(meta: string | undefined): string | null {
  if (!meta) return null;
  const attrMatch = FENCE_TITLE_ATTR_REGEX.exec(meta);
  const attrTitle = attrMatch?.[1] ?? attrMatch?.[2] ?? attrMatch?.[3];
  if (attrTitle) return attrTitle.trim() || null;
  return (
    meta.split(/\s+/).find(
      (candidate) =>
        FENCE_FILENAME_TOKEN_REGEX.test(candidate) &&
        // `GET example.com` names a host; a path such as `docs/example.com` still counts.
        (candidate.includes("/") || !looksLikeGenericHostname(candidate)),
    ) ?? null
  );
}

// Names agents write for grammars Shiki bundles under another name, or that it lacks.
const FENCE_LANGUAGE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["asm", "asm"],
  ["assembly", "asm"],
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  ["gitignore", "ini"],
  ["nasm", "asm"],
  ["s", "asm"],
]);

/** The grammar to highlight a fence with; an unknown name passes through for Shiki to judge. */
export function normalizeFenceLanguage(language: string): string {
  return FENCE_LANGUAGE_ALIASES.get(language.toLowerCase()) ?? language;
}

interface HastCodeChild {
  type?: string;
  tagName?: string;
  data?: { meta?: unknown };
  properties?: { dataCodeMeta?: unknown };
}

/** The fence meta mdast-util-to-hast keeps on the `<code>` inside a `<pre>` (react-markdown drops it from props). */
export function extractPreCodeMeta(node: unknown): string | undefined {
  const children = (node as { children?: HastCodeChild[] } | undefined)?.children;
  const codeNode = children?.find((child) => child?.type === "element" && child.tagName === "code");
  // The HTML parser drops `data`, so a message with raw HTML carries it as a property.
  const meta = codeNode?.data?.meta ?? codeNode?.properties?.dataCodeMeta;
  return typeof meta === "string" && meta.trim().length > 0 ? meta.trim() : undefined;
}
