import { spawnSync } from "node:child_process";

import { DEFAULT_SERVER_SETTINGS, type BranchNamingOptions } from "@piedpiper/contracts";
import { isTemporaryWorktreeBranch } from "@piedpiper/shared/git";
import { describe, expect, it } from "vitest";

import {
  branchNamingOptionsFromSettings,
  formatGeneratedBranchName,
  sanitizeGeneratedBranchName,
} from "./branchNaming.ts";

const naming = (overrides: Partial<BranchNamingOptions>): BranchNamingOptions => ({
  mode: "static",
  prefix: "piedpiper",
  instructions: "",
  ...overrides,
});

describe("branchNamingOptionsFromSettings", () => {
  it("keeps today's piedpiper/<words> naming by default", () => {
    const options = branchNamingOptionsFromSettings(DEFAULT_SERVER_SETTINGS);

    expect(options).toEqual({ mode: "static", prefix: "piedpiper", instructions: "" });
    expect(formatGeneratedBranchName("Add Search", options)).toBe("piedpiper/add-search");
  });
});

describe("formatGeneratedBranchName", () => {
  describe("static", () => {
    it("adds the configured prefix", () => {
      expect(formatGeneratedBranchName("Add Search", naming({ prefix: "team" }))).toBe(
        "team/add-search",
      );
    });

    it("keeps a slash in the generated fragment below the prefix", () => {
      expect(formatGeneratedBranchName("feature/reconnect-backoff", naming({}))).toBe(
        "piedpiper/feature/reconnect-backoff",
      );
    });

    it.each([
      ["piedpiper/add-search", "piedpiper", "piedpiper/add-search"],
      ["refs/heads/piedpiper/add-search", "piedpiper", "piedpiper/add-search"],
      ["Team/Jules/add-search", "Team/Jules", "Team/Jules/add-search"],
      ["team/jules/add-search", "Team/Jules", "Team/Jules/add-search"],
    ])("strips an echoed prefix from %s", (raw, prefix, expected) => {
      expect(formatGeneratedBranchName(raw, naming({ prefix }))).toBe(expected);
    });

    it("does not treat a longer word as an echoed prefix", () => {
      expect(formatGeneratedBranchName("teamwork/add-search", naming({ prefix: "team" }))).toBe(
        "team/teamwork/add-search",
      );
    });

    it.each([
      [" Team / Jules.lock/", "Team/Jules/add-search"],
      ["-team//feature@{new", "team/feature-new/add-search"],
      [" /?. / ", "add-search"],
      ["", "add-search"],
      ["my team", "my-team/add-search"],
    ])("normalizes the prefix %j", (prefix, expected) => {
      expect(formatGeneratedBranchName("Add Search", naming({ prefix }))).toBe(expected);
    });

    it.each([
      ["チーム", "チーム/add-search"],
      ["Füge", "Füge/add-search"],
      ["ash.dev", "ash.dev/add-search"],
      ["a_b/c-d", "a_b/c-d/add-search"],
    ])("keeps the valid prefix %j as written", (prefix, expected) => {
      const name = formatGeneratedBranchName("Add Search", naming({ prefix }));
      expect(name).toBe(expected);
      expect(spawnSync("git", ["check-ref-format", "--branch", name]).status).toBe(0);
    });

    it.each([
      ["ash.dev/add-search", "ash.dev", "ash.dev/add-search"],
      ["Füge/add-search", "Füge", "Füge/add-search"],
      ["チーム/add-search", "チーム", "チーム/add-search"],
    ])("strips an echoed prefix from %s after normalizing both", (raw, prefix, expected) => {
      expect(formatGeneratedBranchName(raw, naming({ prefix }))).toBe(expected);
    });

    it("does not mistake the fallback word for an echo of a prefix with no ASCII", () => {
      expect(formatGeneratedBranchName("update/deps", naming({ prefix: "チーム" }))).toBe(
        "チーム/update/deps",
      );
      expect(formatGeneratedBranchName("update/deps", naming({ prefix: "!!!" }))).toBe(
        "!!!/update/deps",
      );
    });

    it("strips an echo of a prefix that really is the fallback word", () => {
      expect(formatGeneratedBranchName("update/deps", naming({ prefix: "update" }))).toBe(
        "update/deps",
      );
    });

    it("falls back when the model returns nothing usable", () => {
      expect(formatGeneratedBranchName("  ???  ", naming({}))).toBe("piedpiper/update");
    });
  });

  describe("semantic", () => {
    it("uses the model's own prefix and ignores the stored one", () => {
      expect(
        formatGeneratedBranchName("feat/Add Search", naming({ mode: "semantic", prefix: "team" })),
      ).toBe("feat/add-search");
    });

    it("drops a refs/heads prefix", () => {
      expect(formatGeneratedBranchName("refs/heads/fix/login", naming({ mode: "semantic" }))).toBe(
        "fix/login",
      );
    });
  });

  describe("custom", () => {
    const custom = naming({ mode: "custom", prefix: "ignored", instructions: "Use JIRA keys." });

    it("keeps casing and slashes and adds no prefix", () => {
      expect(formatGeneratedBranchName("PROJ-123/Add_Search", custom)).toBe("PROJ-123/Add_Search");
    });

    it.each([
      ["refs/heads/Team/Fix", "Team/Fix"],
      ["`Team/Fix`", "Team/Fix"],
      ["Team Fix", "Team-Fix"],
      ["a..b", "a-b"],
      ["a~b^c:d?e*f[g\\h", "a-b-c-d-e-f-g-h"],
      ["a@{b", "a-b"],
      ["-Team//.Fix.lock/", "Team/Fix"],
      ["Fix.lock.", "Fix"],
      ["Fix.", "Fix"],
    ])("makes %j a valid ref", (raw, expected) => {
      expect(formatGeneratedBranchName(raw, custom)).toBe(expected);
    });

    it("keeps non-ASCII characters, which git allows", () => {
      expect(formatGeneratedBranchName("Füge/Suche-hinzu", custom)).toBe("Füge/Suche-hinzu");
    });

    it("caps the length without leaving an invalid ending", () => {
      const name = formatGeneratedBranchName(`${"a".repeat(99)}/b`, custom);
      expect(name).toBe("a".repeat(99));
    });

    it("falls back when nothing usable remains", () => {
      expect(formatGeneratedBranchName(" ../ ", custom)).toBe("update");
    });

    it("falls back for the one name git refuses despite its format", () => {
      expect(formatGeneratedBranchName("HEAD", custom)).toBe("update");
      expect(formatGeneratedBranchName("refs/heads/HEAD", custom)).toBe("update");
      expect(formatGeneratedBranchName("HEAD/fix", custom)).toBe("HEAD/fix");
    });

    it("caps each path segment by bytes so it fits a filesystem name", () => {
      const name = formatGeneratedBranchName(`語`.repeat(100), custom);
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(240);
      expect(name).toBe("語".repeat(80));
    });

    it("cuts a segment on a whole character and leaves a valid ending", () => {
      const name = formatGeneratedBranchName(`${"語".repeat(79)}a.語`, custom);
      expect(name).toBe(`${"語".repeat(79)}a`);
    });
  });

  it.each([
    ["1234abcd", naming({})],
    ["piedpiper/1234abcd", naming({ mode: "semantic" })],
    ["piedpiper/1234abcd", naming({ mode: "custom" })],
    ["piedpiper-1234ABCD", naming({ mode: "custom" })],
  ])(
    "recognizably yields a placeholder for %j so the caller can skip the rename",
    (raw, options) => {
      expect(isTemporaryWorktreeBranch(formatGeneratedBranchName(raw, options))).toBe(true);
    },
  );

  it.each(["Add Search", "feat/x", "PROJ-1/Y z"])("is stable when re-applied to %j", (raw) => {
    for (const mode of ["semantic", "custom"] as const) {
      const once = formatGeneratedBranchName(raw, naming({ mode }));
      expect(formatGeneratedBranchName(once, naming({ mode }))).toBe(once);
    }
  });
});

describe("sanitizeGeneratedBranchName", () => {
  it("lowercases outside custom mode, including when no options are given", () => {
    expect(sanitizeGeneratedBranchName("  Feat/Session  ")).toBe("feat/session");
    expect(sanitizeGeneratedBranchName("Feat/Session", { mode: "static" })).toBe("feat/session");
    expect(sanitizeGeneratedBranchName("Feat/Session", { mode: "semantic" })).toBe("feat/session");
  });

  it("keeps casing in custom mode", () => {
    expect(sanitizeGeneratedBranchName("  Feat/Session  ", { mode: "custom" })).toBe(
      "Feat/Session",
    );
  });
});
