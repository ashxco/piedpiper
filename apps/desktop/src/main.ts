import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  app,
  autoUpdater as electronAutoUpdater,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  shell,
  systemPreferences,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import * as Effect from "effect/Effect";
import {
  DEFAULT_QUIT_CONFIRMATION_MODE,
  type DesktopTheme,
  type DesktopUpdateActionResult,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
  type QuitConfirmationMode,
} from "@piedpiper/contracts";
import { autoUpdater } from "electron-updater";

import type { ContextMenuItem } from "@piedpiper/contracts";
import { NetService } from "@piedpiper/shared/Net";
import { RotatingFileSink } from "@piedpiper/shared/logging";
import { parsePersistedServerObservabilitySettings } from "@piedpiper/shared/serverSettings";
import {
  BACKEND_QUIT_STOP_TIMEOUT_MS,
  BACKEND_TERMINATE_GRACE_MS,
  createBackendRestartBackoff,
  createOutputTail,
  createStateDirOwnedRetry,
  formatBackendFailureDetail,
  formatBackendStateDirOwnedDetail,
  resolveBackendExitAction,
  resolveBackendStateDir,
  isBackendCrashLooping,
  terminateChildAndWaitForExit,
} from "./backendLifecycle";
import { buildApplicationMenuTemplate } from "./applicationMenu";
import { normalizeBadgeCount } from "./badgeCount";
import { shouldBlockRepeatedCloseShortcut } from "./closeShortcutGuard";
import { buildEditContextMenuTemplate, resolveContextMenuPopupPosition } from "./contextMenu";
import { showDesktopConfirmDialog } from "./confirmDialog";
import { resolveLinuxDisableFeaturesSwitch } from "./hyprlandColorManager";
import { createThemeSourceController } from "./linuxColorScheme";
import { restoreLinuxDeviceScaleFactor } from "./linuxDeviceScaleFactor";
import { isAllowedRendererNavigation } from "./navigationGuard";
import { createQuitController, createQuitGuard, ignoreEpipeErrors } from "./quitLifecycle";
import {
  QUIT_SHORTCUT_HINT_CHANNEL,
  SET_QUIT_CONFIRMATION_MODE_CHANNEL,
  concealPendingQuitWindow,
  isQuitConfirmationMode,
  makeQuitShortcutHandler,
} from "./quitShortcutGuard";
import {
  RENDERER_RECOVERY_RELOAD_DELAY_MS,
  createRendererRecoveryPolicy,
} from "./rendererRecovery";
import { createShellEnvironmentSync } from "./syncShellEnvironment";
import {
  getAutoUpdateDisabledReason,
  resolveUpdateCheckMenuDialog,
  shouldBroadcastDownloadProgress,
} from "./updateState";
import {
  DESKTOP_UPDATE_INSTALL_RECORD_FILE,
  readUpdateInstallRecord,
  removeUpdateInstallRecord,
  writeUpdateInstallRecord,
} from "./updateInstallRecord";
import {
  createUpdateInstallRecovery,
  startUpdaterHandoff,
  waitUntilSettled,
} from "./updateInstallRecovery";
import { installSignatureCheckRetry } from "./updateSignatureRetry";
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
import { isArm64HostRunningIntelBuild, resolveDesktopRuntimeInfo } from "./runtimeArch";
import {
  GET_WINDOW_FULLSCREEN_STATE_CHANNEL,
  forwardWindowFullscreenState,
} from "./windowFullscreen";
import { GET_SYSTEM_LOCALE_CHANNEL, resolveSystemLocaleTag } from "./systemLocale";
import { installWindowInputGestures } from "./windowInputGestures";
import {
  bindFirstRevealTrigger,
  makeRevealWindowHandler,
  raiseWindow,
  type RevealSubscription,
} from "./windowReveal";
import {
  SYNC_WINDOW_BUTTONS_CHANNEL,
  getWindowTitleBarOptions,
  syncMacosWindowButtons,
  syncWindowTitleBarTheme,
} from "./windowTitleBar";
import {
  MAIN_WINDOW_MIN_SIZE,
  createWindowStatePersister,
  readWindowState,
  resolveInitialWindowBounds,
  type WindowStatePersister,
} from "./windowState";

ignoreEpipeErrors(process.stdout);
ignoreEpipeErrors(process.stderr);

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const PICK_PROJECT_FAVICON_CHANNEL = "desktop:pick-project-favicon";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
const GET_WS_URL_CHANNEL = "desktop:get-ws-url";
const SET_BADGE_COUNT_CHANNEL = "desktop:set-badge-count";
const REVEAL_WINDOW_CHANNEL = "desktop:reveal-window";
const BASE_DIR = process.env.PIEDPIPER_HOME?.trim() || Path.join(OS.homedir(), ".piedpiper");
const STATE_DIR = Path.join(BASE_DIR, "userdata");
const DESKTOP_SCHEME = "piedpiper";
const ROOT_DIR = Path.resolve(__dirname, "../../..");
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const BACKEND_STATE_DIR = resolveBackendStateDir(BASE_DIR, isDevelopment);
const APP_DISPLAY_NAME = isDevelopment ? "Pied Piper (Dev)" : "Pied Piper";
const APP_USER_MODEL_ID = "com.piedpiper.app";
const LINUX_DESKTOP_ENTRY_NAME = isDevelopment ? "piedpiper-dev.desktop" : "piedpiper.desktop";
const LINUX_WM_CLASS = isDevelopment ? "piedpiper-dev" : "piedpiper";
const USER_DATA_DIR_NAME = isDevelopment ? "piedpiper-dev" : "piedpiper";

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const LOG_DIR = Path.join(STATE_DIR, "logs");
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");
const SERVER_SETTINGS_PATH = Path.join(STATE_DIR, "settings.json");
const WINDOW_STATE_PATH = Path.join(STATE_DIR, "window-state.json");
const DESKTOP_APP_URL = `${DESKTOP_SCHEME}://app/index.html`;
const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const INSTALL_UPDATE_CHECK_WAIT_MS = 5_000;
const DESKTOP_UPDATE_CHANNEL = "latest";
const DESKTOP_UPDATE_ALLOW_PRERELEASE = false;
const SHELL_ENVIRONMENT_RESTART_WINDOW_MS = 5_000;

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];
type LinuxDesktopNamedApp = Electron.App & {
  setDesktopName?: (desktopName: string) => void;
};

let mainWindow: BrowserWindow | null = null;
let mainWindowStatePersister: WindowStatePersister | null = null;
let backendProcess: ChildProcess.ChildProcess | null = null;
let backendStopInFlight: Promise<string> | null = null;
let backendPort = 0;
let backendAuthToken = "";
let backendWsUrl = "";
const backendRestartBackoff = createBackendRestartBackoff();
const backendOutputTail = createOutputTail();
const backendStateDirOwnedRetry = createStateDirOwnedRetry();
let backendFailureDialogOpen = false;
// Pushed by the renderer from its client settings; the default applies until the first push.
let quitConfirmationMode: QuitConfirmationMode = DEFAULT_QUIT_CONFIRMATION_MODE;
const quitGuard = createQuitGuard();
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;
let bootstrapComplete = false;
let desktopProtocolRegistered = false;
let aboutCommitHashCache: string | null | undefined;
let desktopLogSink: RotatingFileSink | null = null;
let backendLogSink: RotatingFileSink | null = null;
let restoreStdIoCapture: (() => void) | null = null;
let backendObservabilitySettings = readPersistedBackendObservabilitySettings();

