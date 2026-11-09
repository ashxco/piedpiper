/**
 * Status message for a provider CLI that could not be started: names the configured command
 * and where to change it, since a missing CLI is usually a PATH or binary-path problem.
 */
const formatMissingProviderCliMessage = (input: {
  /** Product name shown to the user, e.g. "Codex CLI". */
  readonly cliName: string;
  /** The configured command or path that failed to start. */
  readonly binaryPath: string;
  /** The default command name, used to tell a custom path from the default. */
  readonly defaultBinaryPath: string;
  /** Where the binary path is changed, e.g. "Settings → General → Providers → Claude". */
  readonly settingLocation: string;
  /** Extra hint shown only when the default command is in use. */
  readonly defaultBinaryHint?: string;
}): string => {
  const base = `Could not start ${input.cliName} (\`${input.binaryPath}\`). Check ${input.settingLocation}.`;
  if (input.binaryPath.trim() !== input.defaultBinaryPath) {
    return `${base} Make sure the configured executable exists and can be run.`;
  }
  return input.defaultBinaryHint ? `${base} ${input.defaultBinaryHint}` : base;
};

export const formatMissingCodexCliMessage = (binaryPath: string): string =>
  formatMissingProviderCliMessage({
    cliName: "Codex CLI",
    binaryPath,
    defaultBinaryPath: "codex",
    // Pied Piper has no Codex settings card, so the path is only editable in settings.json.
    settingLocation: "`providers.codex.binaryPath` in the server's settings.json",
    defaultBinaryHint: "Installing the ChatGPT or Codex desktop app may not add codex to PATH.",
  });

export const formatMissingClaudeCliMessage = (binaryPath: string): string =>
  formatMissingProviderCliMessage({
    cliName: "Claude Agent CLI",
    binaryPath,
    defaultBinaryPath: "claude",
    settingLocation: "Settings → General → Providers → Claude → Claude binary path",
    defaultBinaryHint: "Install Claude Code or make sure claude is on PATH.",
  });
