import { describe, expect, it } from "vitest";

import {
  canOfferProviderCommands,
  filterComposerProviderCommands,
  isComposerPathWord,
  providerCommandInsertion,
} from "./composerProviderCommands";

describe("isComposerPathWord", () => {
  it("treats a word with a second slash as a path, wherever the caret is", () => {
    expect(isComposerPathWord("/usr/bin", 0, 8)).toBe(true);
    expect(isComposerPathWord("/usr/bin", 0, 2)).toBe(true);
    expect(isComposerPathWord("/tmp/build.sh now", 0, 4)).toBe(true);
  });

  it("leaves a plain command alone", () => {
    expect(isComposerPathWord("/compact", 0, 8)).toBe(false);
    expect(isComposerPathWord("/compact a/b", 0, 8)).toBe(false);
  });
});

describe("canOfferProviderCommands", () => {
  it("offers commands only at the start of the message", () => {
    expect(canOfferProviderCommands("/com", 0)).toBe(true);
    expect(canOfferProviderCommands("\n  /com", 3)).toBe(true);
    expect(canOfferProviderCommands("hello\n/com", 6)).toBe(false);
  });
});

const named = (...names: string[]) => names.map((name) => ({ name }));

describe("filterComposerProviderCommands", () => {
  it("closes the menu on an exact name, so Enter sends it and not a longer one", () => {
    expect(
      filterComposerProviderCommands(named("review", "security-review"), "review", []),
    ).toEqual([]);
    expect(filterComposerProviderCommands(named("deploy", "deploy-staging"), "deploy", [])).toEqual(
      [],
    );
  });

  const commands = [
    { name: "compact" },
    { name: "context" },
    { name: "recompile" },
    { name: "model" },
    { name: "plan" },
  ];
  const names = (query: string) =>
    filterComposerProviderCommands(commands, query, ["model", "plan", "default"]).map(
      (command) => command.name,
    );

  it("lets local commands win a clash", () => {
    expect(names("")).toEqual(["compact", "context", "recompile"]);
    expect(names("mod")).toEqual([]);
  });

  it("ranks prefix matches above substring ones, ignoring case", () => {
    expect(names("COM")).toEqual(["compact", "recompile"]);
  });

  it("drops an exact name, so Enter sends /compact", () => {
    expect(names("compact")).toEqual([]);
  });

  it("returns nothing for an unknown word, so no empty menu opens", () => {
    expect(names("zzz")).toEqual([]);
  });
});

describe("providerCommandInsertion", () => {
  it("inserts the command with a trailing space", () => {
    expect(providerCommandInsertion({ name: "compact" })).toBe("/compact ");
  });
});
