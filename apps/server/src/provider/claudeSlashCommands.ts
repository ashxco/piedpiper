/** A command the `/` menu can offer; the same shape goes over the wire. */
export interface ClaudeSlashCommand {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
}

/** `pending` means discovery failed for now, so a client may ask again after the cooldown. */
export interface ClaudeSlashCommandList {
  readonly commands: ReadonlyArray<ClaudeSlashCommand>;
  readonly pending: boolean;
}

/** One row of the SDK's `SlashCommand`, whose `builtin` marks the row `/name` actually runs. */
export interface ClaudeReportedSlashCommand {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly builtin?: boolean;
}

/** Always offered: it needs no discovery, and the CLI handles it locally. */
export const CLAUDE_COMPACT_COMMAND: ClaudeSlashCommand = {
  name: "compact",
  description: "Free up context by summarizing the conversation so far",
  argumentHint: "<optional custom summarization instructions>",
};

// Pied Piper has no advisors or skill UI, and the workflow row is an internal handoff.
const HIDDEN_COMMANDS: ReadonlySet<string> = new Set([
  "advisor",
  "reload-skills",
  "skill-doctor",
  "workflow-launch-exec",
]);

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toCommand(name: string, row: ClaudeReportedSlashCommand): ClaudeSlashCommand {
  const description = nonEmpty(row.description);
  const argumentHint = nonEmpty(row.argumentHint);
  return {
    name,
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
  };
}

/**
 * Plain commands from the SDK's initialize rows, each name once. Names the SDK's init
 * message lists as skills or as terminal-only are left out, since neither belongs here.
 */
export function parseClaudeSlashCommands(
  rows: ReadonlyArray<ClaudeReportedSlashCommand> | undefined,
  excluded: {
    readonly skills?: ReadonlyArray<string> | undefined;
    readonly terminalCommands?: ReadonlyArray<string> | undefined;
  } = {},
): ReadonlyArray<ClaudeSlashCommand> {
  const hidden = new Set(
    [...(excluded.skills ?? []), ...(excluded.terminalCommands ?? [])].map((name) =>
      name.trim().toLowerCase(),
    ),
  );
  const byName = new Map<string, ClaudeSlashCommand>();
  const builtinNames = new Set<string>();

  for (const row of rows ?? []) {
    const name = nonEmpty(row.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (hidden.has(key) || HIDDEN_COMMANDS.has(key) || key.startsWith("__")) continue;

    const command = toCommand(name, row);
    const existing = byName.get(key);
    // When rows share a name, `/name` runs the built-in one, so its text wins.
    if (!existing || (row.builtin === true && !builtinNames.has(key))) {
      byName.set(key, existing ? { ...existing, ...command } : command);
    } else {
      byName.set(key, { ...command, ...existing });
    }
    if (row.builtin === true) builtinNames.add(key);
  }

  return [...byName.values()];
}

/** Claude expands a command only at the very start of a message, so nothing may precede it. */
export function isClaudeSlashCommandPrompt(text: string): boolean {
  return /^\/[^\s/]+(\s|$)/.test(text.trim());
}

/** The commands with `/compact` added when discovery did not report it. */
export function withClaudeCompactCommand(
  commands: ReadonlyArray<ClaudeSlashCommand>,
): ReadonlyArray<ClaudeSlashCommand> {
  return commands.some((command) => command.name.toLowerCase() === CLAUDE_COMPACT_COMMAND.name)
    ? commands
    : [...commands, CLAUDE_COMPACT_COMMAND];
}
