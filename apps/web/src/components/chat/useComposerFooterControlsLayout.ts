import { useLayoutEffect, useState } from "react";

import {
  type ComposerFooterControlsLayout,
  type ComposerFooterControlsMeasurement,
  resolveComposerFooterContentWidth,
  resolveComposerFooterControlsLayout,
} from "../composerFooterLayout";

const BLOCK_SELECTOR = "[data-composer-footer-block]";
const OVERFLOW_SELECTOR = "[data-composer-footer-overflow]";
const LABEL_SELECTOR = "[data-composer-control-label]";
const COMPACT_ICON_SELECTOR = "[data-composer-control-compact-icon]";
const ATTACH_BUTTON_SELECTOR = "[data-composer-attach-button]";
const MODEL_PICKER_SELECTOR = '[data-chat-provider-model-picker="true"]';
const MODEL_PICKER_LABEL_SELECTOR = '[data-chat-provider-model-picker-label="true"]';

const INITIAL_LAYOUT: ComposerFooterControlsLayout = { iconOnlyCount: 0, hiddenCount: 0 };

function pixels(value: string): number {
  return Number.parseFloat(value) || 0;
}

function flowWidth(element: HTMLElement): { width: number; inFlow: boolean } {
  const gap = element.parentElement ? pixels(getComputedStyle(element.parentElement).columnGap) : 0;
  return {
    width: element.getBoundingClientRect().width + gap,
    inFlow: getComputedStyle(element).position !== "absolute",
  };
}

/** Reads both variants of a block from one tree: the inactive one stays mounted out of flow. */
function measureBlock(block: HTMLElement): { natural: number; iconOnly: number } {
  let natural = block.getBoundingClientRect().width;
  let iconOnly = natural;
  for (const label of block.querySelectorAll<HTMLElement>(LABEL_SELECTOR)) {
    const { width, inFlow } = flowWidth(label);
    if (inFlow) iconOnly -= width;
    else natural += width;
  }
  for (const icon of block.querySelectorAll<HTMLElement>(COMPACT_ICON_SELECTOR)) {
    const { width, inFlow } = flowWidth(icon);
    if (inFlow) natural -= width;
    else iconOnly += width;
  }
  return { natural, iconOnly: Math.min(natural, iconOnly) };
}

/** The picker shrinks as a last resort, so recover the width its truncated label wants. */
function measureModelPicker(picker: HTMLElement | null): number {
  if (!picker) return 0;
  const label = picker.querySelector<HTMLElement>(MODEL_PICKER_LABEL_SELECTOR);
  const truncatedWidth = label ? Math.max(0, label.scrollWidth - label.clientWidth) : 0;
  const maxWidth = Number.parseFloat(getComputedStyle(picker).maxWidth);
  const natural = picker.getBoundingClientRect().width + truncatedWidth;
  return Number.isFinite(maxWidth) ? Math.min(natural, maxWidth) : natural;
}

export function measureComposerFooterControls(input: {
  footer: HTMLElement;
  leading: HTMLElement;
  actions: HTMLElement;
}): ComposerFooterControlsMeasurement | null {
  const { footer, leading, actions } = input;
  // The leading strip is display:none while a pending question owns the footer.
  if (leading.getClientRects().length === 0) return null;
  const footerStyle = getComputedStyle(footer);
  const contentWidth =
    resolveComposerFooterContentWidth({
      footerWidth: footer.getBoundingClientRect().width,
      paddingLeft: pixels(footerStyle.paddingLeft),
      paddingRight: pixels(footerStyle.paddingRight),
    }) ?? 0;
  const blocks = Array.from(leading.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)).map(
    measureBlock,
  );
  const overflow = leading.querySelector<HTMLElement>(OVERFLOW_SELECTOR);
  const attachButton = leading.querySelector<HTMLElement>(ATTACH_BUTTON_SELECTOR);
  const gap = pixels(getComputedStyle(leading).columnGap);
  return {
    fixedWidth:
      measureModelPicker(leading.querySelector<HTMLElement>(MODEL_PICKER_SELECTOR)) +
      (attachButton ? attachButton.getBoundingClientRect().width + gap : 0),
    gap,
    blockWidths: blocks.map((block) => block.natural),
    iconOnlyBlockWidths: blocks.map((block) => block.iconOnly),
    overflowWidth: overflow?.getBoundingClientRect().width ?? 0,
    availableWidth: Math.max(
      0,
      contentWidth - actions.getBoundingClientRect().width - pixels(footerStyle.columnGap),
    ),
  };
}

/** Fits the footer's controls to its measured width; `layoutKey` re-measures before paint when it changes. */
export function useComposerFooterControlsLayout(layoutKey: string) {
  const [footer, setFooter] = useState<HTMLElement | null>(null);
  const [leading, setLeading] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [layout, setLayout] = useState(INITIAL_LAYOUT);

  useLayoutEffect(() => {
    if (!footer || !leading || !actions) return;
    const measure = () => {
      const measurement = measureComposerFooterControls({ footer, leading, actions });
      if (!measurement) return;
      setLayout((previous) => {
        const next = resolveComposerFooterControlsLayout({ ...measurement, previous });
        return next.iconOnlyCount === previous.iconOnlyCount &&
          next.hiddenCount === previous.hiddenCount
          ? previous
          : next;
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(measure);
    const observeControls = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(footer);
      resizeObserver.observe(actions);
      leading
        .querySelectorAll<HTMLElement>(
          `${BLOCK_SELECTOR}, ${LABEL_SELECTOR}, ${MODEL_PICKER_SELECTOR}, ${MODEL_PICKER_LABEL_SELECTOR}`,
        )
        .forEach((element) => resizeObserver.observe(element));
    };
    observeControls();
    // Blocks and labels come and go with the model and the plan state.
    const mutationObserver = new MutationObserver(observeControls);
    mutationObserver.observe(leading, { childList: true, subtree: true, characterData: true });
    document.fonts?.addEventListener("loadingdone", measure);
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [footer, leading, actions, layoutKey]);

  return {
    layout,
    footerRef: setFooter,
    leadingRef: setLeading,
    actionsRef: setActions,
  };
}
