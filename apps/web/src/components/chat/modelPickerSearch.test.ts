import { describe, expect, it } from "vitest";

import { rankModelPickerSearch, scoreModelPickerSearch } from "./modelPickerSearch";

const model = (name: string, slug: string, providerLabel = "Claude", isFavorite = false) => ({
  name,
  slug,
  providerLabel,
  isFavorite,
});

const OPUS = model("Claude Opus 4.6", "claude-opus-4-6");
const SONNET = model("Claude Sonnet 4.6", "claude-sonnet-4-6");
const CODEX = model("GPT-5.3 Codex", "gpt-5.3-codex", "Codex");
const CODEX_MAX = model("GPT-5 Codex Max", "gpt-5-codex-max", "Codex");

const names = (items: ReadonlyArray<{ name: string }>) => items.map((item) => item.name);

describe("scoreModelPickerSearch", () => {
  it("ranks exact, prefix, word, substring, slug, provider and fuzzy matches in that order", () => {
    const score = (query: string, item = OPUS) => scoreModelPickerSearch(item, query)!;
    expect(score("claude opus 4.6")).toBeLessThan(score("claude"));
    expect(score("claude")).toBeLessThan(score("opus"));
    expect(score("opus")).toBeLessThan(score("pus"));
    expect(score("pus")).toBeLessThan(score("-opus-"));
    expect(score("-opus-")).toBeLessThan(score("opus46"));
    expect(score("opus46")).toBeLessThan(scoreModelPickerSearch(CODEX, "codex")! + 7);
    expect(score("cld")).toBe(7);
  });

  it("matches provider names, requires every word and rejects non-matches", () => {
    expect(scoreModelPickerSearch(CODEX_MAX, "codex max")).not.toBeNull();
    expect(scoreModelPickerSearch(OPUS, "opus sonnet")).toBeNull();
    expect(scoreModelPickerSearch(OPUS, "zzz")).toBeNull();
    expect(scoreModelPickerSearch(model("Haiku", "h", "Claude"), "claude")).toBe(6);
  });

  it("does not fuzzy match very short queries", () => {
    expect(scoreModelPickerSearch(model("Abc", "abc"), "ac")).toBeNull();
  });

  it("treats a blank query as matching everything", () => {
    expect(scoreModelPickerSearch(OPUS, "   ")).toBe(0);
  });
});

describe("rankModelPickerSearch", () => {
  it("puts the better match first and drops non-matches", () => {
    const opusFirst = rankModelPickerSearch([SONNET, CODEX, OPUS], "opus");
    expect(names(opusFirst)).toEqual(["Claude Opus 4.6"]);
    expect(names(rankModelPickerSearch([CODEX, OPUS], "gpt"))).toEqual(["GPT-5.3 Codex"]);
    expect(
      names(rankModelPickerSearch([model("xopus", "x"), OPUS, model("Opus", "o")], "opus")),
    ).toEqual(["Opus", "Claude Opus 4.6", "xopus"]);
  });

  it("keeps provider order on ties", () => {
    expect(names(rankModelPickerSearch([SONNET, OPUS], "claude"))).toEqual([
      "Claude Sonnet 4.6",
      "Claude Opus 4.6",
    ]);
  });

  it("lists favorites first on ties only", () => {
    const favorite = { ...OPUS, isFavorite: true };
    expect(names(rankModelPickerSearch([SONNET, favorite], "claude"))[0]).toBe("Claude Opus 4.6");
    expect(names(rankModelPickerSearch([favorite, model("Claude", "c")], "claude"))[0]).toBe(
      "Claude",
    );
  });
});
