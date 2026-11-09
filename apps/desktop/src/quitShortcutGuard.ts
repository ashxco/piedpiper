import type { QuitConfirmationMode } from "@piedpiper/contracts";

// The quit accelerator is intercepted in before-input-event, which runs before the native
// menu accelerator. Quitting from the application menu is untouched and always immediate.
export const QUIT_HOLD_DURATION_MS = 1200;
export const QUIT_DOUBLE_PRESS_MS = 500;
// "Still held" is proven by auto-repeat keydowns, not by the absence of a release: macOS
// suppresses a letter keyUp while the command key is down, so a tap release can go unseen and
// a release-based timer would quit anyway. Once held, quitting waits for Q keyUp or a quiet
// grace period after repeats stop so they cannot reach the next app. Keyboards with auto-repeat
// disabled must use a double press or the application menu Quit action.
export const QUIT_HOLD_RELEASE_GRACE_MS = 600;
// A slow repeat rate can exceed the fixed grace; waiting two observed cadences stays behind it.
const QUIT_HOLD_REPEAT_CADENCE_MULTIPLIER = 2;

export const QUIT_SHORTCUT_HINT_CHANNEL = "desktop:quit-shortcut";
export const SET_QUIT_CONFIRMATION_MODE_CHANNEL = "desktop:set-quit-confirmation-mode";

export type QuitShortcutHintEvent =
  | { readonly state: "down"; readonly mode: Exclude<QuitConfirmationMode, "direct"> }
  | { readonly state: "up" };

export function isQuitConfirmationMode(value: unknown): value is QuitConfirmationMode {
  return value === "direct" || value === "hold" || value === "double-click";
}

export interface QuitHoldKeyInput {
  readonly type: string;
  readonly key: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly isAutoRepeat: boolean;
}

export interface QuitShortcutOptions {
  readonly platform: NodeJS.Platform;
  readonly getMode: () => Promise<QuitConfirmationMode>;
  readonly notify: (event: QuitShortcutHintEvent) => void;
  readonly concealWindow: () => void;
  readonly quit: () => void;
}

