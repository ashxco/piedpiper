import type { ServerProvider } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import { getProviderVersionUpdate, getUpdatesWithoutCard } from "./providerVersionUpdate.logic";

const provider: ServerProvider = {
  provider: "claudeAgent",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
};

const withAdvisory = (versionAdvisory: object) =>
  ({ ...provider, versionAdvisory }) as ServerProvider;

describe("getProviderVersionUpdate", () => {
  it("returns the update only for a CLI behind the latest version", () => {
    expect(
      getProviderVersionUpdate(
        withAdvisory({
          status: "behind_latest",
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
          updateCommand: "claude update",
        }),
      ),
    ).toEqual({ latestVersion: "2.0.0", updateCommand: "claude update" });
  });

  it("keeps a manual-only update", () => {
    expect(
      getProviderVersionUpdate(
        withAdvisory({
          status: "behind_latest",
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
          updateCommand: null,
        }),
      ),
    ).toEqual({ latestVersion: "2.0.0", updateCommand: null });
  });

  it("says nothing when current, unknown or absent", () => {
    for (const status of ["current", "unknown"]) {
      expect(
        getProviderVersionUpdate(
          withAdvisory({
            status,
            currentVersion: "1.0.0",
            latestVersion: "1.0.0",
            updateCommand: "claude update",
          }),
        ),
      ).toBeNull();
    }
    expect(getProviderVersionUpdate(provider)).toBeNull();
    expect(getProviderVersionUpdate(undefined)).toBeNull();
  });
});

const behind = (candidate: ServerProvider): ServerProvider => ({
  ...candidate,
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    updateCommand: null,
  },
});

describe("getUpdatesWithoutCard", () => {
  it("lists only providers without a card that are behind", () => {
    const codex: ServerProvider = { ...provider, provider: "codex" };
    expect(getUpdatesWithoutCard([behind(provider), behind(codex)], ["claudeAgent"])).toEqual([
      { provider: "codex", update: { latestVersion: "2.0.0", updateCommand: null } },
    ]);
    expect(getUpdatesWithoutCard([codex], ["claudeAgent"])).toEqual([]);
  });
});
