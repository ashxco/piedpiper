import type { AgentSessionProjectCandidate } from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  addAgentSessionProjects,
  defaultAgentSessionProjectSelection,
  describeAgentSessionProject,
  isPreselectedAgentSessionProject,
} from "./agentSessionProjects.logic";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function candidate(
  overrides: Partial<AgentSessionProjectCandidate> = {},
): AgentSessionProjectCandidate {
  return {
    path: "/code/app",
    title: "app",
    sources: ["claudeAgent"],
    threadCount: 3,
    lastActiveAt: new Date(NOW - DAY_MS).toISOString(),
    isGitRepository: true,
    ...overrides,
  };
}

describe("isPreselectedAgentSessionProject", () => {
  it("selects a recent git repository with enough sessions", () => {
    expect(isPreselectedAgentSessionProject(candidate(), NOW)).toBe(true);
  });

  it.each([
    ["not a git repository", { isGitRepository: false }],
    ["too few sessions", { threadCount: 2 }],
    ["older than 30 days", { lastActiveAt: new Date(NOW - 31 * DAY_MS).toISOString() }],
    ["no known activity", { lastActiveAt: null }],
    ["activity in the future", { lastActiveAt: new Date(NOW + DAY_MS).toISOString() }],
    ["an unparseable date", { lastActiveAt: "soon" }],
  ])("skips %s", (_label, overrides) => {
    expect(isPreselectedAgentSessionProject(candidate(overrides), NOW)).toBe(false);
  });

  it("includes activity exactly on the 30 day boundary", () => {
    const lastActiveAt = new Date(NOW - 30 * DAY_MS).toISOString();
    expect(isPreselectedAgentSessionProject(candidate({ lastActiveAt }), NOW)).toBe(true);
  });
});

describe("defaultAgentSessionProjectSelection", () => {
  it("holds only the preselected paths", () => {
    const selection = defaultAgentSessionProjectSelection(
      [candidate(), candidate({ path: "/code/old", threadCount: 1 })],
      NOW,
    );
    expect([...selection]).toEqual(["/code/app"]);
  });
});

describe("describeAgentSessionProject", () => {
  it("names the sources and counts sessions", () => {
    expect(describeAgentSessionProject(candidate({ sources: ["claudeAgent", "codex"] }))).toBe(
      "Claude Code and Codex, 3 sessions",
    );
    expect(describeAgentSessionProject(candidate({ sources: ["codex"], threadCount: 1 }))).toBe(
      "Codex, 1 session",
    );
  });
});

describe("addAgentSessionProjects", () => {
  it("creates one at a time, in order", async () => {
    const events: string[] = [];
    const result = await addAgentSessionProjects(
      [candidate({ path: "/a" }), candidate({ path: "/b" })],
      async ({ path }) => {
        events.push(`start ${path}`);
        await Promise.resolve();
        events.push(`end ${path}`);
      },
    );

    expect(events).toEqual(["start /a", "end /a", "start /b", "end /b"]);
    expect(result).toEqual({ added: ["/a", "/b"], failed: [] });
  });

  it("carries on past a failure and reports it", async () => {
    const createProject = vi.fn(async ({ path }: AgentSessionProjectCandidate) => {
      if (path === "/a") throw new Error("nope");
    });

    const result = await addAgentSessionProjects(
      [candidate({ path: "/a" }), candidate({ path: "/b" })],
      createProject,
    );

    expect(result).toEqual({ added: ["/b"], failed: [{ path: "/a", message: "nope" }] });
  });
});