let destructiveMenuIconCache: Electron.NativeImage | null | undefined;
const expectedBackendExitChildren = new WeakSet<ChildProcess.ChildProcess>();
const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
  platform: process.platform,
  processArch: process.arch,
  runningUnderArm64Translation: app.runningUnderARM64Translation === true,
});
const initialUpdateState = (): DesktopUpdateState =>
  createInitialDesktopUpdateState(app.getVersion(), desktopRuntimeInfo);

// Override Electron's userData path before the `ready` event so that
// Chromium session data uses a filesystem-friendly directory name.
// Must be called synchronously at the top level — before `app.whenReady()`.
app.setPath("userData", resolveUserDataPath());

// The lock is keyed by userData, so it must follow setPath. A second instance would
// start a second backend on the same SQLite database; hand off to the running one instead.
// It runs before shell probing and log setup so a second instance quits fast and leaves the log alone.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
// Last launch's login-shell env is applied now; the probe itself runs in the background after bootstrap.
const shellEnvironmentSync = createShellEnvironmentSync({
  cachePath: Path.join(app.getPath("userData"), "shell-environment.json"),
});
let shellEnvironmentReady = false;
// Only a hydrated env lets the backend skip its own login-shell probe.
let shellEnvironmentHydrated = false;
let backendStartedAtMs = 0;
if (hasSingleInstanceLock) {
  shellEnvironmentReady = shellEnvironmentSync.applyCached();
  shellEnvironmentHydrated = shellEnvironmentReady;
  initializePackagedLogging();
} else {
  console.warn(
    "[desktop] another Pied Piper instance already owns this profile; handing off and exiting",
  );
  isQuitting = true;
  quitGuard.allow();
  app.quit();
}

function logTimestamp(): string {
  return new Date().toISOString();
}

function logScope(scope: string): string {
  return `${scope} run=${APP_RUN_ID}`;
}

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function readPersistedBackendObservabilitySettings(): {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
  readonly otlpLogsUrl: string | undefined;
} {
  try {
    if (!FS.existsSync(SERVER_SETTINGS_PATH)) {
      return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined, otlpLogsUrl: undefined };
    }
    return parsePersistedServerObservabilitySettings(FS.readFileSync(SERVER_SETTINGS_PATH, "utf8"));
  } catch (error) {
    console.warn("[desktop] failed to read persisted backend observability settings", error);
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined, otlpLogsUrl: undefined };
  }
}

function backendChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PIEDPIPER_PORT;
  delete env.PIEDPIPER_AUTH_TOKEN;
  delete env.PIEDPIPER_MODE;
  delete env.PIEDPIPER_NO_BROWSER;
  delete env.PIEDPIPER_HOST;
  delete env.PIEDPIPER_DESKTOP_WS_URL;
  return env;
}

function writeDesktopLogHeader(message: string): void {
  if (!desktopLogSink) return;
  desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop")}] ${message}\n`);
}

function writeBackendSessionBoundary(phase: "START" | "END", details: string): void {
  if (!backendLogSink) return;
  const normalizedDetails = sanitizeLogValue(details);
  backendLogSink.write(
    `[${logTimestamp()}] ---- APP SESSION ${phase} run=${APP_RUN_ID} ${normalizedDetails} ----\n`,
  );
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getSafeExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return null;
  }

  return parsedUrl.toString();
}

const themeSourceController = createThemeSourceController((theme) => {
  nativeTheme.themeSource = theme;
});

function getSafeTheme(rawTheme: unknown): DesktopTheme | null {
  if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") {
    return rawTheme;
  }

  return null;
}

