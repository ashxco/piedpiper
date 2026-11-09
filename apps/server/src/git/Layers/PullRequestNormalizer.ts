/**
 * Pure helpers used by GitManagerLive.
 *
 * Extracted from GitManager.ts to keep the layer file focused on the
 * actual git command orchestration. None of these helpers spawn
 * processes or read Effect services — they parse pull-request payloads,
 * format commit messages, normalize PR references, and shape user-facing
 * progress text.
 */
import {
  GitCommandError,
  type GitRunStackedActionResult,
  type GitStackedAction,
  GitManagerError,
} from "@piedpiper/contracts";
import { sanitizeBranchFragment } from "@piedpiper/shared/git";
import { sliceSurrogateSafe } from "@piedpiper/shared/String";
import { realpath } from "node:fs/promises";

import type { GitHubPullRequestSummary } from "../Services/GitHubCli.ts";
import { canonicalGitHubHost, parseRemoteUrl } from "../remoteUrl.ts";
import { sanitizeCommitSubject } from "../Utils.ts";
import { isNotGitRepositoryStderr } from "./GitParsers.ts";

const SHORT_SHA_LENGTH = 7;
const TOAST_DESCRIPTION_MAX = 72;
const MAX_PROGRESS_TEXT_LENGTH = 500;

export function isNotGitRepositoryError(error: GitCommandError): boolean {
  return isNotGitRepositoryStderr(error.message);
}

export interface OpenPrInfo {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
}

export interface PullRequestInfo extends OpenPrInfo, PullRequestHeadRemoteInfo {
  state: "open" | "closed" | "merged";
  updatedAt: string | null;
  isDraft?: boolean;
}

export interface ResolvedPullRequest {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  state: "open" | "closed" | "merged";
}

export interface PullRequestHeadRemoteInfo {
  isCrossRepository?: boolean;
  headRepositoryNameWithOwner?: string | null;
  headRepositoryOwnerLogin?: string | null;
}

export interface BranchHeadContext {
  localBranch: string;
  headBranch: string;
  headSelectors: ReadonlyArray<string>;
  preferredHeadSelector: string;
  remoteName: string | null;
  /** Normalized identity of the head remote, used to detect a branch retargeted to another repo. */
  headRemoteUrlKey: string | null;
  headRepositoryNameWithOwner: string | null;
  headRepositoryOwnerLogin: string | null;
  isCrossRepository: boolean;
}

export function parseRepositoryNameFromPullRequestUrl(url: string): string | null {
  const trimmed = url.trim();
  const match = /^https?:\/\/[^/?#\s]+\/[^/]+\/([^/]+)\/pull\/\d+(?:[/?#].*)?$/i.exec(trimmed);
  const repositoryName = match?.[1]?.trim() ?? "";
  return repositoryName.length > 0 ? repositoryName : null;
}

export function resolveHeadRepositoryNameWithOwner(
  pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
): string | null {
  const explicitRepository = pullRequest.headRepositoryNameWithOwner?.trim() ?? "";
  if (explicitRepository.length > 0) {
    return explicitRepository;
  }

  if (!pullRequest.isCrossRepository) {
    return null;
  }

  const ownerLogin = pullRequest.headRepositoryOwnerLogin?.trim() ?? "";
  const repositoryName = parseRepositoryNameFromPullRequestUrl(pullRequest.url);
  if (ownerLogin.length === 0 || !repositoryName) {
    return null;
  }

  return `${ownerLogin}/${repositoryName}`;
}

export function resolvePullRequestWorktreeLocalBranchName(
  pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
): string {
  if (!pullRequest.isCrossRepository) {
    return pullRequest.headBranch;
  }

  const sanitizedHeadBranch = sanitizeBranchFragment(pullRequest.headBranch).trim();
  const suffix = sanitizedHeadBranch.length > 0 ? sanitizedHeadBranch : "head";
  return `piedpiper/pr-${pullRequest.number}/${suffix}`;
}

/** `*.ghe.com` is GitHub Enterprise Cloud with data residency, one subdomain per enterprise. */
function isGitHubHost(host: string): boolean {
  if (
    host.endsWith(".github.io") ||
    host === "githubusercontent.com" ||
    host.endsWith(".githubusercontent.com")
  ) {
    return false;
  }
  return host === "github.com" || host.endsWith(".ghe.com") || host.split(".").includes("github");
}

export interface GitHubRemote {
  readonly host: string;
  readonly nameWithOwner: string;
}

/** Parses a GitHub (github.com, GHES or *.ghe.com) remote into its canonical host and owner/repo. */
export function parseGitHubRemoteUrl(url: string | null): GitHubRemote | null {
  const parsed = parseRemoteUrl(url);
  if (!parsed || !isGitHubHost(parsed.host)) {
    return null;
  }

  const segments = parsed.path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (segments.length !== 2 || segments.some((segment) => segment.trim().length === 0)) {
    return null;
  }
  return { host: canonicalGitHubHost(parsed.host), nameWithOwner: segments.join("/") };
}

export function parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url: string | null): string | null {
  return parseGitHubRemoteUrl(url)?.nameWithOwner ?? null;
}

