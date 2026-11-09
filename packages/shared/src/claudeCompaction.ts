/**
 * Copy for Claude's resume compaction dialog. The server asks the question and
 * the web client may recognize it, so both sides must use these strings.
 */
export const CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER = "Compact and continue";
export const CLAUDE_RESUME_COMPACTION_KEEP_ANSWER = "Keep full history";
export const CLAUDE_RESUME_COMPACTION_NEVER_ANSWER = "Don't ask again";

export function formatClaudeResumeCompactionQuestion(input: {
  readonly ageMinutes: number;
  readonly estimatedTokens: number;
}): string {
  const ageLabel =
    input.ageMinutes >= 60
      ? `${Math.floor(input.ageMinutes / 60)}h ${input.ageMinutes % 60}m`
      : `${input.ageMinutes}m`;
  return `This session is ${ageLabel} old and uses ${input.estimatedTokens.toLocaleString("en-US")} tokens. Compact it before continuing?`;
}

const CLAUDE_RESUME_COMPACTION_QUESTION_PATTERN =
  /^This session is (?:\d+h \d+m|\d+m) old and uses \d{1,3}(?:,\d{3})* tokens\. Compact it before continuing\?$/u;

// Reserved for a web client that mirrors the "Don't ask again" resume-compaction dismissal.
export function isClaudeResumeCompactionQuestion(question: string): boolean {
  return CLAUDE_RESUME_COMPACTION_QUESTION_PATTERN.test(question);
}

/** Maps the user's answer to the `resume_return` dialog result; anything unclear keeps full history. */
export function claudeResumeCompactionAction(answer: unknown): "compact" | "continue" | "never" {
  const selection = Array.isArray(answer) ? answer[0] : answer;
  if (selection === CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER) return "compact";
  if (selection === CLAUDE_RESUME_COMPACTION_NEVER_ANSWER) return "never";
  return "continue";
}
