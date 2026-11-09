import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  type NativeApi,
  type ServerConfig,
  type ServerProvider,
} from "@piedpiper/contracts";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { __resetNativeApiForTests } from "../../nativeApi";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { GeneralSettingsPanel } from "./panels/GeneralSettingsPanel";
import { SETTINGS_SEARCH_ENTRIES } from "./settingsSearch";
import { revealSettingsTarget } from "./useSettingsSearchTarget";

function createBaseServerConfig(): ServerConfig {
  return {
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.piedpiper-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: ["cursor"],
    observability: {
      logsDirectoryPath: "/repo/project/.piedpiper/logs",
      localTracingEnabled: true,
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpTracesEnabled: true,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

describe("GeneralSettingsPanel observability", () => {
  beforeEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    document.body.innerHTML = "";
  });

  it("shows diagnostics inside About with a single logs-folder action", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("About")).toBeInTheDocument();
    await expect.element(page.getByText("Diagnostics", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Open logs folder")).toBeInTheDocument();
    await expect.element(page.getByText("Usage data", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText(/PIEDPIPER_TELEMETRY_ENABLED=false/)).toBeInTheDocument();
    await expect.element(page.getByText(/hashed identifier/)).toBeInTheDocument();
    await expect
      .element(page.getByText("/repo/project/.piedpiper/logs", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Local trace file. OTLP exporting traces to http://localhost:4318/v1/traces.",
        ),
      )
      .toBeInTheDocument();
  });

  it("lists OTLP log exporting alongside traces and metrics", async () => {
    const config = createBaseServerConfig();
    setServerConfigSnapshot({
      ...config,
      observability: {
        ...config.observability,
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        otlpMetricsEnabled: true,
        otlpLogsUrl: "http://localhost:4318/v1/logs",
        otlpLogsEnabled: true,
      },
    });

    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect
      .element(
        page.getByText(
          "Local trace file. OTLP exporting traces to http://localhost:4318/v1/traces, metrics to http://localhost:4318/v1/metrics and logs to http://localhost:4318/v1/logs.",
        ),
      )
      .toBeInTheDocument();
  });

  it("opens the logs folder in the preferred editor", async () => {
    const openInEditor = vi.fn<NativeApi["shell"]["openInEditor"]>().mockResolvedValue(undefined);
    window.nativeApi = {
      shell: {
        openInEditor,
      },
    } as unknown as NativeApi;

    setServerConfigSnapshot(createBaseServerConfig());

    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const openLogsButton = page.getByText("Open logs folder");
    await openLogsButton.click();

    expect(openInEditor).toHaveBeenCalledWith("/repo/project/.piedpiper/logs", "cursor");
  });
});

describe("GeneralSettingsPanel new setting controls", () => {
  beforeEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    document.body.innerHTML = "";
  });

  it("renders the chat, appearance, diff and git sections", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    for (const title of [
      "New thread permissions",
      "Thread title instructions",
      "Send shortcut",
      "Math rendering",
      "Chat width",
      "Terminal font size",
      "Sidebar threads",
      "Diff layout",
      "Hide whitespace changes",
      "Commit message style",
      "Background fetch",
      "Worktree location",
      "Continue after restart",
      "Resume after usage limit",
      "Contrast",
      "Code font",
      "Branch naming",
      "Branch prefix",
      "Provider health checks",
      "CLI update checks",
    ]) {
      await expect
        .element(page.getByRole("heading", { name: title, exact: true }))
        .toBeInTheDocument();
    }
  });

  it("writes a client setting and shows its reset button", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect
      .element(page.getByRole("button", { name: "Reset math rendering to default" }))
      .not.toBeInTheDocument();
    await page.getByRole("switch", { name: "Render LaTeX math" }).click();

    await expect
      .element(page.getByRole("button", { name: "Reset math rendering to default" }))
      .toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem("piedpiper:client-settings:v1") ?? "{}").mathRenderingEnabled,
    ).toBe(true);
  });

  it("writes the contrast slider and resets it", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const slider = page.getByRole("slider", { name: "Contrast" });
    await expect.element(slider).toHaveValue("100");
    await slider.fill("150");

    const reset = page.getByRole("button", { name: "Reset contrast to default" });
    await expect.element(reset).toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem("piedpiper:client-settings:v1") ?? "{}").appearanceContrast,
    ).toBe(150);

    await reset.click();
    await expect.element(slider).toHaveValue("100");
  });

  it("offers every tool call mode", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    const screen = await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("combobox", { name: "Tool call visibility" }).click();
    for (const label of ["Show all", "Hide successful", "Hide all", "Zen"]) {
      await expect.element(page.getByRole("option", { name: label })).toBeInTheDocument();
    }

    // The popup is portalled to the body, so unmount before the body is cleared.
    await screen.unmount();
  });

  it("shows the prefix or the instructions to match the branch naming mode", async () => {
    const updateSettings = vi
      .fn<NativeApi["server"]["updateSettings"]>()
      .mockResolvedValue(DEFAULT_SERVER_SETTINGS);
    window.nativeApi = { server: { updateSettings } } as unknown as NativeApi;
    setServerConfigSnapshot(createBaseServerConfig());

    const screen = await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const prefix = page.getByRole("heading", { name: "Branch prefix", exact: true });
    const instructions = page.getByRole("heading", {
      name: "Branch naming instructions",
      exact: true,
    });
    await expect.element(prefix).toBeInTheDocument();
    await expect.element(instructions).not.toBeInTheDocument();

    await page.getByRole("combobox", { name: "Branch naming" }).click();
    await page.getByRole("option", { name: "Custom instructions" }).click();

    await expect.element(instructions).toBeInTheDocument();
    await expect.element(prefix).not.toBeInTheDocument();
    expect(updateSettings).toHaveBeenCalledWith({ branchNamingMode: "custom" });

    // The closing popup is portalled to the body, so unmount before the body is cleared.
    await screen.unmount();
  });

  it("writes a provider-wide check setting to the server", async () => {
    const updateSettings = vi
      .fn<NativeApi["server"]["updateSettings"]>()
      .mockResolvedValue(DEFAULT_SERVER_SETTINGS);
    window.nativeApi = { server: { updateSettings } } as unknown as NativeApi;
    setServerConfigSnapshot(createBaseServerConfig());

    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("switch", { name: "Check for provider CLI updates" }).click();

    expect(updateSettings).toHaveBeenCalledWith({ enableProviderUpdateChecks: false });
    await expect
      .element(page.getByRole("button", { name: "Reset CLI update checks to default" }))
      .toBeInTheDocument();
  });
});

