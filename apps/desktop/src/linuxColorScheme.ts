import { spawn } from "node:child_process";

import type { DesktopTheme } from "@piedpiper/contracts";

const PORTAL_NAME = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const SETTINGS_INTERFACE = "org.freedesktop.portal.Settings";
const APPEARANCE_NAMESPACE = "org.freedesktop.appearance";
const COLOR_SCHEME_KEY = "color-scheme";

export type LinuxColorScheme = "dark" | "light" | null;

export interface GdbusProcess {
  readonly stdout: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  } | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

export type SpawnGdbus = (args: ReadonlyArray<string>) => GdbusProcess;

const spawnGdbusProcess: SpawnGdbus = (args) =>
  spawn("gdbus", [...args], { stdio: ["ignore", "pipe", "ignore"] });

// The portal reports 1 for prefer-dark, 2 for prefer-light and 0 for no preference, which is
// also GNOME's light mode.
function decodeColorScheme(value: string): LinuxColorScheme {
  if (value === "1") return "dark";
  return value === "0" || value === "2" ? "light" : null;
}

function extractColorScheme(text: string): LinuxColorScheme | undefined {
  const value = text.match(/<uint32 (\d+)>/)?.[1];
  return value === undefined ? undefined : decodeColorScheme(value);
}

/** Decodes `gdbus call` output: `(<uint32 1>,)` from ReadOne, `(<<uint32 1>>,)` from Read. */
export function parseColorSchemeReply(output: string): LinuxColorScheme | undefined {
  return extractColorScheme(output);
}

/** Decodes one `gdbus monitor` line; undefined for anything but a color scheme change. */
export function parseColorSchemeSignal(line: string): LinuxColorScheme | undefined {
  if (
    !line.includes(`${SETTINGS_INTERFACE}.SettingChanged`) ||
    !line.includes(`'${APPEARANCE_NAMESPACE}', '${COLOR_SCHEME_KEY}'`)
  ) {
    return undefined;
  }
  return extractColorScheme(line);
}

/**
 * Follows the desktop color scheme through the XDG settings portal using glib's gdbus. Without
 * gdbus, a session bus or the portal it reports nothing, so Chromium's own resolution stays.
 */
export function watchLinuxColorScheme(
  onChange: (scheme: LinuxColorScheme) => void,
  spawnGdbus: SpawnGdbus = spawnGdbusProcess,
): { readonly stop: () => void } {
  let stopped = false;
  let signalSeen = false;
  let activeCall: GdbusProcess | null = null;
  const report = (scheme: LinuxColorScheme) => {
    if (!stopped) onChange(scheme);
  };
  // spawn throws, rather than emits 'error', for errnos such as ENOMEM; this is only a theme nicety.
  const trySpawn = (args: ReadonlyArray<string>): GdbusProcess | null => {
    try {
      return spawnGdbus(args);
    } catch {
      return null;
    }
  };

  const monitor = trySpawn([
    "monitor",
    "--session",
    "--dest",
    PORTAL_NAME,
    "--object-path",
    PORTAL_PATH,
  ]);
  let partialLine = "";
  monitor?.stdout?.on("data", (chunk) => {
    const lines = `${partialLine}${String(chunk)}`.split("\n");
    partialLine = lines.pop() ?? "";
    for (const line of lines) {
      const scheme = parseColorSchemeSignal(line);
      if (scheme === undefined) continue;
      signalSeen = true;
      report(scheme);
    }
  });
  monitor?.on("error", () => undefined);

  const read = (method: "ReadOne" | "Read", onRejected?: () => void) => {
    const call = trySpawn([
      "call",
      "--session",
      "--dest",
      PORTAL_NAME,
      "--object-path",
      PORTAL_PATH,
      "--method",
      `${SETTINGS_INTERFACE}.${method}`,
      APPEARANCE_NAMESPACE,
      COLOR_SCHEME_KEY,
    ]);
    if (call === null) return;
    activeCall = call;
    let output = "";
    let spawnFailed = false;
    call.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    call.on("error", () => {
      spawnFailed = true;
    });
    call.on("close", (code) => {
      if (activeCall === call) activeCall = null;
      if (stopped || spawnFailed) return;
      if (code !== 0) {
        onRejected?.();
        return;
      }
      // A change signal can overtake this reply, which then carries the older value.
      if (signalSeen) return;
      const scheme = parseColorSchemeReply(output);
      if (scheme !== undefined) report(scheme);
    });
  };
  // ReadOne needs Settings portal version 2; older portals only offer Read.
  read("ReadOne", () => read("Read"));

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      monitor?.kill();
      activeCall?.kill();
    },
  };
}

/** An explicit light or dark choice always wins; "system" follows the portal once it has answered. */
export function resolveThemeSource(
  source: DesktopTheme,
  systemScheme: LinuxColorScheme,
): DesktopTheme {
  return source === "system" ? (systemScheme ?? "system") : source;
}

export function createThemeSourceController(
  applyThemeSource: (theme: DesktopTheme) => void,
  watch: typeof watchLinuxColorScheme = watchLinuxColorScheme,
) {
  let source: DesktopTheme = "system";
  let systemScheme: LinuxColorScheme = null;
  let watcher: { readonly stop: () => void } | null = null;
  const apply = () => applyThemeSource(resolveThemeSource(source, systemScheme));

  return {
    setSource: (theme: DesktopTheme) => {
      source = theme;
      apply();
    },
    // Electron reads the Linux color scheme once and then misses changes (electron/electron#48736).
    startFollowingLinuxPortal: () => {
      watcher ??= watch((scheme) => {
        systemScheme = scheme;
        apply();
      });
    },
    stop: () => {
      watcher?.stop();
    },
  };
}
