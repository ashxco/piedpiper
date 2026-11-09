import {
  type ChatWidth,
  DEFAULT_APPEARANCE_CONTRAST,
  DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT,
  MAX_APPEARANCE_CONTRAST,
  MAX_CODE_FONT_SIZE,
  MAX_INTERFACE_FONT_SIZE,
  MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  MAX_TERMINAL_FONT_SIZE,
  MIN_APPEARANCE_CONTRAST,
  MIN_CODE_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
  MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
  MIN_TERMINAL_FONT_SIZE,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_INTERFACE_FONT_SIZE,
  DEFAULT_TERMINAL_FONT_SIZE,
} from "@piedpiper/contracts/settings";
import { clampIntegerSetting } from "@piedpiper/shared/serverSettings";

import { useSettings, useUpdateSettings } from "../../../hooks/useSettings";
import {
  integerRange,
  SettingDefaultResetButton,
  SettingsDraftInput,
  SettingsNumberSelect,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  type SettingsSelectOption,
  SettingsSlider,
} from "./SettingsPrimitives";

const CHAT_WIDTH_OPTIONS: ReadonlyArray<SettingsSelectOption<ChatWidth>> = [
  { value: "comfortable", label: "Comfortable" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full width" },
];

const SIDEBAR_THREAD_PREVIEW_COUNT_PRESETS = [3, 5, 6, 8, 10, 15, 20, 30, 50] as const;

const formatPx = (value: number) => `${value}px`;
const formatPercent = (value: number) => `${value}%`;

/** Layout, font and sidebar density preferences (all client settings). */
export function AppearanceSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  return (
    <SettingsSection id="setting-section-appearance" title="Appearance">
      <SettingsRow
        id="setting-chat-width"
        title="Chat width"
        description="Set how wide messages and the composer can grow on large screens."
        resetAction={<SettingDefaultResetButton setting="chatWidth" label="chat width" />}
        control={
          <SettingsSelect
            value={settings.chatWidth}
            options={CHAT_WIDTH_OPTIONS}
            onValueChange={(chatWidth) => updateSettings({ chatWidth })}
            ariaLabel="Chat width"
          />
        }
      />

      <SettingsRow
        id="setting-contrast"
        title="Contrast"
        description="Adjust the contrast of text and borders across the app."
        resetAction={<SettingDefaultResetButton setting="appearanceContrast" label="contrast" />}
        control={
          <SettingsSlider
            value={settings.appearanceContrast}
            minimum={MIN_APPEARANCE_CONTRAST}
            maximum={MAX_APPEARANCE_CONTRAST}
            step={5}
            formatLabel={formatPercent}
            onValueChange={(value) =>
              updateSettings({
                appearanceContrast: clampIntegerSetting(value, {
                  minimum: MIN_APPEARANCE_CONTRAST,
                  maximum: MAX_APPEARANCE_CONTRAST,
                  fallback: DEFAULT_APPEARANCE_CONTRAST,
                }),
              })
            }
            ariaLabel="Contrast"
          />
        }
      />

      <SettingsRow
        id="setting-interface-font-size"
        title="Interface font size"
        description="Scale text across the app."
        resetAction={
          <SettingDefaultResetButton setting="fontSizeInterface" label="interface font size" />
        }
        control={
          <SettingsNumberSelect
            value={settings.fontSizeInterface}
            options={integerRange(MIN_INTERFACE_FONT_SIZE, MAX_INTERFACE_FONT_SIZE)}
            formatLabel={formatPx}
            onValueChange={(value) =>
              updateSettings({
                fontSizeInterface: clampIntegerSetting(value, {
                  minimum: MIN_INTERFACE_FONT_SIZE,
                  maximum: MAX_INTERFACE_FONT_SIZE,
                  fallback: DEFAULT_INTERFACE_FONT_SIZE,
                }),
              })
            }
            ariaLabel="Interface font size"
          />
        }
      />

      <SettingsRow
        id="setting-code-font-size"
        title="Code font size"
        description="Text size of code blocks in chat."
        resetAction={<SettingDefaultResetButton setting="fontSizeCode" label="code font size" />}
        control={
          <SettingsNumberSelect
            value={settings.fontSizeCode}
            options={integerRange(MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE)}
            formatLabel={formatPx}
            onValueChange={(value) =>
              updateSettings({
                fontSizeCode: clampIntegerSetting(value, {
                  minimum: MIN_CODE_FONT_SIZE,
                  maximum: MAX_CODE_FONT_SIZE,
                  fallback: DEFAULT_CODE_FONT_SIZE,
                }),
              })
            }
            ariaLabel="Code font size"
          />
        }
      />

      <SettingsRow
        id="setting-code-font"
        title="Code font"
        description="Font family for code blocks and diffs. Leave empty for the default monospace font."
        resetAction={<SettingDefaultResetButton setting="fontFamilyCode" label="code font" />}
        control={
          <SettingsDraftInput
            value={settings.fontFamilyCode}
            onCommit={(fontFamilyCode) => updateSettings({ fontFamilyCode })}
            ariaLabel="Code font family"
            placeholder="SF Mono"
            className="sm:w-56"
          />
        }
      />

      <SettingsRow
        id="setting-terminal-font-size"
        title="Terminal font size"
        description="Text size in the thread terminal."
        resetAction={
          <SettingDefaultResetButton setting="fontSizeTerminal" label="terminal font size" />
        }
        control={
          <SettingsNumberSelect
            value={settings.fontSizeTerminal}
            options={integerRange(MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE)}
            formatLabel={formatPx}
            onValueChange={(value) =>
              updateSettings({
                fontSizeTerminal: clampIntegerSetting(value, {
                  minimum: MIN_TERMINAL_FONT_SIZE,
                  maximum: MAX_TERMINAL_FONT_SIZE,
                  fallback: DEFAULT_TERMINAL_FONT_SIZE,
                }),
              })
            }
            ariaLabel="Terminal font size"
          />
        }
      />

      <SettingsRow
        id="setting-terminal-font"
        title="Terminal font"
        description="Font family for the thread terminal. Leave empty for the system monospace font."
        resetAction={
          <SettingDefaultResetButton setting="fontFamilyTerminal" label="terminal font" />
        }
        control={
          <SettingsDraftInput
            value={settings.fontFamilyTerminal}
            onCommit={(fontFamilyTerminal) => updateSettings({ fontFamilyTerminal })}
            ariaLabel="Terminal font family"
            placeholder="SF Mono"
            className="sm:w-56"
          />
        }
      />

      <SettingsRow
        id="setting-sidebar-threads"
        title="Sidebar threads"
        description="Number of threads shown per project before Show more."
        resetAction={
          <SettingDefaultResetButton setting="sidebarThreadPreviewCount" label="sidebar threads" />
        }
        control={
          <SettingsNumberSelect
            value={settings.sidebarThreadPreviewCount}
            options={SIDEBAR_THREAD_PREVIEW_COUNT_PRESETS}
            onValueChange={(value) =>
              updateSettings({
                sidebarThreadPreviewCount: clampIntegerSetting(value, {
                  minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
                  maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
                  fallback: DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT,
                }),
              })
            }
            ariaLabel="Threads shown per project"
          />
        }
      />
    </SettingsSection>
  );
}