describe("GeneralSettingsPanel provider update notice", () => {
  beforeEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    document.body.innerHTML = "";
  });

  const providerWithAdvisory = (versionAdvisory: object) =>
    ({
      provider: "claudeAgent",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      versionAdvisory,
    }) as ServerProvider;

  const renderWith = async (versionAdvisory: object) => {
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [providerWithAdvisory(versionAdvisory)],
    });
    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );
  };

  it("offers a copyable command for a CLI behind the latest version", async () => {
    await renderWith({
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      updateCommand: "claude update",
    });

    await expect.element(page.getByText("v2.0.0 is available.")).toBeInTheDocument();
    await expect.element(page.getByText("claude update", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Copy Claude update command" }))
      .toBeInTheDocument();
  });

  it("points a manual install at its own tool, with nothing to copy", async () => {
    await renderWith({
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      updateCommand: null,
    });

    await expect
      .element(page.getByText("Update it with the tool you installed it with."))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Copy Claude update command" }))
      .not.toBeInTheDocument();
  });

  it("shows an update for Codex, which has no provider card", async () => {
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [
        {
          ...providerWithAdvisory({
            status: "behind_latest",
            currentVersion: "1.0.0",
            latestVersion: "2.0.0",
            updateCommand: "npm install -g @openai/codex@latest",
          }),
          provider: "codex",
        },
      ],
    });
    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("v2.0.0 is available.")).toBeInTheDocument();
    await expect
      .element(page.getByText("npm install -g @openai/codex@latest", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Copy Codex update command" }))
      .toBeInTheDocument();
  });

  it("shows nothing for a current CLI", async () => {
    await renderWith({
      status: "current",
      currentVersion: "2.0.0",
      latestVersion: "2.0.0",
      updateCommand: "claude update",
    });

    await expect.element(page.getByText("Diagnostics", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("is available.")).not.toBeInTheDocument();
  });
});

