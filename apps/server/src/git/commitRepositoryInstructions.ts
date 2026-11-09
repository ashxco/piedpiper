/**
 * Reads the AGENTS.md a Claude commit writer would otherwise miss.
 *
 * @module commitRepositoryInstructions
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_INSTRUCTIONS_BYTES = 20_000;
const CLAUDE_MEMORY_FILES = ["CLAUDE.md", path.join(".claude", "CLAUDE.md")];
const AGENTS_IMPORT_PATTERN = /(?:^|\s)@(?:\.\/)?AGENTS\.md\b/;

interface ContainedFile {
  readonly realPath: string;
  /** Undefined when the file is too large to read. */
  readonly content: string | undefined;
}

/** A regular file at `name` whose real path stays inside `root`, or null. */
async function readContainedFile(root: string, name: string): Promise<ContainedFile | null> {
  const realPath = await fs.realpath(path.join(root, name)).catch(() => null);
  if (realPath === null) return null;
  const relative = path.relative(root, realPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const stat = await fs.stat(realPath).catch(() => null);
  if (!stat?.isFile()) return null;
  return {
    realPath,
    content:
      stat.size < MAX_INSTRUCTIONS_BYTES ? (await fs.readFile(realPath, "utf8")).trim() : undefined,
  };
}

/**
 * The AGENTS.md at `cwd`, only when Claude Code will not load it. The CLI (checked on 2.1.310)
 * reads AGENTS.md alone as a fallback and ignores it once a CLAUDE.md sits beside it, so this
 * returns text only when a CLAUDE.md exists that neither is AGENTS.md nor imports it.
 */
export async function readAgentsInstructionsHiddenFromClaude(
  cwd: string,
): Promise<string | undefined> {
  const root = await fs.realpath(cwd);
  const agents = await readContainedFile(root, "AGENTS.md");
  if (!agents?.content) return undefined;

  const claudeFiles = (
    await Promise.all(CLAUDE_MEMORY_FILES.map((name) => readContainedFile(root, name)))
  ).filter((file) => file !== null);
  if (claudeFiles.length === 0) return undefined;

  const alreadyLoaded = claudeFiles.some(
    (file) =>
      file.realPath === agents.realPath ||
      file.content === agents.content ||
      (file.content !== undefined && AGENTS_IMPORT_PATTERN.test(file.content)),
  );
  return alreadyLoaded ? undefined : agents.content;
}