function writeDesktopStreamChunk(
  streamName: "stdout" | "stderr",
  chunk: unknown,
  encoding: BufferEncoding | undefined,
): void {
  if (!desktopLogSink) return;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : undefined);
  desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName)}] `);
  desktopLogSink.write(buffer);
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    desktopLogSink.write("\n");
  }
}

function installStdIoCapture(): void {
  if (!app.isPackaged || desktopLogSink === null || restoreStdIoCapture !== null) {
    return;
  }

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const patchWrite =
    (streamName: "stdout" | "stderr", originalWrite: typeof process.stdout.write) =>
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      writeDesktopStreamChunk(streamName, chunk, encoding);
      if (typeof encodingOrCallback === "function") {
        return originalWrite(chunk, encodingOrCallback);
      }
      if (callback !== undefined) {
        return originalWrite(chunk, encoding, callback);
      }
      if (encoding !== undefined) {
        return originalWrite(chunk, encoding);
      }
      return originalWrite(chunk);
    };

  process.stdout.write = patchWrite("stdout", originalStdoutWrite);
  process.stderr.write = patchWrite("stderr", originalStderrWrite);

  restoreStdIoCapture = () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    restoreStdIoCapture = null;
  };
}

function initializePackagedLogging(): void {
  if (!app.isPackaged) return;
  try {
    desktopLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "desktop-main.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    backendLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "server-child.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    installStdIoCapture();
    writeDesktopLogHeader(`runtime log capture enabled logDir=${LOG_DIR}`);
  } catch (error) {
    // Logging setup should never block app startup.
    console.error("[desktop] failed to initialize packaged logging", error);
  }
}

function captureBackendOutput(child: ChildProcess.ChildProcess): void {
  if (!app.isPackaged || backendLogSink === null) return;
  const writeChunk = (chunk: unknown): void => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    backendOutputTail.append(buffer);
    backendLogSink?.write(buffer);
  };
  child.stdout?.on("data", writeChunk);
  child.stderr?.on("data", writeChunk);
}

if (process.platform === "linux") {
  app.commandLine.appendSwitch("class", LINUX_WM_CLASS);
  applyHyprlandColorManagerWorkaround();
  restoreLinuxDeviceScaleFactor({
    commandLine: app.commandLine,
    // Kept out of settings.json because the server rewrites that file.
    statePath: Path.join(STATE_DIR, "linux-device-scale-factor"),
    readFile: (path) => FS.readFileSync(path, "utf8"),
    writeFile: (path, value) => {
      FS.mkdirSync(Path.dirname(path), { recursive: true });
      FS.writeFileSync(path, value, "utf8");
    },
  });
}

function readCommandLineSwitchValue(name: string): string | null {
  if (!app.commandLine.hasSwitch(name)) return null;
  const value = app.commandLine.getSwitchValue(name).trim();
  return value.length > 0 ? value : null;
}

function applyHyprlandColorManagerWorkaround(): void {
  try {
    // Chromium keeps only the last --disable-features value, so pass the merged list.
    const disableFeatures = resolveLinuxDisableFeaturesSwitch({
      env: process.env,
      ozonePlatform: readCommandLineSwitchValue("ozone-platform"),
      enableFeatures: readCommandLineSwitchValue("enable-features"),
      disableFeatures: readCommandLineSwitchValue("disable-features"),
      readHyprctlVersionJson: () =>
        ChildProcess.execFileSync("hyprctl", ["version", "-j"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1000,
          maxBuffer: 64 * 1024,
        }),
    });
    if (disableFeatures !== null) {
      app.commandLine.appendSwitch("disable-features", disableFeatures);
    }
  } catch (error) {
    console.warn("[desktop] failed to apply the Hyprland color-manager workaround", error);
  }
}

function getDestructiveMenuIcon(): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") return undefined;
  if (destructiveMenuIconCache !== undefined) {
    return destructiveMenuIconCache ?? undefined;
  }
  try {
    const icon = nativeImage.createFromNamedImage("trash").resize({
      width: 14,
      height: 14,
    });
    if (icon.isEmpty()) {
      destructiveMenuIconCache = null;
      return undefined;
    }
    icon.setTemplateImage(true);
    destructiveMenuIconCache = icon;
    return icon;
  } catch {
    destructiveMenuIconCache = null;
    return undefined;
  }
}
let updatePollTimer: ReturnType<typeof setInterval> | null = null;
let updateStartupTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckInFlight = false;
let runningUpdateCheck: Promise<unknown> | null = null;
let updateDownloadInFlight = false;
let updaterConfigured = false;
let updateState: DesktopUpdateState = initialUpdateState();
const updateInstallRecovery = createUpdateInstallRecovery({
  clearInstallState: () => {
    isQuitting = false;
    quitGuard.reset();
    removeUpdateInstallRecord(resolveUpdateInstallRecordPath());
  },
  restartBackend: () => startBackend(),
  applyFailureState: (message) => {
    setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
  },
  restartUpdateTimers: () => startUpdatePollTimer(),
  ensureWindow: () => {
    if (app.isReady() && bootstrapComplete && BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  },
  onStepError: (error) => {
    console.error("[desktop-updater] Failed install recovery step failed", error);
  },
});

function resolveUpdaterErrorContext(): DesktopUpdateErrorContext {
  if (updateInstallRecovery.isActive()) return "install";
  if (updateDownloadInFlight) return "download";
  if (updateCheckInFlight) return "check";
  return updateState.errorContext;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      // Custom schemes skip Chromium's V8 code cache unless they opt in; dev serves from Vite anyway.
      codeCache: app.isPackaged,
    },
  },
]);

function resolveAppRoot(): string {
  if (!app.isPackaged) {
    return ROOT_DIR;
  }
  return app.getAppPath();
}

/** Read the baked-in app-update.yml config (if applicable). */
function readAppUpdateYml(): Record<string, string> | null {
  try {
    // electron-updater reads from process.resourcesPath in packaged builds,
    // or dev-app-update.yml via app.getAppPath() in dev.
    const ymlPath = app.isPackaged
      ? Path.join(process.resourcesPath, "app-update.yml")
      : Path.join(app.getAppPath(), "dev-app-update.yml");
    const raw = FS.readFileSync(ymlPath, "utf-8");
    // The YAML is simple key-value pairs — avoid pulling in a YAML parser by
    // doing a line-based parse (fields: provider, owner, repo, releaseType, …).
    const entries: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
    }
    return entries.provider ? entries : null;
  } catch {
    return null;
  }
}

function hasUpdateFeedConfig(): boolean {
  return readAppUpdateYml() !== null || Boolean(process.env.PIEDPIPER_DESKTOP_MOCK_UPDATES);
}

function normalizeCommitHash(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase();
}

function resolveEmbeddedCommitHash(): string | null {
  const packageJsonPath = Path.join(resolveAppRoot(), "package.json");
  if (!FS.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const raw = FS.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { piedpiperCommitHash?: unknown };
    return normalizeCommitHash(parsed.piedpiperCommitHash);
  } catch {
    return null;
  }
}

function resolveAboutCommitHash(): string | null {
  if (aboutCommitHashCache !== undefined) {
    return aboutCommitHashCache;
  }

  const envCommitHash = normalizeCommitHash(process.env.PIEDPIPER_COMMIT_HASH);
  if (envCommitHash) {
    aboutCommitHashCache = envCommitHash;
    return aboutCommitHashCache;
  }

  // Only packaged builds are required to expose commit metadata.
  if (!app.isPackaged) {
    aboutCommitHashCache = null;
    return aboutCommitHashCache;
  }

  aboutCommitHashCache = resolveEmbeddedCommitHash();

  return aboutCommitHashCache;
}

function resolveBackendEntry(): string {
  return Path.join(resolveAppRoot(), "apps/server/dist/bin.mjs");
}

function resolveBackendCwd(): string {
  if (!app.isPackaged) {
    return resolveAppRoot();
  }
  return OS.homedir();
}

function resolveDesktopStaticDir(): string | null {
  const appRoot = resolveAppRoot();
  const candidates = [
    Path.join(appRoot, "apps/server/dist/client"),
    Path.join(appRoot, "apps/web/dist"),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(Path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

function resolveDesktopStaticPath(staticRoot: string, requestUrl: string): string {
  const url = new URL(requestUrl);
  const rawPath = decodeURIComponent(url.pathname);
  const normalizedPath = Path.posix.normalize(rawPath).replace(/^\/+/, "");
  if (normalizedPath.includes("..")) {
    return Path.join(staticRoot, "index.html");
  }

  const requestedPath = normalizedPath.length > 0 ? normalizedPath : "index.html";
  const resolvedPath = Path.join(staticRoot, requestedPath);

  if (Path.extname(resolvedPath)) {
    return resolvedPath;
  }

  const nestedIndex = Path.join(resolvedPath, "index.html");
  if (FS.existsSync(nestedIndex)) {
    return nestedIndex;
  }

  return Path.join(staticRoot, "index.html");
}

function isStaticAssetRequest(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return Path.extname(url.pathname).length > 0;
  } catch {
    return false;
  }
}

function handleFatalStartupError(stage: string, error: unknown): void {
  const message = formatErrorMessage(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  writeDesktopLogHeader(`fatal startup error stage=${stage} message=${message}`);
  console.error(`[desktop] fatal startup error (${stage})`, error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox("Pied Piper failed to start", `Stage: ${stage}\n${message}${detail}`);
  }
  requestQuit(`fatal-startup-error:${stage}`);
}

function registerDesktopProtocol(): void {
  if (isDevelopment || desktopProtocolRegistered) return;

  const staticRoot = resolveDesktopStaticDir();
  if (!staticRoot) {
    throw new Error(
      "Desktop static bundle missing. Build apps/server (with bundled client) first.",
    );
  }

  const staticRootResolved = Path.resolve(staticRoot);
  const staticRootPrefix = `${staticRootResolved}${Path.sep}`;
  const fallbackIndex = Path.join(staticRootResolved, "index.html");

  protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
    try {
      const candidate = resolveDesktopStaticPath(staticRootResolved, request.url);
      const resolvedCandidate = Path.resolve(candidate);
      const isInRoot =
        resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
      const isAssetRequest = isStaticAssetRequest(request.url);

      if (!isInRoot || !FS.existsSync(resolvedCandidate)) {
        if (isAssetRequest) {
          callback({ error: -6 });
          return;
        }
        callback({ path: fallbackIndex });
        return;
      }

      callback({ path: resolvedCandidate });
    } catch {
      callback({ path: fallbackIndex });
    }
  });

  desktopProtocolRegistered = true;
}

function dispatchMenuAction(action: string): void {
  if (isQuitting) return;

  const existingWindow =
    BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0];
  const targetWindow = existingWindow ?? createWindow();
  if (!existingWindow) {
    mainWindow = targetWindow;
  }

  const send = () => {
    if (isQuitting || targetWindow.isDestroyed()) return;
    targetWindow.webContents.send(MENU_ACTION_CHANNEL, action);
    if (!targetWindow.isVisible()) {
      targetWindow.show();
    }
    targetWindow.focus();
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", send);
    return;
  }

  send();
}

function handleCheckForUpdatesMenuClick(): void {
  if (isQuitting) return;

  const disabledReason = resolveAutoUpdateDisabledReason();
  if (disabledReason) {
    console.info("[desktop-updater] Manual update check requested, but updates are disabled.");
    void dialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason,
      buttons: ["OK"],
    });
    return;
  }

  if (!BrowserWindow.getAllWindows().length) {
    mainWindow = createWindow();
  }
  void checkForUpdatesFromMenu();
}

async function checkForUpdatesFromMenu(): Promise<void> {
  await checkForUpdates("menu");
  if (isQuitting) return;

  const feedback = resolveUpdateCheckMenuDialog(updateState);
  if (feedback) void dialog.showMessageBox(feedback);
}

function configureApplicationMenu(): void {
  const template = buildApplicationMenuTemplate(process.platform, app.name, {
    onCheckForUpdates: () => handleCheckForUpdatesMenuClick(),
    onOpenSettings: () => dispatchMenuAction("open-settings"),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function resolveResourcePath(fileName: string): string | null {
  const candidates = [
    Path.join(__dirname, "../resources", fileName),
    Path.join(__dirname, "../prod-resources", fileName),
    Path.join(process.resourcesPath, "resources", fileName),
    Path.join(process.resourcesPath, fileName),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveIconPath(ext: "ico" | "icns" | "png"): string | null {
  return resolveResourcePath(`icon.${ext}`);
}

/** Resolve the Electron userData directory path to a clean lowercase name. */
function resolveUserDataPath(): string {
  const appDataBase =
    process.platform === "win32"
      ? process.env.APPDATA || Path.join(OS.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? Path.join(OS.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || Path.join(OS.homedir(), ".config");

  return Path.join(appDataBase, USER_DATA_DIR_NAME);
}

function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME);
  const commitHash = resolveAboutCommitHash();
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    version: commitHash ?? "unknown",
  });

  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }

  if (process.platform === "linux") {
    (app as LinuxDesktopNamedApp).setDesktopName?.(LINUX_DESKTOP_ENTRY_NAME);
  }

  // On macOS the dock icon comes from the .icns in the app bundle — no override needed.
}

function resolveUpdateInstallRecordPath(): string {
  return Path.join(app.getPath("userData"), DESKTOP_UPDATE_INSTALL_RECORD_FILE);
}

function clearUpdatePollTimer(): void {
  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer);
    updateStartupTimer = null;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

function startUpdatePollTimer(): void {
  if (updatePollTimer) clearInterval(updatePollTimer);
  updatePollTimer = setInterval(() => {
    void checkForUpdates("poll");
  }, AUTO_UPDATE_POLL_INTERVAL_MS);
  updatePollTimer.unref();
}

function emitUpdateState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(UPDATE_STATE_CHANNEL, updateState);
  }
}

function setUpdateState(patch: Partial<DesktopUpdateState>): void {
  updateState = { ...updateState, ...patch };
  emitUpdateState();
}

function resolveAutoUpdateDisabledReason(): string | null {
  return getAutoUpdateDisabledReason({
    isDevelopment,
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    disabledByEnv: process.env.PIEDPIPER_DISABLE_AUTO_UPDATE === "1",
    hasUpdateFeedConfig: hasUpdateFeedConfig(),
  });
}

async function checkForUpdates(reason: string): Promise<boolean> {
  if (isQuitting || !updaterConfigured || updateCheckInFlight) return false;
  if (updateState.status === "downloading") {
    console.info(
      `[desktop-updater] Skipping update check (${reason}) while status=${updateState.status}.`,
    );
    return false;
  }
  updateCheckInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnCheckStart(updateState, new Date().toISOString()));
  console.info(`[desktop-updater] Checking for updates (${reason})...`);

  try {
    runningUpdateCheck = autoUpdater.checkForUpdates();
    await runningUpdateCheck;
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(
      reduceDesktopUpdateStateOnCheckFailure(updateState, message, new Date().toISOString()),
    );
    console.error(`[desktop-updater] Failed to check for updates: ${message}`);
    return true;
  } finally {
    updateCheckInFlight = false;
    runningUpdateCheck = null;
  }
}

async function downloadAvailableUpdate(): Promise<{ accepted: boolean; completed: boolean }> {
  if (!updaterConfigured || updateDownloadInFlight || updateState.status !== "available") {
    return { accepted: false, completed: false };
  }
  updateDownloadInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnDownloadStart(updateState));
  autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(desktopRuntimeInfo);
  console.info("[desktop-updater] Downloading update...");

  try {
    installSignatureCheckRetry(autoUpdater);
    await autoUpdater.downloadUpdate();
    return { accepted: true, completed: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] Failed to download update: ${message}`);
    return { accepted: true, completed: false };
  } finally {
    updateDownloadInFlight = false;
  }
}

