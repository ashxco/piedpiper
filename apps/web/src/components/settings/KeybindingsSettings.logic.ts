import {
  STATIC_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type KeybindingRule,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@piedpiper/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  US_SHIFTED_TO_UNSHIFTED_KEYS,
  parseKeybindingShortcut,
  parseKeybindingWhenExpression,
} from "@piedpiper/shared/keybindings";

import { formatShortcutLabel } from "../../keybindings";
import {
  isAltGraphTextEvent,
  shortcutConflictKey,
  shortcutKeyFromEvent,
} from "../../keybindingShortcutKeys";
import { isMacPlatform } from "../../lib/utils";

export type KeybindingSource = "Default" | "Custom" | "Project";

export interface KeybindingRow {
  readonly id: string;
  readonly command: KeybindingCommand;
  readonly key: string;
  readonly when: string;
  readonly source: KeybindingSource;
  /** The default rule Reset restores; null when the command has none left to restore. */
  readonly defaultRule: { readonly key: string; readonly when: string } | null;
  readonly binding: ResolvedKeybindingRule;
  readonly conflicts: ReadonlyArray<string>;
}

export interface KeybindingGroup {
  readonly id: string;
  readonly title: string;
  readonly rows: ReadonlyArray<KeybindingRow>;
}

const COMMAND_LABELS: Partial<Record<string, string>> = {
  "workspace.focusNext": "Focus Next Workspace Area",
  "workspace.focusPrevious": "Focus Previous Workspace Area",
  "navigation.back": "Go Back",
  "navigation.forward": "Go Forward",
  "sidebar.toggle": "Toggle Sidebar",
  "terminal.splitVertical": "Terminal: Split Vertically",
  "chat.new": "New Thread",
  "chat.newLocal": "New Local Thread",
  "chat.find": "Find in Thread",
  "commandPalette.toggle": "Toggle Command Palette",
  "filePicker.toggle": "Toggle File Picker",
  "modelPicker.toggle": "Composer: Model Picker",
  "composer.stash": "Composer: Stash Prompt",
  "composer.effort": "Composer: Effort Picker",
  "composer.increaseEffort": "Composer: Increase Effort",
  "composer.decreaseEffort": "Composer: Decrease Effort",
  "composer.mode": "Composer: Toggle Access Mode",
  "composer.workspace": "Composer: Workspace Picker",
  "composer.branch": "Composer: Branch Picker",
  "composer.sendBackground": "Composer: Start in Background",
  "composer.sendAndNewThread": "Composer: Send and Start New Thread",
  "editor.openFavorite": "Open in Favorite Editor",
  "thread.stop": "Thread: Stop",
  "thread.undo": "Thread: Undo",
  "thread.copyReference": "Thread: Copy Reference",
  "thread.pin": "Thread: Pin",
  "thread.previous": "Thread: Previous",
  "thread.next": "Thread: Next",
};

const KEYBINDING_GROUPS = [
  {
    id: "navigation",
    title: "Navigation",
    prefixes: [
      "sidebar",
      "navigation",
      "workspace",
      "commandPalette",
      "filePicker",
      "editor",
    ] as ReadonlyArray<string>,
  },
  { id: "threads", title: "Threads", prefixes: ["thread", "chat"] as ReadonlyArray<string> },
  {
    id: "composer",
    title: "Composer",
    prefixes: ["composer", "modelPicker"] as ReadonlyArray<string>,
  },
  { id: "terminal", title: "Terminal", prefixes: ["terminal"] as ReadonlyArray<string> },
  { id: "diff", title: "Diff", prefixes: ["diff"] as ReadonlyArray<string> },
  { id: "scripts", title: "Project scripts", prefixes: ["script"] as ReadonlyArray<string> },
];
const OTHER_KEYBINDING_GROUP = { id: "other", title: "Other" };

const CORE_WHEN_VARIABLES = [
  "terminalFocus",
  "terminalOpen",
  "isWeb",
  "isDesktop",
  "true",
  "false",
];

function collectWhenIdentifiers(node: KeybindingWhenNode | undefined, into: Set<string>): void {
  if (!node) return;
  switch (node.type) {
    case "identifier":
      into.add(node.name);
      return;
    case "not":
      collectWhenIdentifiers(node.node, into);
      return;
    case "and":
    case "or":
      collectWhenIdentifiers(node.left, into);
      collectWhenIdentifiers(node.right, into);
      return;
  }
}

const KNOWN_WHEN_VARIABLES = new Set<string>(CORE_WHEN_VARIABLES);
for (const binding of DEFAULT_RESOLVED_KEYBINDINGS) {
  collectWhenIdentifiers(binding.whenAst, KNOWN_WHEN_VARIABLES);
}

