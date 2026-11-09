import { describe, expect, it } from "vitest";

import { explicitBareRepositoryEnv, gitConfigEnv } from "./gitConfigEnv.ts";

describe("gitConfigEnv", () => {
  it("adds the first entry when nothing is inherited", () => {
    expect(gitConfigEnv({}, "a.b", "c", "darwin")).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_VALUE_0: "c",
    });
  });

  it("appends after inherited entries", () => {
    expect(gitConfigEnv({ GIT_CONFIG_COUNT: "2" }, "a.b", "c", "linux")).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "a.b",
      GIT_CONFIG_VALUE_2: "c",
    });
  });

  it("chains, so each entry keeps its own index", () => {
    const first = gitConfigEnv({}, "a.b", "1", "darwin");
    const second = gitConfigEnv({ ...first }, "c.d", "2", "darwin");
    expect({ ...first, ...second }).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_VALUE_0: "1",
      GIT_CONFIG_KEY_1: "c.d",
      GIT_CONFIG_VALUE_1: "2",
    });
  });

  it("matches the count's casing only on Windows", () => {
    expect(gitConfigEnv({ git_config_count: "2" }, "a.b", "c", "linux")).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_VALUE_0: "c",
    });
    expect(
      gitConfigEnv({ git_config_count: "1", GIT_CONFIG_COUNT: "4" }, "a.b", "c", "win32"),
    ).toEqual({
      git_config_count: "5",
      GIT_CONFIG_COUNT: "5",
      GIT_CONFIG_KEY_4: "a.b",
      GIT_CONFIG_VALUE_4: "c",
    });
  });

  it("leaves a count git would reject for git to report", () => {
    for (const count of ["nope", "2x", "-1", "1.5", "  ", "1 "]) {
      expect(gitConfigEnv({ GIT_CONFIG_COUNT: count }, "a.b", "c", "darwin")).toEqual({});
    }
  });
});

describe("explicitBareRepositoryEnv", () => {
  it("applies on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(explicitBareRepositoryEnv({}, platform)).toEqual({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.bareRepository",
        GIT_CONFIG_VALUE_0: "explicit",
      });
    }
  });
});
