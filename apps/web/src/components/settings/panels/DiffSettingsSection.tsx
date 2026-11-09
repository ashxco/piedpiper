import { type DiffColorScheme, type DiffLayout } from "@piedpiper/contracts/settings";

import { useSettings, useUpdateSettings } from "../../../hooks/useSettings";
import { Switch } from "../../ui/switch";
import {
  SettingDefaultResetButton,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  type SettingsSelectOption,
} from "./SettingsPrimitives";

const DIFF_LAYOUT_OPTIONS: ReadonlyArray<SettingsSelectOption<DiffLayout>> = [
  { value: "stacked", label: "Stacked" },
  { value: "split", label: "Split" },
];

const DIFF_COLOR_SCHEME_OPTIONS: ReadonlyArray<SettingsSelectOption<DiffColorScheme>> = [
  { value: "red-green", label: "Red and green" },
  { value: "blue-orange", label: "Blue and orange" },
];

/** Defaults for the diff panel (all client settings). */
export function DiffSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  return (
    <SettingsSection id="setting-section-diffs" title="Diffs">
      <SettingsRow
        id="setting-diff-layout"
        title="Diff layout"
        description="Show changes stacked in one column or split side by side."
        resetAction={<SettingDefaultResetButton setting="diffLayout" label="diff layout" />}
        control={
          <SettingsSelect
            value={settings.diffLayout}
            options={DIFF_LAYOUT_OPTIONS}
            onValueChange={(diffLayout) => updateSettings({ diffLayout })}
            ariaLabel="Diff layout"
          />
        }
      />

      <SettingsRow
        id="setting-diff-line-wrapping"
        title="Diff line wrapping"
        description="Set the default wrap state when the diff panel opens."
        resetAction={
          <SettingDefaultResetButton setting="diffWordWrap" label="diff line wrapping" />
        }
        control={
          <Switch
            checked={settings.diffWordWrap}
            onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
            aria-label="Wrap diff lines by default"
          />
        }
      />

      <SettingsRow
        id="setting-collapse-files"
        title="Collapse files"
        description="Start each file in the diff panel collapsed."
        resetAction={
          <SettingDefaultResetButton setting="diffFilesCollapsed" label="collapse files" />
        }
        control={
          <Switch
            checked={settings.diffFilesCollapsed}
            onCheckedChange={(checked) => updateSettings({ diffFilesCollapsed: Boolean(checked) })}
            aria-label="Collapse diff files by default"
          />
        }
      />

      <SettingsRow
        id="setting-hide-whitespace"
        title="Hide whitespace changes"
        description="Leave out lines that only change indentation or spacing."
        resetAction={
          <SettingDefaultResetButton
            setting="diffIgnoreWhitespace"
            label="hide whitespace changes"
          />
        }
        control={
          <Switch
            checked={settings.diffIgnoreWhitespace}
            onCheckedChange={(checked) =>
              updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
            }
            aria-label="Hide whitespace changes in diffs"
          />
        }
      />

      <SettingsRow
        id="setting-diff-colours"
        title="Diff colours"
        description="Blue and orange is easier to tell apart with red-green colour blindness."
        resetAction={<SettingDefaultResetButton setting="diffColorScheme" label="diff colours" />}
        control={
          <SettingsSelect
            value={settings.diffColorScheme}
            options={DIFF_COLOR_SCHEME_OPTIONS}
            onValueChange={(diffColorScheme) => updateSettings({ diffColorScheme })}
            ariaLabel="Diff colours"
          />
        }
      />
    </SettingsSection>
  );
}
