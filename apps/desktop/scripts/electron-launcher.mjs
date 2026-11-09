// This file mostly exists because we want dev mode to say "Pied Piper (Dev)" instead of "electron"

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DISPLAY_NAME = "Pied Piper";
const APP_BUNDLE_ID = "com.piedpiper.app";
const LAUNCHER_VERSION = 3;
export const DEV_ROOT_FLAG = "--piedpiper-dev-root";

// Dev builds get their own bundle id so macOS does not conflate them with an installed release.
export function resolveAppBundleId(development) {
  return development ? `${APP_BUNDLE_ID}.dev` : APP_BUNDLE_ID;
}

export function buildDevRootArgument(rootDir) {
  return `${DEV_ROOT_FLAG}=${rootDir}`;
}

// ERE for `pkill -f` that matches only the exact dev-root argument, not other checkouts sharing a prefix.
export function buildDevRootCleanupPattern(rootDir) {
  const escaped = buildDevRootArgument(rootDir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(^| )${escaped}( |$)`;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
export const desktopDir = resolve(__dirname, "..");

// Separate dev/release bundles so launching one never deletes or rewrites the other's live .app.
export function resolveRuntimeDir(development) {
  return join(desktopDir, ".electron-runtime", development ? "dev" : "release");
}

function setPlistValue(plistPath, key, type, value) {
  const replaceResult = spawnSync("plutil", ["-replace", key, type, value, plistPath], {
    encoding: "utf8",
  });
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = spawnSync("plutil", ["-insert", key, type, value, plistPath], {
    encoding: "utf8",
  });
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function setPlistString(plistPath, key, value) {
  setPlistValue(plistPath, key, "-string", value);
}

export function setPlistBool(plistPath, key, value) {
  setPlistValue(plistPath, key, "-bool", value ? "true" : "false");
}

function patchMainBundleInfoPlist(appBundlePath, iconPath, bundleId) {
  const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");
  setPlistString(infoPlistPath, "CFBundleDisplayName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleIdentifier", bundleId);
  setPlistString(infoPlistPath, "CFBundleIconFile", "icon.icns");
  // macOS 26 offers Messages/Mail codes in every text field unless opted out.
  setPlistBool(infoPlistPath, "NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac", true);

  const resourcesDir = join(appBundlePath, "Contents", "Resources");
  copyFileSync(iconPath, join(resourcesDir, "icon.icns"));
  copyFileSync(iconPath, join(resourcesDir, "electron.icns"));
}

function patchHelperBundleInfoPlists(appBundlePath, bundleId) {
  const frameworksDir = join(appBundlePath, "Contents", "Frameworks");
  if (!existsSync(frameworksDir)) {
    return;
  }

  for (const entry of readdirSync(frameworksDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) {
      continue;
    }
    if (!entry.name.startsWith("Electron Helper")) {
      continue;
    }

    const helperPlistPath = join(frameworksDir, entry.name, "Contents", "Info.plist");
    if (!existsSync(helperPlistPath)) {
      continue;
    }

    const suffix = entry.name.replace("Electron Helper", "").replace(".app", "").trim();
    const helperName = suffix
      ? `${APP_DISPLAY_NAME} Helper ${suffix}`
      : `${APP_DISPLAY_NAME} Helper`;
    const helperIdSuffix = suffix.replace(/[()]/g, "").trim().toLowerCase().replace(/\s+/g, "-");
    const helperBundleId = helperIdSuffix
      ? `${bundleId}.helper.${helperIdSuffix}`
      : `${bundleId}.helper`;

    setPlistString(helperPlistPath, "CFBundleDisplayName", helperName);
    setPlistString(helperPlistPath, "CFBundleName", helperName);
    setPlistString(helperPlistPath, "CFBundleIdentifier", helperBundleId);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function buildMacLauncher(electronBinaryPath, development) {
  const bundleId = resolveAppBundleId(development);
  const sourceAppBundlePath = resolve(electronBinaryPath, "../../..");
  const runtimeDir = resolveRuntimeDir(development);
  const targetAppBundlePath = join(runtimeDir, `${APP_DISPLAY_NAME}.app`);
  const targetBinaryPath = join(targetAppBundlePath, "Contents", "MacOS", "Electron");
  const iconPath = join(desktopDir, "resources", "icon.icns");
  const metadataPath = join(runtimeDir, "metadata.json");

  mkdirSync(runtimeDir, { recursive: true });

  const expectedMetadata = {
    launcherVersion: LAUNCHER_VERSION,
    bundleId,
    sourceAppBundlePath,
    sourceAppMtimeMs: statSync(sourceAppBundlePath).mtimeMs,
    iconMtimeMs: statSync(iconPath).mtimeMs,
  };

  const currentMetadata = readJson(metadataPath);
  if (
    existsSync(targetBinaryPath) &&
    currentMetadata &&
    JSON.stringify(currentMetadata) === JSON.stringify(expectedMetadata)
  ) {
    return targetBinaryPath;
  }

  rmSync(targetAppBundlePath, { recursive: true, force: true });
  // verbatimSymlinks keeps the framework's relative symlinks; rewritten absolute ones escape the bundle and crash sandboxed helpers.
  cpSync(sourceAppBundlePath, targetAppBundlePath, { recursive: true, verbatimSymlinks: true });
  patchMainBundleInfoPlist(targetAppBundlePath, iconPath, bundleId);
  patchHelperBundleInfoPlists(targetAppBundlePath, bundleId);
  writeFileSync(metadataPath, `${JSON.stringify(expectedMetadata, null, 2)}\n`);

  return targetBinaryPath;
}

export function isLinuxSandboxHelperConfigured(helperStat) {
  return helperStat.uid === 0 && (helperStat.mode & 0o4777) === 0o4755;
}

let warnedAboutLinuxSandbox = false;

// Hosts that block user namespaces fall back to chrome-sandbox, which a package install leaves unconfigured.
export function resolveLinuxSandboxArgs(electronBinaryPath, platform = process.platform) {
  if (platform !== "linux") {
    return [];
  }

  try {
    if (
      isLinuxSandboxHelperConfigured(statSync(join(dirname(electronBinaryPath), "chrome-sandbox")))
    ) {
      return [];
    }
  } catch {
    // A missing helper is reported the same way as a misconfigured one.
  }

  if (!warnedAboutLinuxSandbox) {
    warnedAboutLinuxSandbox = true;
    console.warn(
      "[desktop-launcher] Electron chrome-sandbox is not root-owned with mode 4755; launching local Electron with --no-sandbox.",
    );
  }
  return ["--no-sandbox"];
}

export function resolveElectronPath({ development = false } = {}) {
  const require = createRequire(import.meta.url);
  const electronBinaryPath = require("electron");

  if (process.platform !== "darwin") {
    return electronBinaryPath;
  }

  return buildMacLauncher(electronBinaryPath, development);
}

export function resolveElectronLaunchCommand(args = [], options = {}) {
  const electronPath = resolveElectronPath(options);
  return { electronPath, args: [...resolveLinuxSandboxArgs(electronPath), ...args] };
}
