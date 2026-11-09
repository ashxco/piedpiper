import { describe, expect, it } from "vitest";

import {
  buildModelPickerView,
  claudeUpdateRequiredNote,
  isModelHiddenWhileBrowsing,
  type ModelPickerOption,
  type ModelPickerProviderInput,
  type ModelPickerRef,
  modelPickerRowKey,
  toggleModelRef,
} from "./ProviderModelPicker.logic";

describe("claudeUpdateRequiredNote", () => {
  it("is absent when nothing is gated", () => {
    expect(claudeUpdateRequiredNote(undefined)).toBeNull();
    expect(claudeUpdateRequiredNote([])).toBeNull();
  });

  it("filters to what a search matched, by name or slug", () => {
    const models = [
      { name: "Opus 5.5", slug: "claude-opus-5-5", minVersion: "2.1.280" },
      { name: "Haiku 5.5", slug: "claude-haiku-5-5", minVersion: "2.1.284" },
    ];
    expect(claudeUpdateRequiredNote(models, "opus 5.5")).toBe(
      "Update Claude Code to v2.1.280 to use Opus 5.5.",
    );
    expect(claudeUpdateRequiredNote(models, "haiku-5")).toBe(
      "Update Claude Code to v2.1.284 to use Haiku 5.5.",
    );
    expect(claudeUpdateRequiredNote(models, "gpt")).toBeNull();
  });

  it("names one gated model", () => {
    expect(
      claudeUpdateRequiredNote([{ name: "Opus 5.5", slug: "opus-5-5", minVersion: "2.1.280" }]),
    ).toBe("Update Claude Code to v2.1.280 to use Opus 5.5.");
  });

  it("lists every gated model with the highest version, compared numerically", () => {
    expect(
      claudeUpdateRequiredNote([
        { name: "Opus 5.5", slug: "opus-5-5", minVersion: "2.1.280" },
        { name: "Haiku 5.5", slug: "haiku-5-5", minVersion: "2.1.1000" },
        { name: "Sonnet 5.5", slug: "sonnet-5-5", minVersion: "2.1.284" },
      ]),
    ).toBe("Update Claude Code to v2.1.1000 to use Opus 5.5, Haiku 5.5 and Sonnet 5.5.");
  });
});

const CLAUDE: ReadonlyArray<ModelPickerOption> = [
  { slug: "opus", name: "Opus" },
  { slug: "sonnet", name: "Sonnet" },
  { slug: "haiku-old", name: "Haiku Old", isLegacy: true },
];
const CODEX: ReadonlyArray<ModelPickerOption> = [
  { slug: "gpt", name: "GPT" },
  { slug: "mine", name: "Mine", isCustom: true },
];

const claude = (model: string): ModelPickerRef => ({ provider: "claudeAgent", model });
const codex = (model: string): ModelPickerRef => ({ provider: "codex", model });

function view(
  overrides: Partial<Parameters<typeof buildModelPickerView>[0]> & {
    claudeOptions?: ReadonlyArray<ModelPickerOption>;
    codexEnabled?: boolean;
  } = {},
) {
  const { claudeOptions = CLAUDE, codexEnabled = true, ...rest } = overrides;
  const providers: ReadonlyArray<ModelPickerProviderInput> = [
    { provider: "claudeAgent", label: "Claude", isEnabled: true, options: claudeOptions },
    { provider: "codex", label: "Codex", isEnabled: codexEnabled, options: CODEX },
  ];
  return buildModelPickerView({
    providers,
    favorites: [],
    hiddenModels: [],
    selected: [claude("opus")],
    expandedKeys: new Set(),
    query: "",
    favoritesOnly: false,
    showProviderTitles: true,
    ...rest,
  });
}

const rowNames = (id: string, built: ReturnType<typeof view>) =>
  built.sections.find((section) => section.id === id)?.rows.map((row) => row.name);
const rowOf = (built: ReturnType<typeof view>, name: string) =>
  built.sections
    .flatMap((section) => [
      ...section.rows,
      ...section.expanders.flatMap((expander) => expander.rows),
    ])
    .find((row) => row.name === name);

describe("toggleModelRef", () => {
  it("adds a missing ref and removes a present one", () => {
    expect(toggleModelRef([], claude("opus"))).toEqual([claude("opus")]);
    expect(toggleModelRef([claude("opus"), codex("opus")], claude("opus"))).toEqual([
      codex("opus"),
    ]);
  });
});

