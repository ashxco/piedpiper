import { describe, expect, it } from "vitest";

import {
  canInstallDownloadedUpdate,
  createConfiguredDesktopUpdateState,
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
  resolveNotAppliedInstallVersion,
} from "./updateMachine";

const runtimeInfo = {
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
} as const;

describe("updateMachine", () => {
  it("keeps the disabled reason as the message when updates are disabled", () => {
    const state = createConfiguredDesktopUpdateState(
      "1.0.0",
      runtimeInfo,
      "Automatic updates are only available in packaged production builds.",
    );

    expect(state.enabled).toBe(false);
    expect(state.status).toBe("disabled");
    expect(state.message).toBe(
      "Automatic updates are only available in packaged production builds.",
    );
  });

  it("starts idle with no message when updates are enabled", () => {
    const state = createConfiguredDesktopUpdateState("1.0.0", runtimeInfo, null);

    expect(state.enabled).toBe(true);
    expect(state.status).toBe("idle");
    expect(state.message).toBeNull();
  });

  it("clears transient errors when a check starts", () => {
    const state = reduceDesktopUpdateStateOnCheckStart(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
        enabled: true,
        status: "error",
        message: "network",
        errorContext: "check",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("checking");
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
    expect(state.canRetry).toBe(false);
  });

  it("records a check failure without exposing an action", () => {
    const state = reduceDesktopUpdateStateOnCheckFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
        enabled: true,
        status: "checking",
      },
      "network unavailable",
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("error");
    expect(state.errorContext).toBe("check");
    expect(state.canRetry).toBe(true);
  });

  it("preserves available version on download failure for retry", () => {
    const state = reduceDesktopUpdateStateOnDownloadFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
        downloadPercent: 43,
      },
      "checksum mismatch",
    );

    expect(state.status).toBe("available");
    expect(state.availableVersion).toBe("1.1.0");
    expect(state.errorContext).toBe("download");
    expect(state.canRetry).toBe(true);
  });

  it("transitions to downloaded and then preserves install retry state", () => {
    const downloaded = reduceDesktopUpdateStateOnDownloadComplete(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
      },
      "1.1.0",
    );
    const failedInstall = reduceDesktopUpdateStateOnInstallFailure(
      downloaded,
      "backend shutdown timed out",
    );

    expect(downloaded.status).toBe("downloaded");
    expect(downloaded.downloadedVersion).toBe("1.1.0");
    expect(failedInstall.status).toBe("error");
    expect(failedInstall.errorContext).toBe("install");
    expect(failedInstall.message).toBe("backend shutdown timed out");
    expect(failedInstall.downloadedVersion).toBe("1.1.0");
    expect(failedInstall.canRetry).toBe(true);
    expect(canInstallDownloadedUpdate(failedInstall)).toBe(true);
  });

  it("holds an install back during a check until waiting for it is over", () => {
    const downloaded = reduceDesktopUpdateStateOnDownloadComplete(
      createConfiguredDesktopUpdateState("1.0.0", runtimeInfo, null),
      "1.1.0",
    );
    const checking = reduceDesktopUpdateStateOnCheckStart(downloaded, "2026-01-01T00:00:00.000Z");

    expect(canInstallDownloadedUpdate(checking)).toBe(false);
    expect(canInstallDownloadedUpdate(checking, { checkStillRunning: true })).toBe(true);
    expect(
      canInstallDownloadedUpdate(reduceDesktopUpdateStateOnDownloadStart(downloaded), {
        checkStillRunning: true,
      }),
    ).toBe(false);
  });

  it("clears stale availability when no update is available and nothing is queued", () => {
    const state = reduceDesktopUpdateStateOnNoUpdate(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
        enabled: true,
        status: "error",
        availableVersion: "1.1.0",
        downloadedVersion: null,
        message: "old failure",
        errorContext: "download",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("up-to-date");
    expect(state.availableVersion).toBeNull();
    expect(state.downloadedVersion).toBeNull();
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
  });

  it("tracks available, download start, and progress cleanly", () => {
    const available = reduceDesktopUpdateStateOnUpdateAvailable(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
        enabled: true,
        status: "checking",
      },
      "1.1.0",
      "2026-03-04T00:00:00.000Z",
    );
    const downloading = reduceDesktopUpdateStateOnDownloadStart(available);
    const progress = reduceDesktopUpdateStateOnDownloadProgress(downloading, 55.5);

    expect(available.status).toBe("available");
    expect(downloading.status).toBe("downloading");
    expect(downloading.downloadPercent).toBe(0);
    expect(progress.downloadPercent).toBe(55.5);
    expect(progress.errorContext).toBeNull();
  });
});

