import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@piedpiper/contracts/settings";
import { Equal } from "effect";
import { Undo2Icon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";

import { useSettings, useUpdateSettings } from "../../../hooks/useSettings";
import { isImeComposingKeyboardEvent } from "../../../lib/imeComposition";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Textarea } from "../../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

export function SettingsSection({
  id,
  title,
  icon,
  headerAction,
  children,
}: {
  /** Search anchor. */
  id?: string;
  title: string;
  icon?: ReactNode;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      className={cn("space-y-3", id && "outline-none")}
    >
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {icon}
          {title}
        </h2>
        {headerAction}
      </div>
      <div
        data-settings-card
        className="relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]"
      >
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  id,
  title,
  description,
  status,
  resetAction,
  control,
  children,
}: {
  /** Search anchor. */
  id?: string;
  title: ReactNode;
  description: string;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      id={id}
      tabIndex={id ? -1 : undefined}
      className={cn(
        "border-t border-border px-4 py-4 first:border-t-0 sm:px-5",
        id && "outline-none",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
          {status ? <div className="pt-1 text-[11px] text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SettingResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Reset ${label} to default`}
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Reset to default</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Reset button for one top-level setting. Renders nothing while the setting
 * equals its default, so it can be passed straight to `SettingsRow.resetAction`.
 */
export function SettingDefaultResetButton({
  setting,
  label,
}: {
  setting: keyof UnifiedSettings;
  label: string;
}) {
  const value = useSettings((settings) => settings[setting]);
  const { updateSettings } = useUpdateSettings();
  const defaultValue = DEFAULT_UNIFIED_SETTINGS[setting];
  if (Equal.equals(value, defaultValue)) return null;
  return (
    <SettingResetButton
      label={label}
      onClick={() => updateSettings({ [setting]: defaultValue } as Partial<UnifiedSettings>)}
    />
  );
}

export function SettingsPageContainer({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto p-6 [scrollbar-gutter:stable_both-edges]">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">{children}</div>
    </div>
  );
}

export interface SettingsSelectOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/** Select bound to one enumerated setting. Ignores values that are not in `options`. */
export function SettingsSelect<T extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  triggerClassName = "w-full sm:w-44",
}: {
  value: T;
  options: ReadonlyArray<SettingsSelectOption<T>>;
  onValueChange: (value: T) => void;
  ariaLabel: string;
  triggerClassName?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next);
        if (option) onValueChange(option.value);
      }}
    >
      <SelectTrigger className={triggerClassName} aria-label={ariaLabel}>
        <SelectValue>
          {options.find((option) => option.value === value)?.label ?? value}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem hideIndicator key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Select for an integer setting offered as presets. A stored value that is not
 * a preset (for example one edited in settings.json) is listed as its own option.
 */
export function SettingsNumberSelect({
  value,
  options,
  onValueChange,
  ariaLabel,
  formatLabel = String,
  triggerClassName = "w-full sm:w-32",
}: {
  value: number;
  options: ReadonlyArray<number>;
  onValueChange: (value: number) => void;
  ariaLabel: string;
  formatLabel?: (value: number) => string;
  triggerClassName?: string;
}) {
  const values = options.includes(value)
    ? options
    : [...options, value].toSorted((left, right) => left - right);
  return (
    <SettingsSelect
      value={String(value)}
      options={values.map((option) => ({ value: String(option), label: formatLabel(option) }))}
      onValueChange={(next) => onValueChange(Number(next))}
      ariaLabel={ariaLabel}
      triggerClassName={triggerClassName}
    />
  );
}

/** Inclusive integer range, for building `SettingsNumberSelect` options. */
export function integerRange(minimum: number, maximum: number): number[] {
  return Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index);
}

/**
 * Slider for an integer setting. Every step is written straight away, so the
 * setting's effect previews while dragging; use it only where a write is cheap
 * (client settings). A server setting would send one update per step.
 */
export function SettingsSlider({
  value,
  minimum,
  maximum,
  step = 1,
  onValueChange,
  ariaLabel,
  formatLabel = String,
  className = "w-full sm:w-52",
}: {
  value: number;
  minimum: number;
  maximum: number;
  step?: number;
  onValueChange: (value: number) => void;
  ariaLabel: string;
  formatLabel?: (value: number) => string;
  className?: string;
}) {
  const inputId = useId();
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <output
        htmlFor={inputId}
        className="min-w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
      >
        {formatLabel(value)}
      </output>
      <input
        id={inputId}
        type="range"
        className="min-w-0 flex-1 cursor-pointer accent-primary"
        min={minimum}
        max={maximum}
        step={step}
        value={value}
        onChange={(event) => onValueChange(Number(event.currentTarget.value))}
        aria-label={ariaLabel}
        aria-valuetext={formatLabel(value)}
      />
    </div>
  );
}

/**
 * Text input for a string setting that keeps a local draft and commits the
 * trimmed value on blur or Enter (Cmd/Ctrl+Enter when multiline). Escape
 * reverts the draft. Committing per keystroke would send one settings write per
 * key and fight the server's trimming of the stored value. `normalize` maps the
 * trimmed draft to what the server would store, such as an empty path to its default.
 */
export function SettingsDraftInput({
  value,
  onCommit,
  normalize,
  validate,
  onDraftChange,
  ariaLabel,
  placeholder,
  multiline = false,
  className,
}: {
  value: string;
  onCommit: (value: string) => void;
  normalize?: (value: string) => string;
  /** Returns an error message for an invalid draft, or null to accept it. */
  validate?: (value: string) => string | null;
  /** Reports edits. A change of `value` also replaces the draft, without calling this. */
  onDraftChange?: (draft: string) => void;
  ariaLabel: string;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [syncedValue, setSyncedValue] = useState(value);
  if (syncedValue !== value) {
    // The stored value changed elsewhere (reset, restore defaults, another window).
    setSyncedValue(value);
    setDraft(value);
    setError(null);
  }

  const updateDraft = (next: string) => {
    setDraft(next);
    onDraftChange?.(next);
  };

  const commit = () => {
    const trimmed = draft.trim();
    const next = normalize ? normalize(trimmed) : trimmed;
    if (next === value) {
      updateDraft(value);
      setError(null);
      return;
    }
    const message = validate?.(next) ?? null;
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    if (normalize) updateDraft(next);
    onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (isImeComposingKeyboardEvent(event.nativeEvent)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      updateDraft(value);
      setError(null);
      return;
    }
    if (event.key !== "Enter") return;
    if (multiline && !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    commit();
  };

  const sharedProps = {
    value: draft,
    "aria-label": ariaLabel,
    "aria-invalid": error ? true : undefined,
    placeholder,
    spellCheck: false,
    onBlur: commit,
    onKeyDown,
  } as const;

  return (
    <div className={cn("w-full", className)}>
      {multiline ? (
        <Textarea {...sharedProps} onChange={(event) => updateDraft(event.target.value)} />
      ) : (
        <Input {...sharedProps} onChange={(event) => updateDraft(event.target.value)} />
      )}
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
