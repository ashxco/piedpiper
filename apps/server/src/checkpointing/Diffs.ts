export interface TurnDiffFileSummary {
  readonly path: string;
  /** Source path of a rename or copy. */
  readonly previousPath?: string;
  readonly additions: number;
  readonly deletions: number;
}

/** Reads `git diff --numstat -z` output; binary files ("-" counts) report zero lines. */
export function parseTurnDiffFilesFromNumstat(numstat: string): ReadonlyArray<TurnDiffFileSummary> {
  const records = numstat.split("\0");
  const files: TurnDiffFileSummary[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) continue;

    let path = record.slice(counts[0].length);
    let previousPath: string | undefined;
    if (path.length === 0) {
      // Renames and copies use two more records: the source and then the destination.
      previousPath = records[index + 1];
      path = records[index + 2] ?? "";
      index += 2;
    }
    if (path.length === 0) continue;

    files.push({
      path,
      ...(previousPath ? { previousPath } : {}),
      additions: counts[1] === "-" ? 0 : Number(counts[1]),
      deletions: counts[2] === "-" ? 0 : Number(counts[2]),
    });
  }

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

/**
 * True when Git brought this file in and no work in the range touched it.
 * `authoredPaths` comes from `CheckpointStore.listAuthoredPaths`; null keeps every file.
 * A rename stays visible when either side was authored, because the summary shows it as one file.
 */
export function isGitImport(
  file: TurnDiffFileSummary,
  authoredPaths: ReadonlySet<string> | null,
): boolean {
  return (
    authoredPaths !== null &&
    !authoredPaths.has(file.path) &&
    (file.previousPath === undefined || !authoredPaths.has(file.previousPath))
  );
}
