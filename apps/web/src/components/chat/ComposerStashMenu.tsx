import type { ProviderKind } from "@piedpiper/contracts";
import { ArchiveIcon, Trash2Icon } from "lucide-react";
import { usePromptStashStore, type PromptStashEntry } from "../../promptStashStore";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";

export function ComposerStashMenu(props: {
  provider: ProviderKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasContent: boolean;
  disabled: boolean;
  onStash: () => void;
  onRestore: (entry: PromptStashEntry) => void;
  onError: (error: unknown) => void;
}) {
  const allEntries = usePromptStashStore((state) => state.entries);
  const entries = allEntries.filter((entry) => entry.provider === props.provider);
  return (
    <Menu open={props.open} onOpenChange={props.onOpenChange}>
      <MenuTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Stashed prompts"
            disabled={props.disabled}
          />
        }
      >
        <ArchiveIcon />
      </MenuTrigger>
      <MenuPopup align="start" className="max-h-80 max-w-80 overflow-y-auto">
        <MenuItem disabled={!props.hasContent} onClick={props.onStash}>
          Stash prompt
        </MenuItem>
        {entries.length > 0 && <MenuSeparator />}
        {entries.length === 0 && !props.hasContent && (
          <MenuItem disabled>No stashed prompts</MenuItem>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className="flex min-w-0 items-center">
            <MenuItem
              className="min-w-0 flex-1"
              disabled={props.hasContent}
              onClick={() => props.onRestore(entry)}
              title={props.hasContent ? "Stash or clear the current prompt first" : entry.prompt}
            >
              <span className="truncate">
                {entry.prompt.trim() || entry.attachments[0]?.name || "Attached context"}
              </span>
            </MenuItem>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Delete stashed prompt: ${entry.prompt.slice(0, 40) || "Attached context"}`}
              onClick={() => {
                try {
                  usePromptStashStore.getState().remove(entry.id);
                } catch (error) {
                  props.onError(error);
                }
              }}
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
      </MenuPopup>
    </Menu>
  );
}
