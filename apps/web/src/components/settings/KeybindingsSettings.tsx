import type { KeybindingCommand, KeybindingRuleUpsert } from "@piedpiper/contracts";
import {
  FileJsonIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { isElectron } from "../../env";
import { formatShortcutLabel } from "../../keybindings";
import { ensureNativeApi } from "../../nativeApi";
import {
  useServerAvailableEditors,
  useServerConfig,
  useServerKeybindings,
  useServerKeybindingsConfigPath,
} from "../../rpc/serverState";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildKeybindingCommandOptions,
  buildKeybindingRows,
  commandLabel,
  filterKeybindingRows,
  groupKeybindingRows,
  keybindingConflictLabels,
  isUnmodifiedKeybinding,
  keybindingFromKeyboardEvent,
  parseWhenExpressionDraft,
  rowKeybindingTarget,
  unknownWhenVariables,
  whenAstToExpression,
  type KeybindingRow,
} from "./KeybindingsSettings.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsSection,
} from "./panels/SettingsPrimitives";

function errorDescription(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

async function upsertKeybindingWithToast(input: KeybindingRuleUpsert): Promise<boolean> {
  try {
    await ensureNativeApi().server.upsertKeybinding(input);
    return true;
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Unable to save keybinding",
      description: errorDescription(error, "The keybinding was not saved."),
    });
    return false;
  }
}

/** Interprets a `when` draft: its canonical text once valid, so spacing alone never reads as an edit. */
function readWhenDraft(draft: string) {
  const parsed = parseWhenExpressionDraft(draft);
  if (!parsed.ok) {
    return { expression: draft.trim(), error: parsed.message, unknown: [] as readonly string[] };
  }
  return {
    expression: whenAstToExpression(parsed.value),
    error: null,
    unknown: unknownWhenVariables(parsed.value),
  };
}

function KeybindingCaptureInput({
  label,
  value,
  className,
  autoFocus = false,
  isRecording,
  onRecordingChange,
  onCapture,
  onCancel,
  onSubmit,
}: {
  label: string;
  value: string;
  className?: string;
  autoFocus?: boolean;
  isRecording: boolean;
  onRecordingChange: (recording: boolean) => void;
  onCapture: (key: string, field: HTMLInputElement) => void;
  onCancel: (field: HTMLInputElement) => void;
  onSubmit: () => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // An unhandled Escape closes the settings page.
      event.preventDefault();
      event.stopPropagation();
      onCancel(event.currentTarget);
      return;
    }
    if (!isRecording) {
      // The chord is captured: Enter confirms it, and no other key may overwrite it.
      if (event.key === "Enter") {
        event.preventDefault();
        onSubmit();
      }
      return;
    }
    // Tab keeps moving focus, so a keyboard user can pass through the field.
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) return;
    event.preventDefault();
    const next = keybindingFromKeyboardEvent(event.nativeEvent, navigator.platform);
    if (!next) return;
    onRecordingChange(false);
    onCapture(next, event.currentTarget);
  };

  return (
    <Input
      data-keybinding-capture=""
      autoFocus={autoFocus}
      readOnly
      aria-label={label}
      value={isRecording ? "" : value}
      placeholder={isRecording ? "Press shortcut" : "Unassigned"}
      size="sm"
      className={className ?? "w-full font-mono sm:w-40"}
      onClick={() => onRecordingChange(true)}
      onFocus={() => onRecordingChange(true)}
      onBlur={() => onRecordingChange(false)}
      onKeyDown={onKeyDown}
    />
  );
}

function WhenDraftField({
  label,
  draft,
  onChange,
  onRevert,
  onSubmit,
}: {
  label: string;
  draft: string;
  onChange: (next: string) => void;
  onRevert: () => boolean;
  onSubmit: () => void;
}) {
  const { error, unknown } = readWhenDraft(draft);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">When</span>
        <Input
          value={draft}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          placeholder="Always"
          spellCheck={false}
          size="sm"
          className="w-full font-mono sm:max-w-80"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit();
            } else if (event.key === "Escape") {
              // An unhandled Escape closes the settings page.
              event.preventDefault();
              event.stopPropagation();
              if (!onRevert()) event.currentTarget.blur();
            }
          }}
        />
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {unknown.length > 0 ? (
        <p className="text-xs text-warning">
          Unknown condition{unknown.length > 1 ? "s" : ""}: {unknown.join(", ")}. It can still be
          saved, but it may not match.
        </p>
      ) : null}
    </div>
  );
}

