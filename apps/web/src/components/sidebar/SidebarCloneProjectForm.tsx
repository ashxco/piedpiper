import { FolderIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { isImeComposingKeyboardEvent } from "../../lib/imeComposition";
import { readNativeApi } from "../../nativeApi";
import { getCloneDestinationPath, getCloneDirectoryName, isCloneUrl } from "./cloneProject.logic";

const INPUT_CLASS_NAME =
  "w-full min-w-0 rounded-md border border-border bg-secondary px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-ring focus:outline-none";

export function SidebarCloneProjectForm(props: {
  /** Where the destination starts, until the user picks or types their own. */
  readonly defaultParentDirectory: string;
  readonly isCloning: boolean;
  /** Stays reachable here because the progress toast, which also has Cancel, can be dismissed. */
  readonly onCancel: () => void;
  readonly onClone: (input: { url: string; destinationPath: string }) => void;
  readonly onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [parentDirectory, setParentDirectory] = useState(props.defaultParentDirectory);
  // Null follows the URL; once typed in, the destination is left as the user wrote it.
  const [typedDestination, setTypedDestination] = useState<string | null>(null);

  const destinationPath =
    typedDestination ?? getCloneDestinationPath(parentDirectory, getCloneDirectoryName(url));
  const canClone = isCloneUrl(url) && destinationPath.trim().length > 0 && !props.isCloning;

  const submit = () => {
    if (canClone) props.onClone({ url, destinationPath });
  };

  const pickParentDirectory = async () => {
    const picked = await readNativeApi()
      ?.dialogs.pickFolder()
      .catch(() => null);
    if (!picked) return;
    setParentDirectory(picked);
    setTypedDestination(null);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposingKeyboardEvent(event.nativeEvent)) return;
    if (event.key === "Enter") submit();
    if (event.key === "Escape") props.onClose();
  };

  return (
    <div className="mb-2 flex flex-col gap-1.5 px-1" data-testid="clone-project-form">
      <input
        aria-label="Repository URL"
        className={INPUT_CLASS_NAME}
        placeholder="https://github.com/owner/repo.git"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
      />
      <div className="flex gap-1.5">
        <input
          aria-label="Clone destination"
          className={INPUT_CLASS_NAME}
          placeholder="/path/to/folder/repo"
          value={destinationPath}
          onChange={(event) => setTypedDestination(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {isElectron && (
          <button
            type="button"
            aria-label="Choose a folder to clone into"
            className="inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-secondary px-1.5 text-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-foreground"
            onClick={() => void pickParentDirectory()}
          >
            <FolderIcon className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
          onClick={submit}
          disabled={!canClone}
        >
          {props.isCloning ? "Cloning..." : "Clone"}
        </button>
      </div>
      {props.isCloning && (
        <button
          type="button"
          className="self-end rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
          onClick={props.onCancel}
        >
          Cancel clone
        </button>
      )}
    </div>
  );
}
