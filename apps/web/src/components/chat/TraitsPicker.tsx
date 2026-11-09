import {
  type ClaudeModelOptions,
  type CodexModelOptions,
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProviderModel,
  type ThreadId,
} from "@piedpiper/contracts";
import {
  isClaudeUltrathinkPrompt,
  trimOrNull,
  getDefaultEffort,
  getDefaultContextWindow,
  hasContextWindowOption,
  resolveEffort,
} from "@piedpiper/shared/model";
import { type SVGProps, memo, useCallback, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon, GaugeIcon, ZapIcon } from "lucide-react";
import { useComposerMenuFinalFocus } from "../ChatView.composerMenuFocus";
import { COMPOSER_ICON_ONLY_LABEL_CLASS_NAME } from "../composerFooterLayout";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore } from "../../composerDraftStore";
import { applyComposerEffortToPrompt, updateComposerEffortOptions } from "../../lib/composerEffort";
import { getProviderModelCapabilities } from "../../providerModels";
import { cn } from "~/lib/utils";
import {
  COMPOSER_STANDARD_SERVICE_TIER,
  resolveSelectedServiceTier,
  serviceTierOptionsPatch,
  serviceTierSpeedIcon,
  serviceTierTriggerLabel,
} from "./composerServiceTier";

type ProviderOptions = ProviderModelOptions[ProviderKind];
type TraitsPersistence =
  | {
      threadId: ThreadId;
      onModelOptionsChange?: never;
    }
  | {
      threadId?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

/** All the picker reads from the prompt; passing it instead of the prompt avoids per-keystroke renders. */
export type PromptUltrathink = "none" | "prefix" | "body";

export function readPromptUltrathink(prompt: string): PromptUltrathink {
  if (!isClaudeUltrathinkPrompt(prompt)) return "none";
  return isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, "")) ? "body" : "prefix";
}

function getRawEffort(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (provider === "codex") {
    return trimOrNull((modelOptions as CodexModelOptions | undefined)?.reasoningEffort);
  }
  return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.effort);
}

function getRawContextWindow(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (provider === "claudeAgent") {
    return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.contextWindow);
  }
  return null;
}

function buildNextOptions(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
  patch: Record<string, unknown>,
): ProviderOptions {
  // An undefined patch value removes the key.
  const next = Object.fromEntries(
    Object.entries({ ...modelOptions, ...patch }).filter(([, value]) => value !== undefined),
  );
  return provider === "codex" ? (next as CodexModelOptions) : (next as ClaudeModelOptions);
}

function UltrafastIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="m17 2-10 12h7l-1 8 10-12h-7l1-8Z" opacity="0.4" />
      <path d="m11 2-10 12h7l-1 8 10-12h-7l1-8Z" />
    </svg>
  );
}

function SpeedIcon(props: { icon: "fast" | "ultrafast"; className?: string | undefined }) {
  const Icon = props.icon === "ultrafast" ? UltrafastIcon : ZapIcon;
  return <Icon aria-hidden="true" className={cn("size-3 fill-current", props.className)} />;
}

function ServiceTierSpeedIcon(props: { value: string | null; className?: string }) {
  const icon = props.value === null ? null : serviceTierSpeedIcon(props.value);
  if (icon === null) return null;
  return <SpeedIcon icon={icon} className={props.className} />;
}