/** True for `ssh://`, `git+ssh://`, `user@host:path` and userless `host:path` remotes. */
export function isSshRemoteUrl(url: string | null): boolean {
  return parseRemoteUrl(url)?.isSsh ?? false;
}

export function parseRepositoryOwnerLogin(nameWithOwner: string | null): string | null {
  const trimmed = nameWithOwner?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  const [ownerLogin] = trimmed.split("/");
  const normalizedOwnerLogin = ownerLogin?.trim() ?? "";
  return normalizedOwnerLogin.length > 0 ? normalizedOwnerLogin : null;
}

export function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeOptionalRepositoryNameWithOwner(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

export function normalizeOptionalOwnerLogin(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

export function resolvePullRequestHeadRepositoryNameWithOwner(
  pr: PullRequestHeadRemoteInfo & { url: string },
) {
  const explicitRepository = normalizeOptionalString(pr.headRepositoryNameWithOwner);
  if (explicitRepository) {
    return explicitRepository;
  }

  if (!pr.isCrossRepository) {
    return null;
  }

  const ownerLogin = normalizeOptionalString(pr.headRepositoryOwnerLogin);
  const repositoryName = parseRepositoryNameFromPullRequestUrl(pr.url);
  if (!ownerLogin || !repositoryName) {
    return null;
  }

  return `${ownerLogin}/${repositoryName}`;
}

export function matchesBranchHeadContext(
  pr: PullRequestInfo,
  headContext: Pick<
    BranchHeadContext,
    "headBranch" | "headRepositoryNameWithOwner" | "headRepositoryOwnerLogin" | "isCrossRepository"
  >,
): boolean {
  if (pr.headRefName !== headContext.headBranch) {
    return false;
  }

  const expectedHeadRepository = normalizeOptionalRepositoryNameWithOwner(
    headContext.headRepositoryNameWithOwner,
  );
  const expectedHeadOwner =
    normalizeOptionalOwnerLogin(headContext.headRepositoryOwnerLogin) ??
    parseRepositoryOwnerLogin(expectedHeadRepository);
  const prHeadRepository = normalizeOptionalRepositoryNameWithOwner(
    resolvePullRequestHeadRepositoryNameWithOwner(pr),
  );
  const prHeadOwner =
    normalizeOptionalOwnerLogin(pr.headRepositoryOwnerLogin) ??
    parseRepositoryOwnerLogin(prHeadRepository);
  const hasExpectedIdentity = expectedHeadRepository !== null || expectedHeadOwner !== null;
  const hasPrIdentity = prHeadRepository !== null || prHeadOwner !== null;

  if (expectedHeadRepository && prHeadRepository && expectedHeadRepository !== prHeadRepository) {
    return false;
  }
  if (expectedHeadOwner && prHeadOwner && expectedHeadOwner !== prHeadOwner) {
    return false;
  }

  if (headContext.isCrossRepository) {
    if (pr.isCrossRepository === false) {
      return false;
    }
    return !(hasExpectedIdentity && !hasPrIdentity);
  }

  // Fork workflow: origin is the user's fork and the PR targets upstream, so GitHub reports it as
  // cross-repository; accept it only when both head identities are known and matched above.
  if (pr.isCrossRepository === true) {
    return hasExpectedIdentity && hasPrIdentity;
  }
  return true;
}

export function parsePullRequestList(raw: unknown): PullRequestInfo[] {
  if (!Array.isArray(raw)) return [];

  const parsed: PullRequestInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const number = record.number;
    const title = record.title;
    const url = record.url;
    const baseRefName = record.baseRefName;
    const headRefName = record.headRefName;
    const state = record.state;
    const mergedAt = record.mergedAt;
    const updatedAt = record.updatedAt;
    const isDraft = record.isDraft;
    const isCrossRepository = record.isCrossRepository;
    const headRepositoryRecord =
      typeof record.headRepository === "object" && record.headRepository !== null
        ? (record.headRepository as Record<string, unknown>)
        : null;
    const headRepositoryOwnerRecord =
      typeof record.headRepositoryOwner === "object" && record.headRepositoryOwner !== null
        ? (record.headRepositoryOwner as Record<string, unknown>)
        : null;
    const headRepositoryNameWithOwner =
      typeof record.headRepositoryNameWithOwner === "string"
        ? record.headRepositoryNameWithOwner
        : typeof headRepositoryRecord?.nameWithOwner === "string"
          ? headRepositoryRecord.nameWithOwner
          : null;
    const headRepositoryOwnerLogin =
      typeof record.headRepositoryOwnerLogin === "string"
        ? record.headRepositoryOwnerLogin
        : typeof headRepositoryOwnerRecord?.login === "string"
          ? headRepositoryOwnerRecord.login
          : null;
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
      continue;
    }
    if (
      typeof title !== "string" ||
      typeof url !== "string" ||
      typeof baseRefName !== "string" ||
      typeof headRefName !== "string"
    ) {
      continue;
    }

    let normalizedState: "open" | "closed" | "merged";
    if (
      (typeof mergedAt === "string" && mergedAt.trim().length > 0) ||
      state === "MERGED" ||
      state === "merged"
    ) {
      normalizedState = "merged";
    } else if (state === "OPEN" || state === "open" || state === undefined || state === null) {
      normalizedState = "open";
    } else if (state === "CLOSED" || state === "closed") {
      normalizedState = "closed";
    } else {
      continue;
    }

    parsed.push({
      number,
      title,
      url,
      baseRefName,
      headRefName,
      state: normalizedState,
      updatedAt: typeof updatedAt === "string" && updatedAt.trim().length > 0 ? updatedAt : null,
      ...(typeof isDraft === "boolean" ? { isDraft } : {}),
      ...(typeof isCrossRepository === "boolean" ? { isCrossRepository } : {}),
      ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
      ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
    });
  }
  return parsed;
}

