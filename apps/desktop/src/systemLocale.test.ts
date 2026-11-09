import { describe, expect, it } from "vitest";

import {
  resolveLinuxTimeLocale,
  resolveSystemLocaleTag,
  type SystemLocaleSource,
  toSystemLocaleTag,
} from "./systemLocale";

const source = (overrides: Partial<SystemLocaleSource>): SystemLocaleSource => ({
  platform: "darwin",
  env: {},
  getSystemLocale: () => "en-GB",
  getBooleanUserDefault: () => false,
  ...overrides,
});

describe("toSystemLocaleTag", () => {
  it("normalizes POSIX identifiers", () => {
    expect(toSystemLocaleTag("en_GB")).toBe("en-GB");
  });

  it("applies the macOS region override to the region subtag", () => {
    expect(toSystemLocaleTag("en_US@rg=nlzzzz")).toBe("en-NL");
    expect(toSystemLocaleTag("en-US@rg=nlzzzz", "h12")).toBe("en-NL-u-hc-h12");
  });

  it("adds a forced hour cycle", () => {
    expect(toSystemLocaleTag("en-GB", "h23")).toBe("en-GB-u-hc-h23");
  });

  it("drops ICU keywords Intl cannot read instead of losing the locale", () => {
    expect(toSystemLocaleTag("de_DE@calendar=buddhist")).toBe("de-DE");
  });

  it("returns an unparseable tag unchanged rather than throwing", () => {
    expect(toSystemLocaleTag("not a locale")).toBe("not a locale");
    expect(toSystemLocaleTag("")).toBe("");
  });
});

describe("resolveLinuxTimeLocale", () => {
  it("follows LC_ALL, then LC_TIME, then LANG", () => {
    expect(
      resolveLinuxTimeLocale({ LC_ALL: "fr_FR.UTF-8", LC_TIME: "de_DE.UTF-8", LANG: "en_US" }),
    ).toBe("fr_FR");
    expect(resolveLinuxTimeLocale({ LC_TIME: "de_DE.UTF-8", LANG: "en_US.UTF-8" })).toBe("de_DE");
    expect(resolveLinuxTimeLocale({ LANG: "en_GB.UTF-8" })).toBe("en_GB");
  });

  it("skips an empty LC_ALL, as glibc does", () => {
    expect(resolveLinuxTimeLocale({ LC_ALL: "", LANG: "en_GB.UTF-8" })).toBe("en_GB");
  });

  it("strips encodings and modifiers", () => {
    expect(resolveLinuxTimeLocale({ LANG: "sr_RS.UTF-8@latin" })).toBe("sr_RS");
    expect(resolveLinuxTimeLocale({ LANG: "ca_ES@valencia" })).toBe("ca_ES");
  });

  it("returns null for C, POSIX and nothing set", () => {
    expect(resolveLinuxTimeLocale({ LANG: "C.UTF-8" })).toBeNull();
    expect(resolveLinuxTimeLocale({ LC_ALL: "POSIX" })).toBeNull();
    expect(resolveLinuxTimeLocale({})).toBeNull();
  });
});

describe("resolveSystemLocaleTag", () => {
  it("prefers LC_TIME over Chromium's locale on Linux", () => {
    const tag = resolveSystemLocaleTag(
      source({ platform: "linux", env: { LANG: "en_US.UTF-8", LC_TIME: "de_DE.UTF-8" } }),
    );
    expect(tag).toBe("de-DE");
  });

  it("falls back to Chromium's locale on Linux when the time locale is C", () => {
    const tag = resolveSystemLocaleTag(
      source({ platform: "linux", env: { LANG: "C.UTF-8" }, getSystemLocale: () => "fr-FR" }),
    );
    expect(tag).toBe("fr-FR");
  });

  it("reads both macOS hour preferences, with 24-hour winning", () => {
    const withDefaults = (...keys: string[]) =>
      resolveSystemLocaleTag(
        source({
          getSystemLocale: () => "en_US@rg=nlzzzz",
          getBooleanUserDefault: (key) => keys.includes(key),
        }),
      );
    expect(withDefaults()).toBe("en-NL");
    expect(withDefaults("AppleICUForce12HourTime")).toBe("en-NL-u-hc-h12");
    expect(withDefaults("AppleICUForce24HourTime")).toBe("en-NL-u-hc-h23");
    expect(withDefaults("AppleICUForce12HourTime", "AppleICUForce24HourTime")).toBe(
      "en-NL-u-hc-h23",
    );
  });

  it("uses the system locale elsewhere without reading macOS defaults", () => {
    const tag = resolveSystemLocaleTag(
      source({
        platform: "win32",
        env: { LANG: "de_DE.UTF-8" },
        getBooleanUserDefault: () => {
          throw new Error("macOS only");
        },
      }),
    );
    expect(tag).toBe("en-GB");
  });

  it("produces tags an explicit hour12 still overrides", () => {
    for (const hour12 of [true, false]) {
      for (const tag of [toSystemLocaleTag("en-GB", "h23"), toSystemLocaleTag("en-US", "h12")]) {
        expect(
          new Intl.DateTimeFormat(tag, { hour: "numeric", hour12 }).resolvedOptions().hour12,
        ).toBe(hour12);
      }
    }
  });
});