async function installDownloadedUpdate(): Promise<{ accepted: boolean; completed: boolean }> {
  // A poll can start while the renderer's confirm dialog is open; it must not drop the install.
  if (runningUpdateCheck) await waitUntilSettled(runningUpdateCheck, INSTALL_UPDATE_CHECK_WAIT_MS);
  const targetVersion = updateState.downloadedVersion;
  if (
    isQuitting ||
    !updaterConfigured ||
    updateDownloadInFlight ||
    targetVersion === null ||
    !canInstallDownloadedUpdate(updateState, { checkStillRunning: updateCheckInFlight })
  ) {
    return { accepted: false, completed: false };
  }

  isQuitting = true;
  updateInstallRecovery.begin({
    backendWasRunning:
      backendProcess !== null || restartTimer !== null || backendStopInFlight !== null,
  });
  clearUpdatePollTimer();
  writeUpdateInstallRecord(resolveUpdateInstallRecordPath(), {
    fromVersion: app.getVersion(),
    targetVersion,
  });
  try {
    await stopBackendAndWaitForExit();
    // An updater error or a quit during the stop already decided this attempt.
    if (!updateInstallRecovery.isActive()) return { accepted: true, completed: false };
    // The updater owns the quit from here; cancelling its before-quit would break the install.
    quitGuard.allow();
    // Only starts the handoff, which can still fail; windows stay until before-quit-for-update.
    startUpdaterHandoff(updateInstallRecovery, {
      quitAndInstall: () => autoUpdater.quitAndInstall(true, true),
      schedule: (callback) => setImmediate(callback),
      reportsResultLater: process.platform === "darwin",
      formatError: formatErrorMessage,
    });
    return { accepted: true, completed: false };
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    updateInstallRecovery.recover(message);
    console.error(`[desktop-updater] Failed to install update: ${message}`);
    return { accepted: true, completed: false };
  }
}

function readNotAppliedInstallVersion(): string | null {
  const recordPath = resolveUpdateInstallRecordPath();
  const record = readUpdateInstallRecord(recordPath);
  const notAppliedVersion =
    record === null ? null : resolveNotAppliedInstallVersion(record, app.getVersion());
  // The record stays until the version changes, so no restart forgets the failed version.
  if (notAppliedVersion === null) {
    removeUpdateInstallRecord(recordPath);
  } else {
    console.warn(`[desktop-updater] The last install of ${notAppliedVersion} did not apply.`);
  }
  return notAppliedVersion;
}

