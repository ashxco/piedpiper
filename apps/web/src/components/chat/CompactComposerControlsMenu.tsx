import { ProviderInteractionMode, RuntimeMode } from "@piedpiper/contracts";
import * as Schema from "effect/Schema";
import { Fragment, memo, type ReactNode, useState } from "react";
import { EllipsisIcon, ListTodoIcon } from "lucide-react";
import { useComposerMenuFinalFocus } from "../ChatView.composerMenuFocus";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

const isRuntimeMode = Schema.is(RuntimeMode);

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode: ProviderInteractionMode;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  traitsMenuContent?: ReactNode;
  /** The agent/plan section; hide it while the footer still shows that control. */
  showInteractionMode?: boolean | undefined;
  /** The access section; hide it while the footer still shows that control. */
  showRuntimeMode?: boolean | undefined;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  shortcutLabel?: string | null | undefined;
  /** Controls the menu from outside (keyboard shortcut); local state is used when omitted. */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const isOpen = props.open ?? localOpen;
  const setIsOpen = (open: boolean) => {
    setLocalOpen(open);
    props.onOpenChange?.(open);
  };
  const finalFocus = useComposerMenuFinalFocus();
  const sections: Array<{ id: string; content: ReactNode }> = [];
  if (props.traitsMenuContent) {
    sections.push({ id: "traits", content: props.traitsMenuContent });
  }
  if (props.showInteractionMode ?? true) {
    sections.push({
      id: "mode",
      content: (
        <>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
          <MenuRadioGroup
            value={props.interactionMode}
            onValueChange={(value) => {
              if (!value || value === props.interactionMode) return;
              props.onToggleInteractionMode();
            }}
          >
            <MenuRadioItem value="default">Agent</MenuRadioItem>
            <MenuRadioItem value="plan">Plan</MenuRadioItem>
          </MenuRadioGroup>
        </>
      ),
    });
  }
  if (props.showRuntimeMode ?? true) {
    sections.push({
      id: "access",
      content: (
        <>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
          <MenuRadioGroup
            value={props.runtimeMode}
            onValueChange={(value) => {
              if (!isRuntimeMode(value) || value === props.runtimeMode) return;
              props.onRuntimeModeChange(value);
            }}
          >
            <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
            <MenuRadioItem value="auto">Auto</MenuRadioItem>
            <MenuRadioItem value="full-access">Full access</MenuRadioItem>
          </MenuRadioGroup>
        </>
      ),
    });
  }
  if (props.activePlan) {
    sections.push({
      id: "plan",
      content: (
        <MenuItem onClick={props.onTogglePlanSidebar}>
          <ListTodoIcon className="size-4 shrink-0" />
          {props.planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"}
        </MenuItem>
      ),
    });
  }
  return (
    <Menu open={isOpen} onOpenChange={setIsOpen}>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
            {...(props.shortcutLabel
              ? { title: `More composer controls (${props.shortcutLabel})` }
              : {})}
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start" finalFocus={finalFocus}>
        {sections.map((section, index) => (
          <Fragment key={section.id}>
            {index > 0 ? <MenuDivider /> : null}
            {section.content}
          </Fragment>
        ))}
      </MenuPopup>
    </Menu>
  );
});
