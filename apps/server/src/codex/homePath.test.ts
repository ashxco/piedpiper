import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import { codexHomeEnv, expandCodexHomePath } from "./homePath";

describe("expandCodexHomePath", () => {
  const home = NodePath.join("/", "Users", "pp");

  it("expands a bare tilde to the home directory", () => {
    expect(expandCodexHomePath("~", home)).toBe(home);
  });

  it("expands a leading tilde segment with either separator", () => {
    expect(expandCodexHomePath("~/.codex-work", home)).toBe(NodePath.join(home, ".codex-work"));
    expect(expandCodexHomePath("~\\.codex-work", home)).toBe(NodePath.join(home, ".codex-work"));
  });

  it("leaves absolute and non-leading-tilde paths alone", () => {
    expect(expandCodexHomePath("/opt/codex", home)).toBe("/opt/codex");
    expect(expandCodexHomePath("~other/.codex", home)).toBe("~other/.codex");
    expect(expandCodexHomePath("/tmp/~/codex", home)).toBe("/tmp/~/codex");
  });
});

describe("codexHomeEnv", () => {
  it("exports an expanded CODEX_HOME", () => {
    const env = codexHomeEnv("~/.codex-work");
    expect(env.CODEX_HOME).toBeDefined();
    expect(env.CODEX_HOME?.startsWith("~")).toBe(false);
    expect(env.CODEX_HOME?.endsWith(".codex-work")).toBe(true);
  });

  it("exports nothing for an unset or blank home path", () => {
    expect(codexHomeEnv(undefined)).toEqual({});
    expect(codexHomeEnv("")).toEqual({});
    expect(codexHomeEnv("   ")).toEqual({});
  });
});
