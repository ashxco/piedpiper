export type SettingsTabPath =
  | "/settings/general"
  | "/settings/keybindings"
  | "/settings/archived"
  | "/settings/diagnostics";

export interface SettingsSearchEntry {
  readonly id: string;
  readonly title: string;
  /** Shown beside the title in results. */
  readonly section: string;
  readonly to: SettingsTabPath;
  /**
   * DOM id to scroll to. A row that is not always rendered anchors to its section;
   * an entry that names a whole tab has none.
   */
  readonly anchor?: string;
  readonly terms?: ReadonlyArray<string>;
}

const GENERAL = "/settings/general";
const row = (
  id: string,
  title: string,
  section: string,
  terms?: ReadonlyArray<string>,
): SettingsSearchEntry => ({
  id,
  title,
  section,
  to: GENERAL,
  anchor: `setting-${id}`,
  ...(terms ? { terms } : {}),
});
const inSection = (
  id: string,
  title: string,
  section: string,
  terms?: ReadonlyArray<string>,
): SettingsSearchEntry => ({
  id,
  title,
  section,
  to: GENERAL,
  anchor: `setting-section-${section.toLowerCase()}`,
  ...(terms ? { terms } : {}),
});

export const SETTINGS_SEARCH_ENTRIES: ReadonlyArray<SettingsSearchEntry> = [
  row("theme", "Theme", "General", ["dark mode", "light mode", "appearance", "color scheme"]),
  row("time-format", "Time format", "General", ["12-hour", "24-hour", "clock", "timestamp"]),
  row("assistant-output", "Assistant output", "General", ["streaming", "stream"]),
  row("new-threads", "New threads", "General", ["worktree", "local", "default mode"]),
  row("new-thread-permissions", "New thread permissions", "General", [
    "full access",
    "supervised",
    "auto",
    "approval",
    "runtime mode",
  ]),
  row("archive-confirmation", "Archive confirmation", "General", ["confirm", "prompt"]),
  row("delete-confirmation", "Delete confirmation", "General", ["confirm", "prompt"]),
  inSection("quit-shortcut", "Quit shortcut", "General", ["hold to quit", "cmd q", "close app"]),
  row("continue-after-restart", "Continue after restart", "General", ["resume", "reopen"]),
  row("resume-after-usage-limit", "Resume after usage limit", "General", [
    "rate limit",
    "quota",
    "auto resume",
  ]),
  row("text-generation-model", "Text generation model", "General", [
    "commit message model",
    "title model",
    "ai",
  ]),
  row("thread-title-instructions", "Thread title instructions", "General", [
    "rename",
    "naming",
    "prompt",
  ]),

  row("send-shortcut", "Send shortcut", "Chat", ["enter", "submit", "newline", "cmd enter"]),
  row("notifications", "Notifications", "Chat", ["alert", "sound", "desktop notification"]),
  row("tool-calls", "Tool calls", "Chat", ["visibility", "hide", "zen", "commands"]),
  row("code-block-wrapping", "Code block wrapping", "Chat", ["line wrap", "soft wrap"]),
  row("math-rendering", "Math rendering", "Chat", ["katex", "latex", "equations"]),

  row("chat-width", "Chat width", "Appearance", ["layout", "column", "wide", "narrow"]),
  row("contrast", "Contrast", "Appearance", ["accessibility", "colors"]),
  row("interface-font-size", "Interface font size", "Appearance", ["text size", "zoom", "ui"]),
  row("code-font-size", "Code font size", "Appearance", ["monospace", "text size"]),
  row("code-font", "Code font", "Appearance", ["monospace", "typeface", "font family"]),
  row("terminal-font-size", "Terminal font size", "Appearance", ["text size", "shell"]),
  row("terminal-font", "Terminal font", "Appearance", ["monospace", "typeface", "font family"]),
  row("sidebar-threads", "Sidebar threads", "Appearance", ["sort", "order", "list"]),

  row("diff-layout", "Diff layout", "Diffs", ["split", "unified", "side by side"]),
  row("diff-line-wrapping", "Diff line wrapping", "Diffs", ["soft wrap"]),
  row("collapse-files", "Collapse files", "Diffs", ["fold", "expand"]),
  row("hide-whitespace", "Hide whitespace changes", "Diffs", ["ignore whitespace", "spaces"]),
  row("diff-colours", "Diff colours", "Diffs", ["colors", "theme", "color blind"]),

  row("commit-message-style", "Commit message style", "Git", ["conventional commits"]),
  row("background-fetch", "Background fetch", "Git", ["refresh", "remote", "interval"]),
  row("pull-default-branch", "Pull default branch", "Git", ["main", "master", "sync"]),
  row("start-worktrees-from-remote", "Start worktrees from remote", "Git", ["origin", "base"]),
  row("worktree-submodules", "Worktree submodules", "Git", ["init", "recursive"]),
  row("worktree-location", "Worktree location", "Git", ["directory", "folder", "path"]),
  row("branch-naming", "Branch naming", "Git", ["semantic", "generated", "name"]),
  inSection("branch-prefix", "Branch prefix", "Git", ["namespace", "name"]),
  inSection("branch-naming-instructions", "Branch naming instructions", "Git", ["prompt"]),

  inSection("claude", "Claude", "Providers", ["anthropic", "provider", "enable"]),
  inSection("binary-path", "Binary path", "Providers", ["cli", "executable", "command"]),
  inSection("config-directory", "Config directory", "Providers", ["claude home", "login"]),
  inSection("launch-arguments", "Launch arguments", "Providers", ["cli flags", "launch args"]),
  inSection("auto-compact-window", "Auto-compact window", "Providers", [
    "context",
    "compaction",
    "claude",
  ]),
  inSection("custom-models", "Custom models", "Providers", ["add model", "model slug"]),
  inSection("usage-limits", "Usage limits", "Providers", ["rate limit", "quota", "weekly"]),
  inSection("codex-usage", "Codex usage", "Providers", ["rate limit", "quota", "weekly"]),
  row("provider-health-checks", "Provider health checks", "Providers", ["status", "refresh"]),
  row("cli-update-checks", "CLI update checks", "Providers", [
    "npm",
    "new version",
    "out of date",
    "upgrade",
  ]),

  row("keybindings-file", "Keybindings", "Advanced", ["config file", "json", "shortcuts"]),
  row("diagnostics", "Diagnostics", "About", ["logs", "tracing", "otlp", "debug"]),
  row("usage-data", "Usage data", "About", ["telemetry", "analytics", "posthog", "opt out"]),
  inSection("version", "Version", "About", ["about", "update", "release"]),

  {
    id: "keybindings",
    title: "Keyboard shortcuts",
    section: "Keybindings",
    to: "/settings/keybindings",
    terms: ["keybindings", "hotkeys", "rebind", "commands"],
  },
  {
    id: "archived-threads",
    title: "Archived threads",
    section: "Archived",
    to: "/settings/archived",
    terms: ["archive", "unarchive", "restore", "delete all"],
  },
  {
    id: "archived-projects",
    title: "Archived projects",
    section: "Archived",
    to: "/settings/archived",
    terms: ["archive", "unarchive", "restore"],
  },
  {
    id: "trace-summary",
    title: "Traces",
    section: "Diagnostics",
    to: "/settings/diagnostics",
    anchor: "diagnostics-traces",
    terms: ["spans", "slow", "failures", "errors", "warnings", "observability"],
  },
  {
    id: "child-processes",
    title: "Child processes",
    section: "Diagnostics",
    to: "/settings/diagnostics",
    anchor: "diagnostics-processes",
    terms: ["ps", "kill", "sigkill", "sigint", "pid", "memory", "cpu", "stuck"],
  },
  {
    id: "otlp-endpoints",
    title: "OTLP endpoints",
    section: "Diagnostics",
    to: "/settings/diagnostics",
    anchor: "diagnostics-otlp",
    terms: ["opentelemetry", "otel", "telemetry export", "collector", "grafana", "metrics"],
  },
];

