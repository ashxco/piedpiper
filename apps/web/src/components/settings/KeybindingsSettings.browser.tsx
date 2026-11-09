import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  type KeybindingRule,
  type NativeApi,
  type ServerConfig,
} from "@piedpiper/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingRule,
} from "@piedpiper/shared/keybindings";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { formatShortcutLabel } from "../../keybindings";
import { isMacPlatform } from "../../lib/utils";
import { __resetNativeApiForTests } from "../../nativeApi";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import {
  applyServerConfigEvent,
  resetServerStateForTests,
  setServerConfigSnapshot,
} from "../../rpc/serverState";
import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

const customRule: KeybindingRule = { key: "mod+shift+y", command: "terminal.toggle" };

function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/keybindings.json",
    keybindings: [
      ...DEFAULT_RESOLVED_KEYBINDINGS.filter((rule) => rule.command !== "terminal.toggle"),
      ...[customRule].flatMap((rule) => compileResolvedKeybindingRule(rule) ?? []),
    ],
    issues: [],
    providers: [],
    availableEditors: ["cursor"],
    observability: {
      logsDirectoryPath: "/repo/project/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
    ...overrides,
  };
}

function installApi() {
  const upsertKeybinding = vi.fn().mockResolvedValue({ keybindings: [], issues: [] });
  const removeKeybinding = vi.fn().mockResolvedValue({ keybindings: [], issues: [] });
  const openInEditor = vi.fn().mockResolvedValue(undefined);
  window.nativeApi = {
    server: { upsertKeybinding, removeKeybinding },
    shell: { openInEditor },
  } as unknown as NativeApi;
  return { upsertKeybinding, removeKeybinding, openInEditor };
}

async function renderPanel(config = serverConfig()) {
  setServerConfigSnapshot(config);
  return render(
    <AppAtomRegistryProvider>
      <KeybindingsSettingsPanel />
    </AppAtomRegistryProvider>,
  );
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  document.activeElement?.dispatchEvent(event);
  return event;
}