describe("GeneralSettingsPanel provider usage limits", () => {
  beforeEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    document.body.innerHTML = "";
  });

  const renderProvider = async (overrides: object) => {
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [
        {
          provider: "claudeAgent",
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-01-01T00:00:00.000Z",
          models: [],
          usageLimits: {
            checkedAt: "2026-01-01T00:00:00.000Z",
            windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 42 }],
          },
          ...overrides,
        } as ServerProvider,
      ],
    });
    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );
    await page.getByRole("button", { name: "Toggle Claude details" }).click();
    await expect.element(page.getByText("Models", { exact: true })).toBeInTheDocument();
  };

  it("shows Codex usage in its own row, since Codex has no provider card", async () => {
    await renderProvider({ provider: "codex" });

    await expect.element(page.getByText("Codex usage", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("42% used")).toBeInTheDocument();
    await expect.element(page.getByText("Usage limits", { exact: true })).not.toBeInTheDocument();
  });

  it("shows the usage windows of an enabled, installed provider", async () => {
    await renderProvider({});

    await expect.element(page.getByText("Usage limits", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("42% used")).toBeInTheDocument();
  });

  it.each([
    ["disabled", { enabled: false }],
    ["not installed", { installed: false }],
  ])("hides usage limits for a provider that is %s", async (_label, overrides) => {
    await renderProvider(overrides);

    await expect.element(page.getByText("Usage limits", { exact: true })).not.toBeInTheDocument();
  });
});

describe("GeneralSettingsPanel custom model details", () => {
  beforeEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    document.body.innerHTML = "";
  });

  async function renderCustomModels() {
    const updateSettings = vi
      .fn<NativeApi["server"]["updateSettings"]>()
      .mockResolvedValue(DEFAULT_SERVER_SETTINGS);
    window.nativeApi = { server: { updateSettings } } as unknown as NativeApi;
    const config = createBaseServerConfig();
    setServerConfigSnapshot({
      ...config,
      settings: {
        ...config.settings,
        providers: {
          ...config.settings.providers,
          claudeAgent: {
            ...config.settings.providers.claudeAgent,
            customModels: ["gateway-a", "gateway-b"],
            customModelDetails: [{ slug: "gateway-a", name: "Gateway A" }],
          },
        },
      },
    });
    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );
    const savedClaude = () =>
      updateSettings.mock.calls.map(([patch]) => patch.providers?.claudeAgent);
    return { savedClaude };
  }

  it("saves a display name through the edit dialog, writing both fields", async () => {
    const { savedClaude } = await renderCustomModels();

    await page.getByRole("button", { name: "Edit gateway-b" }).click();
    await page.getByRole("textbox", { name: "Display name" }).fill("Gateway B");
    await page.getByRole("button", { name: "Save" }).click();

    await vi.waitFor(() => {
      expect(savedClaude().at(-1)?.customModels).toEqual(["gateway-a", "gateway-b"]);
      expect(savedClaude().at(-1)?.customModelDetails).toEqual([
        { slug: "gateway-a", name: "Gateway A" },
        { slug: "gateway-b", name: "Gateway B" },
      ]);
    });
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("drops a removed model's details along with its slug", async () => {
    const { savedClaude } = await renderCustomModels();

    await page.getByRole("button", { name: "Remove gateway-a" }).click();

    await vi.waitFor(() => {
      expect(savedClaude().at(-1)?.customModels).toEqual(["gateway-b"]);
      expect(savedClaude().at(-1)?.customModelDetails).toEqual([]);
    });
  });
});

describe("settings search targets", () => {
  beforeEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    document.body.innerHTML = "";
  });

  it("renders every anchor the search index names, under the indexed title", async () => {
    setServerConfigSnapshot(createBaseServerConfig());
    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText("Diagnostics", { exact: true })).toBeInTheDocument();

    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      if (entry.to !== "/settings/general" || !entry.anchor) continue;
      const target = document.getElementById(entry.anchor);
      expect(target, entry.id).not.toBeNull();
      if (target?.tagName === "SECTION") {
        expect(target.querySelector("h2")?.textContent).toBe(entry.section);
      } else {
        expect(target?.querySelector("h3")?.textContent).toBe(entry.title);
      }
    }
  });

  it("scrolls to a target, focuses it, and pulses it again on a repeat", async () => {
    setServerConfigSnapshot(createBaseServerConfig());
    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText("Diagnostics", { exact: true })).toBeInTheDocument();

    const target = document.getElementById("setting-math-rendering")!;
    const scrollIntoView = vi.spyOn(target, "scrollIntoView");
    revealSettingsTarget(target);
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(target);
    const firstPulseCount = target.getAnimations().length;
    expect(firstPulseCount).toBe(1);

    revealSettingsTarget(target);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(target.getAnimations().length).toBe(2);
  });

  it("pulses a section's card, which would hide a background on the section", async () => {
    setServerConfigSnapshot(createBaseServerConfig());
    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText("Diagnostics", { exact: true })).toBeInTheDocument();

    const section = document.getElementById("setting-section-git")!;
    revealSettingsTarget(section);
    const card = section.querySelector(":scope > [data-settings-card]")!;
    expect(card.getAnimations().length).toBe(1);
  });
});

