import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import { buildApplicationMenuTemplate } from "./applicationMenu";

function flatten(template: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
  ]);
}

const actions = { onCheckForUpdates: () => {}, onOpenSettings: () => {} };

describe("buildApplicationMenuTemplate", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "never binds Cmd/Ctrl+W to closing the window on %s",
    (platform) => {
      const items = flatten(buildApplicationMenuTemplate(platform, "Pied Piper", actions));

      expect(items.find((item) => item.role === "close")).toBeUndefined();
      expect(
        items.find((item) => item.role === "windowMenu" && item.submenu === undefined),
      ).toBeUndefined();
      expect(
        items.find((item) => item.accelerator?.toString().toLowerCase().endsWith("+w")),
      ).toBeUndefined();
    },
  );

  it("offers a click-only Close Window item on macOS that closes the given window", () => {
    const items = flatten(buildApplicationMenuTemplate("darwin", "Pied Piper", actions));
    const closeItem = items.find((item) => item.label === "Close Window");
    expect(closeItem?.accelerator).toBeUndefined();

    const close = vi.fn();
    closeItem?.click?.({} as never, { close } as never, {} as never);
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps Quit in the File menu off macOS", () => {
    const [file] = buildApplicationMenuTemplate("linux", "Pied Piper", actions);
    const fileItems = file?.submenu as MenuItemConstructorOptions[];
    expect(fileItems.at(-1)?.role).toBe("quit");
    expect(fileItems.some((item) => item.label === "Close Window")).toBe(false);
  });

  it.each([
    ["CmdOrCtrl+num0", "resetZoom"],
    ["CmdOrCtrl+numadd", "zoomIn"],
    ["CmdOrCtrl+numsub", "zoomOut"],
  ] as const)("binds hidden keypad zoom item %s", (accelerator, role) => {
    const items = flatten(buildApplicationMenuTemplate("linux", "Pied Piper", actions));
    const item = items.find((entry) => entry.accelerator === accelerator);
    expect(item?.role).toBe(role);
    expect(item?.visible).toBe(false);
  });

  it("adds a hidden Cmd+Shift+= zoom in only on macOS", () => {
    const find = (platform: NodeJS.Platform) =>
      flatten(buildApplicationMenuTemplate(platform, "Pied Piper", actions)).find(
        (item) => item.accelerator === "CmdOrCtrl+Shift+=",
      );
    expect(find("darwin")).toMatchObject({ role: "zoomIn", visible: false });
    expect(find("linux")).toBeUndefined();
  });
});
