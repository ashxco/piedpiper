// In rem, not em: chips also render outside the 14px editor (timeline, pending review comments).
export const COMPOSER_INLINE_CHIP_CLASS_NAME =
  "inline-flex max-w-full select-none items-center gap-1 rounded-md border border-border/70 bg-accent/40 px-1.5 py-px font-medium text-[0.75rem] leading-[1.1] text-foreground align-middle";

// Chips are select-none, so the browser skips them when painting a selection; this overlay stands in.
export const COMPOSER_INLINE_CHIP_SELECTION_CLASS_NAME =
  "composer-inline-chip relative data-composer-chip-selected:after:pointer-events-none data-composer-chip-selected:after:absolute data-composer-chip-selected:after:inset-0 data-composer-chip-selected:after:rounded-md data-composer-chip-selected:after:bg-[color:Highlight] data-composer-chip-selected:after:opacity-30";

export const COMPOSER_INLINE_CHIP_ICON_CLASS_NAME = "size-3.5 shrink-0 opacity-85";

export const COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME = "truncate select-none leading-tight";

export const COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME =
  "ml-0.5 inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/72 transition-colors hover:bg-foreground/6 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
