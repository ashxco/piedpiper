import { describe, expect, it } from "vitest";

import { changedFilesMoreLabel, checkpointFileTotals } from "./checkpointFileTotals";

const files = [
  { path: "a.ts", kind: "modified", additions: 3, deletions: 1 },
  { path: "b.ts", kind: "modified", additions: 2, deletions: 4 },
];

describe("checkpointFileTotals", () => {
  it("sums the list when it is complete", () => {
    expect(checkpointFileTotals({ files })).toEqual({
      count: 2,
      additions: 5,
      deletions: 5,
      hiddenFileCount: 0,
    });
  });

  it("prefers server totals over the capped prefix", () => {
    expect(
      checkpointFileTotals({ files, filesTotal: 450, additionsTotal: 900, deletionsTotal: 12 }),
    ).toEqual({ count: 450, additions: 900, deletions: 12, hiddenFileCount: 448 });
  });

  it("never reports a negative hidden count", () => {
    expect(checkpointFileTotals({ files, filesTotal: 1 }).hiddenFileCount).toBe(0);
  });
});

describe("changedFilesMoreLabel", () => {
  it("handles singular and plural", () => {
    expect(changedFilesMoreLabel(1)).toBe("1 more file not listed");
    expect(changedFilesMoreLabel(2)).toBe("2 more files not listed");
  });
});
