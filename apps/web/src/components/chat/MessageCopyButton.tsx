import { renderCodexInlineDirectivesAsMarkdown } from "@piedpiper/shared/codexMarkdownDirectives";
import { memo } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  rewriteCodexDirectives = true,
}: {
  text: string;
  /** Copies Codex file citations as links and follow-ups as their label, as the reply shows them. */
  rewriteCodexDirectives?: boolean;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  return (
    <button
      type="button"
      onClick={() =>
        copyToClipboard(rewriteCodexDirectives ? renderCodexInlineDirectivesAsMarkdown(text) : text)
      }
      title="Copy message"
      className="flex cursor-pointer items-center justify-center text-muted-foreground/40 transition-colors hover:text-foreground/70"
    >
      {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </button>
  );
});
