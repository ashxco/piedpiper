import { describe, expect, it } from "vitest";

import { codexAppServerArgs, codexExecLaunchArgs, resolveCodexLaunchArgs } from "./codexLaunchArgs";

describe("resolveCodexLaunchArgs", () => {
  it("uses PIEDPIPER_CODEX_LAUNCH_ARGS before configured settings", () => {
    expect(
      resolveCodexLaunchArgs(" --strict-config ", { PIEDPIPER_CODEX_LAUNCH_ARGS: "--enable foo" }),
    ).toBe("--enable foo");
  });

  it("uses configured settings when the env override is blank", () => {
    expect(
      resolveCodexLaunchArgs(" --strict-config ", { PIEDPIPER_CODEX_LAUNCH_ARGS: "   " }),
    ).toBe("--strict-config");
    expect(resolveCodexLaunchArgs("", { PIEDPIPER_CODEX_LAUNCH_ARGS: "   " })).toBe("");
  });
});

describe("codexAppServerArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    expect(codexAppServerArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`)).toEqual([
      "app-server",
      "--config",
      'model="gpt-6.1-sol"',
      "--strict-config",
    ]);
  });

  it("returns the app-server command for empty launch args", () => {
    expect(codexAppServerArgs("")).toEqual(["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    expect(codexAppServerArgs(`--strict-config --config model="gpt 5"`)).toEqual([
      "app-server",
      "--strict-config",
      "--config",
      "model=gpt 5",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    expect(codexExecLaunchArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`)).toEqual(
      ["--config", 'model="gpt-6.1-sol"', "--strict-config"],
    );
  });

  it("keeps shared codex flags and omits app-server-only flags", () => {
    expect(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
    ).toEqual(["--strict-config", "--enable", "foo", "--config", "model=gpt 5"]);
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    expect(codexExecLaunchArgs("--config --strict-config --enable --disable")).toEqual([
      "--strict-config",
    ]);
  });
});
