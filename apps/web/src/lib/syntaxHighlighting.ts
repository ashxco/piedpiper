import { setCustomExtension, type HighlighterTypes } from "@pierre/diffs";

// The default .s mapping is riscv, and the other casings and .nasm map to nothing at all.
for (const extension of ["asm", "ASM", "s", "S", "nasm", "NASM"]) {
  setCustomExtension(extension, "asm");
}

/**
 * Always highlight with the Oniguruma WASM engine: the JS regex engine can backtrack
 * catastrophically on minified lines and hang the tokenizing thread. The shared highlighter is a
 * first-caller-wins singleton, so every creation site must pass this value.
 * Highlights is faster, but it renders about 60% of Shiki's language names as plain text.
 */
export const PREFERRED_HIGHLIGHTER: HighlighterTypes = "shiki-wasm";
