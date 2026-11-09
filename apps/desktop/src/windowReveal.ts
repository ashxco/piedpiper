export type RevealSubscription = (listener: () => void) => void;

/** Runs `reveal` once, on whichever subscribed event fires first. */
export function bindFirstRevealTrigger(
  subscribers: readonly RevealSubscription[],
  reveal: () => void,
): void {
  let revealed = false;
  const fire = () => {
    if (revealed) return;
    revealed = true;
    reveal();
  };
  for (const subscribe of subscribers) {
    subscribe(fire);
  }
}

export interface RevealableWindow {
  isMinimized(): boolean;
  restore(): void;
  isVisible(): boolean;
  show(): void;
  focus(): void;
}

/** Raises a minimized or hidden window; `activateApp` lets macOS steal focus from the frontmost app. */
export function raiseWindow(window: RevealableWindow, activateApp?: () => void): void {
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  activateApp?.();
  window.focus();
}

/** Only the main window's own renderer may raise it, and IPC never creates a window. */
export function makeRevealWindowHandler<
  TWindow extends { readonly webContents: { id: number } },
>(input: {
  readonly getMainWindow: () => TWindow | null;
  readonly reveal: (window: TWindow) => void;
}): (event: { readonly sender: { readonly id: number } }) => void {
  return (event) => {
    const window = input.getMainWindow();
    if (window === null || window.webContents.id !== event.sender.id) return;
    input.reveal(window);
  };
}