const pressMod = (key: string, code: string) =>
  press({
    key,
    code,
    ...(isMacPlatform(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
  });

const startRecording = async (label: string) => {
  await page.getByRole("button", { name: `Edit shortcut for ${label}` }).click();
  await expect
    .element(page.getByRole("textbox", { name: `Keybinding for ${label}` }))
    .toHaveFocus();
};

describe("KeybindingsSettingsPanel", () => {
  // The settings route closes on any Escape that reaches the window unhandled.
  let escapesReachingWindow = 0;
  const countEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented) escapesReachingWindow += 1;
  };

  beforeEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    localStorage.clear();
    document.body.innerHTML = "";
    escapesReachingWindow = 0;
    window.addEventListener("keydown", countEscape);
  });

  afterEach(() => {
    window.removeEventListener("keydown", countEscape);
    resetServerStateForTests();
    __resetNativeApiForTests();
    document.body.innerHTML = "";
  });

  it("lists commands by area and filters them from the search box", async () => {
    installApi();
    await renderPanel();

    await expect.element(page.getByRole("heading", { name: "Toggle Sidebar" })).toBeInTheDocument();
    await expect.element(page.getByText("Terminal", { exact: true })).toBeInTheDocument();

    await page.getByRole("searchbox", { name: "Search keybindings" }).fill("file picker");
    await expect
      .element(page.getByRole("heading", { name: "Toggle File Picker" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Toggle Sidebar" }))
      .not.toBeInTheDocument();

    await page.getByRole("searchbox", { name: "Search keybindings" }).fill("no such command");
    await expect.element(page.getByText("No keybindings match your search.")).toBeInTheDocument();
  });

  it("records a chord and saves it in place of the edited rule only", async () => {
    const { upsertKeybinding } = installApi();
    await renderPanel();

    await startRecording("Toggle Sidebar");
    pressMod("g", "KeyG");
    await page.getByRole("button", { name: "Save" }).click();

    expect(upsertKeybinding).toHaveBeenCalledExactlyOnceWith({
      command: "sidebar.toggle",
      key: "mod+g",
      when: "!terminalFocus",
      replace: { command: "sidebar.toggle", key: "mod+b", when: "!terminalFocus" },
    });
  });

  it("shows the saved chord once the server reports the new bindings", async () => {
    installApi();
    const config = serverConfig();
    await renderPanel(config);

    await startRecording("Toggle Sidebar");
    pressMod("g", "KeyG");
    await page.getByRole("button", { name: "Save" }).click();

    const saved = compileResolvedKeybindingRule({
      key: "mod+g",
      command: "sidebar.toggle",
      when: "!terminalFocus",
    })!;
    applyServerConfigEvent({
      version: 1,
      type: "keybindingsUpdated",
      payload: {
        keybindings: [
          ...config.keybindings.filter((rule) => rule.command !== "sidebar.toggle"),
          saved,
        ],
        issues: [],
      },
    });

    await expect
      .element(
        page.getByRole("button", {
          name: `Edit shortcut for Toggle Sidebar: ${formatShortcutLabel(saved.shortcut)}`,
        }),
      )
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Save" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("keeps Escape inside the recorder and restores the rule", async () => {
    const { upsertKeybinding } = installApi();
    await renderPanel();

    await startRecording("Toggle Sidebar");
    press({ key: "Escape", code: "Escape" });

    await expect
      .element(page.getByRole("button", { name: /Edit shortcut for Toggle Sidebar/ }))
      .toHaveFocus();
    expect(escapesReachingWindow).toBe(0);
    expect(upsertKeybinding).not.toHaveBeenCalled();
  });

  it("returns to the pill when the row's own chord is recorded", async () => {
    await renderPanel();
    await startRecording("Terminal: Toggle");

    press({
      key: "Y",
      code: "KeyY",
      shiftKey: true,
      ...(isMacPlatform(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
    });

    await expect
      .element(page.getByRole("button", { name: /Edit shortcut for Terminal: Toggle/ }))
      .toHaveFocus();
  });

  it("stops listening after a capture: Enter saves and other keys change nothing", async () => {
    const { upsertKeybinding } = installApi();
    const screen = await renderPanel();
    await startRecording("Terminal: Toggle");
    pressMod("g", "KeyG");
    const field = page.getByRole("textbox", { name: "Keybinding for Terminal: Toggle" });
    await expect.element(field).toHaveValue("mod+g");

    press({ key: "q", code: "KeyQ" });
    await expect.element(field).toHaveValue("mod+g");

    press({ key: "Enter", code: "Enter" });
    await vi.waitFor(() =>
      expect(upsertKeybinding).toHaveBeenCalledWith({
        command: "terminal.toggle",
        key: "mod+g",
        replace: customRule,
      }),
    );
    // The save settles after this; the panel must not update once teardown disposes its registry.
    await screen.unmount();
  });

  it("restarts recording when the captured field is clicked", async () => {
    await renderPanel();
    await startRecording("Terminal: Toggle");
    pressMod("g", "KeyG");
    const field = page.getByRole("textbox", { name: "Keybinding for Terminal: Toggle" });
    await expect.element(field).toHaveValue("mod+g");

    await field.click();
    pressMod("h", "KeyH");
    await expect.element(field).toHaveValue("mod+h");
  });

  it("lets Tab pass through the recorder without recording it", async () => {
    await renderPanel();
    await startRecording("Terminal: Toggle");

    const event = press({ key: "Tab", code: "Tab" });
    expect(event.defaultPrevented).toBe(false);
    await expect
      .element(page.getByRole("textbox", { name: "Keybinding for Terminal: Toggle" }))
      .toHaveValue("");
  });

  it("warns about a chord with no modifier key", async () => {
    await renderPanel();
    await startRecording("Terminal: Toggle");
    press({ key: "q", code: "KeyQ" });

    await expect.element(page.getByText(/has no modifier key/)).toBeInTheDocument();
  });

  it("keeps Escape in the new row's recorder without closing settings", async () => {
    await renderPanel();
    await page.getByRole("button", { name: "Add keybinding" }).click();
    const field = page.getByRole("textbox", { name: "Keybinding for new keybinding" });
    await field.click();
    press({ key: "q", code: "KeyQ" });
    await expect.element(field).toHaveValue("q");

    press({ key: "Escape", code: "Escape" });
    await expect.element(field).toHaveValue("");
    await expect.element(field).toHaveFocus();
    expect(escapesReachingWindow).toBe(0);
  });

  it("warns about a chord another command uses", async () => {
    installApi();
    await renderPanel();

    await startRecording("Toggle Sidebar");
    pressMod("k", "KeyK");

    await expect
      .element(page.getByLabelText("Conflicts with Toggle Command Palette."))
      .toBeInTheDocument();
  });

  it("does not warn when a chord only collides under the opposite condition", async () => {
    installApi();
    await renderPanel();

    await page.getByRole("searchbox", { name: "Search keybindings" }).fill("mod+d");
    await expect.element(page.getByRole("heading", { name: "Diff: Toggle" })).toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Terminal: Split", exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByLabelText(/^Conflicts with/)).not.toBeInTheDocument();
  });

  it("keeps the draft and leaves the row editable when saving fails", async () => {
    const { upsertKeybinding } = installApi();
    upsertKeybinding.mockRejectedValue(new Error("disk full"));
    await renderPanel();

    await startRecording("Toggle Sidebar");
    pressMod("g", "KeyG");
    await page.getByRole("button", { name: "Save" }).click();

    expect(upsertKeybinding).toHaveBeenCalledOnce();
    await expect
      .element(page.getByRole("textbox", { name: "Keybinding for Toggle Sidebar" }))
      .toHaveValue("mod+g");
    await expect.element(page.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("offers Reset and Remove on custom rows but not on default rows", async () => {
    const { upsertKeybinding, removeKeybinding } = installApi();
    await renderPanel();

    await expect
      .element(page.getByRole("button", { name: "Remove shortcut for Toggle Sidebar" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Reset Toggle Sidebar to default" }))
      .not.toBeInTheDocument();

    await page.getByRole("button", { name: "Remove shortcut for Terminal: Toggle" }).click();
    expect(removeKeybinding).toHaveBeenCalledExactlyOnceWith({
      command: "terminal.toggle",
      key: "mod+shift+y",
    });

    await vi.waitFor(() =>
      expect(
        page.getByRole("button", { name: "Reset Terminal: Toggle to default" }).element(),
      ).toBeEnabled(),
    );
    await page.getByRole("button", { name: "Reset Terminal: Toggle to default" }).click();
    expect(upsertKeybinding).toHaveBeenCalledExactlyOnceWith({
      command: "terminal.toggle",
      key: "mod+j",
      replace: { command: "terminal.toggle", key: "mod+shift+y" },
    });
  });

  it("blocks saving an invalid when clause and reverts it on Escape", async () => {
    const { upsertKeybinding } = installApi();
    await renderPanel();
    const field = page.getByRole("textbox", { name: "When clause for Toggle Sidebar" });

    await field.fill("terminalFocus &&");
    await expect
      .element(page.getByText("Use variables with !, &&, ||, and parentheses."))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();

    press({ key: "Escape", code: "Escape" });
    await expect.element(field).toHaveValue("!terminalFocus");
    expect(escapesReachingWindow).toBe(0);
    expect(upsertKeybinding).not.toHaveBeenCalled();
  });

  it("saves a valid when clause in its canonical form", async () => {
    const { upsertKeybinding } = installApi();
    await renderPanel();

    await page
      .getByRole("textbox", { name: "When clause for Toggle Sidebar" })
      .fill("terminalOpen&&!terminalFocus");
    await page.getByRole("button", { name: "Save" }).click();

    expect(upsertKeybinding).toHaveBeenCalledExactlyOnceWith({
      command: "sidebar.toggle",
      key: "mod+b",
      when: "terminalOpen && !terminalFocus",
      replace: { command: "sidebar.toggle", key: "mod+b", when: "!terminalFocus" },
    });
  });

  it("does not treat spacing changes in a when clause as an edit", async () => {
    installApi();
    await renderPanel();

    await page
      .getByRole("textbox", { name: "When clause for Toggle Sidebar" })
      .fill(" !terminalFocus ");
    await expect.element(page.getByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("adds a binding for a chosen command and closes the row", async () => {
    const { upsertKeybinding } = installApi();
    await renderPanel();

    await page.getByRole("button", { name: "Add keybinding" }).click();
    await page.getByRole("combobox", { name: "Command" }).click();
    await page.getByRole("option", { name: "Composer: Branch Picker" }).click();
    await page.getByRole("textbox", { name: "Keybinding for Composer: Branch Picker" }).click();
    pressMod("g", "KeyG");
    await page.getByRole("button", { name: "Save" }).click();

    expect(upsertKeybinding).toHaveBeenCalledExactlyOnceWith({
      command: "composer.branch",
      key: "mod+g",
    });
    await expect.element(page.getByText("New keybinding")).not.toBeInTheDocument();
  });

  it("shows config issues and opens the file", async () => {
    const { openInEditor } = installApi();
    await renderPanel(
      serverConfig({
        issues: [{ kind: "keybindings.invalid-entry", index: 2, message: "unknown command" }],
      }),
    );

    await expect.element(page.getByText("Entry 3: unknown command")).toBeInTheDocument();
    await page.getByRole("button", { name: "Open keybindings.json" }).click();
    expect(openInEditor).toHaveBeenCalledExactlyOnceWith(
      "/repo/project/keybindings.json",
      "cursor",
    );
  });
});
