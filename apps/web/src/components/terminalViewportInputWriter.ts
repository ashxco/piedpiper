import { TERMINAL_WRITE_MAX_LENGTH } from "@piedpiper/contracts";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/** Splits input into writes that fit `TerminalWriteInput`, never between a surrogate pair. */
export function chunkTerminalWrite(data: string): ReadonlyArray<string> {
  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + TERMINAL_WRITE_MAX_LENGTH, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1;
    }
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * Sends one chunk of terminal input. Resolves true once delivered, false when it failed and the
 * rest should drop, or "not-dispatched" when it was never sent (the view went away).
 */
export type SendTerminalChunk = (chunk: string) => Promise<boolean | "not-dispatched">;

/**
 * Orders one terminal's input into writes that fit `terminal.write`. A split write (a large
 * paste) goes one chunk per round trip and later input waits behind it; other writes go out
 * immediately, like keystrokes. A bracketed paste interrupted after its opening chunk is closed
 * before any later input, so the program does not keep treating keystrokes as pasted text.
 */
export function createTerminalInputWriter() {
  let pending: Promise<void> | null = null;
  const immediate = new Set<Promise<void>>();

  let closeInterruptedPaste: (() => Promise<boolean>) | null = null;
  const closePaste = async () => {
    if (closeInterruptedPaste === null) return true;
    if (!(await closeInterruptedPaste())) return false;
    closeInterruptedPaste = null;
    return true;
  };

  const sendChunks = async (
    data: string,
    chunks: ReadonlyArray<string>,
    send: SendTerminalChunk,
    recover: () => Promise<boolean>,
    interrupted: () => void,
  ) => {
    if (closeInterruptedPaste !== null && !(await closePaste())) {
      interrupted();
      return;
    }
    const bracketed =
      chunks.length > 1 &&
      data.startsWith(BRACKETED_PASTE_START) &&
      data.endsWith(BRACKETED_PASTE_END);
    let opened = false;
    try {
      for (const chunk of chunks) {
        const result = await send(chunk);
        if (result !== true) {
          // A failed send may still have reached the PTY, so its framing must be closed too.
          if (result !== "not-dispatched") opened = bracketed;
          if (chunks.length > 1) interrupted();
          return;
        }
        opened = bracketed;
      }
      opened = false;
    } finally {
      if (opened) {
        closeInterruptedPaste = recover;
        await closePaste();
      }
    }
  };

  return (
    data: string,
    send: SendTerminalChunk,
    recover: () => Promise<boolean> = async () => (await send(BRACKETED_PASTE_END)) === true,
    interrupted: () => void = () => {},
  ): Promise<void> => {
    const chunks = chunkTerminalWrite(data);
    const run = () => sendChunks(data, chunks, send, recover, interrupted);
    if (pending === null && closeInterruptedPaste === null && chunks.length === 1) {
      const current = run();
      immediate.add(current);
      const settle = () => {
        immediate.delete(current);
      };
      void current.then(settle, settle);
      return current;
    }
    const previous = pending ?? (immediate.size > 0 ? Promise.allSettled(immediate) : null);
    const current = previous === null ? run() : previous.then(run, run);
    pending = current;
    const reset = () => {
      if (pending === current) pending = null;
    };
    void current.then(reset, reset);
    return current;
  };
}
