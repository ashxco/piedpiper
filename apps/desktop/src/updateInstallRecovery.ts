export interface UpdateInstallRecoveryActions {
  /** Clears the quit and install flags, so the steps after it are allowed to run. */
  readonly clearInstallState: () => void;
  readonly restartBackend: () => void;
  readonly applyFailureState: (message: string) => void;
  readonly restartUpdateTimers: () => void;
  readonly ensureWindow: () => void;
  readonly onStepError: (error: unknown) => void;
}

export interface UpdateInstallRecovery {
  /** Starts an install attempt; `backendWasRunning` decides whether a failure restarts it. */
  readonly begin: (options: { readonly backendWasRunning: boolean }) => void;
  readonly isActive: () => boolean;
  /** Ends the attempt without recovering: the app is exiting, so there is nothing to restore. */
  readonly abandon: () => void;
  /** Restores the running app once per attempt; false when no attempt is waiting on a result. */
  readonly recover: (message: string) => boolean;
  /** Starts the turn in which electron-updater can still emit a quit it queued for this attempt. */
  readonly openHandoffWindow: () => void;
  /** Ends that turn; true when the attempt is still waiting: no failure was reported, no quit began. */
  readonly closeHandoffWindow: () => boolean;
  /** Answers before-quit-for-update; false when the quit belongs to an attempt already recovered. */
  readonly acceptUpdaterQuit: () => boolean;
  /** For before-quit: true once, for the app.quit() that follows a refused updater quit. */
  readonly consumeRefusedUpdaterQuit: () => boolean;
  /** True until the updater starts quitting: a quit now would leave the install unstarted. */
  readonly isAwaitingHandoff: () => boolean;
}

/** A failed install can surface synchronously or as a late updater event, after windows are gone. */
export function createUpdateInstallRecovery(
  actions: UpdateInstallRecoveryActions,
): UpdateInstallRecovery {
  let active = false;
  let backendWasRunning = false;
  let handedOff = false;
  let handoffWindowOpen = false;
  let queuedQuitIsStale = false;
  let refusedQuitPending = false;

  // One failed step must not leave the user without the others, above all without a window.
  const runStep = (step: () => void): void => {
    try {
      step();
    } catch (error) {
      actions.onStepError(error);
    }
  };

  return {
    begin: (options) => {
      active = true;
      backendWasRunning = options.backendWasRunning;
      handedOff = false;
    },
    isActive: () => active,
    abandon: () => {
      active = false;
    },
    recover: (message) => {
      if (!active) return false;
      active = false;
      queuedQuitIsStale = handoffWindowOpen;
      runStep(actions.clearInstallState);
      if (backendWasRunning) runStep(actions.restartBackend);
      runStep(() => actions.applyFailureState(message));
      runStep(actions.restartUpdateTimers);
      runStep(actions.ensureWindow);
      return true;
    },
    openHandoffWindow: () => {
      handoffWindowOpen = true;
    },
    closeHandoffWindow: () => {
      handoffWindowOpen = false;
      queuedQuitIsStale = false;
      refusedQuitPending = false;
      return active && !handedOff;
    },
    acceptUpdaterQuit: () => {
      if (active) {
        handedOff = true;
        return true;
      }
      if (!queuedQuitIsStale) return true;
      queuedQuitIsStale = false;
      refusedQuitPending = true;
      return false;
    },
    consumeRefusedUpdaterQuit: () => {
      const refused = refusedQuitPending;
      refusedQuitPending = false;
      return refused;
    },
    isAwaitingHandoff: () => active && !handedOff,
  };
}

export const UPDATER_DID_NOT_START_MESSAGE = "The update installer did not start.";

/**
 * Calls quitAndInstall and settles what electron-updater leaves unreported. Its BaseUpdater queues
 * the quit with setImmediate before a failed spawn reports, so recovery can run first; and a call
 * after that failure only re-arms it, silently, so one repeat is the real retry.
 */
export function startUpdaterHandoff(
  recovery: UpdateInstallRecovery,
  options: {
    readonly quitAndInstall: () => void;
    readonly schedule: (callback: () => void) => void;
    /** macOS: Squirrel fetches the update first, so its result arrives later through events. */
    readonly reportsResultLater: boolean;
    readonly formatError: (error: unknown) => string;
  },
): void {
  const attempt = (repeatsLeft: number): void => {
    recovery.openHandoffWindow();
    try {
      options.quitAndInstall();
    } catch (error) {
      recovery.recover(options.formatError(error));
    }
    // Queued after the updater's own immediate, so this runs once that one has.
    options.schedule(() => {
      if (!recovery.closeHandoffWindow() || options.reportsResultLater) return;
      if (repeatsLeft > 0) {
        attempt(repeatsLeft - 1);
        return;
      }
      recovery.recover(UPDATER_DID_NOT_START_MESSAGE);
    });
  };
  attempt(1);
}

/** Resolves when `promise` settles or after `timeoutMs`, whichever comes first; never rejects. */
export function waitUntilSettled(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(finish, finish);
  });
}