function UnmodifiedKeybindingWarning({ keyDraft }: { keyDraft: string }) {
  if (!isUnmodifiedKeybinding(keyDraft)) return null;
  return (
    <p className="text-xs text-warning">
      This shortcut has no modifier key, so it can also fire while you type.
    </p>
  );
}

function KeybindingConflictWarning({ labels }: { labels: ReadonlyArray<string> }) {
  if (labels.length === 0) return null;
  const description = `Conflicts with ${labels.slice(0, 3).join(", ")}${labels.length > 3 ? ", and more" : ""}.`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={description}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <TriangleAlertIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {description} The most recent matching binding wins when both conditions can apply.
      </TooltipPopup>
    </Tooltip>
  );
}

function KeybindingRowEditor({
  row,
  allRows,
  isSaving,
  onSave,
  onRemove,
}: {
  row: KeybindingRow;
  allRows: ReadonlyArray<KeybindingRow>;
  isSaving: boolean;
  onSave: (input: KeybindingRuleUpsert) => Promise<boolean>;
  onRemove: (row: KeybindingRow) => void;
}) {
  const [keyDraft, setKeyDraft] = useState(row.key);
  const [whenDraft, setWhenDraft] = useState(row.when);
  const [isRecording, setIsRecording] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const label = commandLabel(row.command);
  const when = readWhenDraft(whenDraft);
  const isDirty = keyDraft !== row.key || when.expression !== row.when;
  const canSave = isDirty && when.error === null && !isSaving;
  const conflicts = keybindingConflictLabels(allRows, {
    rowId: row.id,
    command: row.command,
    key: keyDraft,
    when: when.expression,
  });

  const replaceRow = (key: string, whenExpression: string) => {
    void onSave({
      command: row.command,
      key,
      ...(whenExpression.length > 0 ? { when: whenExpression } : {}),
      replace: rowKeybindingTarget(row),
    });
  };
  const save = () => {
    if (canSave) replaceRow(keyDraft, when.expression);
  };
  const revert = () => {
    setKeyDraft(row.key);
    setWhenDraft(row.when);
  };
  const returnToPill = (field: HTMLInputElement) => {
    // The field unmounts for the pill; focus would otherwise drop to the page.
    flushSync(() => {
      setKeyDraft(row.key);
      setIsRecording(false);
    });
    if (pillRef.current) pillRef.current.focus();
    else field.blur();
  };

  return (
    <div className="border-t border-border px-4 py-3 first:border-t-0 sm:px-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground" title={row.command}>
              {label}
            </h3>
            {row.source === "Default" ? null : (
              <Badge variant="outline" size="sm">
                {row.source}
              </Badge>
            )}
          </div>
          <WhenDraftField
            label={`When clause for ${label}`}
            draft={whenDraft}
            onChange={setWhenDraft}
            onRevert={() => {
              if (whenDraft === row.when) return false;
              setWhenDraft(row.when);
              return true;
            }}
            onSubmit={save}
          />
          <UnmodifiedKeybindingWarning keyDraft={keyDraft} />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
          <KeybindingConflictWarning labels={conflicts} />
          {isDirty ? (
            <>
              <Button size="xs" variant="ghost" disabled={isSaving} onClick={revert}>
                Cancel
              </Button>
              <Button size="xs" disabled={!canSave} onClick={save}>
                {isSaving ? "Saving" : "Save"}
              </Button>
            </>
          ) : null}
          {row.source !== "Default" && row.defaultRule ? (
            <SettingResetButton
              label={label}
              onClick={() => {
                if (row.defaultRule && !isSaving) {
                  replaceRow(row.defaultRule.key, row.defaultRule.when);
                }
              }}
            />
          ) : null}
          {row.source !== "Default" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    disabled={isSaving}
                    aria-label={`Remove shortcut for ${label}`}
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    onClick={() => onRemove(row)}
                  >
                    <Trash2Icon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Remove</TooltipPopup>
            </Tooltip>
          ) : null}
          {!isRecording && keyDraft === row.key ? (
            <button
              ref={pillRef}
              type="button"
              aria-label={`Edit shortcut for ${label}: ${formatShortcutLabel(row.binding.shortcut)}`}
              className="inline-flex h-7 cursor-pointer items-center rounded-md border border-transparent px-1.5 outline-none transition-colors hover:border-border hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setIsRecording(true)}
            >
              <Kbd>{formatShortcutLabel(row.binding.shortcut)}</Kbd>
            </button>
          ) : (
            <KeybindingCaptureInput
              label={`Keybinding for ${label}`}
              value={keyDraft}
              autoFocus={isRecording}
              isRecording={isRecording}
              onRecordingChange={setIsRecording}
              onCapture={(next, field) => {
                if (next === row.key) returnToPill(field);
                else setKeyDraft(next);
              }}
              onCancel={returnToPill}
              onSubmit={save}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function NewKeybindingRow({
  commandOptions,
  allRows,
  isSaving,
  onSave,
  onCancel,
}: {
  commandOptions: ReadonlyArray<KeybindingCommand>;
  allRows: ReadonlyArray<KeybindingRow>;
  isSaving: boolean;
  onSave: (input: KeybindingRuleUpsert) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [command, setCommand] = useState<KeybindingCommand | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [whenDraft, setWhenDraft] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const when = readWhenDraft(whenDraft);
  const canSave = command !== null && keyDraft.length > 0 && when.error === null && !isSaving;
  const conflicts = keybindingConflictLabels(allRows, {
    rowId: "new",
    command,
    key: keyDraft,
    when: when.expression,
  });

  const save = () => {
    if (!canSave) return;
    void onSave({
      command,
      key: keyDraft,
      ...(when.expression.length > 0 ? { when: when.expression } : {}),
    }).then((saved) => {
      if (saved) onCancel();
    });
  };

  return (
    <div className="flex flex-col gap-2 bg-muted/15 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0 flex-1 space-y-1.5">
        <h3 className="text-sm font-medium text-foreground">New keybinding</h3>
        <WhenDraftField
          label="When clause for new keybinding"
          draft={whenDraft}
          onChange={setWhenDraft}
          onRevert={() => {
            if (whenDraft.length === 0) return false;
            setWhenDraft("");
            return true;
          }}
          onSubmit={save}
        />
        <UnmodifiedKeybindingWarning keyDraft={keyDraft} />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
        <Select
          value={command}
          onValueChange={(next) => {
            const option = commandOptions.find((candidate) => candidate === next);
            if (option) setCommand(option);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Command">
            <SelectValue>{command ? commandLabel(command) : "Command"}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false} className="max-h-72">
            {commandOptions.map((option) => (
              <SelectItem hideIndicator key={option} value={option}>
                {commandLabel(option)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <KeybindingConflictWarning labels={conflicts} />
        <KeybindingCaptureInput
          label={`Keybinding for ${command ? commandLabel(command) : "new keybinding"}`}
          value={keyDraft}
          isRecording={isRecording}
          onRecordingChange={setIsRecording}
          onCapture={setKeyDraft}
          onCancel={(field) => {
            // The first Escape stays in the field; leaving it to the page would close settings next.
            if (!isRecording && keyDraft.length === 0) {
              field.blur();
              return;
            }
            setKeyDraft("");
            setIsRecording(false);
          }}
          onSubmit={save}
        />
        <Button size="xs" disabled={!canSave} onClick={save}>
          {isSaving ? "Saving" : "Save"}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={isSaving}
          aria-label="Cancel new keybinding"
          onClick={onCancel}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function KeybindingsSettingsPanel() {
  const keybindings = useServerKeybindings();
  const issues = useServerConfig()?.issues ?? [];
  const keybindingsConfigPath = useServerKeybindingsConfigPath();
  const availableEditors = useServerAvailableEditors();
  const [query, setQuery] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const allRows = buildKeybindingRows(keybindings);
  const commandOptions = buildKeybindingCommandOptions(keybindings);
  const groups = groupKeybindingRows(filterKeybindingRows(allRows, query));
  const configIssues = issues.filter((issue) => issue.kind.startsWith("keybindings."));

  // The row keeps its draft until the server's update replaces it, so a failed save loses nothing.
  const saveKeybinding = (input: KeybindingRuleUpsert): Promise<boolean> => {
    setIsSaving(true);
    return upsertKeybindingWithToast(input).finally(() => setIsSaving(false));
  };

  const removeKeybinding = (row: KeybindingRow) => {
    setIsSaving(true);
    ensureNativeApi()
      .server.removeKeybinding(rowKeybindingTarget(row))
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Unable to remove keybinding",
          description: errorDescription(error, "The keybinding was not removed."),
        });
      })
      .finally(() => setIsSaving(false));
  };

  const openKeybindingsFile = () => {
    if (!keybindingsConfigPath) return;
    const editor = resolveAndPersistPreferredEditor(availableEditors);
    const opened = editor
      ? ensureNativeApi().shell.openInEditor(keybindingsConfigPath, editor)
      : Promise.reject(new Error("No available editors found."));
    opened.catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Unable to open keybindings file",
        description: errorDescription(error, "The keybindings file was not opened."),
      });
    });
  };

  return (
    <SettingsPageContainer>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 basis-full sm:basis-0 sm:flex-1">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            placeholder="Search keybindings"
            aria-label="Search keybindings"
            className="[&_input]:pl-8"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // An unhandled Escape closes the settings page.
              event.preventDefault();
              event.stopPropagation();
              if (query.length > 0) setQuery("");
              else event.currentTarget.blur();
            }}
          />
        </div>
        <Button variant="outline" disabled={isAdding} onClick={() => setIsAdding(true)}>
          <PlusIcon aria-hidden className="size-4" />
          Add keybinding
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon"
                disabled={!keybindingsConfigPath}
                aria-label="Open keybindings.json"
                onClick={openKeybindingsFile}
              >
                <FileJsonIcon aria-hidden className="size-4" />
              </Button>
            }
          />
          <TooltipPopup side="top">Open keybindings.json</TooltipPopup>
        </Tooltip>
      </div>

      {isElectron ? null : (
        <p className="text-xs text-muted-foreground">
          The browser may claim some shortcuts first. The desktop app receives them all.
        </p>
      )}

      {configIssues.length > 0 ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>Some of keybindings.json could not be loaded</AlertTitle>
          <AlertDescription>
            <ul className="space-y-1">
              {configIssues.map((issue) => (
                <li key={`${issue.kind}:${"index" in issue ? issue.index : ""}:${issue.message}`}>
                  {"index" in issue ? `Entry ${issue.index + 1}: ` : ""}
                  {issue.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {isAdding ? (
        <SettingsSection title="New">
          <NewKeybindingRow
            commandOptions={commandOptions}
            allRows={allRows}
            isSaving={isSaving}
            onSave={saveKeybinding}
            onCancel={() => setIsAdding(false)}
          />
        </SettingsSection>
      ) : null}

      {groups.length > 0 ? (
        groups.map((group) => (
          <SettingsSection key={group.id} title={group.title}>
            {group.rows.map((row) => (
              <KeybindingRowEditor
                key={row.id}
                row={row}
                allRows={allRows}
                isSaving={isSaving}
                onSave={saveKeybinding}
                onRemove={removeKeybinding}
              />
            ))}
          </SettingsSection>
        ))
      ) : (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No keybindings match your search.
        </p>
      )}
    </SettingsPageContainer>
  );
}