const MAX_RESULTS = 8;

/** Lowercase, without accents, with whitespace collapsed. */
export function normalizeSettingsSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Lower is better; null is no match. Anything in a title beats anything in a synonym. */
function scoreEntry(entry: SettingsSearchEntry, query: string): number | null {
  const title = normalizeSettingsSearchText(entry.title);
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (title.includes(` ${query}`)) return 2;
  if (title.includes(query)) return 3;

  const terms = (entry.terms ?? []).map(normalizeSettingsSearchText);
  if (terms.includes(query)) return 4;
  if (terms.some((term) => term.startsWith(query) || term.includes(` ${query}`))) return 5;
  if (terms.some((term) => term.includes(query))) return 6;

  const haystack = [title, ...terms].join(" ");
  return query.split(" ").every((word) => haystack.includes(word)) ? 7 : null;
}

export function searchSettings(
  query: string,
  entries: ReadonlyArray<SettingsSearchEntry> = SETTINGS_SEARCH_ENTRIES,
): ReadonlyArray<SettingsSearchEntry> {
  const normalized = normalizeSettingsSearchText(query);
  if (normalized.length === 0) return [];
  return entries
    .flatMap((entry, index) => {
      const score = scoreEntry(entry, normalized);
      return score === null ? [] : [{ entry, index, score }];
    })
    .toSorted((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, MAX_RESULTS)
    .map(({ entry }) => entry);
}
