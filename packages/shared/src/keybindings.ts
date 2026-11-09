/**
 * Keybinding rules shared by the server and the settings editor: the default rules, the
 * shortcut and `when` parsers, and the merge of persisted rules over the defaults.
 *
 * @module keybindings
 */
import {
  MAX_KEYBINDINGS_COUNT,
  MAX_WHEN_EXPRESSION_DEPTH,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type KeybindingRule,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@piedpiper/contracts";

/** Punctuation a US layout produces with Shift, mapped to the key it shares a position with. */
export const US_SHIFTED_TO_UNSHIFTED_KEYS: ReadonlyMap<string, string> = new Map([
  ["!", "1"],
  ["@", "2"],
  ["#", "3"],
  ["$", "4"],
  ["%", "5"],
  ["^", "6"],
  ["&", "7"],
  ["*", "8"],
  ["(", "9"],
  [")", "0"],
  ["~", "`"],
  ["_", "-"],
  ["+", "="],
  ["{", "["],
  ["}", "]"],
  ["|", "\\"],
  [":", ";"],
  ['"', "'"],
  ["<", ","],
  [">", "."],
  ["?", "/"],
]);

type WhenToken =
  | { type: "identifier"; value: string }
  | { type: "not" }
  | { type: "and" }
  | { type: "or" }
  | { type: "lparen" }
  | { type: "rparen" };

/**
 * `when` clause for the default numbered thread jumps: only in the desktop app, so
 * mod+1..9 still switches browser tabs when the web app runs in a browser. Written as
 * `!isWeb` (not upstream's `isDesktop`) so the jumps keep working on clients whose
 * shortcut context does not provide the identifier yet (unknown identifiers are false).
 */
export const THREAD_JUMP_DEFAULT_WHEN = "!isWeb";

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
  { key: "f6", command: "workspace.focusNext" },
  { key: "shift+f6", command: "workspace.focusPrevious" },
  // Some browsers keep plain F6 for their own toolbars; mod+F6 reaches the page in all of them.
  { key: "mod+f6", command: "workspace.focusNext" },
  { key: "mod+shift+f6", command: "workspace.focusPrevious" },
  { key: "mod+[", command: "navigation.back", when: "!terminalFocus" },
  { key: "mod+]", command: "navigation.forward", when: "!terminalFocus" },
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
  { key: "mod+shift+d", command: "terminal.splitVertical", when: "terminalFocus" },
  { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
  { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
  { key: "mod+w", command: "diff.close", when: "!terminalFocus" },
  { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
  { key: "mod+p", command: "filePicker.toggle", when: "!terminalFocus" },
  { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+n", command: "chat.newLocal", when: "!terminalFocus" },
  { key: "mod+f", command: "chat.find", when: "!terminalFocus" },
  { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  { key: "mod+s", command: "composer.stash", when: "composerFocus" },
  { key: "mod+shift+e", command: "composer.effort", when: "!terminalFocus" },
  { key: "mod+shift+a", command: "composer.mode", when: "!terminalFocus" },
  {
    key: "mod+enter",
    command: "composer.sendBackground",
    when: "composerFocus && draftThreadRoute",
  },
  {
    key: "mod+alt+enter",
    command: "composer.sendBackground",
    when: "composerFocus && draftThreadRoute",
  },
  {
    key: "mod+alt+enter",
    command: "composer.sendAndNewThread",
    when: "composerFocus && !draftThreadRoute",
  },
  { key: "mod+o", command: "editor.openFavorite" },
  { key: "mod+.", command: "thread.stop", when: "!terminalFocus" },
  {
    key: "mod+z",
    command: "thread.undo",
    when: "!terminalFocus && !editableFocus",
  },
  { key: "mod+shift+[", command: "thread.previous" },
  { key: "mod+shift+]", command: "thread.next" },
  { key: "mod+shift+c", command: "thread.copyReference", when: "!terminalFocus" },
  { key: "mod+shift+p", command: "thread.pin", when: "!terminalFocus" },
  ...THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    key: `mod+${index + 1}`,
    command,
    when: THREAD_JUMP_DEFAULT_WHEN,
  })),
];

function normalizeKeyToken(token: string): string {
  if (token === "space") return " ";
  if (token === "esc") return "escape";
  return token;
}

export function parseKeybindingShortcut(value: string): KeybindingShortcut | null {
  const rawTokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  const tokens = [...rawTokens];
  let trailingEmptyCount = 0;
  while (tokens[tokens.length - 1] === "") {
    trailingEmptyCount += 1;
    tokens.pop();
  }
  if (trailingEmptyCount > 0) {
    tokens.push("+");
  }
  if (tokens.some((token) => token.length === 0)) {
    return null;
  }
  if (tokens.length === 0) return null;

  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let shiftKey = false;
  let altKey = false;
  let modKey = false;

  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default: {
        if (key !== null) return null;
        key = normalizeKeyToken(token);
      }
    }
  }

  if (key === null) return null;
  return {
    key,
    metaKey,
    ctrlKey,
    shiftKey,
    altKey,
    modKey,
  };
}

function tokenizeWhenExpression(expression: string): WhenToken[] | null {
  const tokens: WhenToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const current = expression[index];
    if (!current) break;

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (expression.startsWith("&&", index)) {
      tokens.push({ type: "and" });
      index += 2;
      continue;
    }
    if (expression.startsWith("||", index)) {
      tokens.push({ type: "or" });
      index += 2;
      continue;
    }
    if (current === "!") {
      tokens.push({ type: "not" });
      index += 1;
      continue;
    }
    if (current === "(") {
      tokens.push({ type: "lparen" });
      index += 1;
      continue;
    }
    if (current === ")") {
      tokens.push({ type: "rparen" });
      index += 1;
      continue;
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expression.slice(index));
    if (!identifier) {
      return null;
    }
    tokens.push({ type: "identifier", value: identifier[0] });
    index += identifier[0].length;
  }

  return tokens;
}

