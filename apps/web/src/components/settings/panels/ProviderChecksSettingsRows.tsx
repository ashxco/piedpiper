import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL_MS,
  MAX_PROVIDER_HEALTH_REFRESH_INTERVAL_MS,
} from "@piedpiper/contracts/settings";
import { clampIntegerSetting } from "@piedpiper/shared/serverSettings";

import { useSettings, useUpdateSettings } from "../../../hooks/useSettings";
import { Switch } from "../../ui/switch";
import { formatIntervalLabel } from "./settingValueHelpers";
import { SettingDefaultResetButton, SettingsNumberSelect, SettingsRow } from "./SettingsPrimitives";

const PROVIDER_HEALTH_REFRESH_INTERVAL_PRESETS_MS = [
  0, 60_000, 300_000, 900_000, 1_800_000, 3_600_000,
] as const;

/** Background checks that apply to every provider (all server settings). */
export function ProviderChecksSettingsRows() {
  const providerHealthRefreshIntervalMs = useSettings(
    (settings) => settings.providerHealthRefreshIntervalMs,
  );
  const enableProviderUpdateChecks = useSettings((settings) => settings.enableProviderUpdateChecks);
  const { updateSettings } = useUpdateSettings();

  return (
    <>
      <SettingsRow
        id="setting-provider-health-checks"
        title="Provider health checks"
        description="How often to re-check provider status in the background. Refreshing or changing settings always re-checks."
        resetAction={
          <SettingDefaultResetButton
            setting="providerHealthRefreshIntervalMs"
            label="provider health checks"
          />
        }
        control={
          <SettingsNumberSelect
            value={providerHealthRefreshIntervalMs}
            options={PROVIDER_HEALTH_REFRESH_INTERVAL_PRESETS_MS}
            formatLabel={formatIntervalLabel}
            onValueChange={(value) =>
              updateSettings({
                providerHealthRefreshIntervalMs: clampIntegerSetting(value, {
                  minimum: 0,
                  maximum: MAX_PROVIDER_HEALTH_REFRESH_INTERVAL_MS,
                  fallback: DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL_MS,
                }),
              })
            }
            ariaLabel="Provider health check interval"
            triggerClassName="w-full sm:w-44"
          />
        }
      />

      <SettingsRow
        id="setting-cli-update-checks"
        title="CLI update checks"
        description="Check the npm registry for newer versions of the installed provider CLIs."
        resetAction={
          <SettingDefaultResetButton
            setting="enableProviderUpdateChecks"
            label="CLI update checks"
          />
        }
        control={
          <Switch
            checked={enableProviderUpdateChecks}
            onCheckedChange={(checked) =>
              updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
            }
            aria-label="Check for provider CLI updates"
          />
        }
      />
    </>
  );
}
