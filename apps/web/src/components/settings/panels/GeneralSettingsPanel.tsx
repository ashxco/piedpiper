import {
  ChevronDownIcon,
  InfoIcon,
  LoaderIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useRef, useState } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@piedpiper/contracts";
import {
  CLAUDE_AUTO_COMPACT_WINDOW_PATTERN,
  DEFAULT_UNIFIED_SETTINGS,
  type QuitConfirmationMode,
} from "@piedpiper/contracts/settings";
import { type RuntimeMode } from "@piedpiper/contracts";
import { normalizeModelSlug } from "@piedpiper/shared/model";
import { readCustomModelEntries } from "@piedpiper/shared/serverSettings";
import { Equal } from "effect";
import { ProviderModelPicker } from "../../chat/ProviderModelPicker";
import { ProviderUsageLimitRows } from "../../chat/ProviderUsageLimits";
import { TraitsPicker } from "../../chat/TraitsPicker";
import { resolveAndPersistPreferredEditor } from "../../../editorPreferences";
import { isElectron } from "../../../env";
import { useTheme } from "../../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../../hooks/useSettings";
import {
  MAX_CUSTOM_MODEL_LENGTH,
  getCustomModelOptionsByProvider,
  resolveAppModelSelectionState,
} from "../../../modelSelection";
import { ensureNativeApi } from "../../../nativeApi";
import { getSmoothScrollBehavior } from "../../../chat-scroll";
import { isImeComposingKeyboardEvent } from "../../../lib/imeComposition";
import { useRelativeTimeState } from "../../../hooks/useRelativeTimeState";
import { cn, isWindowsPlatform } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Collapsible, CollapsibleContent } from "../../ui/collapsible";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  useServerAvailableEditors,
  useServerKeybindingsConfigPath,
  useServerObservability,
  useServerProviders,
} from "../../../rpc/serverState";
import { AboutVersionSection, AboutVersionTitle } from "./AboutVersionSection";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection";
import { ChatSettingsSection } from "./ChatSettingsSection";
import { CustomModelDetailsDialog } from "./CustomModelDetailsDialog";
import { removeCustomModelEntry, saveCustomModelEntry } from "./customModelDetailsLogic";
import { DiffSettingsSection } from "./DiffSettingsSection";
import { GitSettingsSection } from "./GitSettingsSection";
import { describeModelCapabilities, shouldFlagMissingReasoning } from "./modelCapabilityLabels";
import { ProviderChecksSettingsRows } from "./ProviderChecksSettingsRows";
import { ProviderVersionUpdateNotice } from "./ProviderVersionUpdateNotice";
import { getProviderVersionUpdate, getUpdatesWithoutCard } from "./providerVersionUpdate.logic";
import { validateAbsoluteOrHomePath } from "./settingValueHelpers";
import {
  SettingDefaultResetButton,
  SettingResetButton,
  SettingsDraftInput,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  type SettingsSelectOption,
} from "./SettingsPrimitives";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const RUNTIME_MODE_OPTIONS: ReadonlyArray<SettingsSelectOption<RuntimeMode>> = [
  { value: "full-access", label: "Full access" },
  { value: "auto", label: "Auto" },
  { value: "approval-required", label: "Supervised" },
];

const QUIT_CONFIRMATION_MODE_OPTIONS: ReadonlyArray<SettingsSelectOption<QuitConfirmationMode>> = [
  { value: "direct", label: "Quit immediately" },
  { value: "hold", label: "Hold to quit" },
  { value: "double-click", label: "Press twice" },
];

export function validateClaudeAutoCompactWindow(value: string): string | null {
  return CLAUDE_AUTO_COMPACT_WINDOW_PATTERN.test(value)
    ? null
    : "Enter a whole number from 100000 to 1000000, or leave empty.";
}

type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
};

const PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  {
    provider: "claudeAgent",
    title: "Claude",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: "Path to the Claude binary",
  },
] as const;

const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-amber-400",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ??
        "This provider is installed but disabled for new sessions in Pied Piper.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
  };
}

