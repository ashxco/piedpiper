import {
  type BranchNamingMode,
  type CommitMessageStyleMode,
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL_MS,
  MAX_AUTOMATIC_GIT_FETCH_INTERVAL_MS,
  type WorktreeSubmodules,
} from "@piedpiper/contracts/settings";
import { clampIntegerSetting } from "@piedpiper/shared/serverSettings";

import { useSettings, useUpdateSettings } from "../../../hooks/useSettings";
import { Switch } from "../../ui/switch";
import { formatIntervalLabel, validateAbsoluteOrHomePath } from "./settingValueHelpers";
import {
  SettingDefaultResetButton,
  SettingsDraftInput,
  SettingsNumberSelect,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  type SettingsSelectOption,
} from "./SettingsPrimitives";

const COMMIT_MESSAGE_STYLE_OPTIONS: ReadonlyArray<SettingsSelectOption<CommitMessageStyleMode>> = [
  { value: "repo_conventions", label: "Match the repository" },
  { value: "conventional_commits", label: "Conventional Commits" },
  { value: "custom", label: "Custom" },
];

const WORKTREE_SUBMODULES_OPTIONS: ReadonlyArray<SettingsSelectOption<WorktreeSubmodules>> = [
  { value: "recursive", label: "All, recursively" },
  { value: "top-level", label: "Top level only" },
  { value: "none", label: "Don't check out" },
];

const BRANCH_NAMING_MODE_OPTIONS: ReadonlyArray<SettingsSelectOption<BranchNamingMode>> = [
  { value: "static", label: "Fixed prefix" },
  { value: "semantic", label: "Descriptive prefix" },
  { value: "custom", label: "Custom instructions" },
];

const AUTOMATIC_GIT_FETCH_INTERVAL_PRESETS_MS = [
  0, 15_000, 30_000, 60_000, 300_000, 900_000,
] as const;

