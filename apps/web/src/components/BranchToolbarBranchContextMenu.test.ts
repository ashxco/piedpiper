import { describe, expect, it, vi } from "vitest";

import { runBranchNameContextMenu } from "./BranchToolbarBranchContextMenu";

function fakeApi(choice: string | null) {
  const show = vi.fn(async () => choice);
  return { api: { contextMenu: { show } } as never, show };
}

describe("runBranchNameContextMenu", () => {
  it("copies the branch name when the copy action is chosen", async () => {
    const { api, show } = fakeApi("copy-branch-name");
    const copy = vi.fn(async () => {});
    const result = await runBranchNameContextMenu({
      api,
      branchName: "feature/cache-main-20260918",
      position: { x: 4, y: 8 },
      copy,
    });
    expect(result).toBe("copied");
    expect(copy).toHaveBeenCalledWith("feature/cache-main-20260918");
    expect(show).toHaveBeenCalledWith([{ id: "copy-branch-name", label: "Copy branch name" }], {
      x: 4,
      y: 8,
    });
  });

  it("does nothing when the menu is dismissed", async () => {
    const { api } = fakeApi(null);
    const copy = vi.fn(async () => {});
    await expect(
      runBranchNameContextMenu({ api, branchName: "main", position: { x: 0, y: 0 }, copy }),
    ).resolves.toBe("cancelled");
    expect(copy).not.toHaveBeenCalled();
  });

  it("rejects when the clipboard write fails", async () => {
    const { api } = fakeApi("copy-branch-name");
    const copy = vi.fn(async () => {
      throw new Error("denied");
    });
    await expect(
      runBranchNameContextMenu({ api, branchName: "main", position: { x: 0, y: 0 }, copy }),
    ).rejects.toThrow("denied");
  });
});
