export const LINUX_DEVICE_SCALE_FACTOR_SWITCH = "force-device-scale-factor";

export interface LinuxDeviceScaleFactorCommandLine {
  readonly hasSwitch: (name: string) => boolean;
  readonly getSwitchValue: (name: string) => string;
  readonly appendSwitch: (name: string, value: string) => void;
}

export function isValidDeviceScaleFactor(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0;
}

/** Remembers an explicit Chromium scale across AppImage updates, which relaunch without arguments. */
export function restoreLinuxDeviceScaleFactor(input: {
  readonly commandLine: LinuxDeviceScaleFactorCommandLine;
  readonly statePath: string;
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, value: string) => void;
}): void {
  const { commandLine, statePath } = input;
  if (commandLine.hasSwitch(LINUX_DEVICE_SCALE_FACTOR_SWITCH)) {
    const value = commandLine.getSwitchValue(LINUX_DEVICE_SCALE_FACTOR_SWITCH).trim();
    if (!isValidDeviceScaleFactor(value)) return;
    try {
      input.writeFile(statePath, value);
    } catch {
      // A read-only state directory must not block startup with the explicit switch.
    }
    return;
  }
  try {
    const value = input.readFile(statePath).trim();
    if (isValidDeviceScaleFactor(value)) {
      commandLine.appendSwitch(LINUX_DEVICE_SCALE_FACTOR_SWITCH, value);
    }
  } catch {
    // Missing or unreadable state keeps Chromium's default scaling.
  }
}
