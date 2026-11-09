import { create } from "zustand";

export interface DiffFileRevealRequest {
  /** Bumped on every request to reveal a diff file, so repeat requests for the same path re-run. */
  requestId: number;
  /** The file the request targets; null for requests that are not bound to a path. */
  filePath: string | null;
}

export const useDiffFileRevealStore = create<DiffFileRevealRequest>(() => ({
  requestId: 0,
  filePath: null,
}));

export function requestDiffFileReveal(filePath?: string): void {
  useDiffFileRevealStore.setState((state) => ({
    requestId: state.requestId + 1,
    filePath: filePath ?? null,
  }));
}

/**
 * Key identifying the reveal the diff panel should run, or null while a new request still waits
 * for the route to show its file (the store updates before navigation commits).
 */
export function resolveDiffFileRevealKey(input: {
  scopeKey: string | null;
  selectedFilePath: string | null;
  request: DiffFileRevealRequest;
  consumedRequestId: number | null;
}): string | null {
  const { scopeKey, selectedFilePath, request, consumedRequestId } = input;
  if (selectedFilePath === null) return null;
  const pending =
    request.filePath !== null &&
    request.filePath !== selectedFilePath &&
    request.requestId !== consumedRequestId;
  if (pending) return null;
  return `${scopeKey}:${selectedFilePath}:${request.requestId}`;
}