export function makeQuitShortcutHandler(
  options: QuitShortcutOptions,
): (event: { preventDefault: () => void }, input: QuitHoldKeyInput) => void {
  // Electron's quit role has no Ctrl+Q accelerator on Windows, so there is nothing to guard.
  if (options.platform === "win32") return () => {};
  const modifierKey = options.platform === "darwin" ? "meta" : "control";
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let holding = false;
  let mode: QuitConfirmationMode | undefined;
  let notified = false;
  // Set once getMode resolves to hold; auto-repeats may only complete the hold when armed.
  let armed = false;
  let quitOnRelease = false;
  let heldSince = 0;
  let lastPressAt = 0;
  let lastRepeatAt = 0;
  let repeatCadenceMs = 0;
  // Bumped when a press is superseded or cancelled; a plain release keeps a direct-mode read alive.
  let generation = 0;

  const clearWatchdog = () => {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  };

  const release = (cancelPendingMode = true, keepDoublePressHint = false) => {
    if (cancelPendingMode) generation += 1;
    if (!holding && !notified) return;
    const keepHint = keepDoublePressHint && mode === "double-click" && notified;
    holding = false;
    armed = false;
    quitOnRelease = false;
    lastRepeatAt = 0;
    repeatCadenceMs = 0;
    if (keepHint) return;

    mode = undefined;
    clearWatchdog();
    if (notified) {
      notified = false;
      options.notify({ state: "up" });
    }
  };

  // Dismisses any overlay first so a cancelled quit cannot leave a stale hint.
  const quitNow = () => {
    release();
    lastPressAt = 0;
    options.quit();
  };

  const quitAfterQuietPeriod = () => {
    clearWatchdog();
    const quietPeriodMs = Math.max(
      QUIT_HOLD_RELEASE_GRACE_MS,
      repeatCadenceMs * QUIT_HOLD_REPEAT_CADENCE_MULTIPLIER,
    );
    watchdog = setTimeout(quitNow, quietPeriodMs);
  };

  return (event, input) => {
    const key = input.key.toLowerCase();
    if (input.type === "keyUp") {
      if (key === "q") {
        const shouldQuit = quitOnRelease;
        release(false, true);
        if (shouldQuit) options.quit();
      } else if (key === modifierKey) {
        if (!quitOnRelease) {
          release(false, true);
        } else {
          quitAfterQuietPeriod();
        }
      }
      return;
    }
    if (input.type !== "keyDown") return;

    const modifierDown = options.platform === "darwin" ? input.meta : input.control;
    if (input.isAutoRepeat && modifierDown && key === "q") {
      const now = Date.now();
      repeatCadenceMs = now - (lastRepeatAt === 0 ? heldSince : lastRepeatAt);
      lastRepeatAt = now;
    }
    if (quitOnRelease) {
      event.preventDefault();
      // A Q keydown proves the key is still down, with or without the modifier.
      if (key === "q") quitAfterQuietPeriod();
      return;
    }

    if (!modifierDown || input.alt || input.shift || key !== "q") {
      // Re-pressing the modifier starts a second full shortcut; it must not cancel a double press.
      if (key === modifierKey && !input.alt && !input.shift) return;

      // Other keys cancel the hold and the first tap, even after release.
      if (!input.isAutoRepeat) {
        lastPressAt = 0;
        release();
      }
      return;
    }

    event.preventDefault();

    if (input.isAutoRepeat) {
      if (mode === "hold" && armed && Date.now() - heldSince >= QUIT_HOLD_DURATION_MS) {
        armed = false;
        quitOnRelease = true;
        options.concealWindow();
        quitAfterQuietPeriod();
      }
      return;
    }

    const now = Date.now();
    const previousPressAt = lastPressAt;
    lastPressAt = now;
    // A fresh keydown supersedes the current hold or the hint kept alive after a release.
    if (holding || notified) release();

    generation += 1;
    // Every mode accepts two quick presses; quit before the mode read so it cannot delay this.
    if (previousPressAt !== 0 && now - previousPressAt <= QUIT_DOUBLE_PRESS_MS) {
      quitNow();
      return;
    }
    const pressGeneration = generation;
    holding = true;
    heldSince = now;
    void options.getMode().then(
      (resolvedMode) => {
        if (generation !== pressGeneration) return;
        if (resolvedMode === "direct") {
          quitNow();
          return;
        }
        if (resolvedMode === "double-click") {
          const remainingMs = QUIT_DOUBLE_PRESS_MS - (Date.now() - now);
          if (remainingMs <= 0) {
            release();
            return;
          }
          mode = resolvedMode;
          notified = true;
          options.notify({ state: "down", mode: resolvedMode });
          watchdog = setTimeout(release, remainingMs);
          return;
        }

        // A hold cannot be armed after its physical press has ended.
        if (!holding) return;

        mode = resolvedMode;
        notified = true;
        options.notify({ state: "down", mode: resolvedMode });

        armed = true;
        // No auto-repeat by then means the key was released unseen or repeat is off: don't quit.
        watchdog = setTimeout(() => {
          watchdog = undefined;
          release();
        }, QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS);
      },
      // A failed settings read must never strand the quit request.
      () => {
        if (generation !== pressGeneration) return;
        quitNow();
      },
    );
  };
}

export interface ConcealableQuitWindow {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  setOpacity(opacity: number): void;
}

/** Hides a window whose quit is committed but keeps it focused so trailing repeats stay in-app. */
export function concealPendingQuitWindow(window: ConcealableQuitWindow): void {
  if (window.isDestroyed()) return;
  if (window.isFullScreen()) {
    window.setFullScreen(false);
  }
  // Electron implements opacity on macOS and Windows only; Linux keeps the window visible.
  window.setOpacity(0);
}
