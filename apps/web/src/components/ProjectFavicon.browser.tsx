import "../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useStore } from "../store";
import type { Project } from "../types";
import { ProjectFavicon } from "./ProjectFavicon";

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const originalProjects = useStore.getState().projects;

function setFaviconPath(faviconPath: string | null) {
  const project = { id: "project-1", name: "Repo", cwd: "/repo", scripts: [], faviconPath };
  useStore.setState({ projects: [project as unknown as Project] });
}

describe("ProjectFavicon", () => {
  afterEach(() => {
    useStore.setState({ projects: originalProjects });
    document.body.innerHTML = "";
  });

  it("changes the URL and drops the theme tone when an icon is chosen", async () => {
    setFaviconPath(null);
    const screen = await render(<ProjectFavicon cwd="/repo" />);
    const img = () => screen.container.querySelector("img")!;
    const discoveredSrc = img().src;
    expect(new URL(discoveredSrc).searchParams.get("v")).toBeNull();
    expect(img().className).toContain("brightness-0");

    setFaviconPath("assets/logo.png");
    await expect.poll(() => new URL(img().src).searchParams.get("v")).toBe("assets/logo.png");
    expect(img().className).not.toContain("brightness-0");

    setFaviconPath(null);
    await expect.poll(() => img().src).toBe(discoveredSrc);
    expect(img().className).toContain("brightness-0");
  });

  it("loads a newly chosen icon again after the previous one failed", async () => {
    setFaviconPath("missing.png");
    const screen = await render(<ProjectFavicon cwd="/repo" />);
    const failed = screen.container.querySelector("img")!;
    failed.dispatchEvent(new Event("error"));
    await expect.poll(() => screen.container.querySelector("svg") !== null).toBe(true);

    setFaviconPath("assets/logo.png");
    await expect.poll(() => screen.container.querySelector("img") !== failed).toBe(true);
    // The test server has no icon route, so load the new element from a real image.
    screen.container.querySelector("img")!.src = PIXEL;
    await expect.poll(() => screen.container.querySelector("svg")).toBeNull();
    expect(screen.container.querySelector("img")!.className).not.toContain("hidden");
  });
});
