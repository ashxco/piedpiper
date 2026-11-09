import { type ProviderKind, ServerProviderUpdateRequiredModel } from "@piedpiper/contracts";

import { rankModelPickerSearch } from "./modelPickerSearch";

export interface ModelPickerOption {
  readonly slug: string;
  readonly name: string;
  readonly isLegacy?: boolean | undefined;
  readonly isCustom?: boolean | undefined;
}

export interface ModelPickerRef {
  readonly provider: ProviderKind;
  readonly model: string;
}

export interface ModelPickerRow {
  readonly key: string;
  readonly provider: ProviderKind;
  readonly providerLabel: string;
  readonly slug: string;
  readonly name: string;
  readonly isFavorite: boolean;
  /** In the hidden list and not rescued by a star, so the row offers to show it again. */
  readonly isHidden: boolean;
  readonly canHide: boolean;
}

export interface ModelPickerExpander {
  readonly key: string;
  readonly label: string;
  readonly isExpanded: boolean;
  readonly count: number;
  readonly rows: ReadonlyArray<ModelPickerRow>;
}

export interface ModelPickerSection {
  readonly id: string;
  readonly title: string | null;
  readonly provider: ProviderKind | null;
  readonly isDisabled: boolean;
  readonly rows: ReadonlyArray<ModelPickerRow>;
  readonly expanders: ReadonlyArray<ModelPickerExpander>;
}

export interface ModelPickerView {
  readonly sections: ReadonlyArray<ModelPickerSection>;
  /** Every selectable row in list order, which is the order keyboard highlight follows. */
  readonly visibleKeys: ReadonlyArray<string>;
  /** Starts with `visibleKeys`: the combobox finds the selected row's opening index in this list. */
  readonly allKeys: ReadonlyArray<string>;
}

export interface ModelPickerProviderInput {
  readonly provider: ProviderKind;
  readonly label: string;
  readonly isEnabled: boolean;
  readonly options: ReadonlyArray<ModelPickerOption>;
}

/** Explains models hidden for an old CLI, naming the version that unlocks all of them. */
export function claudeUpdateRequiredNote(
  allModels: ReadonlyArray<ServerProviderUpdateRequiredModel> | undefined,
  query?: string,
): string | null {
  const needle = query?.trim().toLowerCase() ?? "";
  // With a search, only what it matched: that explains why `opus 5.5` finds nothing.
  const models = needle
    ? allModels?.filter(
        (model) =>
          model.name.toLowerCase().includes(needle) || model.slug.toLowerCase().includes(needle),
      )
    : allModels;
  if (!models || models.length === 0) return null;
  const highest = models
    .map((model) => model.minVersion)
    .reduce((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }) >= 0 ? left : right,
    );
  const names = models.map((model) => model.name);
  const nameList =
    names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `Update Claude Code to v${highest} to use ${nameList}.`;
}

export function isSameModelRef(a: ModelPickerRef, b: ModelPickerRef): boolean {
  return a.provider === b.provider && a.model === b.model;
}

export function toggleModelRef(
  refs: ReadonlyArray<ModelPickerRef>,
  ref: ModelPickerRef,
): ReadonlyArray<ModelPickerRef> {
  return refs.some((candidate) => isSameModelRef(candidate, ref))
    ? refs.filter((candidate) => !isSameModelRef(candidate, ref))
    : [...refs, ref];
}

export function modelPickerRowKey(provider: ProviderKind, slug: string): string {
  return `model:${provider}:${slug}`;
}

/** A hidden model stays out of browsing lists unless a star or the current selection rescues it. */
export function isModelHiddenWhileBrowsing(input: {
  readonly ref: ModelPickerRef;
  readonly isCustom?: boolean | undefined;
  readonly favorites: ReadonlyArray<ModelPickerRef>;
  readonly hiddenModels: ReadonlyArray<ModelPickerRef>;
  readonly selected: ReadonlyArray<ModelPickerRef>;
}): boolean {
  const has = (refs: ReadonlyArray<ModelPickerRef>) =>
    refs.some((candidate) => isSameModelRef(candidate, input.ref));
  return (
    input.isCustom !== true &&
    has(input.hiddenModels) &&
    !has(input.favorites) &&
    !has(input.selected)
  );
}

function flatSection(id: string, title: string | null, rows: ReadonlyArray<ModelPickerRow>) {
  return {
    id,
    title,
    provider: null,
    isDisabled: false,
    rows,
    expanders: [],
  };
}

