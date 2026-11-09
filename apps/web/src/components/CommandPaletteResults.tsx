import type { ResolvedKeybindingsConfig } from "@piedpiper/contracts";
import { ChevronRightIcon } from "lucide-react";

import { shortcutLabelForCommand } from "../keybindings";
import type { CommandPaletteGroup, CommandPaletteItem } from "./CommandPalette.logic";
import {
  CommandCollection,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";

export function CommandPaletteResults(props: {
  emptyMessage: string;
  groups: ReadonlyArray<CommandPaletteGroup>;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteItem) => void;
}) {
  if (props.groups.length === 0) {
    return (
      <div className="py-10 text-center text-muted-foreground text-sm">{props.emptyMessage}</div>
    );
  }
  return (
    <CommandList>
      {props.groups.map((group) => (
        <CommandGroup items={[...group.items]} key={group.value}>
          <CommandGroupLabel>{group.label}</CommandGroupLabel>
          <CommandCollection>
            {(item: CommandPaletteItem) => (
              <CommandPaletteRow
                item={item}
                key={item.value}
                keybindings={props.keybindings}
                onExecuteItem={props.onExecuteItem}
              />
            )}
          </CommandCollection>
        </CommandGroup>
      ))}
    </CommandList>
  );
}

function CommandPaletteRow(props: {
  item: CommandPaletteItem;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteItem) => void;
}) {
  const { item } = props;
  const shortcutLabel = item.shortcutCommand
    ? shortcutLabelForCommand(props.keybindings, item.shortcutCommand)
    : null;
  return (
    <CommandItem
      className="cursor-pointer gap-2"
      onClick={() => props.onExecuteItem(item)}
      // Keep focus in the search box, so Enter and arrow keys keep working after a click.
      onMouseDown={(event) => event.preventDefault()}
      value={item.value}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{item.icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-foreground text-sm">{item.title}</span>
        {item.description ? (
          <span className="truncate text-muted-foreground/70 text-xs">{item.description}</span>
        ) : null}
      </span>
      {item.timestamp ? (
        <span className="shrink-0 text-right text-[10px] text-muted-foreground/70 tabular-nums">
          {item.timestamp}
        </span>
      ) : null}
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
      {item.kind === "submenu" ? (
        <ChevronRightIcon className="ms-auto size-4 shrink-0 text-muted-foreground/50" />
      ) : null}
    </CommandItem>
  );
}