function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  const lastCheckedRelative = useRelativeTimeState(lastCheckedAt);
  if (lastCheckedRelative.status !== "relative") return null;

  return (
    <span className="text-[11px] text-muted-foreground/60">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

export function GeneralSettingsPanel() {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [openingPathByTarget, setOpeningPathByTarget] = useState({
    keybindings: false,
    logsDirectory: false,
  });
  const [openPathErrorByTarget, setOpenPathErrorByTarget] = useState<
    Partial<Record<"keybindings" | "logsDirectory", string | null>>
  >({});
  const [openProviderDetails, setOpenProviderDetails] = useState<Record<ProviderKind, boolean>>({
    codex: Boolean(
      settings.providers.codex.binaryPath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.binaryPath ||
      settings.providers.codex.homePath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.homePath ||
      settings.providers.codex.customModels.length > 0,
    ),
    claudeAgent: Boolean(
      settings.providers.claudeAgent.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent.binaryPath ||
      settings.providers.claudeAgent.homePath !==
        DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent.homePath ||
      settings.providers.claudeAgent.customModels.length > 0 ||
      settings.providers.claudeAgent.launchArgs !==
        DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent.launchArgs ||
      settings.providers.claudeAgent.autoCompactWindow !==
        DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent.autoCompactWindow,
    ),
  });
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [editingCustomModel, setEditingCustomModel] = useState<{
    readonly provider: ProviderKind;
    readonly slug: string;
  } | null>(null);
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshingRef = useRef(false);
  const modelListRefs = useRef<Partial<Record<ProviderKind, HTMLDivElement | null>>>({});
  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void ensureNativeApi()
      .server.refreshProviders()
      .catch((error: unknown) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  }, []);

  const keybindingsConfigPath = useServerKeybindingsConfigPath();
  const availableEditors = useServerAvailableEditors();
  const observability = useServerObservability();
  const serverProviders = useServerProviders();
  const liveCodexProvider = serverProviders.find((provider) => provider.provider === "codex");
  const logsDirectoryPath = observability?.logsDirectoryPath ?? null;
  const diagnosticsDescription = (() => {
    const exports: string[] = [];
    if (observability?.otlpTracesEnabled && observability.otlpTracesUrl) {
      exports.push(`traces to ${observability.otlpTracesUrl}`);
    }
    if (observability?.otlpMetricsEnabled && observability.otlpMetricsUrl) {
      exports.push(`metrics to ${observability.otlpMetricsUrl}`);
    }
    if (observability?.otlpLogsEnabled && observability.otlpLogsUrl) {
      exports.push(`logs to ${observability.otlpLogsUrl}`);
    }
    const mode = observability?.localTracingEnabled ? "Local trace file" : "Terminal logs only";
    const exportList =
      exports.length > 2
        ? `${exports.slice(0, -1).join(", ")} and ${exports.at(-1)}`
        : exports.join(" and ");
    return exports.length > 0 ? `${mode}. OTLP exporting ${exportList}.` : `${mode}.`;
  })();

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenProvider = textGenerationModelSelection.provider;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelOptionsByProvider = getCustomModelOptionsByProvider(
    settings,
    serverProviders,
    textGenProvider,
    textGenModel,
  );
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  const openInPreferredEditor = useCallback(
    (target: "keybindings" | "logsDirectory", path: string | null, failureMessage: string) => {
      if (!path) return;
      setOpenPathErrorByTarget((existing) => ({ ...existing, [target]: null }));
      setOpeningPathByTarget((existing) => ({ ...existing, [target]: true }));

      const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
      if (!editor) {
        setOpenPathErrorByTarget((existing) => ({
          ...existing,
          [target]: "No available editors found.",
        }));
        setOpeningPathByTarget((existing) => ({ ...existing, [target]: false }));
        return;
      }

      void ensureNativeApi()
        .shell.openInEditor(path, editor)
        .catch((error) => {
          setOpenPathErrorByTarget((existing) => ({
            ...existing,
            [target]: error instanceof Error ? error.message : failureMessage,
          }));
        })
        .finally(() => {
          setOpeningPathByTarget((existing) => ({ ...existing, [target]: false }));
        });
    },
    [availableEditors],
  );

  const openKeybindingsFile = useCallback(() => {
    openInPreferredEditor("keybindings", keybindingsConfigPath, "Unable to open keybindings file.");
  }, [keybindingsConfigPath, openInPreferredEditor]);

  const openLogsDirectory = useCallback(() => {
    openInPreferredEditor("logsDirectory", logsDirectoryPath, "Unable to open logs folder.");
  }, [logsDirectoryPath, openInPreferredEditor]);

  const openKeybindingsError = openPathErrorByTarget.keybindings ?? null;
  const openDiagnosticsError = openPathErrorByTarget.logsDirectory ?? null;
  const isOpeningKeybindings = openingPathByTarget.keybindings;
  const isOpeningLogsDirectory = openingPathByTarget.logsDirectory;

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = settings.providers[provider].customModels;
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (
        serverProviders
          .find((candidate) => candidate.provider === provider)
          ?.models.some((option) => !option.isCustom && option.slug === normalized)
      ) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: [...customModels, normalized],
          },
        },
      });
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));

      const el = modelListRefs.current[provider];
      if (!el) return;
      const scrollToEnd = () =>
        el.scrollTo({ top: el.scrollHeight, behavior: getSmoothScrollBehavior() });
      requestAnimationFrame(scrollToEnd);
      const observer = new MutationObserver(() => {
        scrollToEnd();
        observer.disconnect();
      });
      observer.observe(el, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 2_000);
    },
    [customModelInputByProvider, serverProviders, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            ...removeCustomModelEntry(settings.providers[provider], slug),
          },
        },
      });
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  const providerCards = PROVIDER_SETTINGS.map((providerSettings) => {
    const liveProvider = serverProviders.find(
      (candidate) => candidate.provider === providerSettings.provider,
    );
    const providerConfig = settings.providers[providerSettings.provider];
    const defaultProviderConfig = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    const statusKey = liveProvider?.status ?? (providerConfig.enabled ? "warning" : "disabled");
    const summary = getProviderSummary(liveProvider);
    const models: ReadonlyArray<ServerProviderModel> =
      liveProvider?.models ??
      providerConfig.customModels.map((slug) => ({
        slug,
        name: slug,
        isCustom: true,
        capabilities: null,
      }));

    return {
      provider: providerSettings.provider,
      title: providerSettings.title,
      flagMissingReasoning: shouldFlagMissingReasoning(models),
      binaryPlaceholder: providerSettings.binaryPlaceholder,
      binaryDescription: providerSettings.binaryDescription,
      binaryPathValue: providerConfig.binaryPath,
      isDirty: !Equal.equals(providerConfig, defaultProviderConfig),
      liveProvider,
      models,
      providerConfig,
      statusStyle: PROVIDER_STATUS_STYLES[statusKey],
      summary,
      versionLabel: getProviderVersionLabel(liveProvider?.version),
      versionUpdate: getProviderVersionUpdate(liveProvider),
    };
  });

  const updatesWithoutCard = getUpdatesWithoutCard(
    serverProviders,
    PROVIDER_SETTINGS.map((providerSettings) => providerSettings.provider),
  );

  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;
  return (
    <SettingsPageContainer>
      <SettingsSection id="setting-section-general" title="General">
        <SettingsRow
          id="setting-theme"
          title="Theme"
          description="Choose how Pied Piper looks across the app."
          resetAction={
            theme !== "system" ? (
              <SettingResetButton label="theme" onClick={() => setTheme("system")} />
            ) : null
          }
          control={
            <Select
              value={theme}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  setTheme(value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                <SelectValue>
                  {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          id="setting-time-format"
          title="Time format"
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          id="setting-assistant-output"
          title="Assistant output"
          description="Show token-by-token output while a response is in progress. When off, finished paragraphs appear as they complete."
          resetAction={
            settings.enableAssistantStreaming !==
            DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
              <SettingResetButton
                label="assistant output"
                onClick={() =>
                  updateSettings({
                    enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) =>
                updateSettings({ enableAssistantStreaming: Boolean(checked) })
              }
              aria-label="Stream assistant messages"
            />
          }
        />

        <SettingsRow
          id="setting-new-threads"
          title="New threads"
          description="Pick the default workspace mode for newly created draft threads."
          resetAction={
            settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
              <SettingResetButton
                label="new threads"
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value === "local" || value === "worktree") {
                  updateSettings({ defaultThreadEnvMode: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                <SelectValue>
                  {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="local">
                  Local
                </SelectItem>
                <SelectItem hideIndicator value="worktree">
                  New worktree
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          id="setting-new-thread-permissions"
          title="New thread permissions"
          description="Pick the permission mode new threads start in."
          resetAction={
            <SettingDefaultResetButton
              setting="defaultRuntimeMode"
              label="new thread permissions"
            />
          }
          control={
            <SettingsSelect
              value={settings.defaultRuntimeMode}
              options={RUNTIME_MODE_OPTIONS}
              onValueChange={(defaultRuntimeMode) => updateSettings({ defaultRuntimeMode })}
              ariaLabel="Default permission mode"
            />
          }
        />

        <SettingsRow
          id="setting-archive-confirmation"
          title="Archive confirmation"
          description="Ask before archiving a thread."
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="Confirm thread archiving"
            />
          }
        />

        <SettingsRow
          id="setting-delete-confirmation"
          title="Delete confirmation"
          description="Ask before deleting a thread and its chat history."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />

        {/* The quit-shortcut guard does nothing on Windows. */}
        {isElectron && !isWindowsPlatform(navigator.platform) ? (
          <SettingsRow
            title="Quit shortcut"
            description="Guard the quit shortcut against stray presses. Hold mode also quits on two quick presses."
            resetAction={<SettingDefaultResetButton setting="confirmQuit" label="quit shortcut" />}
            control={
              <SettingsSelect
                value={settings.confirmQuit}
                options={QUIT_CONFIRMATION_MODE_OPTIONS}
                onValueChange={(confirmQuit) => updateSettings({ confirmQuit })}
                ariaLabel="Quit shortcut behavior"
              />
            }
          />
        ) : null}

        <SettingsRow
          id="setting-continue-after-restart"
          title="Continue after restart"
          description="Resume threads that were running when the app closed or updated. A normal quit counts too."
          resetAction={
            <SettingDefaultResetButton
              setting="continueThreadsAfterRestart"
              label="continue after restart"
            />
          }
          control={
            <Switch
              checked={settings.continueThreadsAfterRestart}
              onCheckedChange={(checked) =>
                updateSettings({ continueThreadsAfterRestart: Boolean(checked) })
              }
              aria-label="Continue running threads after a restart"
            />
          }
        />

        <SettingsRow
          id="setting-resume-after-usage-limit"
          title="Resume after usage limit"
          description="Resume a thread automatically when its usage limit resets. You can cancel it in the thread."
          resetAction={
            <SettingDefaultResetButton
              setting="autoResumeLimitedThreads"
              label="resume after usage limit"
            />
          }
          control={
            <Switch
              checked={settings.autoResumeLimitedThreads}
              onCheckedChange={(checked) =>
                updateSettings({ autoResumeLimitedThreads: Boolean(checked) })
              }
              aria-label="Resume threads after usage limits reset"
            />
          }
        />

        <SettingsRow
          id="setting-text-generation-model"
          title="Text generation model"
          description="Configure the model used for generated commit messages, PR titles, and similar Git text."
          resetAction={
            isGitWritingModelDirty ? (
              <SettingResetButton
                label="text generation model"
                onClick={() =>
                  updateSettings({
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                provider={textGenProvider}
                model={textGenModel}
                lockedProvider={null}
                providers={serverProviders}
                modelOptionsByProvider={gitModelOptionsByProvider}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onProviderModelChange={(provider, model) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: { provider, model },
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
              <TraitsPicker
                provider={textGenProvider}
                models={
                  serverProviders.find((provider) => provider.provider === textGenProvider)
                    ?.models ?? []
                }
                model={textGenModel}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={textGenModelOptions}
                allowPromptInjectedEffort={false}
                allowUltracode={false}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onModelOptionsChange={(nextOptions) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: {
                          provider: textGenProvider,
                          model: textGenModel,
                          ...(nextOptions ? { options: nextOptions } : {}),
                        },
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
            </div>
          }
        />

        <SettingsRow
          id="setting-thread-title-instructions"
          title="Thread title instructions"
          description="Extra rules for generated thread titles. Leave empty for the default style."
          resetAction={
            <SettingDefaultResetButton
              setting="threadTitleInstructions"
              label="thread title instructions"
            />
          }
        >
          <SettingsDraftInput
            multiline
            className="mt-3"
            value={settings.threadTitleInstructions}
            onCommit={(threadTitleInstructions) => updateSettings({ threadTitleInstructions })}
            ariaLabel="Thread title instructions"
            placeholder="For example: Use sentence case. Mention the ticket number when there is one."
          />
        </SettingsRow>
      </SettingsSection>

      <ChatSettingsSection />

      <AppearanceSettingsSection />

      <DiffSettingsSection />

      <GitSettingsSection />

      <SettingsSection
        id="setting-section-providers"
        title="Providers"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={isRefreshingProviders}
                    onClick={() => void refreshProviders()}
                    aria-label="Refresh provider status"
                  >
                    {isRefreshingProviders ? (
                      <LoaderIcon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider status</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {providerCards.map((providerCard) => {
          const customModelInput = customModelInputByProvider[providerCard.provider];
          const customModelError = customModelErrorByProvider[providerCard.provider] ?? null;
          const providerDisplayName =
            PROVIDER_DISPLAY_NAMES[providerCard.provider] ?? providerCard.title;

          return (
            <div key={providerCard.provider} className="border-t border-border first:border-t-0">
              <div className="px-4 py-4 sm:px-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-h-5 items-center gap-1.5">
                      <span
                        className={cn("size-2 shrink-0 rounded-full", providerCard.statusStyle.dot)}
                      />
                      <h3 className="text-sm font-medium text-foreground">{providerDisplayName}</h3>
                      {providerCard.versionLabel ? (
                        <code className="text-xs text-muted-foreground">
                          {providerCard.versionLabel}
                        </code>
                      ) : null}
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                        {providerCard.isDirty ? (
                          <SettingResetButton
                            label={`${providerDisplayName} provider settings`}
                            onClick={() => {
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  [providerCard.provider]:
                                    DEFAULT_UNIFIED_SETTINGS.providers[providerCard.provider],
                                },
                              });
                              setCustomModelErrorByProvider((existing) => ({
                                ...existing,
                                [providerCard.provider]: null,
                              }));
                            }}
                          />
                        ) : null}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {providerCard.summary.headline}
                      {providerCard.summary.detail ? ` - ${providerCard.summary.detail}` : null}
                    </p>
                    {providerCard.versionUpdate ? (
                      <ProviderVersionUpdateNotice
                        providerName={providerDisplayName}
                        update={providerCard.versionUpdate}
                      />
                    ) : null}
                  </div>
                  <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        setOpenProviderDetails((existing) => ({
                          ...existing,
                          [providerCard.provider]: !existing[providerCard.provider],
                        }))
                      }
                      aria-label={`Toggle ${providerDisplayName} details`}
                    >
                      <ChevronDownIcon
                        className={cn(
                          "size-3.5 transition-transform",
                          openProviderDetails[providerCard.provider] && "rotate-180",
                        )}
                      />
                    </Button>
                    <Switch
                      checked={providerCard.providerConfig.enabled}
                      onCheckedChange={(checked) => {
                        const isDisabling = !checked;
                        const shouldClearModelSelection =
                          isDisabling && textGenProvider === providerCard.provider;
                        updateSettings({
                          providers: {
                            ...settings.providers,
                            [providerCard.provider]: {
                              ...settings.providers[providerCard.provider],
                              enabled: Boolean(checked),
                            },
                          },
                          ...(shouldClearModelSelection
                            ? {
                                textGenerationModelSelection:
                                  DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                              }
                            : {}),
                        });
                      }}
                      aria-label={`Enable ${providerDisplayName}`}
                    />
                  </div>
                </div>
              </div>

              <Collapsible
                open={openProviderDetails[providerCard.provider]}
                onOpenChange={(open) =>
                  setOpenProviderDetails((existing) => ({
                    ...existing,
                    [providerCard.provider]: open,
                  }))
                }
              >
                <CollapsibleContent>
                  <div className="space-y-0">
                    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                      <span className="text-xs font-medium text-foreground">
                        {providerDisplayName} binary path
                      </span>
                      <SettingsDraftInput
                        className="mt-1.5"
                        value={providerCard.binaryPathValue}
                        normalize={(binaryPath) =>
                          binaryPath ||
                          DEFAULT_UNIFIED_SETTINGS.providers[providerCard.provider].binaryPath
                        }
                        onCommit={(binaryPath) =>
                          updateSettings({
                            providers: {
                              ...settings.providers,
                              [providerCard.provider]: {
                                ...settings.providers[providerCard.provider],
                                binaryPath,
                              },
                            },
                          })
                        }
                        ariaLabel={`${providerDisplayName} binary path`}
                        placeholder={providerCard.binaryPlaceholder}
                      />
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {providerCard.binaryDescription}
                      </span>
                    </div>

                    {providerCard.provider === "claudeAgent" ? (
                      <>
                        <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                          <span className="text-xs font-medium text-foreground">
                            Config directory
                          </span>
                          <SettingsDraftInput
                            className="mt-1.5"
                            value={settings.providers.claudeAgent.homePath}
                            validate={validateAbsoluteOrHomePath}
                            onCommit={(homePath) =>
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  claudeAgent: { ...settings.providers.claudeAgent, homePath },
                                },
                              })
                            }
                            ariaLabel="Claude config directory"
                            placeholder="~/.claude"
                          />
                          <span className="mt-1 block text-xs text-muted-foreground">
                            Use a separate Claude account, which needs its own login: run{" "}
                            <code>claude auth login</code> with <code>CLAUDE_CONFIG_DIR</code> set
                            to this directory. Leave empty for Claude's default. Threads with a
                            running session keep the old directory until that session restarts, then
                            start fresh because their transcripts stay in the old directory.
                          </span>
                        </div>

                        <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                          <span className="text-xs font-medium text-foreground">
                            Launch arguments
                          </span>
                          <SettingsDraftInput
                            className="mt-1.5"
                            value={settings.providers.claudeAgent.launchArgs}
                            onCommit={(launchArgs) =>
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  claudeAgent: { ...settings.providers.claudeAgent, launchArgs },
                                },
                              })
                            }
                            ariaLabel="Claude launch arguments"
                            placeholder="--add-dir ../shared"
                          />
                          <span className="mt-1 block text-xs text-muted-foreground">
                            Extra --flags passed to every Claude session. Quote values with spaces.
                            --add-dir can repeat, and --settings takes inline JSON or a file path,
                            merged beneath what Pied Piper sets. Flags Pied Piper sets itself (like
                            --model or --resume) and anything after -- are ignored. Applies to new
                            sessions.
                          </span>
                        </div>

                        <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                          <span className="text-xs font-medium text-foreground">
                            Auto-compact window
                          </span>
                          <SettingsDraftInput
                            className="mt-1.5"
                            value={settings.providers.claudeAgent.autoCompactWindow}
                            validate={validateClaudeAutoCompactWindow}
                            onCommit={(autoCompactWindow) =>
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  claudeAgent: {
                                    ...settings.providers.claudeAgent,
                                    autoCompactWindow,
                                  },
                                },
                              })
                            }
                            ariaLabel="Claude auto-compact window"
                            placeholder="Claude default"
                          />
                          <span className="mt-1 block text-xs text-muted-foreground">
                            Tokens of context before Claude compacts the conversation, from 100000
                            to 1000000.
                          </span>
                        </div>
                      </>
                    ) : null}

                    {providerCard.liveProvider?.enabled && providerCard.liveProvider.installed ? (
                      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                        <div className="text-xs font-medium text-foreground">Usage limits</div>
                        <ProviderUsageLimitRows
                          className="mt-2"
                          provider={providerCard.liveProvider}
                        />
                      </div>
                    ) : null}

                    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                      <div className="text-xs font-medium text-foreground">Models</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {providerCard.models.length} model
                        {providerCard.models.length === 1 ? "" : "s"} available.
                      </div>
                      <div
                        ref={(el) => {
                          modelListRefs.current[providerCard.provider] = el;
                        }}
                        className="mt-2 max-h-40 overflow-y-auto pb-1"
                      >
                        {providerCard.models.map((model) => {
                          const capLabels = describeModelCapabilities(
                            model,
                            providerCard.flagMissingReasoning,
                          );
                          const hasDetails = capLabels.length > 0 || model.name !== model.slug;

                          return (
                            <div
                              key={`${providerCard.provider}:${model.slug}`}
                              className="flex items-center gap-2 py-1"
                            >
                              <span className="min-w-0 truncate text-xs text-foreground/90">
                                {model.name}
                              </span>
                              {hasDetails ? (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <button
                                        type="button"
                                        className="shrink-0 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
                                        aria-label={`Details for ${model.name}`}
                                      />
                                    }
                                  >
                                    <InfoIcon className="size-3" />
                                  </TooltipTrigger>
                                  <TooltipPopup side="top" className="max-w-56">
                                    <div className="space-y-1">
                                      <code className="block text-[11px] text-foreground">
                                        {model.slug}
                                      </code>
                                      {capLabels.length > 0 ? (
                                        <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                                          {capLabels.map((label) => (
                                            <span
                                              key={label}
                                              className="text-[10px] text-muted-foreground"
                                            >
                                              {label}
                                            </span>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>
                                  </TooltipPopup>
                                </Tooltip>
                              ) : null}
                              {model.isCustom ? (
                                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                  <span className="text-[10px] text-muted-foreground">custom</span>
                                  <button
                                    type="button"
                                    className="text-muted-foreground transition-colors hover:text-foreground"
                                    aria-label={`Edit ${model.slug}`}
                                    onClick={() =>
                                      setEditingCustomModel({
                                        provider: providerCard.provider,
                                        slug: model.slug,
                                      })
                                    }
                                  >
                                    <PencilIcon className="size-3" />
                                  </button>
                                  <button
                                    type="button"
                                    className="text-muted-foreground transition-colors hover:text-foreground"
                                    aria-label={`Remove ${model.slug}`}
                                    onClick={() =>
                                      removeCustomModel(providerCard.provider, model.slug)
                                    }
                                  >
                                    <XIcon className="size-3" />
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>

                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <Input
                          id={`custom-model-${providerCard.provider}`}
                          value={customModelInput}
                          onChange={(event) => {
                            const value = event.target.value;
                            setCustomModelInputByProvider((existing) => ({
                              ...existing,
                              [providerCard.provider]: value,
                            }));
                            if (customModelError) {
                              setCustomModelErrorByProvider((existing) => ({
                                ...existing,
                                [providerCard.provider]: null,
                              }));
                            }
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.key !== "Enter" ||
                              isImeComposingKeyboardEvent(event.nativeEvent)
                            )
                              return;
                            event.preventDefault();
                            addCustomModel(providerCard.provider);
                          }}
                          placeholder="claude-sonnet-5-0"
                          spellCheck={false}
                        />
                        <Button
                          className="shrink-0"
                          variant="outline"
                          onClick={() => addCustomModel(providerCard.provider)}
                        >
                          <PlusIcon className="size-3.5" />
                          Add
                        </Button>
                      </div>

                      {customModelError ? (
                        <p className="mt-2 text-xs text-destructive">{customModelError}</p>
                      ) : null}
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>

              {editingCustomModel?.provider === providerCard.provider ? (
                <CustomModelDetailsDialog
                  key={editingCustomModel.slug}
                  open
                  entry={
                    readCustomModelEntries(providerCard.providerConfig).find(
                      (entry) => entry.slug === editingCustomModel.slug,
                    ) ?? { slug: editingCustomModel.slug }
                  }
                  models={providerCard.models}
                  provider={providerCard.provider}
                  onOpenChange={(open) => {
                    if (!open) setEditingCustomModel(null);
                  }}
                  onSave={(entry) =>
                    updateSettings({
                      providers: {
                        ...settings.providers,
                        [providerCard.provider]: {
                          ...settings.providers[providerCard.provider],
                          ...saveCustomModelEntry(settings.providers[providerCard.provider], entry),
                        },
                      },
                    })
                  }
                />
              ) : null}
            </div>
          );
        })}

        {updatesWithoutCard.map(({ provider, update }) => (
          <div key={provider} className="border-t border-border px-4 py-4 first:border-t-0 sm:px-5">
            <h3 className="text-sm font-medium text-foreground">
              {PROVIDER_DISPLAY_NAMES[provider]}
            </h3>
            <ProviderVersionUpdateNotice
              providerName={PROVIDER_DISPLAY_NAMES[provider]}
              update={update}
            />
          </div>
        ))}

        <ProviderChecksSettingsRows />
        {liveCodexProvider?.enabled && liveCodexProvider.installed ? (
          <SettingsRow
            id="setting-codex-usage-limits"
            title="Codex usage"
            description="Session and weekly limits reported by Codex."
            status={<ProviderUsageLimitRows className="mt-2" provider={liveCodexProvider} />}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection id="setting-section-advanced" title="Advanced">
        <SettingsRow
          id="setting-keybindings-file"
          title="Keybindings"
          description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {keybindingsConfigPath ?? "Resolving keybindings path..."}
              </span>
              {openKeybindingsError ? (
                <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
              ) : (
                <span className="mt-1 block">Opens in your preferred editor.</span>
              )}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!keybindingsConfigPath || isOpeningKeybindings}
              onClick={openKeybindingsFile}
            >
              {isOpeningKeybindings ? "Opening..." : "Open file"}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection id="setting-section-about" title="About">
        {isElectron ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Current version of the application."
          />
        )}
        <SettingsRow
          id="setting-diagnostics"
          title="Diagnostics"
          description={diagnosticsDescription}
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {logsDirectoryPath ?? "Resolving logs directory..."}
              </span>
              {openDiagnosticsError ? (
                <span className="mt-1 block text-destructive">{openDiagnosticsError}</span>
              ) : null}
            </>
          }
          control={
            <>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void navigate({ to: "/settings/diagnostics" })}
              >
                View diagnostics
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!logsDirectoryPath || isOpeningLogsDirectory}
                onClick={openLogsDirectory}
              >
                {isOpeningLogsDirectory ? "Opening..." : "Open logs folder"}
              </Button>
            </>
          }
        />
        <SettingsRow
          id="setting-usage-data"
          title="Usage data"
          description="Usage data is off unless PIEDPIPER_POSTHOG_KEY is set in the server environment. With a key set, the server sends product events to PostHog, such as sessions started and turns sent, with provider, model, mode and counts, plus your OS and WSL distro name, architecture, app version and client type, but never prompts or code. Events are tagged with a hashed identifier. To opt out, set PIEDPIPER_TELEMETRY_ENABLED=false in the server environment."
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