function configureAutoUpdater(): void {
  const disabledReason = resolveAutoUpdateDisabledReason();
  setUpdateState(
    createConfiguredDesktopUpdateState(
      app.getVersion(),
      desktopRuntimeInfo,
      disabledReason,
      disabledReason === null ? readNotAppliedInstallVersion() : null,
    ),
  );
  if (disabledReason !== null) {
    return;
  }
  updaterConfigured = true;

  const githubToken =
    process.env.PIEDPIPER_DESKTOP_UPDATE_GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || "";
  if (githubToken) {
    // When a token is provided, re-configure the feed with `private: true` so
    // electron-updater uses the GitHub API (api.github.com) instead of the
    // public Atom feed (github.com/…/releases.atom) which rejects Bearer auth.
    const appUpdateYml = readAppUpdateYml();
    if (appUpdateYml?.provider === "github") {
      autoUpdater.setFeedURL({
        ...appUpdateYml,
        provider: "github" as const,
        private: true,
        token: githubToken,
      });
    }
  }

  if (process.env.PIEDPIPER_DESKTOP_MOCK_UPDATES) {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: `http://localhost:${process.env.PIEDPIPER_DESKTOP_MOCK_UPDATE_SERVER_PORT ?? 3000}`,
    });
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Keep alpha branding, but force all installs onto the stable update track.
  autoUpdater.channel = DESKTOP_UPDATE_CHANNEL;
  autoUpdater.allowPrerelease = DESKTOP_UPDATE_ALLOW_PRERELEASE;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(desktopRuntimeInfo);
  let lastLoggedDownloadMilestone = -1;

  if (isArm64HostRunningIntelBuild(desktopRuntimeInfo)) {
    console.info(
      "[desktop-updater] Apple Silicon host detected while running Intel build; updates will switch to arm64 packages.",
    );
  }

  // The quit follows as soon as this returns, so anything async here would race the exit.
  electronAutoUpdater.on("before-quit-for-update", () => {
    writeDesktopLogHeader("before-quit-for-update received");
    // A failed spawn reported first and recovery already restored the app; keep it running.
    if (!updateInstallRecovery.acceptUpdaterQuit()) return;
    isQuitting = true;
    quitGuard.allow();
    clearUpdatePollTimer();
    mainWindowStatePersister?.flush();
    destroyAllWindows();
  });
  autoUpdater.on("checking-for-update", () => {
    console.info("[desktop-updater] Looking for updates...");
  });
  autoUpdater.on("update-available", (info) => {
    setUpdateState(
      reduceDesktopUpdateStateOnUpdateAvailable(
        updateState,
        info.version,
        new Date().toISOString(),
      ),
    );
    lastLoggedDownloadMilestone = -1;
    console.info(`[desktop-updater] Update available: ${info.version}`);
  });
  autoUpdater.on("update-not-available", () => {
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    lastLoggedDownloadMilestone = -1;
    console.info("[desktop-updater] No updates available.");
  });
  autoUpdater.on("error", (error) => {
    const message = formatErrorMessage(error);
    if (updateInstallRecovery.recover(message)) {
      console.error(`[desktop-updater] Updater error: ${message}`);
      return;
    }
    if (!updateCheckInFlight && !updateDownloadInFlight) {
      setUpdateState({
        status: "error",
        message,
        checkedAt: new Date().toISOString(),
        downloadPercent: null,
        errorContext: resolveUpdaterErrorContext(),
        canRetry: updateState.availableVersion !== null || updateState.downloadedVersion !== null,
      });
    }
    console.error(`[desktop-updater] Updater error: ${message}`);
  });
  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.floor(progress.percent);
    if (
      shouldBroadcastDownloadProgress(updateState, progress.percent) ||
      updateState.message !== null
    ) {
      setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(updateState, progress.percent));
    }
    const milestone = percent - (percent % 10);
    if (milestone > lastLoggedDownloadMilestone) {
      lastLoggedDownloadMilestone = milestone;
      console.info(`[desktop-updater] Download progress: ${percent}%`);
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState(reduceDesktopUpdateStateOnDownloadComplete(updateState, info.version));
    console.info(`[desktop-updater] Update downloaded: ${info.version}`);
  });

  clearUpdatePollTimer();

  updateStartupTimer = setTimeout(() => {
    updateStartupTimer = null;
    void checkForUpdates("startup");
  }, AUTO_UPDATE_STARTUP_DELAY_MS);
  updateStartupTimer.unref();

  startUpdatePollTimer();
}
function scheduleBackendRestart(reason: string, options?: { readonly fatal?: boolean }): void {
  if (isQuitting || restartTimer || backendFailureDialogOpen) return;

  if (options?.fatal || isBackendCrashLooping(backendRestartBackoff.attempt())) {
    void showBackendFailureDialog(reason);
    return;
  }

  const delayMs = backendRestartBackoff.nextRestartDelayMs();
  console.error(`[desktop] backend exited unexpectedly (${reason}); restarting in ${delayMs}ms`);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    startBackend();
  }, delayMs);
}

async function showBackendFailureDialog(reason: string): Promise<void> {
  backendFailureDialogOpen = true;
  console.error(`[desktop] backend failed to start repeatedly (${reason}); giving up`);
  writeDesktopLogHeader(`backend crash loop detected reason=${sanitizeLogValue(reason)}`);
  const detail = formatBackendFailureDetail({
    reason,
    outputTail: backendOutputTail.text(),
    logDir: app.isPackaged ? LOG_DIR : null,
  });
  try {
    // Copy Details re-shows the dialog; Retry and Quit leave it.
    for (;;) {
      if (isQuitting) return;
      const options: Electron.MessageBoxOptions = {
        type: "error",
        title: "Pied Piper backend failed to start",
        message: "The Pied Piper backend keeps exiting during startup.",
        detail,
        buttons: ["Retry", "Copy Details", "Quit"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      };
      const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const { response } = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options);
      if (response === 1) {
        clipboard.writeText(detail);
        continue;
      }
      if (response === 0) break;
      requestQuit("backend-crash-loop");
      return;
    }
  } finally {
    backendFailureDialogOpen = false;
  }
  // Restart outside the try so a new failure dialog is not cleared by this one's finally.
  backendRestartBackoff.reset();
  startBackend();
}

/** Another server owns the state directory: restarting like a crash could never succeed. */
function retryBackendWhileStateDirOwned(delayMs: number): void {
  writeDesktopLogHeader(`backend refused: state directory is owned; retrying in ${delayMs}ms`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startBackend();
  }, delayMs);
}

