import type { ThreadId } from "@piedpiper/contracts";
import { EllipsisIcon } from "lucide-react";
import { memo, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { formatRelativeTime } from "../../timestampFormat";
import { resolveThreadRowClassName } from "../Sidebar.logic";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";

interface DraftThreadRowProps {
  draftThreadId: ThreadId;
  isActive: boolean;
  onSelect: () => void;
  onDismiss: () => void;
}

export const DraftThreadRow = memo(function DraftThreadRow({
  draftThreadId,
  isActive,
  onSelect,
  onDismiss,
}: DraftThreadRowProps) {
  const [dotHovered, setDotHovered] = useState(false);
  const draftCreatedAt = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[draftThreadId]?.createdAt ?? null,
  );
  return (
    <SidebarMenuSubItem className="group/menu-sub-item relative w-full" data-thread-item>
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} />}
        size="sm"
        isActive={isActive}
        data-testid={`draft-thread-row-${draftThreadId}`}
        className={`${resolveThreadRowClassName({
          isActive,
          isSelected: false,
        })} relative isolate`}
        onClick={onSelect}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span
            className="flex size-3.5 shrink-0 items-center justify-center cursor-default"
            onMouseEnter={() => setDotHovered(true)}
            onMouseLeave={() => setDotHovered(false)}
          >
            <span className="size-1.5 rounded-full bg-foreground/20" />
          </span>
          <span className="relative min-w-0 flex-1 overflow-hidden">
            <span
              className={`block truncate text-xs transition-all duration-200 ${dotHovered ? "opacity-0 -translate-y-2" : "opacity-100 translate-y-0"}`}
            >
              New Chat
            </span>
            <span
              className={`absolute inset-0 flex items-center truncate text-xs transition-all duration-200 ${dotHovered ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"} text-muted-foreground/50`}
            >
              Idle
            </span>
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <div className="flex min-w-12 justify-end">
            {draftCreatedAt && (
              <span
                className={`text-xs tabular-nums transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 ${
                  isActive ? "text-foreground/55" : "text-foreground/35"
                }`}
              >
                {formatRelativeTime(draftCreatedAt).value}
              </span>
            )}
            <div
              className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Menu>
                <MenuTrigger
                  data-thread-selection-safe
                  aria-label="Draft thread actions"
                  className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <EllipsisIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end" side="bottom" className="min-w-32">
                  <MenuItem
                    className="min-h-7 py-1 sm:text-xs"
                    variant="destructive"
                    onClick={() => onDismiss()}
                  >
                    Delete
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
          </div>
        </div>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
});
