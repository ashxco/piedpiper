import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readAgentsInstructionsHiddenFromClaude } from "./commitRepositoryInstructions.ts";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-agents-instructions-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, name: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readAgentsInstructionsHiddenFromClaude", () => {
  it.each(["CLAUDE.md", ".claude/CLAUDE.md"])(
    "returns AGENTS.md when a separate %s hides it",
    async (claudeFile) => {
      const root = makeDir();
      write(root, "AGENTS.md", "  Use imperative subjects.\n");
      write(root, claudeFile, "Something else.\n");

      await expect(readAgentsInstructionsHiddenFromClaude(root)).resolves.toBe(
        "Use imperative subjects.",
      );
    },
  );

  it("adds nothing when only AGENTS.md exists, since the CLI loads it", async () => {
    const root = makeDir();
    write(root, "AGENTS.md", "rules");

    await expect(readAgentsInstructionsHiddenFromClaude(root)).resolves.toBeUndefined();
  });

  it("adds nothing when there is no AGENTS.md or it is empty", async () => {
    const root = makeDir();
    write(root, "CLAUDE.md", "rules");
    await expect(readAgentsInstructionsHiddenFromClaude(root)).resolves.toBeUndefined();

    write(root, "AGENTS.md", "  \n");
    await expect(readAgentsInstructionsHiddenFromClaude(root)).resolves.toBeUndefined();
  });

  it("skips equal content, ignoring surrounding whitespace", async () => {
    const root = makeDir();
    write(root, "AGENTS.md", "rules\n");
    write(root, "CLAUDE.md", "  rules");

    await expect(readAgentsInstructionsHiddenFromClaude(root)).resolves.toBeUndefined();
  });

  it.each([
    ["CLAUDE.md", "AGENTS.md"],
    ["AGENTS.md", "CLAUDE.md"],
  ])("skips %s as a symlink to %s", async (link, target) => {
    const root = makeDir();
    write(root, target, "rules");
    fs.symlinkSync(target, path.join(root, link));

    await expect(readAgentsInstructionsHiddenFromClaude(root)).resolves.toBeUndefined();
  });

  it.each(["@AGENTS.md", "Read this first:\n@./AGENTS.md\n"])(
    "skips a CLAUDE.md that imports AGENTS.md: %j",
    async (claudeContent) => {
      const root = makeDir();
      write(root, "AGENTS.md", "rules");
      write(root, "CLAUDE.md", claudeContent);

      await expect(readAgentsInstructionsHiddenFromClaude(root)).resolves.toBeUndefined();
    },
  );

  it("ignores an AGENTS.md of 20 KB or more", async () => {
    const root = makeDir();
    write(root, "CLAUDE.md", "other");
    write(root, "AGENTS.md", "x".repeat(20_000));
    await expect(readAgentsInstructionsHiddenFromClaude(root)).resolves.toBeUndefined();

    write(root, "AGENTS.md", "x".repeat(19_999));
    await expect(readAgentsInstructionsHiddenFromClaude(root)).resolves.toBe("x".repeat(19_999));
  });

  it("still returns AGENTS.md beside a CLAUDE.md too large to compare", async () => {
    const root = makeDir();
    write(root, "CLAUDE.md", "y".repeat(30_000));
    write(root, "AGENTS.md", "rules");

    await expect(readAgentsInstructionsHiddenFromClaude(root)).resolves.toBe("rules");
  });

  it("ignores files that resolve outside the directory", async () => {
    const outside = makeDir();
    write(outside, "shared.md", "outside");

    const agentsEscape = makeDir();
    write(agentsEscape, "CLAUDE.md", "other");
    fs.symlinkSync(path.join(outside, "shared.md"), path.join(agentsEscape, "AGENTS.md"));
    await expect(readAgentsInstructionsHiddenFromClaude(agentsEscape)).resolves.toBeUndefined();

    const claudeEscape = makeDir();
    write(claudeEscape, "AGENTS.md", "rules");
    fs.symlinkSync(path.join(outside, "shared.md"), path.join(claudeEscape, "CLAUDE.md"));
    await expect(readAgentsInstructionsHiddenFromClaude(claudeEscape)).resolves.toBeUndefined();
  });

  it("ignores directories named like the files", async () => {
    const root = makeDir();
    write(root, "CLAUDE.md", "other");
    fs.mkdirSync(path.join(root, "AGENTS.md"));

    await expect(readAgentsInstructionsHiddenFromClaude(root)).resolves.toBeUndefined();
  });
});
