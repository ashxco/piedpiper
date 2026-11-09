/**
 * Whether a main-frame navigation stays on the app's own renderer: same scheme and host as
 * `appUrl`, or under the dev server's origin and path prefix.
 */
export function isAllowedRendererNavigation(input: {
  readonly navigationUrl: string;
  readonly appUrl: string;
  readonly devServerUrl?: string | undefined;
}): boolean {
  let navigation: URL;
  try {
    navigation = new URL(input.navigationUrl);
  } catch {
    return false;
  }
  return (
    isSameSchemeAndHost(navigation, input.appUrl) ||
    (Boolean(input.devServerUrl) && isUnderDevServer(navigation, input.devServerUrl as string))
  );
}

// Custom-scheme origins serialize as "null", so compare protocol and host explicitly.
function isSameSchemeAndHost(navigation: URL, appUrl: string): boolean {
  try {
    const app = new URL(appUrl);
    return app.host !== "" && navigation.protocol === app.protocol && navigation.host === app.host;
  } catch {
    return false;
  }
}

function isUnderDevServer(navigation: URL, devServerUrl: string): boolean {
  try {
    const devServer = new URL(devServerUrl);
    if (devServer.host === "" || navigation.origin !== devServer.origin) return false;
    const basePath = devServer.pathname.endsWith("/")
      ? devServer.pathname
      : `${devServer.pathname}/`;
    return navigation.pathname === devServer.pathname || navigation.pathname.startsWith(basePath);
  } catch {
    return false;
  }
}