describe("GeneralSettingsPanel provider binary path", () => {
  beforeEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    document.body.innerHTML = "";
  });

  async function renderBinaryPath(binaryPath: string) {
    const updateSettings = vi
      .fn<NativeApi["server"]["updateSettings"]>()
      .mockResolvedValue(DEFAULT_SERVER_SETTINGS);
    window.nativeApi = { server: { updateSettings } } as unknown as NativeApi;
    const config = createBaseServerConfig();
    setServerConfigSnapshot({
      ...config,
      settings: {
        ...config.settings,
        providers: {
          ...config.settings.providers,
          claudeAgent: { ...config.settings.providers.claudeAgent, binaryPath },
        },
      },
    });
    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );
    // A custom path opens the details on mount. A click would close them, and the input would then
    // work only until the closing animation unmounts it.
    if (binaryPath === DEFAULT_SERVER_SETTINGS.providers.claudeAgent.binaryPath) {
      await page.getByRole("button", { name: "Toggle Claude details" }).click();
    }
    const input = page.getByRole("textbox", { name: "Claude binary path" });
    await expect.element(input).toBeVisible();
    const savedPaths = () =>
      updateSettings.mock.calls.map(([patch]) => patch.providers?.claudeAgent?.binaryPath);
    return { input, savedPaths };
  }

  it("saves once, trimmed, on blur and not while typing", async () => {
    const { input, savedPaths } = await renderBinaryPath("claude");

    await input.fill("  /opt/my tools/claude  ");
    expect(savedPaths()).toEqual([]);

    (input.element() as HTMLInputElement).blur();
    await vi.waitFor(() => expect(savedPaths()).toEqual(["/opt/my tools/claude"]));
  });

  it("saves on Enter", async () => {
    const { input, savedPaths } = await renderBinaryPath("claude");

    await input.fill("/opt/claude");
    await userEvent.keyboard("{Enter}");
    expect(savedPaths()).toEqual(["/opt/claude"]);
  });

  it("falls back to the default command when cleared", async () => {
    const { input, savedPaths } = await renderBinaryPath("/opt/claude");

    await input.fill("");
    await userEvent.keyboard("{Enter}");
    expect(savedPaths()).toEqual(["claude"]);
    await expect.element(input).toHaveValue("claude");
  });

  it("shows the default again without saving when already on it", async () => {
    const { input, savedPaths } = await renderBinaryPath("claude");

    await input.fill("");
    (input.element() as HTMLInputElement).blur();
    expect(savedPaths()).toEqual([]);
    await expect.element(input).toHaveValue("claude");
  });

  it("reverts on Escape without saving", async () => {
    const { input, savedPaths } = await renderBinaryPath("/opt/claude");

    await input.fill("/somewhere/else");
    await userEvent.keyboard("{Escape}");
    await expect.element(input).toHaveValue("/opt/claude");
    expect(savedPaths()).toEqual([]);
  });
});

describe("GeneralSettingsPanel diagnostics row", () => {
  beforeEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    document.body.innerHTML = "";
  });

  it("opens the Diagnostics tab", async () => {
    setServerConfigSnapshot(createBaseServerConfig());
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        createRoute({
          getParentRoute: () => rootRoute,
          path: "/settings/general",
          component: GeneralSettingsPanel,
        }),
        createRoute({
          getParentRoute: () => rootRoute,
          path: "/settings/diagnostics",
          component: () => <div>Diagnostics tab</div>,
        }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/settings/general"] }),
    });
    await router.load();
    await render(
      <AppAtomRegistryProvider>
        <RouterProvider router={router as never} />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("button", { name: "View diagnostics" }).click();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/settings/diagnostics"));
  });
});
