import { describe, expect, it } from "vitest";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@piedpiper/contracts";

import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDisabledReason,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("shows a download action when an update is available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("keeps install action available after an install error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("prefers install when a downloaded version already exists", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
  });

  it("offers install only when the main process would accept it", () => {
    const queued = { availableVersion: "1.1.0", downloadedVersion: "1.1.0" };
    expect(resolveDesktopUpdateButtonAction({ ...baseState, ...queued, status: "checking" })).toBe(
      "none",
    );
    for (const errorContext of [null, "install"] as const) {
      expect(
        resolveDesktopUpdateButtonAction({
          ...baseState,
          ...queued,
          status: "error",
          errorContext,
        }),
      ).toBe("install");
    }
    expect(
      resolveDesktopUpdateButtonAction({
        ...baseState,
        ...queued,
        status: "error",
        errorContext: "download",
      }),
    ).toBe("download");
  });

  it("hides the button for non-actionable check errors", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "network unavailable",
      errorContext: "check",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });

  it("disables the button while downloading", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 42.5,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
    expect(getDesktopUpdateButtonTooltip(state)).toContain("42%");
  });
});

describe("getDesktopUpdateActionError", () => {
  it("returns user-visible message for accepted failed attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        message: "checksum mismatch",
        errorContext: "download",
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBe("checksum mismatch");
  });

  it("ignores messages for non-accepted attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: false,
      completed: false,
      state: {
        ...baseState,
        status: "error",
        message: "background failure",
        errorContext: "check",
        canRetry: false,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });

  it("ignores messages for successful attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: true,
      state: {
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        availableVersion: "1.1.0",
        message: null,
        errorContext: null,
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });
});

describe("desktop update UI helpers", () => {
  it("toasts only for actionable updater errors", () => {
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: "checksum mismatch" },
      }),
    ).toBe(true);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: null },
      }),
    ).toBe(false);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: true,
        state: { ...baseState, message: "checksum mismatch" },
      }),
    ).toBe(false);
  });

  it("shows an Apple Silicon warning for Intel builds under Rosetta", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
    };

    expect(shouldShowArm64IntelBuildWarning(state)).toBe(true);
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Apple Silicon");
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Intel build");
  });

  it("changes the warning copy when a native build update is ready to download", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
      status: "available",
      availableVersion: "1.1.0",
    };

    expect(getArm64IntelBuildWarningDescription(state)).toContain("Download the available update");
  });

  it("includes the downloaded version in the install confirmation copy", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.1",
      }),
    ).toContain("Install update 1.1.1 and restart Pied Piper?");
  });

  it("falls back to generic install confirmation copy when no version is available", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: null,
        downloadedVersion: null,
      }),
    ).toContain("Install update and restart Pied Piper?");
  });

  it("promises running tasks continue only when the setting is on", () => {
    const state = { availableVersion: "1.1.0", downloadedVersion: "1.1.0" };
    const on = getDesktopUpdateInstallConfirmationMessage(state, "MacIntel", {
      continueThreadsAfterRestart: true,
    });
    expect(on).toContain("continue when Pied Piper restarts");
    expect(on).not.toContain("will be interrupted");
    for (const message of [
      getDesktopUpdateInstallConfirmationMessage(state, "MacIntel"),
      getDesktopUpdateInstallConfirmationMessage(state, "MacIntel", {
        continueThreadsAfterRestart: false,
      }),
    ]) {
      expect(message).toContain("will be interrupted");
      expect(message).not.toContain("continue when Pied Piper restarts");
    }
  });

  it("warns Windows users that the silent installer may keep the app closed", () => {
    const state = { availableVersion: "1.1.0", downloadedVersion: "1.1.0" };
    expect(getDesktopUpdateInstallConfirmationMessage(state, "Win32")).toContain(
      "may remain closed for several minutes",
    );
    expect(getDesktopUpdateInstallConfirmationMessage(state, "MacIntel")).not.toContain(
      "may remain closed for several minutes",
    );
    expect(getDesktopUpdateInstallConfirmationMessage(state)).not.toContain(
      "may remain closed for several minutes",
    );
  });
});

