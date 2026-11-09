import type { DesktopUpdateState } from "@piedpiper/contracts";
import type { MessageBoxOptions } from "electron";

export function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number,
): boolean {
  if (currentState.status !== "downloading") {
    return true;
  }

  const currentPercent = currentState.downloadPercent;
  if (currentPercent === null) {
    return true;
  }

  const previousStep = Math.floor(currentPercent / 10);
  const nextStep = Math.floor(nextPercent / 10);
  return nextStep !== previousStep || nextPercent === 100;
}

export function nextStatusAfterDownloadFailure(
  currentState: DesktopUpdateState,
): DesktopUpdateState["status"] {
  return currentState.availableVersion ? "available" : "error";
}

export function getCanRetryAfterDownloadFailure(currentState: DesktopUpdateState): boolean {
  return currentState.availableVersion !== null;
}

export function getAutoUpdateDisabledReason(args: {
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
}): string | null {
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the PIEDPIPER_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage) {
    return "Automatic updates on Linux require running the AppImage build.";
  }
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured for this build.";
  }
  return null;
}

/** What a Check for Updates menu click reports once the check settled; the sidebar shows the rest. */
export function resolveUpdateCheckMenuDialog(state: DesktopUpdateState): MessageBoxOptions | null {
  if (state.status === "up-to-date") {
    return {
      type: "info",
      title: "You're up to date!",
      message: `Pied Piper ${state.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    };
  }
  if (state.status === "downloaded") {
    return {
      type: "info",
      title: "Update ready to install",
      message: `Pied Piper ${state.downloadedVersion ?? "update"} has already been downloaded.`,
      detail: "Use the update button in the sidebar to restart and install it.",
      buttons: ["OK"],
    };
  }
  if (state.status === "error") {
    return {
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: state.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    };
  }
  return null;
}
