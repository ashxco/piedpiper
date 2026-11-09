import type { BranchNamingOptions, ServerSettings } from "@piedpiper/contracts";
import { sanitizeBranchFragment } from "@piedpiper/shared/git";

const CUSTOM_BRANCH_NAME_MAX_CHARS = 100;
// NAME_MAX is 255 bytes per path segment; leaves room for git's ".lock" and a -N suffix.
const BRANCH_SEGMENT_MAX_BYTES = 240;
const CUSTOM_BRANCH_NAME_FALLBACK = "update";

/** The branch naming options a first-turn worktree rename should use. */
export function branchNamingOptionsFromSettings(
  settings: Pick<
    ServerSettings,
    "branchNamingMode" | "branchNamePrefix" | "branchNameInstructions"
  >,
): BranchNamingOptions {
  return {
    mode: settings.branchNamingMode,
    prefix: settings.branchNamePrefix,
    instructions: settings.branchNameInstructions,
  };
}

function capUtf8Bytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let capped = "";
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > maxBytes) break;
    capped += character;
  }
  return capped;
}

/** Keeps casing, slashes and non-ASCII, dropping only what `git check-ref-format` rejects. */
function cleanRefPath(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^refs\/heads\//i, "")
    .replace(/['"`]/g, "")
    .replace(/[\s\p{Cc}~^:?*[\\]+/gu, "-")
    .replace(/@\{/g, "-")
    .replace(/\.{2,}/g, "-");
  return Array.from(cleaned)
    .slice(0, CUSTOM_BRANCH_NAME_MAX_CHARS)
    .join("")
    .split("/")
    .map((segment) =>
      capUtf8Bytes(segment, BRANCH_SEGMENT_MAX_BYTES)
        .replace(/^[.-]+/, "")
        .replace(/(?:\.lock|[.-])+$/i, ""),
    )
    .filter((segment) => segment.length > 0)
    .join("/");
}

function sanitizeCustomBranchName(raw: string): string {
  const name = cleanRefPath(raw);
  // Git refuses a branch named exactly HEAD, though it passes every other ref format rule.
  return name.length > 0 && name !== "HEAD" ? name : CUSTOM_BRANCH_NAME_FALLBACK;
}

/** Cleans a model's branch answer; only custom mode keeps its casing. */
export function sanitizeGeneratedBranchName(
  raw: string,
  naming?: Pick<BranchNamingOptions, "mode">,
): string {
  return naming?.mode === "custom" ? sanitizeCustomBranchName(raw) : sanitizeBranchFragment(raw);
}

// Fragments come from sanitizeBranchFragment, which never ends in a slash, so a strip leaves text.
function stripLeadingNamespace(fragment: string, namespace: string): string {
  return fragment.startsWith(`${namespace}/`) ? fragment.slice(namespace.length + 1) : fragment;
}

// With no ASCII to keep, a prefix sanitizes to the fallback word, which is no echo of the prefix.
function survivesFragmentRules(prefix: string): boolean {
  return /[a-z0-9]/i.test(prefix.normalize("NFKD"));
}

/** The full branch name for a generated answer. Placeholders never go through this. */
export function formatGeneratedBranchName(raw: string, naming: BranchNamingOptions): string {
  if (naming.mode === "custom") return sanitizeCustomBranchName(raw);

  const fragment = stripLeadingNamespace(sanitizeBranchFragment(raw), "refs/heads");
  if (naming.mode === "semantic") return fragment;

  const prefix = cleanRefPath(naming.prefix);
  if (prefix.length === 0) return fragment;
  // An echoed prefix went through the fragment rules too, so compare it in that form.
  const words = survivesFragmentRules(prefix)
    ? stripLeadingNamespace(fragment, sanitizeBranchFragment(prefix))
    : fragment;
  return `${prefix}/${words}`;
}
