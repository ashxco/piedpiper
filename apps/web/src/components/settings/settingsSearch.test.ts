import { describe, expect, it } from "vitest";

import {
  SETTINGS_SEARCH_ENTRIES,
  normalizeSettingsSearchText,
  searchSettings,
  type SettingsSearchEntry,
} from "./settingsSearch";

const titles = (query: string, entries?: ReadonlyArray<SettingsSearchEntry>) =>
  searchSettings(query, entries).map((entry) => entry.title);

const entry = (title: string, terms?: ReadonlyArray<string>): SettingsSearchEntry => ({
  id: title,
  title,
  section: "General",
  to: "/settings/general",
  ...(terms ? { terms } : {}),
});

describe("the settings search index", () => {
  it("has unique ids", () => {
    const ids = SETTINGS_SEARCH_ENTRIES.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique title and section pairs", () => {
    const pairs = SETTINGS_SEARCH_ENTRIES.map(({ title, section }) => `${section}/${title}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("anchors every entry that names part of a tab", () => {
    for (const candidate of SETTINGS_SEARCH_ENTRIES) {
      expect(candidate.anchor !== undefined).toBe(
        candidate.to === "/settings/general" || candidate.to === "/settings/diagnostics",
      );
    }
  });

  it("finds the auto-compact field and archived projects", () => {
    expect(titles("auto-compact")).toContain("Auto-compact window");
    expect(titles("archived projects")).toContain("Archived projects");
  });
});

describe("the diagnostics entries", () => {
  it.each(["otlp", "opentelemetry", "collector"])("finds the OTLP endpoints for %s", (query) => {
    expect(titles(query)).toContain("OTLP endpoints");
  });

  it("finds the process list and the trace summary", () => {
    expect(titles("sigkill")).toContain("Child processes");
    expect(titles("spans")).toContain("Traces");
  });
});

describe("normalizeSettingsSearchText", () => {
  it("folds accents, case and whitespace", () => {
    expect(normalizeSettingsSearchText("  Thème   CLAIR ")).toBe("theme clair");
  });
});

describe("searchSettings", () => {
  it("returns nothing for an empty query", () => {
    expect(searchSettings("   ")).toEqual([]);
  });

  it("ranks exact, then prefix, then word start, then substring", () => {
    const entries = [
      entry("Reprefixed"),
      entry("Branch prefix"),
      entry("Prefix options"),
      entry("Prefix"),
    ];
    expect(titles("prefix", entries)).toEqual([
      "Prefix",
      "Prefix options",
      "Branch prefix",
      "Reprefixed",
    ]);
  });

  it("ranks a title match over a synonym match", () => {
    const entries = [entry("Appearance", ["font"]), entry("Code font")];
    expect(titles("font", entries)).toEqual(["Code font", "Appearance"]);
  });

  it("finds a setting by its synonym", () => {
    expect(titles("dark mode")).toContain("Theme");
    expect(titles("rate limit")).toContain("Resume after usage limit");
    expect(titles("hotkeys")).toContain("Keyboard shortcuts");
  });

  it("finds the Codex usage row, which only renders while Codex is available", () => {
    expect(titles("codex usage")).toEqual(["Codex usage"]);
    expect(searchSettings("codex usage")[0]?.anchor).toBe("setting-section-providers");
  });

  it("matches accented input against plain text", () => {
    expect(titles("thème")).toContain("Theme");
  });

  it("matches words in any order across title and synonyms", () => {
    expect(titles("wrap code")).toContain("Code block wrapping");
  });

  it("returns nothing when no word matches", () => {
    expect(titles("zzzz")).toEqual([]);
  });

  it("caps the result list", () => {
    expect(searchSettings("e").length).toBeLessThanOrEqual(8);
  });
});
