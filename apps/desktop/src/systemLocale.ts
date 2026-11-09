// Keep in sync with preload.ts; the sandboxed preload stays standalone.
export const GET_SYSTEM_LOCALE_CHANNEL = "desktop:get-system-locale";

export type SystemHourCycle = "h12" | "h23";

/**
 * Turns an OS locale identifier (`en_GB`, `en-US@rg=nlzzzz`) into a BCP-47 tag `Intl` accepts.
 * `Intl` ignores `rg` extensions, so a macOS region override replaces the region subtag.
 */
export function toSystemLocaleTag(identifier: string, hourCycle?: SystemHourCycle): string {
  const [base = "", keywords = ""] = identifier.split("@");
  const languageTag = base.replace(/_/g, "-");
  const region = /(?:^|;)rg=([a-z]{2}|\d{3})zzzz(?:;|$)/i.exec(keywords)?.[1]?.toUpperCase();
  try {
    return new Intl.Locale(languageTag, {
      ...(region ? { region } : {}),
      ...(hourCycle ? { hourCycle } : {}),
    }).toString();
  } catch {
    return languageTag;
  }
}

/** The Linux locale for dates and times, or null for `C`/`POSIX`, which name no real locale. */
export function resolveLinuxTimeLocale(env: NodeJS.ProcessEnv): string | null {
  const raw = env.LC_ALL || env.LC_TIME || env.LANG;
  const locale = raw?.split(".")[0]?.split("@")[0]?.trim();
  if (!locale || locale === "C" || locale === "POSIX") return null;
  return locale;
}

export interface SystemLocaleSource {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** `app.getSystemLocale()`: asks the OS, unlike the app locale pinned by `electronLanguages`. */
  readonly getSystemLocale: () => string;
  /** `systemPreferences.getUserDefault(key, "boolean")`; only read on macOS. */
  readonly getBooleanUserDefault: (key: string) => boolean;
}

/** The OS locale tag the renderer cannot read for itself in a packaged build. */
export function resolveSystemLocaleTag(source: SystemLocaleSource): string {
  if (source.platform === "linux") {
    return toSystemLocaleTag(resolveLinuxTimeLocale(source.env) ?? source.getSystemLocale());
  }
  if (source.platform === "darwin") {
    const hourCycle = source.getBooleanUserDefault("AppleICUForce24HourTime")
      ? "h23"
      : source.getBooleanUserDefault("AppleICUForce12HourTime")
        ? "h12"
        : undefined;
    return toSystemLocaleTag(source.getSystemLocale(), hourCycle);
  }
  return toSystemLocaleTag(source.getSystemLocale());
}
