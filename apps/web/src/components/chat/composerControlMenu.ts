export type ChatComposerControl = "model" | "effort" | "mode";

export type ChatComposerOpenMenu = ChatComposerControl | "compact";

/** The footer's collapsible controls, leading to trailing; trailing ones collapse first. */
export type ComposerFooterBlockId = "traits" | "mode" | "access" | "plan";

/** Which composer menu a control shortcut opens, or null when that control is not shown. */
export function resolveComposerControlMenu(input: {
  control: ChatComposerControl;
  footerControlsShown: boolean;
  hiddenBlocks: readonly ComposerFooterBlockId[];
  hasTraitsPicker: boolean;
}): ChatComposerOpenMenu | null {
  if (!input.footerControlsShown) return null;
  // The model picker stays in the footer in every layout.
  if (input.control === "model") return "model";
  if (input.control === "effort" && !input.hasTraitsPicker) return null;
  // The mode shortcut opens the access picker; the agent/plan button has no menu.
  const block = input.control === "effort" ? "traits" : "access";
  return input.hiddenBlocks.includes(block) ? "compact" : input.control;
}

/** The shortcut that opens the overflow menu, by the rule `resolveComposerControlMenu` follows. */
export function resolveComposerOverflowShortcutLabel(input: {
  hiddenBlocks: readonly ComposerFooterBlockId[];
  effortShortcutLabel: string | null;
  modeShortcutLabel: string | null;
}): string | null {
  if (input.hiddenBlocks.includes("traits") && input.effortShortcutLabel) {
    return input.effortShortcutLabel;
  }
  return input.hiddenBlocks.includes("access") ? input.modeShortcutLabel : null;
}

/** Whether a menu's trigger is out of the footer, so its popup would have nothing to anchor to. */
export function isComposerMenuTriggerHidden(
  menu: ChatComposerOpenMenu,
  hiddenBlocks: readonly ComposerFooterBlockId[],
): boolean {
  if (menu === "compact") return hiddenBlocks.length === 0;
  if (menu === "effort") return hiddenBlocks.includes("traits");
  if (menu === "mode") return hiddenBlocks.includes("access");
  return false;
}

export type ComposerMenuOpenChangeHandlers = Record<ChatComposerOpenMenu, (open: boolean) => void>;

/** One stable onOpenChange per menu, so memoized pickers keep equal props across composer renders. */
export function createComposerMenuOpenChangeHandlers(
  setOpenMenu: (
    update: (current: ChatComposerOpenMenu | null) => ChatComposerOpenMenu | null,
  ) => void,
): ComposerMenuOpenChangeHandlers {
  const handlerFor = (menu: ChatComposerOpenMenu) => (open: boolean) =>
    setOpenMenu((current) => (open ? menu : current === menu ? null : current));
  return {
    model: handlerFor("model"),
    effort: handlerFor("effort"),
    mode: handlerFor("mode"),
    compact: handlerFor("compact"),
  };
}
