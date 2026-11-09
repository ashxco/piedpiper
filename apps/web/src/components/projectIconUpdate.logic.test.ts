import { describe, expect, it, vi } from "vitest";

import { resolveProjectIconUpdate } from "./projectIconUpdate.logic";

describe("resolveProjectIconUpdate", () => {
  const choose = (pick: ((initialPath: string) => Promise<string | null>) | undefined) =>
    resolveProjectIconUpdate({ action: "choose-icon", cwd: "/repo", pick });

  it("opens the picker at the project and stores a pick inside it as relative", async () => {
    const pick = vi.fn(async () => "/repo/brand/logo.png");
    await expect(choose(pick)).resolves.toEqual({ faviconPath: "brand/logo.png" });
    expect(pick).toHaveBeenCalledWith("/repo");
  });

  it("stores a pick outside the project as absolute", async () => {
    await expect(choose(async () => "/pictures/logo.png")).resolves.toEqual({
      faviconPath: "/pictures/logo.png",
    });
  });

  it("dispatches nothing when the dialog is cancelled, so the current icon stays", async () => {
    await expect(choose(async () => null)).resolves.toBeNull();
  });

  it("dispatches nothing when no picker is available", async () => {
    await expect(choose(undefined)).resolves.toBeNull();
  });

  it("clears the icon on reset without opening the picker", async () => {
    const pick = vi.fn(async () => "/repo/logo.png");
    await expect(
      resolveProjectIconUpdate({ action: "reset-icon", cwd: "/repo", pick }),
    ).resolves.toEqual({ faviconPath: null });
    expect(pick).not.toHaveBeenCalled();
  });

  it("propagates a rejected pick", async () => {
    const failure = new Error("dialog failed");
    await expect(choose(() => Promise.reject(failure))).rejects.toBe(failure);
  });
});
