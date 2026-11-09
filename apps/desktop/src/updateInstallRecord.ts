import * as FS from "node:fs";
import * as Path from "node:path";

import type { DesktopUpdateInstallRecord } from "./updateMachine";

/** Saved before an install quits the app and read on the next start to see whether it applied. */
export const DESKTOP_UPDATE_INSTALL_RECORD_FILE = "desktop-update-install.json";

function isInstallRecord(value: unknown): value is DesktopUpdateInstallRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "fromVersion" in value &&
    typeof value.fromVersion === "string" &&
    "targetVersion" in value &&
    typeof value.targetVersion === "string"
  );
}

/** Best effort: a missing record only loses the "did not apply" hint, so it never blocks an install. */
export function writeUpdateInstallRecord(
  filePath: string,
  record: DesktopUpdateInstallRecord,
): void {
  try {
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    FS.writeFileSync(filePath, `${JSON.stringify(record)}\n`);
  } catch (error) {
    console.warn("[desktop-updater] Could not record the update install.", error);
  }
}

export function readUpdateInstallRecord(filePath: string): DesktopUpdateInstallRecord | null {
  try {
    const parsed: unknown = JSON.parse(FS.readFileSync(filePath, "utf8"));
    return isInstallRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function removeUpdateInstallRecord(filePath: string): void {
  try {
    FS.rmSync(filePath, { force: true });
  } catch (error) {
    console.warn("[desktop-updater] Could not remove the update install record.", error);
  }
}
