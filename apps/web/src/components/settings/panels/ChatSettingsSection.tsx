import {
  type NotificationMode,
  type SendShortcut,
  type ToolCallVisibility,
} from "@piedpiper/contracts/settings";

import { useSettings, useUpdateSettings } from "../../../hooks/useSettings";
import { isMacPlatform } from "../../../lib/utils";
import {
  hasNotificationSound,
  hasSystemNotifications,
  requestThreadNotificationPermission,
  unlockNotificationAudio,
} from "../../../threadNotifications";
import { Switch } from "../../ui/switch";
import {
  SettingDefaultResetButton,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  type SettingsSelectOption,
} from "./SettingsPrimitives";

const NOTIFICATION_MODE_OPTIONS: ReadonlyArray<SettingsSelectOption<NotificationMode>> = [
  { value: "off", label: "Off" },
  { value: "notifications", label: "Notifications" },
  { value: "sound", label: "Sound" },
  { value: "notifications-and-sound", label: "Notifications and sound" },
];

const TOOL_CALL_VISIBILITY_OPTIONS: ReadonlyArray<SettingsSelectOption<ToolCallVisibility>> = [
  { value: "showAll", label: "Show all" },
  { value: "hideSuccessful", label: "Hide successful" },
  { value: "hideAll", label: "Hide all" },
  { value: "zen", label: "Zen" },
];

export function getSendShortcutOptions(
  platform: string = typeof navigator === "undefined" ? "" : navigator.platform,
): ReadonlyArray<SettingsSelectOption<SendShortcut>> {
  const modifierLabel = isMacPlatform(platform) ? "⌘" : "Ctrl";
  return [
    { value: "enter", label: "Enter" },
    { value: "mod-enter-multiline", label: `${modifierLabel} + Enter for multiline prompts` },
    { value: "mod-enter", label: `${modifierLabel} + Enter always` },
  ];
}

/** Composer, timeline and alert preferences (all client settings). */
export function ChatSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  return (
    <SettingsSection id="setting-section-chat" title="Chat">
      <SettingsRow
        id="setting-send-shortcut"
        title="Send shortcut"
        description="Choose which key sends a message. The other inserts a new line."
        resetAction={<SettingDefaultResetButton setting="sendShortcut" label="send shortcut" />}
        control={
          <SettingsSelect
            value={settings.sendShortcut}
            options={getSendShortcutOptions()}
            onValueChange={(sendShortcut) => updateSettings({ sendShortcut })}
            ariaLabel="Send shortcut"
            triggerClassName="w-full sm:w-64"
          />
        }
      />

      <SettingsRow
        id="setting-notifications"
        title="Notifications"
        description="Alert you when a thread finishes, fails or needs your input."
        resetAction={<SettingDefaultResetButton setting="notificationMode" label="notifications" />}
        control={
          <SettingsSelect
            value={settings.notificationMode}
            options={NOTIFICATION_MODE_OPTIONS}
            onValueChange={(notificationMode) => {
              // Safari and Firefox only allow these from a user gesture.
              if (hasSystemNotifications(notificationMode)) requestThreadNotificationPermission();
              if (hasNotificationSound(notificationMode)) unlockNotificationAudio();
              updateSettings({ notificationMode });
            }}
            ariaLabel="Notification mode"
            triggerClassName="w-full sm:w-56"
          />
        }
      />

      <SettingsRow
        id="setting-tool-calls"
        title="Tool calls"
        description="Choose how much tool activity the thread timeline shows. Zen also reduces each finished turn to its last message."
        resetAction={<SettingDefaultResetButton setting="toolCallVisibility" label="tool calls" />}
        control={
          <SettingsSelect
            value={settings.toolCallVisibility}
            options={TOOL_CALL_VISIBILITY_OPTIONS}
            onValueChange={(toolCallVisibility) => updateSettings({ toolCallVisibility })}
            ariaLabel="Tool call visibility"
          />
        }
      />

      <SettingsRow
        id="setting-code-block-wrapping"
        title="Code block wrapping"
        description="Wrap long lines in chat code blocks by default."
        resetAction={
          <SettingDefaultResetButton setting="chatCodeWordWrap" label="code block wrapping" />
        }
        control={
          <Switch
            checked={settings.chatCodeWordWrap}
            onCheckedChange={(checked) => updateSettings({ chatCodeWordWrap: Boolean(checked) })}
            aria-label="Wrap chat code blocks by default"
          />
        }
      />

      <SettingsRow
        id="setting-math-rendering"
        title="Math rendering"
        description="Render LaTeX math in assistant messages."
        resetAction={
          <SettingDefaultResetButton setting="mathRenderingEnabled" label="math rendering" />
        }
        control={
          <Switch
            checked={settings.mathRenderingEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ mathRenderingEnabled: Boolean(checked) })
            }
            aria-label="Render LaTeX math"
          />
        }
      />
    </SettingsSection>
  );
}