export function toPullRequestInfo(summary: GitHubPullRequestSummary): PullRequestInfo {
  return {
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state ?? "open",
    updatedAt: null,
    ...(summary.isDraft !== undefined ? { isDraft: summary.isDraft } : {}),
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}

export function gitManagerError(
  operation: string,
  detail: string,
  cause?: unknown,
): GitManagerError {
  return new GitManagerError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export function limitContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${sliceSurrogateSafe(value, maxChars)}\n\n[truncated]`;
}

export function shortenSha(sha: string | undefined): string | null {
  if (!sha) return null;
  return sha.slice(0, SHORT_SHA_LENGTH);
}

export function truncateText(
  value: string | undefined,
  maxLength = TOAST_DESCRIPTION_MAX,
): string | undefined {
  if (!value) return undefined;
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return "...".slice(0, maxLength);
  return `${sliceSurrogateSafe(value, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function withDescription(title: string, description: string | undefined) {
  return description ? { title, description } : { title };
}

export function summarizeGitActionResult(
  result: Pick<GitRunStackedActionResult, "commit" | "push" | "pr">,
): {
  title: string;
  description?: string;
} {
  if (result.pr.status === "created" || result.pr.status === "opened_existing") {
    const prNumber = result.pr.number ? ` #${result.pr.number}` : "";
    const title = `${result.pr.status === "created" ? "Created PR" : "Opened PR"}${prNumber}`;
    return withDescription(title, truncateText(result.pr.title));
  }

  if (result.push.status === "pushed") {
    const shortSha = shortenSha(result.commit.commitSha);
    const branch = result.push.upstreamBranch ?? result.push.branch;
    const pushedCommitPart = shortSha ? ` ${shortSha}` : "";
    const branchPart = branch ? ` to ${branch}` : "";
    return withDescription(
      `Pushed${pushedCommitPart}${branchPart}`,
      truncateText(result.commit.subject),
    );
  }

  if (result.commit.status === "created") {
    const shortSha = shortenSha(result.commit.commitSha);
    const title = shortSha ? `Committed ${shortSha}` : "Committed changes";
    return withDescription(title, truncateText(result.commit.subject));
  }

  return { title: "Done" };
}

export function sanitizeCommitMessage(generated: {
  subject: string;
  body: string;
  branch?: string | undefined;
}): {
  subject: string;
  body: string;
  branch?: string | undefined;
} {
  const safeSubject = sanitizeCommitSubject(generated.subject);
  return {
    subject: safeSubject,
    body: generated.body.trim(),
    ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
  };
}

export function sanitizeProgressText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length <= MAX_PROGRESS_TEXT_LENGTH) {
    return trimmed;
  }
  return sliceSurrogateSafe(trimmed, MAX_PROGRESS_TEXT_LENGTH).trimEnd();
}

export interface CommitAndBranchSuggestion {
  subject: string;
  body: string;
  branch?: string | undefined;
  commitMessage: string;
}

export function isCommitAction(action: GitStackedAction): action is "commit" | "commit_push" {
  return action === "commit" || action === "commit_push";
}

export function formatCommitMessage(subject: string, body: string): string {
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    return subject;
  }
  return `${subject}\n\n${trimmedBody}`;
}

export function parseCustomCommitMessage(raw: string): { subject: string; body: string } | null {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return null;
  }

  const [firstLine, ...rest] = normalized.split("\n");
  const subject = firstLine?.trim() ?? "";
  if (subject.length === 0) {
    return null;
  }

  return {
    subject,
    body: rest.join("\n").trim(),
  };
}

