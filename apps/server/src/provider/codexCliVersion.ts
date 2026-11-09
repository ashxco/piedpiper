import { compareCliVersions, normalizeCliVersion, parseCliSemver } from "./cliVersion";

const CODEX_VERSION_PATTERN = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/;

const MINIMUM_CODEX_CLI_VERSION = "0.37.0";

/** First Codex CLI whose app-server accepts `approvalsReviewer: "auto_review"` on thread/start and resume. */
const MINIMUM_CODEX_APPROVALS_REVIEWER_VERSION = "0.124.0";

export const compareCodexCliVersions = compareCliVersions;

export function parseCodexCliVersion(output: string): string | null {
  const match = CODEX_VERSION_PATTERN.exec(output);
  if (!match?.[1]) {
    return null;
  }

  const parsed = parseCliSemver(match[1]);
  if (!parsed) {
    return null;
  }

  return normalizeCliVersion(match[1]);
}

export function isCodexCliVersionSupported(version: string): boolean {
  return compareCodexCliVersions(version, MINIMUM_CODEX_CLI_VERSION) >= 0;
}

export function formatCodexCliUpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Codex CLI ${versionLabel} is too old for Pied Piper. Upgrade to v${MINIMUM_CODEX_CLI_VERSION} or newer and restart Pied Piper.`;
}

export function supportsCodexApprovalsReviewer(version: string | null | undefined): boolean {
  if (!version) return false;
  const parsed = parseCodexCliVersion(version);
  return (
    parsed !== null &&
    compareCodexCliVersions(parsed, MINIMUM_CODEX_APPROVALS_REVIEWER_VERSION) >= 0
  );
}
