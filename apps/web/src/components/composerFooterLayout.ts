export const COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX = 780;
/** Promotions must clear this margin, so sub-pixel label widths cannot flip a threshold back and forth. */
const COMPOSER_FOOTER_RESTORE_SLACK_PX = 1;

/** Keeps a label measurable while an icon replaces it; leaves its button's flex flow. */
export const COMPOSER_ICON_ONLY_LABEL_CLASS_NAME = "pointer-events-none invisible absolute w-max";

export function shouldUseCompactComposerPrimaryActions(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  if (!options?.hasWideActions) {
    return false;
  }
  return width !== null && width < COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX;
}

export interface ComposerFooterControlsLayout {
  /** Trailing blocks showing only their icon; hidden blocks count too. */
  iconOnlyCount: number;
  /** Trailing blocks moved into the overflow menu. */
  hiddenCount: number;
}

export interface ComposerFooterControlsMeasurement {
  /** Width of what stays in the footer whatever else collapses: the model picker. */
  fixedWidth: number;
  gap: number;
  blockWidths: readonly number[];
  iconOnlyBlockWidths: readonly number[];
  overflowWidth: number;
  /** Footer content width minus the actions cluster and the gap before it. */
  availableWidth: number;
}

function composerFooterControlsWidth(
  input: ComposerFooterControlsMeasurement,
  layout: ComposerFooterControlsLayout,
): number {
  const { blockWidths, iconOnlyBlockWidths, gap } = input;
  const visibleCount = blockWidths.length - layout.hiddenCount;
  let width = input.fixedWidth + gap * visibleCount;
  for (let index = 0; index < visibleCount; index += 1) {
    const iconOnly = index >= blockWidths.length - layout.iconOnlyCount;
    width += (iconOnly ? iconOnlyBlockWidths[index] : blockWidths[index]) ?? 0;
  }
  return layout.hiddenCount > 0 ? width + gap + input.overflowWidth : width;
}

/**
 * Trailing blocks lose their labels first, then move into the overflow menu.
 * Demotion is immediate; restoring what `previous` had collapsed needs a pixel of slack.
 */
export function resolveComposerFooterControlsLayout(
  input: ComposerFooterControlsMeasurement & { previous?: ComposerFooterControlsLayout },
): ComposerFooterControlsLayout {
  const blockCount = input.blockWidths.length;
  const { previous } = input;
  const layoutAtStep = (step: number): ComposerFooterControlsLayout => ({
    iconOnlyCount: Math.min(step, blockCount),
    hiddenCount: Math.max(0, step - blockCount),
  });
  const previousStep = previous
    ? previous.hiddenCount > 0
      ? blockCount + Math.min(previous.hiddenCount, blockCount)
      : Math.min(previous.iconOnlyCount, blockCount)
    : 0;
  let step = 0;
  while (
    step < blockCount * 2 &&
    composerFooterControlsWidth(input, layoutAtStep(step)) >
      input.availableWidth - (step < previousStep ? COMPOSER_FOOTER_RESTORE_SLACK_PX : 0)
  ) {
    step += 1;
  }
  return layoutAtStep(step);
}

/** Splits an ordered block list by a layout's trailing counts. */
export function resolveComposerFooterBlockStates<Id extends string>(
  blockIds: readonly Id[],
  layout: ComposerFooterControlsLayout,
): { hidden: readonly Id[]; iconOnly: readonly Id[] } {
  const trailing = (count: number) => (count > 0 ? blockIds.slice(-count) : []);
  return { hidden: trailing(layout.hiddenCount), iconOnly: trailing(layout.iconOnlyCount) };
}

export function resolveComposerFooterContentWidth(input: {
  footerWidth: number | null;
  paddingLeft: number | null;
  paddingRight: number | null;
}): number | null {
  const footerWidth = input.footerWidth;
  const paddingLeft = input.paddingLeft;
  const paddingRight = input.paddingRight;
  if (footerWidth === null || paddingLeft === null || paddingRight === null) {
    return null;
  }
  return Math.max(0, footerWidth - paddingLeft - paddingRight);
}