async function showBackendStateDirOwnedDialog(): Promise<void> {
  backendFailureDialogOpen = true;
  writeDesktopLogHeader("backend refused: state directory is still owned; asking the user");
  try {
    const options: Electron.MessageBoxOptions = {
      type: "error",
      title: "Pied Piper is already running",
      message: "Another Pied Piper server is using this data folder.",
      detail: formatBackendStateDirOwnedDetail({
        stateDir: BACKEND_STATE_DIR,
        outputTail: backendOutputTail.text(),
        platform: process.platform,
      }),
      buttons: ["Retry", "Quit"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const { response } = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    if (isQuitting) return;
    if (response !== 0) {
      requestQuit("backend-state-dir-owned");
      return;
    }
  } finally {
    backendFailureDialogOpen = false;
  }
  backendStateDirOwnedRetry.reset();
  startBackend();
}

function startBackend(): void {
  // Without a cached shell env the backend waits for the first probe so it never runs with a GUI PATH.
  if (isQuitting || backendProcess || !shellEnvironmentReady) return;

  backendObservabilitySettings = readPersistedBackendObservabilitySettings();
  const backendEntry = resolveBackendEntry();
  backendOutputTail.clear();
  if (!FS.existsSync(backendEntry)) {
    // A packaged build cannot gain the entry by waiting; dev may be mid-rebuild.
    scheduleBackendRestart(`missing server entry at ${backendEntry}`, { fatal: app.isPackaged });
    return;
  }

  const captureBackendLogs = app.isPackaged && backendLogSink !== null;
  // `--require` rather than NODE_COMPILE_CACHE so the cache does not leak into provider and terminal children.
  const compileCacheArgs = app.isPackaged
    ? ["--require", Path.join(__dirname, "compileCache.js")]
    : [];
  const child = ChildProcess.spawn(
    process.execPath,
    [...compileCacheArgs, backendEntry, "--bootstrap-fd", "3"],
    {
      cwd: resolveBackendCwd(),
      // In Electron main, process.execPath points to the Electron binary.
      // Run the child in Node mode so this backend process does not become a GUI app instance.
      env: {
        ...backendChildEnv(),
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: captureBackendLogs
        ? ["ignore", "pipe", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit", "pipe"],
    },
  );
  const bootstrapStream = child.stdio[3];
  if (bootstrapStream && "write" in bootstrapStream) {
    bootstrapStream.write(
      `${JSON.stringify({
        mode: "desktop",
        noBrowser: true,
        port: backendPort,
        piedpiperHome: BASE_DIR,
        authToken: backendAuthToken,
        // When the desktop hydrated PATH into the env this backend inherits, the backend skips its probe.
        shellEnvironmentPrepared: shellEnvironmentHydrated,
        ...(backendObservabilitySettings.otlpTracesUrl
          ? { otlpTracesUrl: backendObservabilitySettings.otlpTracesUrl }
          : {}),
        ...(backendObservabilitySettings.otlpMetricsUrl
          ? { otlpMetricsUrl: backendObservabilitySettings.otlpMetricsUrl }
          : {}),
        ...(backendObservabilitySettings.otlpLogsUrl
          ? { otlpLogsUrl: backendObservabilitySettings.otlpLogsUrl }
          : {}),
      })}\n`,
    );
    bootstrapStream.end();
  } else {
    child.kill("SIGTERM");
    scheduleBackendRestart("missing desktop bootstrap pipe");
    return;
  }
  backendProcess = child;
  backendStartedAtMs = Date.now();
  let backendSessionClosed = false;
  const closeBackendSession = (details: string) => {
    if (backendSessionClosed) return;
    backendSessionClosed = true;
    writeBackendSessionBoundary("END", details);
  };
  writeBackendSessionBoundary(
    "START",
    `pid=${child.pid ?? "unknown"} port=${backendPort} cwd=${resolveBackendCwd()}`,
  );
  captureBackendOutput(child);

  // The attempt counter only resets once the backend proves stable, so a crash loop keeps backing off.
  let stability: { readonly cancel: () => void } | null = null;
  child.once("spawn", () => {
    stability = backendRestartBackoff.markSpawned();
  });

  child.on("error", (error) => {
    const wasExpected = expectedBackendExitChildren.has(child);
    stability?.cancel();
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
    if (wasExpected) {
      return;
    }
    scheduleBackendRestart(error.message);
  });

  child.on("exit", (code, signal) => {
    const wasExpected = expectedBackendExitChildren.has(child);
    stability?.cancel();
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(
      `pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    const action = resolveBackendExitAction({
      code,
      signal,
      expected: isQuitting || wasExpected,
      restartOrDialogPending: restartTimer !== null || backendFailureDialogOpen,
      stateDirOwnedRetry: backendStateDirOwnedRetry,
      nowMs: Date.now(),
    });
    if (action.kind === "retry-state-dir") retryBackendWhileStateDirOwned(action.delayMs);
    else if (action.kind === "ask-state-dir") void showBackendStateDirOwnedDialog();
    else if (action.kind === "restart") scheduleBackendRestart(action.reason);
  });
}

async function refreshShellEnvironment(): Promise<void> {
  const { changed, hydrated } = await shellEnvironmentSync.refresh();
  shellEnvironmentHydrated = hydrated;
  if (isQuitting) return;
  if (!shellEnvironmentReady) {
    shellEnvironmentReady = true;
    writeDesktopLogHeader("login shell environment ready; starting backend");
    startBackend();
    return;
  }
  if (!changed) return;
  // Only a just-started backend is restarted: later restarts could interrupt a running turn.
  if (backendProcess && Date.now() - backendStartedAtMs < SHELL_ENVIRONMENT_RESTART_WINDOW_MS) {
    writeDesktopLogHeader("login shell environment changed; restarting backend");
    await stopBackendAndWaitForExit();
    startBackend();
    return;
  }
  writeDesktopLogHeader("login shell environment changed; it applies on the next backend start");
}

async function stopBackendAndWaitForExit(
  timeoutMs = BACKEND_QUIT_STOP_TIMEOUT_MS,
): Promise<string> {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  // A concurrent caller (installer vs quit) must wait on the same termination, not exit past it.
  if (!child) return backendStopInFlight ?? "no-backend";
  expectedBackendExitChildren.add(child);
  const stop = terminateChildAndWaitForExit(child, {
    graceMs: BACKEND_TERMINATE_GRACE_MS,
    timeoutMs,
  }).finally(() => {
    if (backendStopInFlight === stop) backendStopInFlight = null;
  });
  backendStopInFlight = stop;
  return stop;
}

function destroyAllWindows(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch (error) {
      console.error("[desktop] failed to destroy window during quit", error);
    }
  }
}

async function shutdownForQuit(source: string): Promise<void> {
  isQuitting = true;
  // This quit beat the updater handoff, so the install never reached the OS installer.
  if (updateInstallRecovery.isActive()) {
    removeUpdateInstallRecord(resolveUpdateInstallRecordPath());
  }
  updateInstallRecovery.abandon();
  writeDesktopLogHeader(`${source}: stopping backend`);
  clearUpdatePollTimer();
  themeSourceController.stop();
  // Windows go away immediately so the quit feels instant while the backend drains.
  destroyAllWindows();
  const outcome = await stopBackendAndWaitForExit();
  writeDesktopLogHeader(`${source}: backend stop finished outcome=${outcome}`);
}

function exitNow(): void {
  restoreStdIoCapture?.();
  app.exit(0);
}

/** Single quit path for before-quit, signals and fatal errors: stop the backend once, then exit. */
const requestQuit = createQuitController({
  guard: quitGuard,
  shutdown: shutdownForQuit,
  exit: exitNow,
  // Already allowed (shutdown done, or the updater owns the quit): still quit, never ignore a signal.
  proceed: () => app.quit(),
  log: writeDesktopLogHeader,
  onShutdownError: (source, error) => {
    console.error(`[desktop] shutdown failed (${source})`, error);
  },
});

function focusExistingWindow(): void {
  if (isQuitting) return;
  const window = mainWindow ?? BrowserWindow.getAllWindows()[0];
  if (!window || window.isDestroyed()) {
    // Before bootstrap finishes, its own createWindow() will surface the window.
    if (app.isReady() && bootstrapComplete) {
      mainWindow = createWindow();
    }
    return;
  }
  revealWindow(window);
}

function revealWindow(window: BrowserWindow): void {
  raiseWindow(window, process.platform === "darwin" ? () => app.focus({ steal: true }) : undefined);
}

function registerIpcHandlers(): void {
  ipcMain.removeAllListeners(GET_WS_URL_CHANNEL);
  ipcMain.on(GET_WS_URL_CHANNEL, (event) => {
    event.returnValue = backendWsUrl;
  });

  ipcMain.removeAllListeners(GET_WINDOW_FULLSCREEN_STATE_CHANNEL);
  ipcMain.on(GET_WINDOW_FULLSCREEN_STATE_CHANNEL, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    event.returnValue = window !== null && !window.isDestroyed() && window.isFullScreen();
  });

  ipcMain.removeAllListeners(GET_SYSTEM_LOCALE_CHANNEL);
  ipcMain.on(GET_SYSTEM_LOCALE_CHANNEL, (event) => {
    event.returnValue = resolveSystemLocaleTag({
      platform: process.platform,
      env: process.env,
      getSystemLocale: () => app.getSystemLocale(),
      getBooleanUserDefault: (key) => systemPreferences.getUserDefault(key, "boolean") === true,
    });
  });

  ipcMain.removeAllListeners(SYNC_WINDOW_BUTTONS_CHANNEL);
  ipcMain.on(SYNC_WINDOW_BUTTONS_CHANNEL, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) syncMacosWindowButtons(window, process.platform);
  });

  ipcMain.removeAllListeners(SET_QUIT_CONFIRMATION_MODE_CHANNEL);
  ipcMain.on(SET_QUIT_CONFIRMATION_MODE_CHANNEL, (_event, mode: unknown) => {
    if (isQuitConfirmationMode(mode)) quitConfirmationMode = mode;
  });

  ipcMain.removeHandler(SET_BADGE_COUNT_CHANNEL);
  ipcMain.handle(SET_BADGE_COUNT_CHANNEL, async (_event, count: unknown) => {
    app.setBadgeCount(normalizeBadgeCount(count));
  });

  ipcMain.removeHandler(REVEAL_WINDOW_CHANNEL);
  ipcMain.handle(
    REVEAL_WINDOW_CHANNEL,
    makeRevealWindowHandler({
      getMainWindow: () =>
        isQuitting || mainWindow === null || mainWindow.isDestroyed() ? null : mainWindow,
      reveal: revealWindow,
    }),
  );

  ipcMain.removeHandler(PICK_FOLDER_CHANNEL);
  ipcMain.handle(PICK_FOLDER_CHANNEL, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.removeHandler(PICK_PROJECT_FAVICON_CHANNEL);
  ipcMain.handle(PICK_PROJECT_FAVICON_CHANNEL, async (_event, initialPath: unknown) => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const options: Electron.OpenDialogOptions = {
      properties: ["openFile"],
      filters: [
        { name: "Images", extensions: ["avif", "gif", "ico", "jpg", "jpeg", "png", "svg", "webp"] },
      ],
      ...(typeof initialPath === "string" ? { defaultPath: initialPath } : {}),
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return null;
    // The renderer compares strings, so a symlink leaving the workspace must arrive as its real path.
    const picked = result.filePaths[0];
    return picked ? await FS.promises.realpath(picked).catch(() => picked) : null;
  });

  ipcMain.removeHandler(CONFIRM_CHANNEL);
  ipcMain.handle(CONFIRM_CHANNEL, async (_event, message: unknown) => {
    if (typeof message !== "string") {
      return false;
    }

    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    return showDesktopConfirmDialog(message, owner);
  });

  ipcMain.removeHandler(SET_THEME_CHANNEL);
  ipcMain.handle(SET_THEME_CHANNEL, async (_event, rawTheme: unknown) => {
    const theme = getSafeTheme(rawTheme);
    if (!theme) {
      return;
    }

    themeSourceController.setSource(theme);
  });

  ipcMain.removeHandler(CONTEXT_MENU_CHANNEL);
  ipcMain.handle(
    CONTEXT_MENU_CHANNEL,
    async (_event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = items
        .filter((item) => typeof item.id === "string" && typeof item.label === "string")
        .map((item) => ({
          id: item.id,
          label: item.label,
          destructive: item.destructive === true,
          disabled: item.disabled === true,
        }));
      if (normalizedItems.length === 0) {
        return null;
      }

      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (!window) return null;
      const popupPosition = resolveContextMenuPopupPosition(
        position,
        window.webContents.getZoomFactor(),
      );

      return new Promise<string | null>((resolve) => {
        const template: MenuItemConstructorOptions[] = [];
        let hasInsertedDestructiveSeparator = false;
        for (const item of normalizedItems) {
          if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
            template.push({ type: "separator" });
            hasInsertedDestructiveSeparator = true;
          }
          const itemOption: MenuItemConstructorOptions = {
            label: item.label,
            enabled: !item.disabled,
            click: () => resolve(item.id),
          };
          if (item.destructive) {
            const destructiveIcon = getDestructiveMenuIcon();
            if (destructiveIcon) {
              itemOption.icon = destructiveIcon;
            }
          }
          template.push(itemOption);
        }

        const menu = Menu.buildFromTemplate(template);
        menu.popup({
          window,
          ...popupPosition,
          callback: () => resolve(null),
        });
      });
    },
  );

  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, rawUrl: unknown) => {
    const externalUrl = getSafeExternalUrl(rawUrl);
    if (!externalUrl) {
      return false;
    }

    try {
      await shell.openExternal(externalUrl);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL);
  ipcMain.handle(UPDATE_GET_STATE_CHANNEL, async () => updateState);

  ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL);
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
    const result = await downloadAvailableUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, async () => {
    if (isQuitting) {
      return {
        accepted: false,
        completed: false,
        state: updateState,
      } satisfies DesktopUpdateActionResult;
    }
    const result = await installDownloadedUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(UPDATE_CHECK_CHANNEL);
  ipcMain.handle(UPDATE_CHECK_CHANNEL, async () => {
    if (!updaterConfigured) {
      return {
        checked: false,
        state: updateState,
      } satisfies DesktopUpdateCheckResult;
    }
    const checked = await checkForUpdates("web-ui");
    return {
      checked,
      state: updateState,
    } satisfies DesktopUpdateCheckResult;
  });
}

function getIconOption(): { icon: string } | Record<string, never> {
  if (process.platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = process.platform === "win32" ? "ico" : "png";
  const iconPath = resolveIconPath(ext);
  return iconPath ? { icon: iconPath } : {};
}

function loadMainWindowContent(window: BrowserWindow): void {
  if (isDevelopment) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
  } else {
    void window.loadURL(DESKTOP_APP_URL);
  }
}

function readDisplayBounds(): Electron.Rectangle[] {
  try {
    return screen.getAllDisplays().map((display) => display.bounds);
  } catch (error) {
    console.warn("[desktop] failed to read connected displays; using default window size", error);
    return [];
  }
}

function createWindow(): BrowserWindow {
  const savedWindowState = readWindowState(WINDOW_STATE_PATH);
  const initialBounds = resolveInitialWindowBounds(savedWindowState.bounds, readDisplayBounds());
  if (savedWindowState.bounds !== null && initialBounds !== savedWindowState.bounds) {
    console.warn("[desktop] saved main window bounds could not be restored; using defaults");
  }
  const window = new BrowserWindow({
    ...initialBounds,
    minWidth: MAIN_WINDOW_MIN_SIZE.width,
    minHeight: MAIN_WINDOW_MIN_SIZE.height,
    show: false,
    autoHideMenuBar: true,
    ...getIconOption(),
    title: APP_DISPLAY_NAME,
    ...getWindowTitleBarOptions(process.platform, nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: Path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Hidden renderers are throttled; boot at full speed and re-enable at first reveal.
      backgroundThrottling: false,
    },
  });

  // Applies the configured direct, hold or double-press behavior to the quit accelerator.
  const quitShortcutHandler = makeQuitShortcutHandler({
    platform: process.platform,
    getMode: () => Promise.resolve(quitConfirmationMode),
    notify: (hint) => {
      if (!window.isDestroyed()) window.webContents.send(QUIT_SHORTCUT_HINT_CHANNEL, hint);
    },
    // Keep the window focused until release so trailing repeats cannot reach the next app.
    concealWindow: () => concealPendingQuitWindow(window),
    quit: () => app.quit(),
  });
  window.webContents.on("before-input-event", (event, input) => {
    quitShortcutHandler(event, input);
    if (shouldBlockRepeatedCloseShortcut(input, process.platform)) {
      event.preventDefault();
    }
  });
  forwardWindowFullscreenState(window);
  installWindowInputGestures(window, process.platform);
  const syncWindowButtons = () => syncMacosWindowButtons(window, process.platform);
  window.on("leave-full-screen", syncWindowButtons);
  // Registered after the input gestures, which apply the zoom this event only requests.
  window.webContents.on("zoom-changed", syncWindowButtons);

  window.webContents.on("context-menu", (event, params) => {
    event.preventDefault();

    const menuTemplate = buildEditContextMenuTemplate(params, {
      safeLinkUrl: getSafeExternalUrl(params.linkURL),
      replaceMisspelling: (suggestion) => window.webContents.replaceMisspelling(suggestion),
      copyText: (text) => clipboard.writeText(text),
      copyImageAt: (x, y) => window.webContents.copyImageAt(x, y),
    });
    Menu.buildFromTemplate(menuTemplate).popup({ window });
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });

  // Prevent the main frame from navigating to unexpected URLs.
  window.webContents.on("will-navigate", (event, url) => {
    const allowed = isAllowedRendererNavigation({
      navigationUrl: url,
      appUrl: DESKTOP_APP_URL,
      devServerUrl: process.env.VITE_DEV_SERVER_URL,
    });
    if (!allowed) {
      event.preventDefault();
    }
  });

  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_DISPLAY_NAME);
  });
  window.webContents.on("did-finish-load", () => {
    window.setTitle(APP_DISPLAY_NAME);
    syncWindowButtons();
    emitUpdateState();
  });
  const windowStatePersister = createWindowStatePersister({
    filePath: WINDOW_STATE_PATH,
    window,
    saved: savedWindowState,
    restoredSavedBounds: initialBounds === savedWindowState.bounds,
    onError: (error) => console.warn("[desktop] failed to persist main window state", error),
  });
  mainWindowStatePersister = windowStatePersister;
  window.on("resize", windowStatePersister.schedule);
  window.on("move", windowStatePersister.schedule);
  window.on("maximize", windowStatePersister.schedule);
  window.on("unmaximize", windowStatePersister.schedule);
  window.on("close", windowStatePersister.flush);

  // On Linux/Wayland with `show: false`, ready-to-show only fires after show(), so also
  // reveal on did-finish-load there; elsewhere keep the no-flash ready-to-show path.
  const revealSubscribers: RevealSubscription[] = [(fire) => window.once("ready-to-show", fire)];
  if (process.platform === "linux") {
    revealSubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
  }
  bindFirstRevealTrigger(revealSubscribers, () => {
    if (window.isDestroyed()) return;
    window.webContents.setBackgroundThrottling(true);
    if (savedWindowState.maximized) {
      window.maximize();
    }
    window.show();
  });

  // A dead renderer (usually V8 OOM on a long session) leaves a blank window while the
  // backend keeps running; reload so it rehydrates, bounded so a boot crash cannot loop.
  const rendererRecovery = createRendererRecoveryPolicy();
  window.webContents.on("render-process-gone", (_event, details) => {
    const recovering =
      !isQuitting &&
      !window.isDestroyed() &&
      rendererRecovery.shouldRecover(details.reason, Date.now());
    const summary = `reason=${details.reason} exitCode=${details.exitCode} recovering=${recovering}`;
    console.error(`[desktop] renderer process gone ${summary}`);
    writeDesktopLogHeader(`renderer process gone ${summary}`);
    if (!recovering) return;
    setTimeout(() => {
      if (isQuitting || window.isDestroyed()) return;
      loadMainWindowContent(window);
    }, RENDERER_RECOVERY_RELOAD_DELAY_MS);
  });

  loadMainWindowContent(window);

  window.on("closed", () => {
    windowStatePersister.dispose();
    if (mainWindowStatePersister === windowStatePersister) {
      mainWindowStatePersister = null;
    }
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    focusExistingWindow();
  });
}

// The renderer only counts unread threads while unfocused, so focus clears the dock badge.
app.on("browser-window-focus", () => {
  app.setBadgeCount(0);
});

configureAppIdentity();

async function bootstrap(): Promise<void> {
  writeDesktopLogHeader("bootstrap start");
  backendPort = await Effect.service(NetService).pipe(
    Effect.flatMap((net) => net.reserveLoopbackPort()),
    Effect.provide(NetService.layer),
    Effect.runPromise,
  );
  writeDesktopLogHeader(`reserved backend port via NetService port=${backendPort}`);
  backendAuthToken = Crypto.randomBytes(24).toString("hex");
  const baseUrl = `ws://127.0.0.1:${backendPort}`;
  backendWsUrl = `${baseUrl}/?token=${encodeURIComponent(backendAuthToken)}`;
  writeDesktopLogHeader(`bootstrap resolved websocket endpoint baseUrl=${baseUrl}`);

  registerIpcHandlers();
  writeDesktopLogHeader("bootstrap ipc handlers registered");
  startBackend();
  writeDesktopLogHeader(
    shellEnvironmentReady
      ? "bootstrap backend start requested"
      : "bootstrap backend waiting for the login shell environment",
  );
  mainWindow = createWindow();
  bootstrapComplete = true;
  writeDesktopLogHeader("bootstrap main window created");
  void refreshShellEnvironment().catch((error) => {
    console.warn("[desktop] failed to refresh the login shell environment", error);
    shellEnvironmentHydrated = false;
    shellEnvironmentReady = true;
    startBackend();
  });
}

app.on("before-quit", (event) => {
  writeDesktopLogHeader("before-quit received");
  if (updateInstallRecovery.consumeRefusedUpdaterQuit()) {
    event.preventDefault();
    return;
  }
  mainWindowStatePersister?.flush();
  if (quitGuard.phase() === "allowed") {
    // A quit before the updater took over means the install never reached the OS installer.
    if (updateInstallRecovery.isAwaitingHandoff()) {
      removeUpdateInstallRecord(resolveUpdateInstallRecordPath());
    }
    // Shutdown already ran, or the updater owns this quit: let Electron proceed.
    isQuitting = true;
    updateInstallRecovery.abandon();
    clearUpdatePollTimer();
    themeSourceController.stop();
    restoreStdIoCapture?.();
    return;
  }
  // Electron would exit before the backend's SIGKILL timer fires; hold the quit until it stopped.
  event.preventDefault();
  requestQuit("before-quit");
});

app
  .whenReady()
  .then(() => {
    if (!hasSingleInstanceLock) return;
    writeDesktopLogHeader("app ready");
    configureAppIdentity();
    configureApplicationMenu();
    registerDesktopProtocol();
    configureAutoUpdater();
    nativeTheme.on("updated", () => {
      for (const window of BrowserWindow.getAllWindows()) {
        syncWindowTitleBarTheme(window, process.platform, nativeTheme.shouldUseDarkColors);
      }
    });
    if (process.platform === "linux") themeSourceController.startFollowingLinuxPortal();
    void bootstrap().catch((error) => {
      handleFatalStartupError("bootstrap", error);
    });

    app.on("activate", () => {
      if (isQuitting || !bootstrapComplete) return;
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
      }
    });
  })
  .catch((error) => {
    handleFatalStartupError("whenReady", error);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !isQuitting) {
    app.quit();
  }
});

if (process.platform !== "win32") {
  process.on("SIGINT", () => {
    writeDesktopLogHeader("SIGINT received");
    requestQuit("SIGINT");
  });

  process.on("SIGTERM", () => {
    writeDesktopLogHeader("SIGTERM received");
    requestQuit("SIGTERM");
  });
}
