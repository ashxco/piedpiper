const SCP_SSH_REMOTE_PATTERN = /^[a-zA-Z0-9._-]+@([^:/\s]+):(?!\/\/)(\S+)$/;
// Git also reads `host:path` as SSH. A single letter is a Windows drive and `::` names a remote helper.
const USERLESS_SCP_SSH_REMOTE_PATTERN = /^([^@:/\\\s]{2,}):(?!:)(\/?[^/\s]+(?:\/[^/\s]+)+\/?)$/;
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const SSH_URL_PROTOCOLS = new Set(["ssh:", "git+ssh:", "ssh+git:"]);
const GIT_PROTOCOL_DEFAULT_PORT = "9418";
const SSH_DEFAULT_PORT = "22";

export interface ParsedRemoteUrl {
  readonly host: string;
  readonly path: string;
  readonly isSsh: boolean;
  /** Null when the URL names no port or its scheme's default one. */
  readonly port: string | null;
}

/** Parses a URL or scp-style remote. Returns null for local paths and anything else without a host. */
export function parseRemoteUrl(url: string | null): ParsedRemoteUrl | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }

  if (URL_SCHEME_PATTERN.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname.length === 0) {
        return null;
      }
      const protocol = parsed.protocol.toLowerCase();
      const isSsh = SSH_URL_PROTOCOLS.has(protocol);
      const defaultPort = isSsh
        ? SSH_DEFAULT_PORT
        : protocol === "git:"
          ? GIT_PROTOCOL_DEFAULT_PORT
          : "";
      return {
        host: parsed.hostname.toLowerCase(),
        path: decodeURIComponent(parsed.pathname),
        isSsh,
        port: parsed.port.length > 0 && parsed.port !== defaultPort ? parsed.port : null,
      };
    } catch {
      return null;
    }
  }

  const scpMatch =
    SCP_SSH_REMOTE_PATTERN.exec(trimmed) ?? USERLESS_SCP_SSH_REMOTE_PATTERN.exec(trimmed);
  if (scpMatch?.[1] && scpMatch[2]) {
    return { host: scpMatch[1].toLowerCase(), path: scpMatch[2], isSsh: true, port: null };
  }
  return null;
}

// github.com also serves git over `ssh.github.com:443` and redirects `www.github.com`.
export function canonicalGitHubHost(host: string): string {
  return host === "ssh.github.com" || host === "www.github.com" ? "github.com" : host;
}

function stripRepositorySuffix(path: string): string {
  return path.replace(/\/+$/g, "").replace(/\.git$/i, "");
}

/**
 * Key that is equal for two URLs of one repository, whichever transport or user they name. A
 * non-default port stays in the key, and a local path is kept verbatim because its case can matter.
 */
export function remoteUrlIdentityKey(url: string): string {
  const parsed = parseRemoteUrl(url);
  if (parsed === null) {
    return `path:${stripRepositorySuffix(url.trim())}`;
  }
  // 443 is the ordinary SSH port of ssh.github.com.
  const hasDefaultPort =
    parsed.port === null || (parsed.host === "ssh.github.com" && parsed.port === "443");
  const host = `${canonicalGitHubHost(parsed.host)}${hasDefaultPort ? "" : `:${parsed.port}`}`;
  const repositoryPath = stripRepositorySuffix(parsed.path.replace(/^\/+/g, ""));
  return `remote:${host}/${repositoryPath.toLowerCase()}`;
}
