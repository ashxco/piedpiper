import { describe, expect, it, vi } from "vitest";

import { resolveLinuxDisableFeaturesSwitch } from "./hyprlandColorManager";

const releaseCommits: Record<string, string> = {
  "0.48.0": "5ee35f914f921e5696030698e74fb5566a804768",
  "0.48.1": "29e2e59fdbab8ed2cc23a20e3c6043d5decb5cdc",
  "0.49.0": "9958d297641b5c84dcff93f9039d80a5ad37ab00",
  "0.50.0": "c4a4c341568944bd4fb9cd503558b2de602c0213",
  "0.50.1": "4e242d086e20b32951fdc0ebcbfb4d41b5be8dcc",
};

const hyprctlVersion =
  (version: string, overrides: Record<string, unknown> = {}) =>
  () =>
    JSON.stringify({
      commit: releaseCommits[version] ?? "0123456789abcdef0123456789abcdef01234567",
      version,
      dirty: false,
      tag: `v${version}`,
      flags: [],
      ...overrides,
    });

const brokenHyprland = {
  env: { XDG_CURRENT_DESKTOP: "Hyprland", XDG_SESSION_TYPE: "wayland" } as NodeJS.ProcessEnv,
  ozonePlatform: "wayland" as string | null,
  enableFeatures: null as string | null,
  disableFeatures: null as string | null,
  readHyprctlVersionJson: hyprctlVersion("0.48.1"),
};

describe("resolveLinuxDisableFeaturesSwitch", () => {
  it.each(Object.keys(releaseCommits))("disables the color manager on Hyprland %s", (version) => {
    expect(
      resolveLinuxDisableFeaturesSwitch({
        ...brokenHyprland,
        readHyprctlVersionJson: hyprctlVersion(version),
      }),
    ).toBe("WaylandWpColorManagerV1");
  });

  it.each([{ XDG_CURRENT_DESKTOP: "foo:HYPRLAND" }, { XDG_SESSION_DESKTOP: "hyprland" }])(
    "detects Hyprland from %o",
    (env) => {
      expect(resolveLinuxDisableFeaturesSwitch({ ...brokenHyprland, env })).toBe(
        "WaylandWpColorManagerV1",
      );
    },
  );

  it("merges with existing disabled features", () => {
    expect(
      resolveLinuxDisableFeaturesSwitch({
        ...brokenHyprland,
        disableFeatures: "Vulkan,WaylandWpColorManagerV1Extra",
      }),
    ).toBe("Vulkan,WaylandWpColorManagerV1Extra,WaylandWpColorManagerV1");
  });

  it.each([
    ["0.47.2", hyprctlVersion("0.47.2")],
    ["0.51.0", hyprctlVersion("0.51.0")],
    ["a prerelease", hyprctlVersion("0.49.0-rc1")],
    ["a dev build tag", hyprctlVersion("0.50.1", { tag: "v0.50.1-87-g4e8875b5" })],
    ["a different commit", hyprctlVersion("0.50.1", { commit: "4e8875b5e9700c81ca4e169dc7b85b" })],
    ["another release's commit", hyprctlVersion("0.48.0", { commit: releaseCommits["0.48.1"] })],
    ["a dirty build", hyprctlVersion("0.48.1", { dirty: true })],
    ["missing metadata", () => JSON.stringify({ version: "0.48.1" })],
    ["unparseable output", () => "ok"],
    ["JSON null", () => "null"],
    [
      "a missing hyprctl",
      () => {
        throw new Error("spawnSync hyprctl ENOENT");
      },
    ],
  ])("preserves color management for %s", (_label, readHyprctlVersionJson) => {
    expect(
      resolveLinuxDisableFeaturesSwitch({ ...brokenHyprland, readHyprctlVersionJson }),
    ).toBeNull();
  });

  it.each([
    { env: { XDG_CURRENT_DESKTOP: "KDE", HYPRLAND_INSTANCE_SIGNATURE: "abc_123" } },
    { ozonePlatform: "x11" },
    { ozonePlatform: null },
    { disableFeatures: "Vulkan, WaylandWpColorManagerV1" },
    { enableFeatures: "*WaylandWpColorManagerV1<Study.Group:mode/strict" },
  ])("skips the hyprctl probe for %o", (overrides) => {
    const readHyprctlVersionJson = vi.fn(hyprctlVersion("0.48.1"));
    expect(
      resolveLinuxDisableFeaturesSwitch({
        ...brokenHyprland,
        ...overrides,
        readHyprctlVersionJson,
      }),
    ).toBeNull();
    expect(readHyprctlVersionJson).not.toHaveBeenCalled();
  });
});
