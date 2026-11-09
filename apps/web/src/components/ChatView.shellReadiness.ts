import type { TerminalEvent } from "@piedpiper/contracts";

// Line editors (zsh, fish, bash 5.1+) enable bracketed paste when they start reading a command.
const BRACKETED_PASTE_ON = "\x1b[?2004h";
// eslint-disable-next-line no-control-regex -- Match private mode set and reset sequences.
const PRIVATE_MODE_PATTERN = /\u001b\[\?([0-9;]*)([hl])/gu;
// Longer than one subprocess poll, so a startup prompt is seen as busy before the fallback fires.
export const SHELL_QUIET_FALLBACK_MS = 3_000;

export type ShellReadiness = "ready" | "exited";

export function lineEditorReading(text: string, previous: boolean): boolean {
  let reading = previous;
  // A restored history ends in a reset listing 2004 among other modes, so match inside lists.
  for (const match of text.matchAll(PRIVATE_MODE_PATTERN)) {
    if (match[1]?.split(";").includes("2004")) reading = match[2] === "h";
  }
  return reading;
}

/** Shells without a bracketed-paste signal (cmd.exe, PowerShell) keep the immediate write. */
export function shellSignalsReadiness(platform: string): boolean {
  return !/^win(dows)?/i.test(platform);
}

/**
 * Resolves once a freshly opened shell is reading input: on bracketed paste, or after a quiet
 * period with no running subprocess. Subscribe before opening the terminal so no output is missed.
 * Resolves "exited" when the shell exits or fails to start, or once `isTerminalOpen` turns false
 * (the server closes a session without an exit event).
 */
export function watchShellReadiness(input: {
  readonly subscribe: (listener: (event: TerminalEvent) => void) => () => void;
  readonly threadId: string;
  readonly terminalId: string;
  readonly quietMs?: number;
  readonly isTerminalOpen?: () => boolean;
}): {
  readonly promise: Promise<ShellReadiness>;
  readonly cancel: () => void;
  /** Feeds the history from `terminal.open`: a fast shell's early output, or a live shell's prompt. */
  readonly observeHistory: (history: string) => void;
} {
  const quietMs = input.quietMs ?? SHELL_QUIET_FALLBACK_MS;
  let reading = false;
  let carry = "";
  let busy = false;
  let activity = 0;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolvePromise!: (value: ShellReadiness) => void;
  const promise = new Promise<ShellReadiness>((resolve) => {
    resolvePromise = resolve;
  });

  const finish = (outcome: ShellReadiness | null) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    unsubscribe();
    if (outcome) resolvePromise(outcome);
  };

  const unsubscribe = input.subscribe((event) => {
    if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) return;
    activity += 1;
    if (event.type === "started" || event.type === "restarted") {
      busy = false;
      reading = false;
      carry = "";
    }
    if (event.type === "activity") busy = event.hasRunningSubprocess;
    if (event.type === "output") {
      // Only live output counts; restored history can hold a previous shell's editor state.
      const text = carry + event.data;
      carry = text.slice(-(BRACKETED_PASTE_ON.length - 1));
      reading = lineEditorReading(text, reading);
    }
    if (event.type === "exited" || event.type === "error") {
      finish("exited");
      return;
    }
    if (reading) finish("ready");
  });

  const scheduleQuietCheck = () => {
    const seen = activity;
    timer = setTimeout(() => {
      timer = null;
      if (settled) return;
      if (input.isTerminalOpen && !input.isTerminalOpen()) {
        finish("exited");
        return;
      }
      // A startup prompt runs as a child process, so a busy shell keeps waiting for the user.
      if (activity === seen && !busy) {
        finish("ready");
        return;
      }
      scheduleQuietCheck();
    }, quietMs);
  };
  scheduleQuietCheck();

  return {
    promise,
    cancel: () => finish(null),
    observeHistory: (history) => {
      if (settled) return;
      reading = lineEditorReading(history, reading);
      if (reading) finish("ready");
    },
  };
}
