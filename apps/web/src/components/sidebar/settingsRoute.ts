const SETTINGS_PATHNAME_PATTERN = /^\/settings(\/|$)/;

export function isSettingsPathname(pathname: string): boolean {
  return SETTINGS_PATHNAME_PATTERN.test(pathname);
}
