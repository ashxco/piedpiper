import type { ThreadId } from "@piedpiper/contracts";
import { useState } from "react";

import { canSnoozeThread, resolveSnoozePresets, type ThreadSnoozeShell } from "../Sidebar.snooze";
import { MenuItem, MenuSub, MenuSubPopup, MenuSubTrigger } from "../ui/menu";
import { snoozeThreadWithUndo } from "./threadSnoozeActions";

// Mounted when the submenu opens, so the wake times are measured from that moment.
function ThreadSnoozePresetItems(props: { threadId: ThreadId }) {
  const [presets] = useState(() => resolveSnoozePresets(new Date()));
  return presets.map((preset) => (
    <MenuItem
      key={preset.id}
      className="min-h-7 py-1 sm:text-xs"
      onClick={() => snoozeThreadWithUndo(props.threadId, preset.snoozedUntil)}
    >
      {preset.label}
      <span className="ms-auto ps-3 text-muted-foreground/72">{preset.whenLabel}</span>
    </MenuItem>
  ));
}

/** The "Snooze" submenu of a thread row's actions menu. */
export function ThreadSnoozeSubmenu(props: { threadId: ThreadId; thread: ThreadSnoozeShell }) {
  return (
    <MenuSub>
      <MenuSubTrigger className="min-h-7 py-1 sm:text-xs" disabled={!canSnoozeThread(props.thread)}>
        Snooze
      </MenuSubTrigger>
      <MenuSubPopup className="min-w-44">
        <ThreadSnoozePresetItems threadId={props.threadId} />
      </MenuSubPopup>
    </MenuSub>
  );
}
