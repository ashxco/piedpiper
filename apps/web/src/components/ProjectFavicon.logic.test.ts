import { describe, expect, it } from "vitest";

import {
  projectFaviconSearchParams,
  projectFaviconToneClass,
  readProjectFaviconPath,
  readProjectFaviconVersion,
} from "./ProjectFavicon.logic";
import type { Project } from "../types";

const project = (updatedAt: string, faviconPath: string | null) =>
  ({ faviconPath, updatedAt }) as never;

describe("ProjectFavicon logic", () => {
  it("treats a missing project, an absent field and null as no chosen icon", () => {
    const project = { id: "p", cwd: "/repo" } as unknown as Project;
    expect(readProjectFaviconPath(undefined)).toBeNull();
    expect(readProjectFaviconPath(project)).toBeNull();
    expect(readProjectFaviconPath({ ...project, faviconPath: null } as Project)).toBeNull();
    expect(readProjectFaviconPath({ ...project, faviconPath: "logo.png" } as Project)).toBe(
      "logo.png",
    );
  });

  it("versions the icon URL only while an icon is chosen", () => {
    expect(projectFaviconSearchParams("/repo", null)).toEqual({ cwd: "/repo" });
    expect(projectFaviconSearchParams("/repo", "logo.png")).toEqual({
      cwd: "/repo",
      v: "logo.png",
    });
  });

  it("moves the URL on a re-pick of the same path, and not for a discovered icon", () => {
    const first = readProjectFaviconVersion(project("2026-01-01T00:00:00.000Z", "a.png"));
    const second = readProjectFaviconVersion(project("2026-01-02T00:00:00.000Z", "a.png"));
    expect(first).not.toBe(second);
    expect(projectFaviconSearchParams("/repo", "a.png", second).v).toBe(second);
    expect(readProjectFaviconVersion(project("2026-01-01T00:00:00.000Z", null))).toBeNull();
    expect(projectFaviconSearchParams("/repo", null, null)).toEqual({ cwd: "/repo" });
  });

  it("tones only discovered icons", () => {
    expect(projectFaviconToneClass(null)).toContain("brightness-0");
    expect(projectFaviconToneClass("logo.png")).toBe("");
  });
});
