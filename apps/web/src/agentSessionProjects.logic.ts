import type { AgentSessionProjectCandidate, AgentSessionSource } from "@piedpiper/contracts";

const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PRESELECT_MIN_SESSIONS = 3;

/** Only established work starts ticked: a git repository with 3+ sessions in the last 30 days. */
export function isPreselectedAgentSessionProject(
  candidate: AgentSessionProjectCandidate,
  now: number,
): boolean {
  if (!candidate.isGitRepository || candidate.threadCount < PRESELECT_MIN_SESSIONS) return false;
  if (candidate.lastActiveAt === null) return false;
  const lastActiveAt = Date.parse(candidate.lastActiveAt);
  return lastActiveAt >= now - RECENT_WINDOW_MS && lastActiveAt <= now;
}

export function defaultAgentSessionProjectSelection(
  candidates: ReadonlyArray<AgentSessionProjectCandidate>,
  now: number,
): ReadonlySet<string> {
  return new Set(
    candidates
      .filter((candidate) => isPreselectedAgentSessionProject(candidate, now))
      .map((candidate) => candidate.path),
  );
}

const SOURCE_LABELS: Record<AgentSessionSource, string> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
};

export function describeAgentSessionProject(candidate: AgentSessionProjectCandidate): string {
  const sources = candidate.sources.map((source) => SOURCE_LABELS[source]).join(" and ");
  const sessions = `${candidate.threadCount} ${candidate.threadCount === 1 ? "session" : "sessions"}`;
  return `${sources}, ${sessions}`;
}

export interface AddAgentSessionProjectsResult {
  readonly added: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{ readonly path: string; readonly message: string }>;
}

/** One at a time, so a failure only costs that project and the order stays predictable. */
export async function addAgentSessionProjects(
  candidates: ReadonlyArray<AgentSessionProjectCandidate>,
  createProject: (candidate: AgentSessionProjectCandidate) => Promise<void>,
): Promise<AddAgentSessionProjectsResult> {
  const added: string[] = [];
  const failed: Array<{ path: string; message: string }> = [];
  for (const candidate of candidates) {
    try {
      await createProject(candidate);
      added.push(candidate.path);
    } catch (error) {
      failed.push({
        path: candidate.path,
        message: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  }
  return { added, failed };
}
