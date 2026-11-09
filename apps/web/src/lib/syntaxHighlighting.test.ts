import { getFiletypeFromFileName, getSharedHighlighter } from "@pierre/diffs";
import { expect, it } from "vitest";

import { normalizeFenceLanguage } from "../markdown-code-fence";
import { resolveDiffThemeName } from "./diffRendering";
import { PREFERRED_HIGHLIGHTER } from "./syntaxHighlighting";

const themes = [resolveDiffThemeName("dark"), resolveDiffThemeName("light")];
const code = "mov eax, 42 ; answer\nret";

async function expectHighlighted(language: string) {
  const highlighter = await getSharedHighlighter({
    themes,
    langs: [language as never],
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
  });
  for (const theme of themes) {
    const { tokens } = highlighter.codeToTokens(code, { lang: language as never, theme });
    expect(tokens.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(code);
    expect(new Set(tokens.flat().map((token) => token.color)).size).toBeGreaterThan(1);
  }
}

it.each(["asm", "ASM", "s", "S", "nasm", "NASM"])(
  "highlights a .%s file as assembly",
  async (ext) => {
    const language = getFiletypeFromFileName(`src/start.${ext}`);
    expect(language).toBe("asm");
    await expectHighlighted(language);
  },
);

it.each(["asm", "assembly", "nasm", "s"])("highlights a %s fence as assembly", async (fence) => {
  await expectHighlighted(normalizeFenceLanguage(fence));
});
