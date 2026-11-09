import * as FS from "node:fs";
import * as Path from "node:path";

export interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PersistedWindowState {
  readonly bounds: WindowBounds | null;
  readonly maximized: boolean;
}

export interface WindowStateSource {
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  getBounds(): WindowBounds;
  getNormalBounds(): WindowBounds;
}

// Small enough to tile into half-screen slots on scaled displays; also the enforced window minimum.
export const MAIN_WINDOW_MIN_SIZE = { width: 400, height: 360 } as const;
export const DEFAULT_MAIN_WINDOW_SIZE = { width: 1100, height: 780 } as const;
const WINDOW_STATE_PERSIST_DEBOUNCE_MS = 500;
const EMPTY_WINDOW_STATE: PersistedWindowState = { bounds: null, maximized: false };

function normalizeWindowBounds(value: unknown): WindowBounds | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return null;
  }
  const bounds = {
    x: Math.round(x as number),
    y: Math.round(y as number),
    width: Math.round(width as number),
    height: Math.round(height as number),
  };
  return bounds.width >= MAIN_WINDOW_MIN_SIZE.width && bounds.height >= MAIN_WINDOW_MIN_SIZE.height
    ? bounds
    : null;
}

export function readWindowState(filePath: string): PersistedWindowState {
  try {
    const parsed: unknown = JSON.parse(FS.readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return EMPTY_WINDOW_STATE;
    const record = parsed as Record<string, unknown>;
    const bounds = normalizeWindowBounds(record.bounds);
    return { bounds, maximized: bounds !== null && record.maximized === true };
  } catch {
    return EMPTY_WINDOW_STATE;
  }
}

function writeWindowStateFile(filePath: string, state: PersistedWindowState): void {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    FS.writeFileSync(tempPath, `${JSON.stringify(state)}\n`, "utf8");
    FS.renameSync(tempPath, filePath);
  } finally {
    try {
      FS.rmSync(tempPath, { force: true });
    } catch {}
  }
}

function fitsWithinDisplay(window: WindowBounds, display: WindowBounds): boolean {
  return (
    window.x >= display.x &&
    window.y >= display.y &&
    window.x + window.width <= display.x + display.width &&
    window.y + window.height <= display.y + display.height
  );
}

/** Saved bounds when they fit entirely on a connected display, else the default size. */
export function resolveInitialWindowBounds(
  saved: WindowBounds | null,
  displays: readonly WindowBounds[],
): WindowBounds | typeof DEFAULT_MAIN_WINDOW_SIZE {
  if (saved !== null && displays.some((display) => fitsWithinDisplay(saved, display))) {
    return saved;
  }
  return DEFAULT_MAIN_WINDOW_SIZE;
}

function boundsEqual(left: WindowBounds, right: WindowBounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

export interface WindowStatePersister {
  /** Debounced save; call on move/resize/maximize/unmaximize. */
  readonly schedule: () => void;
  /** Cancels any pending save and writes the current state now. */
  readonly flush: () => void;
  readonly dispose: () => void;
}

export function createWindowStatePersister(options: {
  readonly filePath: string;
  readonly window: WindowStateSource;
  readonly saved: PersistedWindowState;
  /** Whether `saved.bounds` was applied; if not, keep it until the user moves or resizes. */
  readonly restoredSavedBounds: boolean;
  readonly debounceMs?: number;
  readonly writeState?: (filePath: string, state: PersistedWindowState) => void;
  readonly onError?: (error: unknown) => void;
}): WindowStatePersister {
  const { window, saved } = options;
  const writeState = options.writeState ?? writeWindowStateFile;
  const debounceMs = options.debounceMs ?? WINDOW_STATE_PERSIST_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let enabled = saved.bounds === null || options.restoredSavedBounds;
  let lastWritten: PersistedWindowState | null = enabled ? saved : null;

  const snapshot = (): PersistedWindowState | null => {
    if (window.isDestroyed()) return null;
    const useNormal = window.isFullScreen() || window.isMaximized() || window.isMinimized();
    const bounds = normalizeWindowBounds(useNormal ? window.getNormalBounds() : window.getBounds());
    return bounds === null ? null : { bounds, maximized: window.isMaximized() };
  };
  const fallback = enabled ? null : snapshot();

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const persistNow = () => {
    if (!enabled) return;
    const state = snapshot();
    if (state === null || state.bounds === null) return;
    if (
      lastWritten?.bounds &&
      boundsEqual(lastWritten.bounds, state.bounds) &&
      lastWritten.maximized === state.maximized
    ) {
      return;
    }
    try {
      writeState(options.filePath, state);
      lastWritten = state;
    } catch (error) {
      options.onError?.(error);
    }
  };

  return {
    schedule: () => {
      if (!enabled) {
        const current = snapshot();
        if (
          current === null ||
          current.bounds === null ||
          (fallback?.bounds &&
            boundsEqual(current.bounds, fallback.bounds) &&
            current.maximized === saved.maximized)
        ) {
          return;
        }
        enabled = true;
      }
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        persistNow();
      }, debounceMs);
    },
    flush: () => {
      clearTimer();
      persistNow();
    },
    dispose: clearTimer,
  };
}