export function parseKeybindingWhenExpression(expression: string): KeybindingWhenNode | null {
  const tokens = tokenizeWhenExpression(expression);
  if (!tokens || tokens.length === 0) return null;
  let index = 0;

  const parsePrimary = (depth: number): KeybindingWhenNode | null => {
    if (depth > MAX_WHEN_EXPRESSION_DEPTH) {
      return null;
    }
    const token = tokens[index];
    if (!token) return null;

    if (token.type === "identifier") {
      index += 1;
      return { type: "identifier", name: token.value };
    }

    if (token.type === "lparen") {
      index += 1;
      const expressionNode = parseOr(depth + 1);
      const closeToken = tokens[index];
      if (!expressionNode || !closeToken || closeToken.type !== "rparen") {
        return null;
      }
      index += 1;
      return expressionNode;
    }

    return null;
  };

  const parseUnary = (depth: number): KeybindingWhenNode | null => {
    let notCount = 0;
    while (tokens[index]?.type === "not") {
      index += 1;
      notCount += 1;
      if (notCount > MAX_WHEN_EXPRESSION_DEPTH) {
        return null;
      }
    }

    let node = parsePrimary(depth);
    if (!node) return null;

    while (notCount > 0) {
      node = { type: "not", node };
      notCount -= 1;
    }

    return node;
  };

  const parseAnd = (depth: number): KeybindingWhenNode | null => {
    let left = parseUnary(depth);
    if (!left) return null;

    while (tokens[index]?.type === "and") {
      index += 1;
      const right = parseUnary(depth);
      if (!right) return null;
      left = { type: "and", left, right };
    }

    return left;
  };

  const parseOr = (depth: number): KeybindingWhenNode | null => {
    let left = parseAnd(depth);
    if (!left) return null;

    while (tokens[index]?.type === "or") {
      index += 1;
      const right = parseAnd(depth);
      if (!right) return null;
      left = { type: "or", left, right };
    }

    return left;
  };

  const ast = parseOr(0);
  if (!ast || index !== tokens.length) return null;
  return ast;
}

export function compileResolvedKeybindingRule(rule: KeybindingRule): ResolvedKeybindingRule | null {
  const shortcut = parseKeybindingShortcut(rule.key);
  if (!shortcut) return null;

  if (rule.when !== undefined) {
    const whenAst = parseKeybindingWhenExpression(rule.when);
    if (!whenAst) return null;
    return {
      command: rule.command,
      shortcut,
      whenAst,
    };
  }

  return {
    command: rule.command,
    shortcut,
  };
}

export function encodeShortcut(shortcut: KeybindingShortcut): string | null {
  const modifiers: string[] = [];
  if (shortcut.modKey) modifiers.push("mod");
  if (shortcut.metaKey) modifiers.push("meta");
  if (shortcut.ctrlKey) modifiers.push("ctrl");
  if (shortcut.altKey) modifiers.push("alt");
  if (shortcut.shiftKey) modifiers.push("shift");
  if (!shortcut.key) return null;
  if (shortcut.key !== "+" && shortcut.key.includes("+")) return null;
  const key = shortcut.key === " " ? "space" : shortcut.key;
  return [...modifiers, key].join("+");
}

export function encodeWhenAst(node: KeybindingWhenNode): string {
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!(${encodeWhenAst(node.node)})`;
    case "and":
      return `(${encodeWhenAst(node.left)} && ${encodeWhenAst(node.right)})`;
    case "or":
      return `(${encodeWhenAst(node.left)} || ${encodeWhenAst(node.right)})`;
  }
}

/**
 * Canonical form of a rule. Settings sends replace and remove targets in its own spelling, which
 * can differ from a hand-edited file ("cmd+k" vs "meta+k", "a&&b" vs "a && b").
 */
export function keybindingRuleIdentity(rule: KeybindingRule): string {
  const shortcut = parseKeybindingShortcut(rule.key);
  const key = (shortcut && encodeShortcut(shortcut)) ?? rule.key;
  if (rule.when === undefined) return JSON.stringify([rule.command, key, null]);
  const whenAst = parseKeybindingWhenExpression(rule.when);
  return JSON.stringify([rule.command, key, whenAst ? encodeWhenAst(whenAst) : rule.when]);
}

export const DEFAULT_RESOLVED_KEYBINDINGS: ResolvedKeybindingsConfig = DEFAULT_KEYBINDINGS.flatMap(
  (rule) => compileResolvedKeybindingRule(rule) ?? [],
);

export function mergeWithDefaultKeybindings(
  custom: ResolvedKeybindingsConfig,
): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return [...DEFAULT_RESOLVED_KEYBINDINGS];
  }

  const overriddenCommands = new Set(custom.map((binding) => binding.command));
  const retainedDefaults = DEFAULT_RESOLVED_KEYBINDINGS.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  const merged = [...retainedDefaults, ...custom];

  if (merged.length <= MAX_KEYBINDINGS_COUNT) {
    return merged;
  }

  // Keep the latest rules when the config exceeds max size; later rules have higher precedence.
  return merged.slice(-MAX_KEYBINDINGS_COUNT);
}