export function appendUnique(values: string[], next: string | null | undefined): void {
  const trimmed = next?.trim() ?? "";
  if (trimmed.length === 0 || values.includes(trimmed)) {
    return;
  }
  values.push(trimmed);
}

export function toStatusPr(pr: PullRequestInfo): {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  state: "open" | "closed" | "merged";
  isDraft?: boolean;
} {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    state: pr.state,
    ...(pr.isDraft !== undefined ? { isDraft: pr.isDraft } : {}),
  };
}

export function normalizePullRequestReference(reference: string): string {
  const trimmed = reference.trim();
  const hashNumber = /^#(\d+)$/.exec(trimmed);
  return hashNumber?.[1] ?? trimmed;
}

export async function canonicalizeExistingPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return value;
  }
}

export function toResolvedPullRequest(pr: {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  state?: "open" | "closed" | "merged";
}): ResolvedPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    state: pr.state ?? "open",
  };
}

export function shouldPreferSshRemote(url: string | null): boolean {
  return isSshRemoteUrl(url);
}

export function toPullRequestHeadRemoteInfo(pr: {
  isCrossRepository?: boolean;
  headRepositoryNameWithOwner?: string | null;
  headRepositoryOwnerLogin?: string | null;
}): PullRequestHeadRemoteInfo {
  return {
    ...(pr.isCrossRepository !== undefined ? { isCrossRepository: pr.isCrossRepository } : {}),
    ...(pr.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: pr.headRepositoryNameWithOwner }
      : {}),
    ...(pr.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: pr.headRepositoryOwnerLogin }
      : {}),
  };
}
