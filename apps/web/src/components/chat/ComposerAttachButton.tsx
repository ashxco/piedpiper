import { PaperclipIcon } from "lucide-react";
import { useRef } from "react";

import { Button } from "../ui/button";

/** HEIC is listed by extension too: some systems report no MIME type for it. */
export const COMPOSER_ATTACH_IMAGE_ACCEPT = [
  "image/gif",
  "image/heic",
  "image/heic-sequence",
  "image/heif",
  "image/heif-sequence",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/*",
  ".md,.mdx,.json,.jsonl,.yaml,.yml,.toml,.log,.csv,.ts,.tsx,.js,.jsx,.py,.go,.rs,.sh,.sql",
  ".heic",
  ".heif",
  ".pdf",
].join(",");

/** Opens the file picker; picked files take the same path as dropped ones. */
export function ComposerAttachButton(props: {
  readonly disabled?: boolean | undefined;
  readonly onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div data-composer-attach-button className="flex shrink-0 items-center">
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        accept={COMPOSER_ATTACH_IMAGE_ACCEPT}
        data-testid="composer-attach-input"
        onChange={(event) => {
          // Resetting the value empties the live FileList, and is what lets the same file be re-picked.
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) props.onFiles(files);
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground/70 hover:text-foreground/80"
        aria-label="Attach files"
        title="Attach files"
        disabled={props.disabled}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => inputRef.current?.click()}
      >
        <PaperclipIcon />
      </Button>
    </div>
  );
}
