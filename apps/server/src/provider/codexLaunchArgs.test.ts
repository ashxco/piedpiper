import { describe, expect, it } from "vitest";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  codexMcpListLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs";

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

  it("keeps a trailing escaped space in the env override", () => {
    const override = String.raw`--config model=gpt\ `;
    expect(resolveCodexLaunchArgs("", { PIEDPIPER_CODEX_LAUNCH_ARGS: override })).toBe(override);
    expect(
      codexExecLaunchArgs(resolveCodexLaunchArgs("", { PIEDPIPER_CODEX_LAUNCH_ARGS: override })),
    ).toEqual(["--config", "model=gpt "]);
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

  it("keeps compact -cKEY=VALUE and -pPROFILE options", () => {
    expect(codexExecLaunchArgs("-cmodel=gpt -pwork -c=a=b")).toEqual([
      "-c=model=gpt",
      "-p=work",
      "-c=a=b",
    ]);
    expect(codexMcpListLaunchArgs("-cmodel=gpt -pwork")).toEqual(["-c=model=gpt", "-p=work"]);
  });

  it("drops launch-arg enables for features text generation turns off", () => {
    expect(
      codexExecLaunchArgs(
        "--enable hooks --enable=codex_hooks --enable apps --enable=connectors --enable plugins --enable foo",
      ),
    ).toEqual(["--enable", "foo"]);
    expect(codexMcpListLaunchArgs("--enable hooks --enable=apps --enable plugins")).toEqual([
      "--enable",
      "hooks",
    ]);
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    expect(codexExecLaunchArgs("--config --strict-config --enable --disable")).toEqual([
      "--strict-config",
    ]);
  });
});

describe("codex exec and mcp list launch args", () => {
  const launchArgs =
    "--strict-config --oss --local-provider ollama --profile local -p=work --listen off --enable foo";

  it("keeps the local model provider flags for codex exec", () => {
    expect(codexExecLaunchArgs(launchArgs)).toEqual([
      "--strict-config",
      "--oss",
      "--local-provider",
      "ollama",
      "--profile",
      "local",
      "-p=work",
      "--enable",
      "foo",
    ]);
  });

  it("keeps the selected profile and drops exec-only flags for codex mcp list", () => {
    expect(codexMcpListLaunchArgs(launchArgs)).toEqual([
      "--profile",
      "local",
      "-p=work",
      "--enable",
      "foo",
    ]);
  });
});
