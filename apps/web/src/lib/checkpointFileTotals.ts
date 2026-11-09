import type { TurnDiffFileChange } from "../types";
import { summarizeTurnDiffStats } from "./turnDiffTree";

/** Added to the expanded changed-files card height when the "more files" button renders. */
export const CHANGED_FILES_MORE_BUTTON_HEIGHT_PX = 32;

export interface CheckpointFileTotals {
  readonly count: number;
  readonly additions: number;
  readonly deletions: number;
  /** Files the server left out of `files`. */
  readonly hiddenFileCount: number;
}

/** `files` is a prefix when `filesTotal` is set; these totals always cover the whole turn. */
export function checkpointFileTotals(summary: {
  readonly files: ReadonlyArray<TurnDiffFileChange>;
  readonly filesTotal?: number | undefined;
  readonly additionsTotal?: number | undefined;
  readonly deletionsTotal?: number | undefined;
}): CheckpointFileTotals {
  const { files, filesTotal, additionsTotal, deletionsTotal } = summary;
  const count = filesTotal ?? files.length;
  const prefixStat =
    additionsTotal === undefined || deletionsTotal === undefined
      ? summarizeTurnDiffStats(files)
      : null;
  return {
    count,
    additions: additionsTotal ?? prefixStat?.additions ?? 0,
    deletions: deletionsTotal ?? prefixStat?.deletions ?? 0,
    hiddenFileCount: Math.max(0, count - files.length),
  };
}

export function changedFilesMoreLabel(hiddenFileCount: number): string {
  return `${hiddenFileCount.toLocaleString()} more file${hiddenFileCount === 1 ? "" : "s"} not listed`;
}