function getSelectedTraits(
  provider: ProviderKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  promptUltrathink: PromptUltrathink,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
  allowUltracode: boolean,
) {
  const caps = getProviderModelCapabilities(models, model, provider);
  const effortLevels = allowPromptInjectedEffort
    ? caps.reasoningEffortLevels
    : caps.reasoningEffortLevels.filter(
        (option) => !caps.promptInjectedEffortLevels.includes(option.value),
      );

  // Resolve effort from options (provider-specific key)
  const rawEffort = getRawEffort(provider, modelOptions);
  const effort = resolveEffort(caps, rawEffort) ?? null;

  // Thinking toggle (only for models that support it)
  const thinkingEnabled = caps.supportsThinkingToggle
    ? ((modelOptions as ClaudeModelOptions | undefined)?.thinking ?? true)
    : null;

  // Codex tiers from the model catalog replace the Fast Mode toggle on models listing them.
  const codexOptions =
    provider === "codex" ? (modelOptions as CodexModelOptions | undefined) : null;
  const serviceTierOptions = provider === "codex" ? (caps.serviceTierOptions ?? []) : [];
  const selectedServiceTier =
    serviceTierOptions.length > 0
      ? resolveSelectedServiceTier(serviceTierOptions, codexOptions)
      : null;

  // Fast mode: an explicit choice wins over the provider's configured default (Codex service_tier).
  // A tier stored on another model outranks fastMode on the server, so the toggle reads it too.
  const codexServiceTier = codexOptions?.serviceTier;
  const fastModeEnabled =
    caps.supportsFastMode &&
    (codexServiceTier !== undefined
      ? codexServiceTier !== null && serviceTierSpeedIcon(codexServiceTier) === "fast"
      : ((modelOptions as { fastMode?: boolean } | undefined)?.fastMode ?? caps.fastModeDefault) ===
        true);

  // Ultracode is independent of effort; absent means off.
  const ultracodeAvailable = allowUltracode && caps.supportsUltracode === true;
  const ultracodeEnabled =
    ultracodeAvailable && (modelOptions as ClaudeModelOptions | undefined)?.ultracode === true;

  // Context window
  const contextWindowOptions = caps.contextWindowOptions;
  const rawContextWindow = getRawContextWindow(provider, modelOptions);
  const defaultContextWindow = getDefaultContextWindow(caps);
  const contextWindow =
    rawContextWindow && hasContextWindowOption(caps, rawContextWindow)
      ? rawContextWindow
      : defaultContextWindow;

  // Prompt-controlled effort (e.g. ultrathink in prompt text)
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    caps.promptInjectedEffortLevels.length > 0 &&
    promptUltrathink !== "none";

  // Check if "ultrathink" appears in the body text (not just our prefix)
  const ultrathinkInBodyText = ultrathinkPromptControlled && promptUltrathink === "body";

  return {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    serviceTierOptions,
    selectedServiceTier,
    fastModeEnabled,
    ultracodeAvailable,
    ultracodeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
  };
}

