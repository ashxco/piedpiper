import type { FileDiffMetadata } from "@pierre/diffs";
import { useState } from "react";

import { buildDiffFileBlockKey, isDiffFileShown } from "../components/DiffPanel.logic";
import {
  buildDiffFileTreeEntries,
  resolveFileDiffPath,
} from "../components/DiffPanelFileTree.logic";
import { resolveCollapsedDiffFileKeys, type ScopedDiffCollapseState } from "../lib/diffCollapse";
import { reuseUnchangedDiffFiles } from "../lib/diffRendering";
import type { ReviewCommentContext } from "../reviewCommentContext";
import {
  canShowTurnDiffFullContext,
  isTurnDiffRename,
  resolveTurnDiffFullContextState,
  type TurnDiffFullContextState,
} from "../lib/turnDiffFullContext";

// The panel's per-file lists come from hooks because the compiler treats a hook's result as
// immutable. A plain call's result could be mutated by anything it is passed to, so it would stay
// unmemoized across the panel's other hooks, and every file's row would re-render with the panel.

type DiffFiles = ReadonlyArray<FileDiffMetadata>;

export function useUnchangedDiffFiles(files: DiffFiles): DiffFiles {
  const [heldFiles, setHeldFiles] = useState(files);
  const reusedFiles = reuseUnchangedDiffFiles(heldFiles, files);
  if (reusedFiles !== heldFiles) setHeldFiles(reusedFiles);
  return reusedFiles;
}

export function useFullContextDiffFiles(files: DiffFiles, paths: ReadonlySet<string>): DiffFiles {
  "use memo";
  return files.filter(
    (file) => paths.has(resolveFileDiffPath(file)) && canShowTurnDiffFullContext(file),
  );
}

export function resolveFileDiffOldPath(file: FileDiffMetadata): string {
  return isTurnDiffRename(file) && file.prevName
    ? resolveFileDiffPath({ name: file.prevName })
    : resolveFileDiffPath(file);
}

export function useFullContextStates(
  files: DiffFiles,
  queries: ReadonlyArray<
    Pick<Parameters<typeof resolveTurnDiffFullContextState>[0], "data" | "error">
  >,
  ignoreWhitespace: boolean,
): ReadonlyMap<string, TurnDiffFullContextState> {
  "use memo";
  return new Map(
    files.map((file, index) => {
      const query = queries[index];
      const filePath = resolveFileDiffPath(file);
      return [
        filePath,
        resolveTurnDiffFullContextState({
          fileDiff: file,
          oldPath: resolveFileDiffOldPath(file),
          newPath: filePath,
          ignoreWhitespace,
          data: query?.data,
          error: query?.error,
        }),
      ];
    }),
  );
}

export function useShownDiffFiles(
  files: DiffFiles,
  hideTestFiles: boolean,
  selectedFilePath: string | null,
  draftFilePath: string | null,
): DiffFiles {
  "use memo";
  return files.filter((file) =>
    isDiffFileShown({
      filePath: resolveFileDiffPath(file),
      hideTestFiles,
      selectedFilePath,
      draftFilePath,
    }),
  );
}

export function useDiffFileTreeEntries(files: DiffFiles) {
  "use memo";
  return buildDiffFileTreeEntries(files);
}

export function useDiffFileKeys(files: DiffFiles): ReadonlyArray<string> {
  "use memo";
  return files.map((file) => buildDiffFileBlockKey(file));
}

export function useCollapsedDiffFileKeys(
  collapseState: ScopedDiffCollapseState | null,
  scopeKey: string | null,
  fileKeys: ReadonlyArray<string>,
  collapsedBySetting: boolean,
): ReadonlySet<string> {
  "use memo";
  return resolveCollapsedDiffFileKeys(collapseState, scopeKey, fileKeys, collapsedBySetting);
}

/** So a comment re-renders only the files that have comments, not every viewer in the patch. */
export function useReviewCommentsByFilePath(
  comments: ReadonlyArray<ReviewCommentContext>,
): ReadonlyMap<string, ReadonlyArray<ReviewCommentContext>> {
  "use memo";
  const byFilePath = new Map<string, ReviewCommentContext[]>();
  for (const comment of comments) {
    const fileComments = byFilePath.get(comment.filePath);
    if (fileComments) fileComments.push(comment);
    else byFilePath.set(comment.filePath, [comment]);
  }
  return byFilePath;
}
