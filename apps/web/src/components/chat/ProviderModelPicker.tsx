import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProvider,
} from "@piedpiper/contracts";
import { resolveSelectableModel } from "@piedpiper/shared/model";
import {
  memo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { VariantProps } from "class-variance-authority";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  StarIcon,
} from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { useComposerMenuFinalFocus } from "../ChatView.composerMenuFocus";
import { ClaudeAI, OpenAI } from "../Icons";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { isImeComposingKeyboardEvent } from "~/lib/imeComposition";
import { cn, isMacPlatform } from "~/lib/utils";
import {
  buildModelPickerView,
  claudeUpdateRequiredNote,
  type ModelPickerOption,
  type ModelPickerRef,
  type ModelPickerRow,
  modelPickerRowKey,
  toggleModelRef,
} from "./ProviderModelPicker.logic";

const PROVIDER_ORDER: ReadonlyArray<ProviderKind> = ["claudeAgent", "codex"];
const rowShortcutPrefix = isMacPlatform(navigator.platform) ? "\u2325" : "Alt+";

function ProviderIcon(props: { provider: ProviderKind; className?: string | undefined }) {
  return props.provider === "codex" ? (
    <OpenAI aria-hidden="true" className={cn("size-4 shrink-0", props.className)} />
  ) : (
    <ClaudeAI
      aria-hidden="true"
      className={cn("size-4 shrink-0 text-[#d97757]", props.className)}
    />
  );
}