export interface TraitsMenuContentProps {
  provider: ProviderKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  /** Prefer promptUltrathink + onPromptEdit, which keep the picker from re-rendering per keystroke. */
  prompt?: string | undefined;
  onPromptChange?: ((prompt: string) => void) | undefined;
  promptUltrathink?: PromptUltrathink | undefined;
  /** Receives an edit of the live prompt; takes precedence over onPromptChange. */
  onPromptEdit?: ((edit: (prompt: string) => string) => void) | undefined;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  /** False where the choice has no effect, such as the text generation model. */
  allowUltracode?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  models,
  model,
  prompt,
  onPromptChange,
  promptUltrathink,
  onPromptEdit,
  modelOptions,
  allowPromptInjectedEffort = true,
  allowUltracode = true,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const editPrompt = (edit: (current: string) => string) => {
    if (onPromptEdit) {
      onPromptEdit(edit);
      return;
    }
    onPromptChange?.(edit(prompt ?? ""));
  };
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if ("onModelOptionsChange" in persistence) {
        persistence.onModelOptionsChange(nextOptions);
        return;
      }
      setProviderModelOptions(persistence.threadId, provider, nextOptions, { persistSticky: true });
    },
    [persistence, provider, setProviderModelOptions],
  );
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    serviceTierOptions,
    selectedServiceTier,
    fastModeEnabled,
    ultracodeAvailable,
    ultracodeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
  } = getSelectedTraits(
    provider,
    models,
    model,
    promptUltrathink ?? readPromptUltrathink(prompt ?? ""),
    modelOptions,
    allowPromptInjectedEffort,
    allowUltracode,
  );
  const defaultEffort = getDefaultEffort(caps);

  const handleEffortChange = (value: string) => {
    if (!value) return;
    const nextOption = effortLevels.find((option) => option.value === value);
    if (!nextOption) return;
    if (caps.promptInjectedEffortLevels.includes(nextOption.value)) {
      editPrompt((current) => applyComposerEffortToPrompt(current, nextOption.value));
      return;
    }
    if (ultrathinkInBodyText) return;
    if (ultrathinkPromptControlled) {
      editPrompt((current) => applyComposerEffortToPrompt(current, nextOption.value));
    }
    updateModelOptions(updateComposerEffortOptions(provider, modelOptions, nextOption.value));
  };

  if (
    effort === null &&
    thinkingEnabled === null &&
    contextWindowOptions.length <= 1 &&
    !ultracodeAvailable &&
    serviceTierOptions.length === 0
  ) {
    return null;
  }

  return (
    <>
      {effort ? (
        <>
          <MenuGroup>
            <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">Effort</div>
            {ultrathinkInBodyText ? (
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change effort.
              </div>
            ) : null}
            <MenuRadioGroup
              value={ultrathinkPromptControlled ? "ultrathink" : effort}
              onValueChange={handleEffortChange}
            >
              {effortLevels.map((option) => (
                <MenuRadioItem
                  key={option.value}
                  value={option.value}
                  disabled={ultrathinkInBodyText}
                  closeOnClick
                >
                  {option.label}
                  {option.value === defaultEffort ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : thinkingEnabled !== null ? (
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Thinking</div>
          <MenuRadioGroup
            value={thinkingEnabled ? "on" : "off"}
            onValueChange={(value) => {
              updateModelOptions(
                buildNextOptions(provider, modelOptions, { thinking: value === "on" }),
              );
            }}
          >
            <MenuRadioItem value="on" closeOnClick>
              On (default)
            </MenuRadioItem>
            <MenuRadioItem value="off" closeOnClick>
              Off
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      ) : null}
      {serviceTierOptions.length > 0 ? (
        <>
          <MenuDivider />
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              Service Tier
            </div>
            <MenuRadioGroup
              value={selectedServiceTier ?? COMPOSER_STANDARD_SERVICE_TIER}
              onValueChange={(value) => {
                updateModelOptions(
                  buildNextOptions(provider, modelOptions, serviceTierOptionsPatch(value)),
                );
              }}
            >
              {serviceTierOptions.map((option) => (
                <MenuRadioItem key={option.value} value={option.value} closeOnClick>
                  <span className="flex items-center gap-1.5">
                    {option.label}
                    {option.isDefault ? " (default)" : ""}
                    <ServiceTierSpeedIcon value={option.value} className="opacity-80" />
                  </span>
                  {option.description ? (
                    <span className="block max-w-56 text-muted-foreground/80 text-xs">
                      {option.description}
                    </span>
                  ) : null}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : caps.supportsFastMode ? (
        <>
          <MenuDivider />
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast Mode</div>
            <MenuRadioGroup
              value={fastModeEnabled ? "on" : "off"}
              onValueChange={(value) => {
                updateModelOptions(
                  buildNextOptions(provider, modelOptions, {
                    fastMode: value === "on",
                    serviceTier: undefined,
                  }),
                );
              }}
            >
              <MenuRadioItem value="off" closeOnClick>
                off
              </MenuRadioItem>
              <MenuRadioItem value="on" closeOnClick>
                on
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
      {ultracodeAvailable ? (
        <>
          <MenuDivider />
          <MenuGroup>
            <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
              Ultracode
            </div>
            <div className="max-w-56 px-2 pb-1.5 text-muted-foreground/80 text-xs">
              Runs multi-agent workflows at any effort. Can use far more tokens.
            </div>
            <MenuRadioGroup
              value={ultracodeEnabled ? "on" : "off"}
              onValueChange={(value) => {
                updateModelOptions(
                  buildNextOptions(provider, modelOptions, { ultracode: value === "on" }),
                );
              }}
            >
              <MenuRadioItem value="off" closeOnClick>
                off
              </MenuRadioItem>
              <MenuRadioItem value="on" closeOnClick>
                on
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
      {contextWindowOptions.length > 1 ? (
        <>
          <MenuDivider />
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              Context Window
            </div>
            <MenuRadioGroup
              value={contextWindow ?? defaultContextWindow ?? ""}
              onValueChange={(value) => {
                updateModelOptions(
                  buildNextOptions(provider, modelOptions, {
                    contextWindow: value,
                  }),
                );
              }}
            >
              {contextWindowOptions.map((option) => (
                <MenuRadioItem key={option.value} value={option.value} closeOnClick>
                  {option.label}
                  {option.value === defaultContextWindow ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
    </>
  );
});

/** Lets the composer open the menu from a keyboard shortcut; local state is used when omitted. */
export interface TraitsPickerOpenControl {
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  triggerTitle?: string | undefined;
  /** Replaces the label with an icon; the footer sets this when the label no longer fits. */
  iconOnly?: boolean | undefined;
}

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  models,
  model,
  prompt,
  onPromptChange,
  promptUltrathink,
  onPromptEdit,
  modelOptions,
  allowPromptInjectedEffort = true,
  allowUltracode = true,
  triggerVariant,
  triggerClassName,
  open,
  onOpenChange,
  triggerTitle,
  iconOnly = false,
  ...persistence
}: TraitsMenuContentProps & TraitsPickerOpenControl & TraitsPersistence) {
  const [localMenuOpen, setLocalMenuOpen] = useState(false);
  const isMenuOpen = open ?? localMenuOpen;
  const setIsMenuOpen = (nextOpen: boolean) => {
    setLocalMenuOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  const finalFocus = useComposerMenuFinalFocus();
  const resolvedPromptUltrathink = promptUltrathink ?? readPromptUltrathink(prompt ?? "");
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    serviceTierOptions,
    selectedServiceTier,
    fastModeEnabled,
    ultracodeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
  } = getSelectedTraits(
    provider,
    models,
    model,
    resolvedPromptUltrathink,
    modelOptions,
    allowPromptInjectedEffort,
    allowUltracode,
  );

  const effortLabel = effort
    ? (effortLevels.find((l) => l.value === effort)?.label ?? effort)
    : null;
  const contextWindowLabel =
    contextWindowOptions.length > 1 && contextWindow !== defaultContextWindow
      ? (contextWindowOptions.find((o) => o.value === contextWindow)?.label ?? null)
      : null;
  const serviceTierLabel =
    selectedServiceTier !== null
      ? serviceTierTriggerLabel(serviceTierOptions, selectedServiceTier)
      : null;
  const traitLabels = [
    ultrathinkPromptControlled
      ? "Ultrathink"
      : effortLabel
        ? effortLabel
        : thinkingEnabled === null
          ? null
          : `Thinking ${thinkingEnabled ? "On" : "Off"}`,
    ...(serviceTierLabel ? [serviceTierLabel] : []),
    ...(serviceTierOptions.length === 0 && caps.supportsFastMode && fastModeEnabled
      ? ["Fast"]
      : []),
    ...(ultracodeEnabled ? ["Ultracode"] : []),
    ...(contextWindowLabel ? [contextWindowLabel] : []),
  ]
    .filter(Boolean)
    .join(" · ");
  // A model whose only trait is its tier still needs a readable trigger on Standard.
  const standardTierLabel = serviceTierOptions.find(
    (option) => option.value === COMPOSER_STANDARD_SERVICE_TIER,
  )?.label;
  const triggerLabel = traitLabels || (standardTierLabel ?? "");

  const isCodexStyle = provider === "codex";
  // Stays mounted either way so the footer can measure both variants from one tree.
  const compactSpeedIcon =
    selectedServiceTier !== null
      ? serviceTierSpeedIcon(selectedServiceTier)
      : serviceTierOptions.length === 0 && caps.supportsFastMode && fastModeEnabled
        ? "fast"
        : null;
  const compactIcon = (
    <span
      data-composer-control-compact-icon
      className={cn("inline-flex shrink-0", !iconOnly && "pointer-events-none invisible absolute")}
    >
      {compactSpeedIcon ? (
        <SpeedIcon icon={compactSpeedIcon} className="size-4" />
      ) : (
        <GaugeIcon aria-hidden="true" className="size-4" />
      )}
    </span>
  );
  const label = (
    <span
      data-composer-control-label
      className={cn(iconOnly && COMPOSER_ICON_ONLY_LABEL_CLASS_NAME)}
    >
      <ServiceTierSpeedIcon
        value={selectedServiceTier}
        className="me-1 inline align-[-1px] opacity-80"
      />
      {triggerLabel}
    </span>
  );
  const title = iconOnly
    ? [triggerLabel, triggerTitle].filter(Boolean).join(" \u2014 ")
    : triggerTitle;

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant={triggerVariant ?? "ghost"}
            {...(title ? { title } : {})}
            {...(iconOnly
              ? { "aria-label": triggerLabel ? `Effort: ${triggerLabel}` : "Model options" }
              : {})}
            className={cn(
              "text-[11px]",
              isCodexStyle
                ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 text-foreground/60 hover:text-foreground/90 sm:max-w-48 [&_svg]:mx-0"
                : "shrink-0 whitespace-nowrap px-2 text-foreground/60 hover:text-foreground/90",
              triggerClassName,
            )}
          />
        }
      >
        {isCodexStyle ? (
          <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
            {compactIcon}
            {label}
            <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
          </span>
        ) : (
          <>
            {compactIcon}
            {label}
            <ChevronDownIcon aria-hidden="true" className="size-3.5 opacity-70" />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start" finalFocus={finalFocus}>
        <TraitsMenuContent
          provider={provider}
          models={models}
          model={model}
          prompt={prompt}
          onPromptChange={onPromptChange}
          promptUltrathink={resolvedPromptUltrathink}
          onPromptEdit={onPromptEdit}
          modelOptions={modelOptions}
          allowPromptInjectedEffort={allowPromptInjectedEffort}
          allowUltracode={allowUltracode}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});