describe("updateMachine with a queued download", () => {
  const checkedAt = "2026-03-04T00:00:00.000Z";
  const queued = {
    ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
    enabled: true,
    status: "downloaded",
    availableVersion: "1.1.0",
    downloadedVersion: "1.1.0",
    downloadPercent: 100,
    canRetry: true,
  } as const;

  it("keeps the queued version while a check runs", () => {
    const state = reduceDesktopUpdateStateOnCheckStart(queued, checkedAt);

    expect(state.status).toBe("checking");
    expect(state.downloadedVersion).toBe("1.1.0");
    expect(state.downloadPercent).toBe(100);
    expect(canInstallDownloadedUpdate(state)).toBe(false);
  });

  it("returns to downloaded when the check finds nothing", () => {
    const state = reduceDesktopUpdateStateOnNoUpdate(
      reduceDesktopUpdateStateOnCheckStart(queued, checkedAt),
      checkedAt,
    );

    expect(state).toMatchObject({
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
      canRetry: true,
    });
  });

  it("returns to downloaded without an error when the check fails", () => {
    const state = reduceDesktopUpdateStateOnCheckFailure(
      reduceDesktopUpdateStateOnCheckStart(queued, checkedAt),
      "network unavailable",
      checkedAt,
    );

    expect(state).toMatchObject({
      status: "downloaded",
      downloadedVersion: "1.1.0",
      message: null,
      errorContext: null,
      canRetry: true,
    });
  });

  it("keeps the download when the feed offers the same version again", () => {
    const state = reduceDesktopUpdateStateOnUpdateAvailable(
      reduceDesktopUpdateStateOnCheckStart(queued, checkedAt),
      "1.1.0",
      checkedAt,
    );

    expect(state).toMatchObject({
      status: "downloaded",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
      canRetry: true,
    });
  });

  it("drops the download when a newer version appears", () => {
    const state = reduceDesktopUpdateStateOnUpdateAvailable(
      reduceDesktopUpdateStateOnCheckStart(queued, checkedAt),
      "1.2.0",
      checkedAt,
    );

    expect(state).toMatchObject({
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: null,
      downloadPercent: null,
      canRetry: false,
    });
  });
});

describe("canInstallDownloadedUpdate", () => {
  const base = {
    ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
    enabled: true,
    availableVersion: "1.1.0",
    downloadedVersion: "1.1.0",
  } as const;

  it.each([
    ["downloaded", null, true],
    ["error", null, true],
    ["error", "install", true],
    ["error", "check", false],
    ["error", "download", false],
    ["checking", null, false],
    ["downloading", null, false],
  ] as const)("with status %s and context %s returns %s", (status, errorContext, expected) => {
    expect(canInstallDownloadedUpdate({ ...base, status, errorContext })).toBe(expected);
  });

  it("refuses when nothing has been downloaded", () => {
    expect(
      canInstallDownloadedUpdate({ ...base, status: "downloaded", downloadedVersion: null }),
    ).toBe(false);
  });
});

describe("resolveNotAppliedInstallVersion", () => {
  const record = { fromVersion: "1.2.3", targetVersion: "1.2.4" };

  it("flags the target when the app came back on the version it installed from", () => {
    expect(resolveNotAppliedInstallVersion(record, "1.2.3")).toBe("1.2.4");
  });

  it("stays quiet when the install applied or the app runs another version", () => {
    expect(resolveNotAppliedInstallVersion(record, "1.2.4")).toBeNull();
    expect(resolveNotAppliedInstallVersion(record, "1.2.5")).toBeNull();
  });

  it("stays quiet for a record that targets the running version", () => {
    expect(
      resolveNotAppliedInstallVersion({ fromVersion: "1.2.3", targetVersion: "1.2.3" }, "1.2.3"),
    ).toBeNull();
  });
});

describe("notAppliedVersion", () => {
  const checkedAt = "2026-03-04T00:00:00.000Z";

  it("is absent unless the last install did not apply", () => {
    expect(createConfiguredDesktopUpdateState("1.0.0", runtimeInfo, null)).not.toHaveProperty(
      "notAppliedVersion",
    );
  });

  it("survives every reducer of a session", () => {
    const configured = createConfiguredDesktopUpdateState("1.0.0", runtimeInfo, null, "1.1.0");
    const steps = [
      (state: typeof configured) => reduceDesktopUpdateStateOnCheckStart(state, checkedAt),
      (state: typeof configured) => reduceDesktopUpdateStateOnCheckFailure(state, "x", checkedAt),
      (state: typeof configured) =>
        reduceDesktopUpdateStateOnUpdateAvailable(state, "1.1.0", checkedAt),
      reduceDesktopUpdateStateOnDownloadStart,
      (state: typeof configured) => reduceDesktopUpdateStateOnDownloadProgress(state, 50),
      (state: typeof configured) => reduceDesktopUpdateStateOnDownloadFailure(state, "x"),
      (state: typeof configured) => reduceDesktopUpdateStateOnDownloadComplete(state, "1.1.0"),
      (state: typeof configured) => reduceDesktopUpdateStateOnInstallFailure(state, "x"),
      (state: typeof configured) => reduceDesktopUpdateStateOnNoUpdate(state, checkedAt),
    ];

    let state = configured;
    for (const step of steps) {
      state = step(state);
      expect(state).toHaveProperty("notAppliedVersion", "1.1.0");
    }
  });
});