export function buildModelPickerView(input: {
  readonly providers: ReadonlyArray<ModelPickerProviderInput>;
  readonly favorites: ReadonlyArray<ModelPickerRef>;
  readonly hiddenModels: ReadonlyArray<ModelPickerRef>;
  readonly selected: ReadonlyArray<ModelPickerRef>;
  readonly expandedKeys: ReadonlySet<string>;
  readonly query: string;
  readonly favoritesOnly: boolean;
  /** Drops section titles for a single locked provider, whose rows need no heading. */
  readonly showProviderTitles: boolean;
}): ModelPickerView {
  const has = (refs: ReadonlyArray<ModelPickerRef>, ref: ModelPickerRef) =>
    refs.some((candidate) => isSameModelRef(candidate, ref));

  const favoriteRows: ModelPickerRow[] = [];
  const allRows: ModelPickerRow[] = [];
  const providerSections: ModelPickerSection[] = [];

  for (const { provider, label, isEnabled, options } of input.providers) {
    if (!isEnabled) {
      providerSections.push({
        id: provider,
        title: label,
        provider,
        isDisabled: true,
        rows: [],
        expanders: [],
      });
      continue;
    }

    const favorites: ModelPickerOption[] = [];
    let primary: ModelPickerOption[] = [];
    let hidden: ModelPickerOption[] = [];
    let legacy: ModelPickerOption[] = [];
    const isSelected = (slug: string) => has(input.selected, { provider, model: slug });
    const isFavorite = (slug: string) => has(input.favorites, { provider, model: slug });
    const isHiddenOption = (option: ModelPickerOption) =>
      option.isCustom !== true && has(input.hiddenModels, { provider, model: option.slug });
    for (const option of options) {
      if (isFavorite(option.slug)) favorites.push(option);
      else if (isSelected(option.slug)) primary.push(option);
      else if (isHiddenOption(option)) hidden.push(option);
      else if (option.isLegacy === true) legacy.push(option);
      else primary.push(option);
    }
    // A provider never lists nothing: its collapsed models come back before that happens.
    if (favorites.length + primary.length === 0) {
      if (hidden.length > 0) {
        primary = hidden;
        hidden = [];
      } else {
        primary = legacy;
        legacy = [];
      }
    }

    const hideablePrimary = favorites.length + primary.length > 1;
    const primarySlugs = new Set(primary.map((option) => option.slug));
    const toRow = (option: ModelPickerOption): ModelPickerRow => {
      const favorite = isFavorite(option.slug);
      const isHidden = !favorite && isHiddenOption(option);
      return {
        key: modelPickerRowKey(provider, option.slug),
        provider,
        providerLabel: label,
        slug: option.slug,
        name: option.name,
        isFavorite: favorite,
        isHidden,
        canHide:
          !favorite &&
          !isHidden &&
          option.isCustom !== true &&
          !isSelected(option.slug) &&
          (!primarySlugs.has(option.slug) || hideablePrimary),
      };
    };

    allRows.push(...options.map(toRow));
    favoriteRows.push(...favorites.map(toRow));
    const expander = (kind: "legacy" | "hidden", title: string, group: ModelPickerOption[]) => {
      const key = `${kind}:${provider}`;
      return {
        key,
        label: title,
        isExpanded: input.expandedKeys.has(key),
        count: group.length,
        rows: group.map(toRow),
      };
    };
    const expanders = [
      ...(legacy.length > 0 ? [expander("legacy", "Legacy models", legacy)] : []),
      ...(hidden.length > 0 ? [expander("hidden", "Hidden models", hidden)] : []),
    ];
    providerSections.push({
      id: provider,
      title: input.showProviderTitles ? label : null,
      provider,
      isDisabled: false,
      rows: primary.map(toRow),
      expanders,
    });
  }

  const allKeys = [
    ...allRows.map((row) => row.key),
    ...providerSections.flatMap((section) => section.expanders.map((expander) => expander.key)),
  ];
  const finish = (sections: ReadonlyArray<ModelPickerSection>): ModelPickerView => {
    const visibleKeys = sections.flatMap((section) => [
      ...section.rows.map((row) => row.key),
      ...section.expanders.flatMap((expander) => [
        expander.key,
        ...(expander.isExpanded ? expander.rows.map((row) => row.key) : []),
      ]),
    ]);
    const visibleKeySet = new Set(visibleKeys);
    return {
      sections,
      visibleKeys,
      allKeys: [...visibleKeys, ...allKeys.filter((key) => !visibleKeySet.has(key))],
    };
  };

  // Searching covers collapsed models too, since hiding and legacy status only affect browsing.
  if (input.query.trim()) {
    const searched = input.favoritesOnly ? allRows.filter((row) => row.isFavorite) : allRows;
    const ranked = rankModelPickerSearch(searched, input.query);
    return finish(ranked.length > 0 ? [flatSection("search", null, ranked)] : []);
  }
  if (input.favoritesOnly) {
    return finish(favoriteRows.length > 0 ? [flatSection("favorites", null, favoriteRows)] : []);
  }
  // Starring every model of a provider moves them all up, which leaves it nothing to list.
  const listedProviderSections = providerSections.filter(
    (section) => section.isDisabled || section.rows.length > 0 || section.expanders.length > 0,
  );
  return finish([
    ...(favoriteRows.length > 0 ? [flatSection("favorites", "Favorites", favoriteRows)] : []),
    ...listedProviderSections,
  ]);
}
