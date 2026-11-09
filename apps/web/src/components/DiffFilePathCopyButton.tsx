import { CheckIcon, CopyIcon } from "lucide-react";
import { formatFilePathForClipboard } from "../filePathClipboard";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { toastManager } from "./ui/toast";

export function DiffFilePathCopyButton({
  filePath,
  hostPath,
}: {
  filePath: string;
  /** Where the file really is; its separators decide how the relative path is written. */
  hostPath?: string | undefined;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy path",
        description: error.message,
      });
    },
  });

  return (
    <button
      type="button"
      aria-label={isCopied ? "Copied file path" : "Copy file path"}
      title={isCopied ? "Copied" : "Copy path"}
      className="inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:text-foreground"
      onClick={(event) => {
        event.stopPropagation();
        copyToClipboard(formatFilePathForClipboard(filePath, hostPath));
      }}
    >
      {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
      <span className="sr-only" aria-live="polite">
        {isCopied ? "Copied" : ""}
      </span>
    </button>
  );
}