describe("isModelHiddenWhileBrowsing", () => {
  const ref = claude("sonnet");
  const base = { ref, favorites: [], hiddenModels: [ref], selected: [] };

  it("hides a listed model, unless a star, the selection or being custom rescues it", () => {
    expect(isModelHiddenWhileBrowsing(base)).toBe(true);
    expect(isModelHiddenWhileBrowsing({ ...base, favorites: [ref] })).toBe(false);
    expect(isModelHiddenWhileBrowsing({ ...base, selected: [ref] })).toBe(false);
    expect(isModelHiddenWhileBrowsing({ ...base, isCustom: true })).toBe(false);
    expect(isModelHiddenWhileBrowsing({ ...base, hiddenModels: [] })).toBe(false);
  });
});

describe("buildModelPickerView", () => {
  it("drops a provider whose models are all starred, keeping them under Favorites", () => {
    const built = view({ favorites: [codex("gpt"), codex("mine")] });
    expect(built.sections.map((section) => section.id)).toEqual(["favorites", "claudeAgent"]);
    expect(rowNames("favorites", built)).toEqual(["GPT", "Mine"]);
  });

  it("keeps a disabled provider's section, which has no rows by design", () => {
    const built = buildModelPickerView({
      providers: [{ provider: "codex", label: "Codex", isEnabled: false, options: CODEX }],
      favorites: [],
      hiddenModels: [],
      selected: [],
      expandedKeys: new Set(),
      query: "",
      favoritesOnly: false,
      showProviderTitles: true,
    });
    expect(built.sections.map((section) => section.isDisabled)).toEqual([true]);
  });

  it("groups by provider in order with legacy models collapsed", () => {
    const built = view();
    expect(built.sections.map((section) => section.id)).toEqual(["claudeAgent", "codex"]);
    expect(rowNames("claudeAgent", built)).toEqual(["Opus", "Sonnet"]);
    expect(built.sections[0]?.expanders.map((expander) => expander.label)).toEqual([
      "Legacy models",
    ]);
    expect(built.visibleKeys).toEqual([
      modelPickerRowKey("claudeAgent", "opus"),
      modelPickerRowKey("claudeAgent", "sonnet"),
      "legacy:claudeAgent",
      modelPickerRowKey("codex", "gpt"),
      modelPickerRowKey("codex", "mine"),
    ]);
  });

  it("starts allKeys with the visible rows, so the selected row's index matches the list", () => {
    const built = view({ favorites: [codex("gpt")], selected: [claude("sonnet")] });
    expect(built.visibleKeys[0]).toBe(modelPickerRowKey("codex", "gpt"));
    expect(built.allKeys.slice(0, built.visibleKeys.length)).toEqual(built.visibleKeys);
    // The collapsed legacy row stays known to the combobox, after everything on screen.
    expect(built.allKeys).toContain(modelPickerRowKey("claudeAgent", "haiku-old"));
    expect(built.visibleKeys).not.toContain(modelPickerRowKey("claudeAgent", "haiku-old"));
    expect(new Set(built.allKeys).size).toBe(built.allKeys.length);
  });

  it("lists expanded legacy rows after their expander", () => {
    const built = view({ expandedKeys: new Set(["legacy:claudeAgent"]) });
    expect(built.visibleKeys.indexOf(modelPickerRowKey("claudeAgent", "haiku-old"))).toBe(
      built.visibleKeys.indexOf("legacy:claudeAgent") + 1,
    );
  });

  it("hoists favorites into a first section, legacy ones included, without duplicates", () => {
    const built = view({ favorites: [claude("sonnet"), claude("haiku-old"), codex("gpt")] });
    expect(built.sections[0]?.title).toBe("Favorites");
    expect(rowNames("favorites", built)).toEqual(["Sonnet", "Haiku Old", "GPT"]);
    expect(rowNames("claudeAgent", built)).toEqual(["Opus"]);
    expect(rowNames("codex", built)).toEqual(["Mine"]);
    expect(new Set(built.visibleKeys).size).toBe(built.visibleKeys.length);
  });

  it("ignores stale favorites and hidden refs", () => {
    const built = view({ favorites: [claude("gone")], hiddenModels: [codex("gone")] });
    expect(built.sections.map((section) => section.id)).toEqual(["claudeAgent", "codex"]);
    expect(rowNames("codex", built)).toEqual(["GPT", "Mine"]);
  });

  it("lists only favorites in the Favorites view, and nothing without any", () => {
    const built = view({ favorites: [codex("gpt")], favoritesOnly: true });
    expect(built.sections.map((section) => section.id)).toEqual(["favorites"]);
    expect(built.sections[0]?.title).toBeNull();
    expect(rowNames("favorites", built)).toEqual(["GPT"]);
    expect(view({ favoritesOnly: true }).visibleKeys).toEqual([]);
  });

  it("collapses hidden models behind an expander", () => {
    const built = view({ hiddenModels: [claude("sonnet")] });
    expect(rowNames("claudeAgent", built)).toEqual(["Opus"]);
    const hidden = built.sections[0]?.expanders.find((expander) =>
      expander.label.startsWith("Hidden"),
    );
    expect(hidden?.count).toBe(1);
    expect(built.visibleKeys).not.toContain(modelPickerRowKey("claudeAgent", "sonnet"));
    expect(rowOf(built, "Sonnet")?.isHidden).toBe(true);
  });

  it("keeps the selected model visible even when hidden or legacy", () => {
    const hiddenSelected = view({ hiddenModels: [claude("opus")] });
    expect(rowNames("claudeAgent", hiddenSelected)).toContain("Opus");
    expect(rowOf(hiddenSelected, "Opus")?.isHidden).toBe(true);

    const legacySelected = view({ selected: [claude("haiku-old")] });
    expect(rowNames("claudeAgent", legacySelected)).toContain("Haiku Old");
  });

  it("lets a star beat hidden", () => {
    const built = view({ hiddenModels: [claude("sonnet")], favorites: [claude("sonnet")] });
    expect(rowNames("favorites", built)).toEqual(["Sonnet"]);
    expect(rowOf(built, "Sonnet")?.isHidden).toBe(false);
    expect(rowOf(built, "Sonnet")?.canHide).toBe(false);
  });

  it("cannot hide custom models", () => {
    const built = view({ hiddenModels: [codex("mine")] });
    expect(rowNames("codex", built)).toEqual(["GPT", "Mine"]);
    expect(rowOf(built, "Mine")?.canHide).toBe(false);
    expect(rowOf(built, "Mine")?.isHidden).toBe(false);
  });

  it("never leaves a provider empty", () => {
    const allHidden = view({
      selected: [codex("gpt")],
      hiddenModels: [claude("opus"), claude("sonnet"), claude("haiku-old")],
    });
    expect(rowNames("claudeAgent", allHidden)).toEqual(["Opus", "Sonnet", "Haiku Old"]);
    expect(allHidden.sections[0]?.expanders).toEqual([]);

    const onlyLegacy = view({
      selected: [codex("gpt")],
      claudeOptions: [{ slug: "old", name: "Old", isLegacy: true }],
    });
    expect(rowNames("claudeAgent", onlyLegacy)).toEqual(["Old"]);
  });

  it("does not offer to hide the last visible model or the selected one", () => {
    const options = [
      { slug: "a", name: "A" },
      { slug: "b", name: "B" },
    ];
    const built = view({ claudeOptions: options, selected: [claude("a")] });
    expect(rowOf(built, "A")?.canHide).toBe(false);
    expect(rowOf(built, "B")?.canHide).toBe(true);

    const last = view({
      claudeOptions: options,
      selected: [codex("gpt")],
      hiddenModels: [claude("a")],
    });
    expect(rowOf(last, "B")?.canHide).toBe(false);
  });

  it("searches across legacy and hidden models, ranked in one flat list", () => {
    const built = view({ query: "o", hiddenModels: [claude("sonnet")] });
    expect(built.sections).toHaveLength(1);
    expect(built.sections[0]?.id).toBe("search");
    expect(built.sections[0]?.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining(["Opus", "Sonnet", "Haiku Old"]),
    );
    expect(built.visibleKeys).toContain(modelPickerRowKey("claudeAgent", "haiku-old"));
    expect(view({ query: "   " }).sections).toHaveLength(2);
  });

  it("limits search to favorites in the Favorites view and reports no results", () => {
    const built = view({ query: "gpt", favoritesOnly: true, favorites: [claude("opus")] });
    expect(built.visibleKeys).toEqual([]);
    expect(built.sections).toEqual([]);
    expect(view({ query: "zzzzz" }).visibleKeys).toEqual([]);
  });

  it("shows a disabled provider as a row with no models, and keeps it out of search", () => {
    const built = view({ codexEnabled: false, favorites: [codex("gpt")] });
    expect(built.sections.map((section) => section.id)).toEqual(["claudeAgent", "codex"]);
    expect(built.sections[1]?.isDisabled).toBe(true);
    expect(built.sections[1]?.rows).toEqual([]);
    expect(view({ codexEnabled: false, query: "gpt" }).visibleKeys).toEqual([]);
  });

  it("drops section titles for a locked provider", () => {
    const built = buildModelPickerView({
      providers: [{ provider: "claudeAgent", label: "Claude", isEnabled: true, options: CLAUDE }],
      favorites: [codex("gpt")],
      hiddenModels: [],
      selected: [claude("opus")],
      expandedKeys: new Set(),
      query: "",
      favoritesOnly: false,
      showProviderTitles: false,
    });
    expect(built.sections.map((section) => [section.id, section.title])).toEqual([
      ["claudeAgent", null],
    ]);
  });
});
