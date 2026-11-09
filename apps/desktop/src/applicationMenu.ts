import type { MenuItemConstructorOptions } from "electron";

export interface ApplicationMenuActions {
  readonly onCheckForUpdates: () => void;
  readonly onOpenSettings: () => void;
}

/**
 * Builds the native application menu. Cmd/Ctrl+W belongs to the renderer (closing terminals), so
 * no item may carry a close-window role or a `+W` accelerator on any platform.
 */
export function buildApplicationMenuTemplate(
  platform: NodeJS.Platform,
  appName: string,
  actions: ApplicationMenuActions,
): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: "about" },
        { label: "Check for Updates...", click: () => actions.onCheckForUpdates() },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => actions.onOpenSettings(),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        ...(isMac
          ? []
          : [
              {
                label: "Settings...",
                accelerator: "CmdOrCtrl+,",
                click: () => actions.onOpenSettings(),
              },
              { type: "separator" as const },
            ]),
        isMac
          ? { label: "Close Window", click: (_item, window) => window?.close() }
          : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+=" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+Plus", visible: false },
        ...(isMac
          ? [{ role: "zoomIn" as const, accelerator: "CmdOrCtrl+Shift+=", visible: false }]
          : []),
        { role: "zoomOut" },
        // The numeric keypad sends its own key codes, so the number-row accelerators miss it.
        { role: "resetZoom", accelerator: "CmdOrCtrl+num0", visible: false },
        { role: "zoomIn", accelerator: "CmdOrCtrl+numadd", visible: false },
        { role: "zoomOut", accelerator: "CmdOrCtrl+numsub", visible: false },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      // Electron's default Window submenu adds a Cmd/Ctrl+W close item.
      role: "windowMenu",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [{ type: "separator" as const }, { role: "front" as const }] : []),
      ],
    },
    {
      role: "help",
      submenu: [{ label: "Check for Updates...", click: () => actions.onCheckForUpdates() }],
    },
  );

  return template;
}