export function unknownWhenVariables(node: KeybindingWhenNode | undefined): ReadonlyArray<string> {
  const identifiers = new Set<string>();
  collectWhenIdentifiers(node, identifiers);
  return [...identifiers].filter((name) => !KNOWN_WHEN_VARIABLES.has(name)).toSorted();
}

export function shortcutToKeybindingInput(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("mod");
  if (shortcut.metaKey) parts.push("meta");
  if (shortcut.ctrlKey) parts.push("ctrl");
  if (shortcut.altKey) parts.push("alt");
  if (shortcut.shiftKey) parts.push("shift");
  parts.push(shortcut.key === " " ? "space" : shortcut.key === "escape" ? "esc" : shortcut.key);
  return parts.join("+");
}

function wrapWhenExpression(node: KeybindingWhenNode): string {
  if (node.type === "identifier" || node.type === "not") return whenAstToExpression(node);
  return `(${whenAstToExpression(node)})`;
}

export function whenAstToExpression(node: KeybindingWhenNode | undefined): string {
  if (!node) return "";
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${wrapWhenExpression(node.node)}`;
    case "and":
      return `${wrapWhenExpression(node.left)} && ${wrapWhenExpression(node.right)}`;
    case "or":
      return `${wrapWhenExpression(node.left)} || ${wrapWhenExpression(node.right)}`;
  }
}

export function parseWhenExpressionDraft(
  expression: string,
): { ok: true; value: KeybindingWhenNode | undefined } | { ok: false; message: string } {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };
  const ast = parseKeybindingWhenExpression(trimmed);
  if (!ast) {
    return { ok: false, message: "Use variables with !, &&, ||, and parentheses." };
  }
  return { ok: true, value: ast };
}

function keybindingRowId(command: KeybindingCommand, key: string, when: string): string {
  return `${command}\u0000${key}\u0000${when}`;
}

function resolvedRowId(binding: ResolvedKeybindingRule): string {
  return keybindingRowId(
    binding.command,
    shortcutToKeybindingInput(binding.shortcut),
    whenAstToExpression(binding.whenAst),
  );
}

// Computed against the shipped defaults: first run writes them all to the file, so being on disk
// says nothing about whether the user customized a rule.
const DEFAULT_ROW_IDS = new Set(DEFAULT_RESOLVED_KEYBINDINGS.map(resolvedRowId));

function sourceForBinding(binding: ResolvedKeybindingRule): KeybindingSource {
  if (String(binding.command).startsWith("script.")) return "Project";
  return DEFAULT_ROW_IDS.has(resolvedRowId(binding)) ? "Default" : "Custom";
}

function conflictsWithWhen(leftWhen: string, rightWhen: string): boolean {
  return leftWhen.length === 0 || rightWhen.length === 0 || leftWhen === rightWhen;
}

export function keybindingConflictLabels(
  rows: ReadonlyArray<KeybindingRow>,
  input: {
    readonly rowId: string;
    readonly command: KeybindingCommand | null;
    readonly key: string;
    readonly when: string;
  },
  platform = navigator.platform,
): ReadonlyArray<string> {
  const shortcut = parseKeybindingShortcut(input.key);
  if (input.key.trim().length === 0 || !shortcut) return [];
  const conflictKey = shortcutConflictKey(shortcut, platform);
  const conflicts = new Set<string>();
  for (const candidate of rows) {
    if (
      candidate.id !== input.rowId &&
      candidate.command !== input.command &&
      shortcutConflictKey(candidate.binding.shortcut, platform) === conflictKey &&
      conflictsWithWhen(candidate.when, input.when)
    ) {
      conflicts.add(commandLabel(candidate.command));
    }
  }
  return [...conflicts].toSorted();
}

export function buildKeybindingRows(
  keybindings: ResolvedKeybindingsConfig,
  platform = navigator.platform,
): ReadonlyArray<KeybindingRow> {
  const bindingsById = new Map(keybindings.map((binding) => [resolvedRowId(binding), binding]));
  const rows = [...bindingsById].map(([id, binding]): KeybindingRow => {
    const when = whenAstToExpression(binding.whenAst);
    // Only a default not already bound, so Reset never lands on a sibling rule.
    const unusedDefaults = DEFAULT_RESOLVED_KEYBINDINGS.filter(
      (entry) => entry.command === binding.command && !bindingsById.has(resolvedRowId(entry)),
    );
    const defaultBinding =
      unusedDefaults.find((entry) => whenAstToExpression(entry.whenAst) === when) ??
      unusedDefaults[0];
    return {
      id,
      command: binding.command,
      key: shortcutToKeybindingInput(binding.shortcut),
      when,
      source: sourceForBinding(binding),
      defaultRule: defaultBinding
        ? {
            key: shortcutToKeybindingInput(defaultBinding.shortcut),
            when: whenAstToExpression(defaultBinding.whenAst),
          }
        : null,
      binding,
      conflicts: [],
    };
  });

  return rows
    .map((row) =>
      Object.assign({}, row, {
        conflicts: keybindingConflictLabels(
          rows,
          { rowId: row.id, command: row.command, key: row.key, when: row.when },
          platform,
        ),
      }),
    )
    .toSorted(
      (left, right) =>
        commandLabel(left.command).localeCompare(commandLabel(right.command)) ||
        left.key.localeCompare(right.key) ||
        left.when.localeCompare(right.when),
    );
}

export function filterKeybindingRows(
  rows: ReadonlyArray<KeybindingRow>,
  query: string,
  platform = navigator.platform,
): ReadonlyArray<KeybindingRow> {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return rows;
  return rows.filter((row) =>
    [
      row.command,
      commandLabel(row.command),
      row.key,
      formatShortcutLabel(row.binding.shortcut, platform),
      row.when,
      row.source,
    ].some((text) => text.toLowerCase().includes(normalizedQuery)),
  );
}

export function groupKeybindingRows(
  rows: ReadonlyArray<KeybindingRow>,
): ReadonlyArray<KeybindingGroup> {
  const rowsByGroup = new Map<string, KeybindingRow[]>();
  for (const row of rows) {
    const prefix = String(row.command).split(".")[0] ?? "";
    const group =
      KEYBINDING_GROUPS.find((entry) => entry.prefixes.includes(prefix)) ?? OTHER_KEYBINDING_GROUP;
    const bucket = rowsByGroup.get(group.id);
    if (bucket) bucket.push(row);
    else rowsByGroup.set(group.id, [row]);
  }
  return [...KEYBINDING_GROUPS, OTHER_KEYBINDING_GROUP].flatMap((group) => {
    const groupRows = rowsByGroup.get(group.id);
    return groupRows ? [{ id: group.id, title: group.title, rows: groupRows }] : [];
  });
}

/** Every command a new rule can target, including ones with no binding today. */
export function buildKeybindingCommandOptions(
  keybindings: ResolvedKeybindingsConfig,
): ReadonlyArray<KeybindingCommand> {
  const commands = new Set<KeybindingCommand>(STATIC_KEYBINDING_COMMANDS);
  for (const binding of keybindings) commands.add(binding.command);
  return [...commands].toSorted((left, right) =>
    commandLabel(left).localeCompare(commandLabel(right)),
  );
}

function titleCaseCommandSegment(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function commandLabel(command: KeybindingCommand): string {
  const raw = String(command);
  const label = COMMAND_LABELS[raw];
  if (label) return label;
  if (raw.startsWith("script.") && raw.endsWith(".run")) {
    return `Run Script: ${titleCaseCommandSegment(raw.slice("script.".length, -".run".length))}`;
  }
  return raw.split(".").map(titleCaseCommandSegment).join(": ");
}

export function rowKeybindingTarget(row: KeybindingRow): KeybindingRule {
  return {
    command: row.command,
    key: row.key,
    ...(row.when.length > 0 ? { when: row.when } : {}),
  };
}

function recordedShortcutKey(
  event: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey">,
): string {
  const physicalKey = shortcutKeyFromEvent(event);
  const layoutKey = event.key.toLowerCase();
  if (event.altKey || layoutKey.length !== 1 || /^[a-z]$/.test(physicalKey)) return physicalKey;
  // Normalize only US shifted glyphs at their US position; other layouts can produce the same
  // glyph without Shift or at a different position.
  const unshiftedKey = event.shiftKey ? US_SHIFTED_TO_UNSHIFTED_KEYS.get(layoutKey) : undefined;
  return unshiftedKey === physicalKey ? physicalKey : layoutKey;
}

function normalizeShortcutKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized.length === 1 || /^f\d{1,2}$/.test(normalized)) return normalized;
  const namedKeys = [
    "arrowup",
    "arrowdown",
    "arrowleft",
    "arrowright",
    "enter",
    "tab",
    "backspace",
    "delete",
    "home",
    "end",
    "pageup",
    "pagedown",
  ];
  return namedKeys.includes(normalized) ? normalized : null;
}

/** A chord with no modifier matches in any text field too. Function keys never type text. */
export function isUnmodifiedKeybinding(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (normalized.length === 0 || /^f\d{1,2}$/.test(normalized)) return false;
  return !/^(?:mod|ctrl|meta|alt|shift)\+./.test(normalized);
}

/** The rule text for a pressed chord, or null while only modifiers are held. */
export function keybindingFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> &
    Partial<Pick<KeyboardEvent, "getModifierState">>,
  platform: string,
): string | null {
  if (isAltGraphTextEvent(event, platform)) return null;
  const keyToken = normalizeShortcutKeyToken(recordedShortcutKey(event));
  if (!keyToken) return null;

  const parts: string[] = [];
  if (isMacPlatform(platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(keyToken);
  return parts.join("+");
}