/** Row actions keep the picker open and focus in the search box. */
function ModelRowAction(props: {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      className={cn(
        "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        props.className,
      )}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {props.children}
    </button>
  );
}

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ModelPickerOption>>;
  activeProviderIconClassName?: string;
  disabled?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  /** Controls the menu from outside (keyboard shortcut); local state is used when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shortcutLabel?: string | null | undefined;
  onProviderModelChange: (provider: ProviderKind, model: string) => void;
  /** The models a draft sends to at once; the trigger and items switch to multi-select when set. */
  selectedModels?: ReadonlyArray<{ provider: ProviderKind; model: string }> | undefined;
  /** Enables Shift-click (or Shift+Enter) on a model to add or remove it from `selectedModels`. */
  onToggleModel?: ((provider: ProviderKind, model: string) => void) | undefined;
}) {
  const [localMenuOpen, setLocalMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? localMenuOpen;
  const setIsMenuOpen = (open: boolean) => {
    setLocalMenuOpen(open);
    props.onOpenChange?.(open);
  };
  const activeProvider = props.lockedProvider ?? props.provider;
  const modelLabel = (provider: ProviderKind, model: string) =>
    props.modelOptionsByProvider[provider].find((option) => option.slug === model)?.name ?? model;
  const selectedModelLabel = modelLabel(activeProvider, props.model);
  const multiModelLabels = props.selectedModels?.map((selection) =>
    modelLabel(selection.provider, selection.model),
  );
  const triggerLabel = multiModelLabels
    ? `${multiModelLabels.slice(0, 2).join(", ")}${
        multiModelLabels.length > 2 ? `, ${multiModelLabels.length - 2} more` : ""
      }`
    : selectedModelLabel;
  const triggerProviders = props.selectedModels
    ? [...new Set(props.selectedModels.map((selection) => selection.provider))]
    : [activeProvider];
  const triggerTitle = [
    multiModelLabels?.join(", "),
    props.shortcutLabel ? `Change model (${props.shortcutLabel})` : undefined,
  ]
    .filter(Boolean)
    .join(" \u2014 ");
  const isProviderEnabled = (provider: ProviderKind) =>
    props.providers?.find((status) => status.provider === provider)?.enabled !== false;

  const finalFocus = useComposerMenuFinalFocus();
  // A thread locked to another provider cannot offer Claude, so an update would not help it.
  const claudeUpdateRequiredModels =
    props.lockedProvider === null || props.lockedProvider === "claudeAgent"
      ? props.providers?.find((status) => status.provider === "claudeAgent")?.updateRequiredModels
      : undefined;
  const claudeUpdateNote = claudeUpdateRequiredNote(claudeUpdateRequiredModels);

  const favorites = useSettings((settings) => settings.favorites);
  const hiddenModels = useSettings((settings) => settings.hiddenModels);
  const { updateSettings } = useUpdateSettings();
  const [query, setQuery] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  // Holds the list's height while searching, so the box stays put when the popup opens upward.
  const [searchHeight, setSearchHeight] = useState<number | null>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const highlightedKeyRef = useRef<string | null>(null);

  const selected: ReadonlyArray<ModelPickerRef> = props.selectedModels ?? [
    { provider: activeProvider, model: props.model },
  ];
  // A started thread stays on its provider, so it lists only that provider's models.
  const view = buildModelPickerView({
    providers: (props.lockedProvider ? [props.lockedProvider] : PROVIDER_ORDER).map((provider) => ({
      provider,
      label: PROVIDER_DISPLAY_NAMES[provider],
      isEnabled: props.lockedProvider !== null || isProviderEnabled(provider),
      options: props.modelOptionsByProvider[provider],
    })),
    favorites,
    hiddenModels,
    selected,
    expandedKeys,
    query,
    favoritesOnly,
    showProviderTitles: props.lockedProvider === null,
  });
  const showRowProvider = props.lockedProvider === null;
  const selectedKeys = selected.map((ref) => modelPickerRowKey(ref.provider, ref.model));
  const rowByKey = new Map(
    view.sections
      .flatMap((section) => [
        ...section.rows,
        ...section.expanders.flatMap((expander) => expander.rows),
      ])
      .map((row) => [row.key, row]),
  );

  // The note normally sits under Claude's section, which goes away once every Claude model is starred.
  // A search for a gated model finds nothing, so the note says why.
  const detachedClaudeUpdateNote = query.trim()
    ? claudeUpdateRequiredNote(claudeUpdateRequiredModels, query)
    : !favoritesOnly && !view.sections.some((section) => section.provider === "claudeAgent")
      ? claudeUpdateNote
      : null;

  const handleModelChange = (provider: ProviderKind, value: string) => {
    if (props.disabled || !value) return;
    const resolvedModel = resolveSelectableModel(
      provider,
      value,
      props.modelOptionsByProvider[provider],
    );
    if (!resolvedModel) return;
    props.onProviderModelChange(provider, resolvedModel);
    setIsMenuOpen(false);
  };

  const toggleModel = (provider: ProviderKind, value: string) => {
    if (props.disabled) return;
    const resolvedModel = resolveSelectableModel(
      provider,
      value,
      props.modelOptionsByProvider[provider],
    );
    if (resolvedModel) props.onToggleModel?.(provider, resolvedModel);
  };

  const toggleExpanded = (key: string) => {
    const next = new Set(expandedKeys);
    if (!next.delete(key)) next.add(key);
    setExpandedKeys(next);
  };

  const toggleFavorite = (row: ModelPickerRow) =>
    updateSettings({
      favorites: toggleModelRef(favorites, { provider: row.provider, model: row.slug }),
    });
  const toggleHidden = (row: ModelPickerRow) =>
    updateSettings({
      hiddenModels: toggleModelRef(hiddenModels, { provider: row.provider, model: row.slug }),
    });

  const onSearchKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement> & { preventBaseUIHandler: () => void },
  ) => {
    // By code: Alt+letter types a different character on macOS. Row buttons are pointer-only,
    // since focus stays in this box.
    if (event.altKey && (event.code === "KeyF" || event.code === "KeyH")) {
      if (isImeComposingKeyboardEvent(event.nativeEvent)) return;
      event.preventDefault();
      event.preventBaseUIHandler();
      const row = highlightedKeyRef.current ? rowByKey.get(highlightedKeyRef.current) : undefined;
      if (!row) return;
      if (event.code === "KeyF") toggleFavorite(row);
      else if (row.canHide || row.isHidden) toggleHidden(row);
      return;
    }
    // Shift+Enter toggles instead of selecting; the popup stays open for more.
    if (event.key !== "Enter" || !event.shiftKey || !props.onToggleModel) return;
    if (isImeComposingKeyboardEvent(event.nativeEvent)) return;
    event.preventDefault();
    event.preventBaseUIHandler();
    const row = highlightedKeyRef.current ? rowByKey.get(highlightedKeyRef.current) : undefined;
    if (row) toggleModel(row.provider, row.slug);
  };

  const renderRow = (row: ModelPickerRow, showProvider: boolean) => {
    const favoriteLabel = row.isFavorite ? "Remove from favorites" : "Add to favorites";
    return (
      <ComboboxItem
        key={row.key}
        hideIndicator
        value={row.key}
        className="group/model pe-2 [&>div]:min-w-0"
        data-model-picker-row={row.slug}
        onClick={(event) => {
          event.preventBaseUIHandler();
          if (event.shiftKey && props.onToggleModel) {
            toggleModel(row.provider, row.slug);
            return;
          }
          handleModelChange(row.provider, row.slug);
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <ModelRowAction
            label={favoriteLabel}
            className={cn(
              row.isFavorite ? "text-amber-500" : "opacity-40 group-hover/model:opacity-100",
            )}
            onClick={() => toggleFavorite(row)}
          >
            <StarIcon className={cn("size-3.5", row.isFavorite && "fill-current")} />
          </ModelRowAction>
          {showProvider ? <ProviderIcon provider={row.provider} className="size-3.5" /> : null}
          <span className={cn("min-w-0 flex-1 truncate", row.isHidden && "opacity-64")}>
            {row.name}
          </span>
          {row.canHide || row.isHidden ? (
            <ModelRowAction
              label={row.isHidden ? "Show in the model list" : "Hide from the model list"}
              className={cn(
                row.isHidden
                  ? "opacity-64"
                  : "opacity-0 group-hover/model:opacity-64 group-data-highlighted/model:opacity-64 pointer-coarse:opacity-64",
              )}
              onClick={() => toggleHidden(row)}
            >
              {row.isHidden ? (
                <EyeIcon className="size-3.5" />
              ) : (
                <EyeOffIcon className="size-3.5" />
              )}
            </ModelRowAction>
          ) : null}
          {selectedKeys.includes(row.key) ? (
            <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
          ) : null}
        </span>
      </ComboboxItem>
    );
  };

  return (
    <Combobox<string, boolean>
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
      onOpenChangeComplete={(open) => {
        if (open) return;
        setQuery("");
        setSearchHeight(null);
      }}
      items={view.allKeys}
      filteredItems={view.visibleKeys}
      filter={null}
      autoHighlight
      multiple={props.selectedModels !== undefined}
      value={props.selectedModels ? selectedKeys : (selectedKeys[0] ?? null)}
      // Clicks and Enter run the row's handlers; only a press released on a row from elsewhere,
      // such as a drag from the trigger, commits through here.
      onValueChange={(value, details) => {
        if (details.reason !== "item-press") return;
        const key = Array.isArray(value)
          ? (value.find((candidate) => !selectedKeys.includes(candidate)) ??
            selectedKeys.find((candidate) => !value.includes(candidate)))
          : value;
        const row = key ? rowByKey.get(key) : undefined;
        if (row) handleModelChange(row.provider, row.slug);
      }}
      onItemHighlighted={(key) => {
        highlightedKeyRef.current = typeof key === "string" ? key : null;
      }}
    >
      <ComboboxTrigger
        render={
          <Button
            size="xs"
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            {...(triggerTitle ? { title: triggerTitle } : {})}
            className={cn(
              "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2 text-[11px] text-foreground/60 hover:text-foreground/90 [&_svg]:mx-0",
              "max-w-48 shrink sm:max-w-56",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span className="flex min-w-0 w-full box-border items-center gap-2 overflow-hidden">
          {triggerProviders.map((provider) => (
            <ProviderIcon
              key={provider}
              provider={provider}
              className={props.activeProviderIconClassName}
            />
          ))}
          <span data-chat-provider-model-picker-label="true" className="min-w-0 flex-1 truncate">
            {triggerLabel}
          </span>
          <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
        </span>
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="w-72" finalFocus={finalFocus}>
        <div className="flex items-center gap-1 border-b p-1">
          <div className="min-w-0 flex-1">
            <ComboboxInput
              aria-label="Search models"
              className="rounded-md font-sans [&_input]:font-sans"
              inputClassName="ring-0"
              placeholder="Search models..."
              showTrigger={false}
              size="sm"
              value={query}
              onChange={(event) => {
                const nextQuery = event.target.value;
                if (!nextQuery.trim()) setSearchHeight(null);
                else if (!query.trim()) {
                  setSearchHeight(listContainerRef.current?.offsetHeight ?? null);
                }
                setQuery(nextQuery);
              }}
              onKeyDown={onSearchKeyDown}
              aria-keyshortcuts="Alt+F Alt+H"
            />
          </div>
          <button
            type="button"
            aria-label="Show favorites only"
            aria-pressed={favoritesOnly}
            title="Show favorites only"
            className={cn(
              "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              favoritesOnly && "bg-accent text-amber-500 hover:text-amber-500",
            )}
            // Keeps focus in the search box.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setFavoritesOnly(!favoritesOnly)}
          >
            <StarIcon className={cn("size-3.5", favoritesOnly && "fill-current")} />
          </button>
        </div>
        <div
          ref={listContainerRef}
          className="flex min-h-0 flex-col"
          {...(searchHeight === null ? {} : { style: { height: searchHeight } })}
        >
          <ComboboxEmpty>
            {query.trim()
              ? "No models found."
              : favoritesOnly
                ? "Star a model to see it here."
                : "No models available."}
          </ComboboxEmpty>
          <ComboboxList>
            {view.sections.map((section) =>
              section.isDisabled ? (
                <div
                  key={section.id}
                  className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-sm opacity-64"
                >
                  {section.provider ? <ProviderIcon provider={section.provider} /> : null}
                  {section.title}
                  <span className="ms-auto text-xs">Disabled</span>
                </div>
              ) : (
                <ComboboxGroup key={section.id} data-model-picker-section={section.id}>
                  {section.title ? (
                    <ComboboxGroupLabel className="flex items-center gap-1.5">
                      {section.provider ? (
                        <ProviderIcon provider={section.provider} className="size-3.5" />
                      ) : null}
                      {section.title}
                    </ComboboxGroupLabel>
                  ) : null}
                  {section.rows.map((row) =>
                    renderRow(row, showRowProvider && section.provider === null),
                  )}
                  {section.expanders.map((expander) => (
                    <div key={expander.key}>
                      <ComboboxItem
                        hideIndicator
                        value={expander.key}
                        className="pe-2 text-muted-foreground [&>div]:min-w-0"
                        aria-expanded={expander.isExpanded}
                        onClick={(event) => {
                          event.preventBaseUIHandler();
                          toggleExpanded(expander.key);
                        }}
                        // A release from elsewhere would otherwise close the popup with no selection.
                        onMouseUp={(event) => event.preventBaseUIHandler()}
                      >
                        <span className="flex items-center gap-1.5">
                          <ChevronRightIcon
                            aria-hidden="true"
                            className={cn(
                              "size-3.5 shrink-0 transition-transform duration-150",
                              expander.isExpanded && "rotate-90",
                            )}
                          />
                          <span className="min-w-0 flex-1 truncate">{expander.label}</span>
                          <span className="text-xs tabular-nums">{expander.count}</span>
                        </span>
                      </ComboboxItem>
                      {expander.isExpanded
                        ? expander.rows.map((row) => renderRow(row, false))
                        : null}
                    </div>
                  ))}
                  {section.provider === "claudeAgent" && claudeUpdateNote && !query.trim() ? (
                    <div className="px-2 py-1.5 text-muted-foreground text-xs">
                      {claudeUpdateNote}
                    </div>
                  ) : null}
                </ComboboxGroup>
              ),
            )}
            {detachedClaudeUpdateNote ? (
              <div className="px-2 py-1.5 text-muted-foreground text-xs">
                {detachedClaudeUpdateNote}
              </div>
            ) : null}
          </ComboboxList>
        </div>
        <div className="border-t px-2 py-1.5 text-muted-foreground text-xs">
          {props.onToggleModel ? (
            <div>Shift-click to send to several models, each in a new worktree.</div>
          ) : null}
          <div>
            {rowShortcutPrefix}F stars the highlighted model; {rowShortcutPrefix}H hides it.
          </div>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
});