/** Git, commit message and worktree preferences (all server settings). */
export function GitSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  return (
    <SettingsSection id="setting-section-git" title="Git">
      <SettingsRow
        id="setting-commit-message-style"
        title="Commit message style"
        description="Rules the text generation model follows when it writes commit messages."
        resetAction={
          <SettingDefaultResetButton setting="commitMessageStyle" label="commit message style" />
        }
        control={
          <SettingsSelect
            value={settings.commitMessageStyle.mode}
            options={COMMIT_MESSAGE_STYLE_OPTIONS}
            onValueChange={(mode) =>
              updateSettings({ commitMessageStyle: { ...settings.commitMessageStyle, mode } })
            }
            ariaLabel="Commit message style"
            triggerClassName="w-full sm:w-52"
          />
        }
      >
        {settings.commitMessageStyle.mode === "custom" ? (
          <SettingsDraftInput
            multiline
            className="mt-3"
            value={settings.commitMessageStyle.customInstructions}
            onCommit={(customInstructions) =>
              updateSettings({
                commitMessageStyle: { ...settings.commitMessageStyle, customInstructions },
              })
            }
            ariaLabel="Custom commit message instructions"
            placeholder="For example: Start with a ticket number. Keep the subject under 60 characters."
          />
        ) : null}
      </SettingsRow>

      <SettingsRow
        id="setting-background-fetch"
        title="Background fetch"
        description="How often to fetch from the remote to keep ahead and behind counts current."
        resetAction={
          <SettingDefaultResetButton
            setting="automaticGitFetchIntervalMs"
            label="background fetch"
          />
        }
        control={
          <SettingsNumberSelect
            value={settings.automaticGitFetchIntervalMs}
            options={AUTOMATIC_GIT_FETCH_INTERVAL_PRESETS_MS}
            formatLabel={formatIntervalLabel}
            onValueChange={(value) =>
              updateSettings({
                automaticGitFetchIntervalMs: clampIntegerSetting(value, {
                  minimum: 0,
                  maximum: MAX_AUTOMATIC_GIT_FETCH_INTERVAL_MS,
                  fallback: DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL_MS,
                }),
              })
            }
            ariaLabel="Background fetch interval"
            triggerClassName="w-full sm:w-44"
          />
        }
      />

      <SettingsRow
        id="setting-pull-default-branch"
        title="Pull default branch"
        description="Fast-forward the default branch from the remote when it has no local changes."
        resetAction={
          <SettingDefaultResetButton setting="autoPullDefaultBranch" label="pull default branch" />
        }
        control={
          <Switch
            checked={settings.autoPullDefaultBranch}
            onCheckedChange={(checked) =>
              updateSettings({ autoPullDefaultBranch: Boolean(checked) })
            }
            aria-label="Pull the default branch automatically"
          />
        }
      />

      <SettingsRow
        id="setting-start-worktrees-from-remote"
        title="Start worktrees from remote"
        description="Base new worktrees on the latest remote branch instead of the local one."
        resetAction={
          <SettingDefaultResetButton
            setting="newWorktreesStartFromOrigin"
            label="start worktrees from remote"
          />
        }
        control={
          <Switch
            checked={settings.newWorktreesStartFromOrigin}
            onCheckedChange={(checked) =>
              updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
            }
            aria-label="Start new worktrees from the remote branch"
          />
        }
      />

      <SettingsRow
        id="setting-fast-worktree-checkout"
        title="Cached worktree checkout (beta)"
        description="Reuse clean checkouts with macOS copy-on-write. Uses extra disk space; performance varies by repository."
        resetAction={
          <SettingDefaultResetButton
            setting="fastWorktreeCheckout"
            label="cached worktree checkout"
          />
        }
        control={
          <Switch
            checked={settings.fastWorktreeCheckout}
            onCheckedChange={(checked) =>
              updateSettings({ fastWorktreeCheckout: Boolean(checked) })
            }
            aria-label="Cached worktree checkout"
          />
        }
      />

      <SettingsRow
        id="setting-worktree-submodules"
        title="Worktree submodules"
        description="Check out git submodules when a new worktree is created."
        resetAction={
          <SettingDefaultResetButton setting="worktreeSubmodules" label="worktree submodules" />
        }
        control={
          <SettingsSelect
            value={settings.worktreeSubmodules}
            options={WORKTREE_SUBMODULES_OPTIONS}
            onValueChange={(worktreeSubmodules) => updateSettings({ worktreeSubmodules })}
            ariaLabel="Worktree submodules"
          />
        }
      />

      <SettingsRow
        id="setting-worktree-location"
        title="Worktree location"
        description="Folder new worktrees are created in. Leave empty for the default location."
        resetAction={
          <SettingDefaultResetButton setting="worktreesDirectory" label="worktree location" />
        }
        control={
          <SettingsDraftInput
            value={settings.worktreesDirectory}
            validate={validateAbsoluteOrHomePath}
            onCommit={(worktreesDirectory) => updateSettings({ worktreesDirectory })}
            ariaLabel="Worktree location"
            placeholder="~/worktrees"
            className="sm:w-64"
          />
        }
      />

      <SettingsRow
        id="setting-branch-naming"
        title="Branch naming"
        description="How new worktree branches are named from your first message."
        status={
          settings.branchNamingMode === "semantic"
            ? "The model picks a prefix that describes the work, such as feat/add-search or fix/login-timeout."
            : undefined
        }
        resetAction={<SettingDefaultResetButton setting="branchNamingMode" label="branch naming" />}
        control={
          <SettingsSelect
            value={settings.branchNamingMode}
            options={BRANCH_NAMING_MODE_OPTIONS}
            onValueChange={(branchNamingMode) => updateSettings({ branchNamingMode })}
            ariaLabel="Branch naming"
            triggerClassName="w-full sm:w-52"
          />
        }
      />

      {settings.branchNamingMode === "static" ? (
        <SettingsRow
          title="Branch prefix"
          description="For example, acme gives acme/add-search. Leave empty for no prefix."
          resetAction={
            <SettingDefaultResetButton setting="branchNamePrefix" label="branch prefix" />
          }
          control={
            <SettingsDraftInput
              value={settings.branchNamePrefix}
              onCommit={(branchNamePrefix) => updateSettings({ branchNamePrefix })}
              ariaLabel="Branch prefix"
              placeholder="No prefix"
              className="sm:w-56"
            />
          }
        />
      ) : null}

      {settings.branchNamingMode === "custom" ? (
        <SettingsRow
          title="Branch naming instructions"
          description="Added to the naming prompt. The model returns the full branch name and no prefix is added."
          resetAction={
            <SettingDefaultResetButton
              setting="branchNameInstructions"
              label="branch naming instructions"
            />
          }
        >
          <SettingsDraftInput
            multiline
            className="mt-3"
            value={settings.branchNameInstructions}
            onCommit={(branchNameInstructions) => updateSettings({ branchNameInstructions })}
            ariaLabel="Branch naming instructions"
            placeholder="For example: Start with the ticket number, then a short description."
          />
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