describe("canCheckForUpdate", () => {
  it("returns false for null state", () => {
    expect(canCheckForUpdate(null)).toBe(false);
  });

  it("returns false when updates are disabled", () => {
    expect(canCheckForUpdate({ ...baseState, enabled: false, status: "disabled" })).toBe(false);
  });

  it("returns false while checking", () => {
    expect(canCheckForUpdate({ ...baseState, status: "checking" })).toBe(false);
  });

  it("returns false while downloading", () => {
    expect(canCheckForUpdate({ ...baseState, status: "downloading", downloadPercent: 50 })).toBe(
      false,
    );
  });

  it("returns true while a downloaded update waits, so newer releases are still found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });

  it("returns true when idle", () => {
    expect(canCheckForUpdate({ ...baseState, status: "idle" })).toBe(true);
  });

  it("returns true when up-to-date", () => {
    expect(canCheckForUpdate({ ...baseState, status: "up-to-date" })).toBe(true);
  });

  it("returns true when an update is available", () => {
    expect(
      canCheckForUpdate({ ...baseState, status: "available", availableVersion: "1.1.0" }),
    ).toBe(true);
  });

  it("returns true on error so the user can retry", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "error",
        errorContext: "check",
        message: "network",
      }),
    ).toBe(true);
  });
});

describe("getDesktopUpdateButtonTooltip", () => {
  it("returns 'Up to date' for non-actionable states", () => {
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "idle" })).toBe("Up to date");
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "up-to-date" })).toBe(
      "Up to date",
    );
  });

  it("keeps offering a queued update after a background error", () => {
    expect(
      getDesktopUpdateButtonTooltip({
        ...baseState,
        status: "error",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        message: "background failure",
      }),
    ).toBe("Update 1.1.0 downloaded. Click to restart and install.");
  });

  describe("after an install that did not apply", () => {
    const notApplied = (overrides: Partial<DesktopUpdateState>) => {
      const state = { ...baseState, notAppliedVersion: "1.1.0", ...overrides };
      return getDesktopUpdateButtonTooltip(state);
    };

    it("says so when the same version is offered again", () => {
      const message = "Update 1.1.0 did not apply. Click to retry.";
      expect(notApplied({ status: "available", availableVersion: "1.1.0" })).toBe(message);
      expect(
        notApplied({ status: "downloaded", availableVersion: "1.1.0", downloadedVersion: "1.1.0" }),
      ).toBe(message);
    });

    it("uses the normal tooltip for a newer version and for other statuses", () => {
      expect(notApplied({ status: "available", availableVersion: "1.2.0" })).toBe(
        "Update 1.2.0 ready to download",
      );
      expect(
        notApplied({ status: "downloaded", availableVersion: "1.2.0", downloadedVersion: "1.2.0" }),
      ).toContain("1.2.0 downloaded");
      expect(notApplied({ status: "idle" })).toBe("Up to date");
    });
  });
});

describe("getDesktopUpdateDisabledReason", () => {
  it("returns the reason when updates are disabled", () => {
    expect(
      getDesktopUpdateDisabledReason({
        ...baseState,
        enabled: false,
        status: "disabled",
        message: "Automatic updates are not available in development builds.",
      }),
    ).toBe("Automatic updates are not available in development builds.");
  });

  it("returns null for other statuses and a missing state", () => {
    expect(getDesktopUpdateDisabledReason(null)).toBeNull();
    expect(
      getDesktopUpdateDisabledReason({ ...baseState, status: "idle", message: "x" }),
    ).toBeNull();
    expect(
      getDesktopUpdateDisabledReason({ ...baseState, status: "error", message: "x" }),
    ).toBeNull();
  });

  it("keeps the disabled tooltip from claiming the app is up to date", () => {
    const disabled: DesktopUpdateState = { ...baseState, enabled: false, status: "disabled" };
    expect(getDesktopUpdateButtonTooltip(disabled)).toBe("Updates unavailable");
    expect(
      getDesktopUpdateButtonTooltip({ ...disabled, message: "No update feed configured." }),
    ).toBe("No update feed configured.");
  });
});
