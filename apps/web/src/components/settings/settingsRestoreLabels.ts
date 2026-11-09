import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@piedpiper/contracts/settings";
import { Equal } from "effect";

/**
 * Top-level settings shown in the "Restore defaults" confirmation, in panel
 * order. `textGenerationModelSelection` and `providers` are summarised
 * separately in `useSettingsRestore`.
 * Every key here is reset by `resetSettings`, which writes all defaults.
 */
export const RESTORABLE_SETTING_LABELS: ReadonlyArray<
  readonly [key: keyof UnifiedSettings, label: string]
> = [
  // General
  ["timestampFormat", "Time format"],
  ["enableAssistantStreaming", "Assistant output"],
  ["defaultThreadEnvMode", "New thread mode"],
  ["defaultRuntimeMode", "New thread permissions"],
  ["confirmThreadArchive", "Archive confirmation"],
  ["confirmThreadDelete", "Delete confirmation"],
  ["confirmQuit", "Quit shortcut"],
  ["continueThreadsAfterRestart", "Continue after restart"],
  ["autoResumeLimitedThreads", "Resume after usage limit"],
  ["threadTitleInstructions", "Thread title instructions"],
  // Chat
  ["sendShortcut", "Send shortcut"],
  ["notificationMode", "Notifications"],
  ["toolCallVisibility", "Tool calls"],
  ["chatCodeWordWrap", "Code block wrapping"],
  ["mathRenderingEnabled", "Math rendering"],
  // Appearance
  ["chatWidth", "Chat width"],
  ["appearanceContrast", "Contrast"],
  ["fontSizeInterface", "Interface font size"],
  ["fontSizeCode", "Code font size"],
  ["fontFamilyCode", "Code font"],
  ["fontSizeTerminal", "Terminal font size"],
  ["fontFamilyTerminal", "Terminal font"],
  ["sidebarThreadPreviewCount", "Sidebar threads"],
  // Diffs
  ["diffLayout", "Diff layout"],
  ["diffWordWrap", "Diff line wrapping"],
  ["diffFilesCollapsed", "Collapse files"],
  ["diffIgnoreWhitespace", "Hide whitespace changes"],
  ["diffColorScheme", "Diff colours"],
  // Git
  ["commitMessageStyle", "Commit message style"],
  ["automaticGitFetchIntervalMs", "Background fetch"],
  ["autoPullDefaultBranch", "Pull default branch"],
  ["newWorktreesStartFromOrigin", "Start worktrees from remote"],
  ["fastWorktreeCheckout", "Faster worktree checkout"],
  ["worktreeSubmodules", "Worktree submodules"],
  ["worktreesDirectory", "Worktree location"],
  ["branchNamingMode", "Branch naming"],
  ["branchNamePrefix", "Branch prefix"],
  ["branchNameInstructions", "Branch naming instructions"],
  // Providers
  ["providerHealthRefreshIntervalMs", "Provider health checks"],
  ["enableProviderUpdateChecks", "CLI update checks"],
  // Diagnostics
  ["observability", "OTLP endpoints"],
  // Model picker: set from the picker, with no row here, but restoring still clears them.
  ["favorites", "Favorite models"],
  ["hiddenModels", "Hidden models"],
];

export function getChangedTopLevelSettingLabels(settings: UnifiedSettings): string[] {
  return RESTORABLE_SETTING_LABELS.filter(
    ([key]) => !Equal.equals(settings[key], DEFAULT_UNIFIED_SETTINGS[key]),
  ).map(([, label]) => label);
}
