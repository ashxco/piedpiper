import { changedFilesMoreLabel } from "../../lib/checkpointFileTotals";
import { Button } from "../ui/button";

/** Shown under a capped changed-files tree; opens the diff panel. */
export function ChangedFilesMoreButton({
  hiddenFileCount,
  onClick,
}: {
  hiddenFileCount: number;
  onClick: () => void;
}) {
  if (hiddenFileCount <= 0) return null;
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="mt-1"
      data-scroll-anchor-ignore
      onClick={onClick}
    >
      {changedFilesMoreLabel(hiddenFileCount)}
    </Button>
  );
}
