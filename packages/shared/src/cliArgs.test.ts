import { describe, expect, it } from "vitest";

import { parseCliArgs, tokenizeCliArgs } from "./cliArgs";

describe("tokenizeCliArgs", () => {
  it("preserves quoted values and escaped spaces", () => {
    expect(
      tokenizeCliArgs(
        String.raw`--config model="gpt 5" --enable foo\ bar --config=profile='work profile'`,
      ),
    ).toEqual(["--config", "model=gpt 5", "--enable", "foo bar", "--config=profile=work profile"]);
  });

  it("preserves literal backslashes in path values", () => {
    expect(
      tokenizeCliArgs(String.raw`--config cacheDir=C:\Users\me --config "quoted=C:\Users\me"`),
    ).toEqual([
      "--config",
      String.raw`cacheDir=C:\Users\me`,
      "--config",
      String.raw`quoted=C:\Users\me`,
    ]);
  });

  it("keeps backslash-escaped double quotes literal without opening a quote", () => {
    expect(tokenizeCliArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`)).toEqual([
      "--config",
      'model="gpt-6.1-sol"',
      "--strict-config",
    ]);
  });

  it("keeps backslash-escaped single quotes literal without opening a quote", () => {
    expect(tokenizeCliArgs(String.raw`--append-system-prompt don\'t --verbose`)).toEqual([
      "--append-system-prompt",
      "don't",
      "--verbose",
    ]);
  });
});

describe("parseCliArgs", () => {
  it("does not swallow the next flag after a backslash-escaped quote", () => {
    expect(parseCliArgs(String.raw`--append-system-prompt don\'t --verbose`)).toEqual({
      flags: { "append-system-prompt": "don't", verbose: null },
      positionals: [],
    });
  });

  it("returns empty result for empty string", () => {
    expect(parseCliArgs("")).toEqual({ flags: {}, positionals: [] });
  });

  it("returns empty result for whitespace-only string", () => {
    expect(parseCliArgs("   ")).toEqual({ flags: {}, positionals: [] });
  });

  it("returns empty result for empty array", () => {
    expect(parseCliArgs([])).toEqual({ flags: {}, positionals: [] });
  });

  it("parses --chrome boolean flag", () => {
    expect(parseCliArgs("--chrome")).toEqual({
      flags: { chrome: null },
      positionals: [],
    });
  });

  it("parses --chrome with --verbose", () => {
    expect(parseCliArgs("--chrome --verbose")).toEqual({
      flags: { chrome: null, verbose: null },
      positionals: [],
    });
  });

  it("parses --effort with a value", () => {
    expect(parseCliArgs("--effort high")).toEqual({
      flags: { effort: "high" },
      positionals: [],
    });
  });

  it("parses --chrome --effort high --debug", () => {
    expect(parseCliArgs("--chrome --effort high --debug")).toEqual({
      flags: { chrome: null, effort: "high", debug: null },
      positionals: [],
    });
  });

  it("parses --model with full model name", () => {
    expect(parseCliArgs("--model claude-sonnet-4-6")).toEqual({
      flags: { model: "claude-sonnet-4-6" },
      positionals: [],
    });
  });

  it("parses --append-system-prompt with value and --chrome", () => {
    expect(parseCliArgs("--append-system-prompt always-think-step-by-step --chrome")).toEqual({
      flags: { "append-system-prompt": "always-think-step-by-step", chrome: null },
      positionals: [],
    });
  });

  it("parses quoted --append-system-prompt with value and --chrome", () => {
    expect(parseCliArgs(`--append-system-prompt "always think step by step" --chrome`)).toEqual({
      flags: { "append-system-prompt": "always think step by step", chrome: null },
      positionals: [],
    });
  });

  it("parses --max-budget-usd with numeric value", () => {
    expect(parseCliArgs("--chrome --max-budget-usd 5.00")).toEqual({
      flags: { chrome: null, "max-budget-usd": "5.00" },
      positionals: [],
    });
  });

  it("parses --effort=high syntax", () => {
    expect(parseCliArgs("--effort=high")).toEqual({
      flags: { effort: "high" },
      positionals: [],
    });
  });

  it("parses --key=value mixed with boolean flags", () => {
    expect(parseCliArgs("--chrome --model=claude-sonnet-4-6 --debug")).toEqual({
      flags: { chrome: null, model: "claude-sonnet-4-6", debug: null },
      positionals: [],
    });
  });

  it("collects positional arguments", () => {
    expect(parseCliArgs("1.2.3")).toEqual({
      flags: {},
      positionals: ["1.2.3"],
    });
  });

  it("collects positionals mixed with flags (argv array)", () => {
    expect(parseCliArgs(["1.2.3", "--root", "/path", "--github-output"])).toEqual({
      flags: { root: "/path", "github-output": null },
      positionals: ["1.2.3"],
    });
  });

  it("handles extra whitespace between tokens", () => {
    expect(parseCliArgs("  --chrome   --verbose  ")).toEqual({
      flags: { chrome: null, verbose: null },
      positionals: [],
    });
  });

  it("ignores bare -- with no flag name", () => {
    expect(parseCliArgs("--")).toEqual({ flags: {}, positionals: [] });
  });

  it("boolean flag does not consume next token as value", () => {
    expect(parseCliArgs(["--github-output", "1.2.3"], { booleanFlags: ["github-output"] })).toEqual(
      {
        flags: { "github-output": null },
        positionals: ["1.2.3"],
      },
    );
  });

  it("non-boolean flag still consumes next token", () => {
    expect(parseCliArgs(["--root", "/path", "1.2.3"], { booleanFlags: ["github-output"] })).toEqual(
      {
        flags: { root: "/path" },
        positionals: ["1.2.3"],
      },
    );
  });

  it("mixes boolean and value flags with positionals", () => {
    expect(
      parseCliArgs(["--github-output", "--root", "/path", "1.2.3"], {
        booleanFlags: ["github-output"],
      }),
    ).toEqual({
      flags: { "github-output": null, root: "/path" },
      positionals: ["1.2.3"],
    });
  });
});

describe("tokenizeCliArgs and Windows paths before a quote", () => {
  it("reads a doubled backslash before a quote as a literal backslash", () => {
    expect(tokenizeCliArgs(String.raw`--add-dir C:\Users\\"My Name"\x --verbose`)).toEqual([
      "--add-dir",
      String.raw`C:\Users\My Name\x`,
      "--verbose",
    ]);
  });

  it("keeps a single backslash before a quote as an escaped quote", () => {
    expect(tokenizeCliArgs(String.raw`C:\dir\"sub dir"`)).toEqual([String.raw`C:\dir"sub`, "dir"]);
  });

  it("keeps the quote escaped after an odd run of backslashes", () => {
    expect(tokenizeCliArgs(String.raw`a\\\"b --x`)).toEqual([String.raw`a\\` + '"b', "--x"]);
  });

  it("leaves paths with no quote alone", () => {
    expect(tokenizeCliArgs(String.raw`C:\Users\me`)).toEqual([String.raw`C:\Users\me`]);
    expect(tokenizeCliArgs(String.raw`\\server\share`)).toEqual([String.raw`\\server\share`]);
  });
});
