import { type RuntimeMode } from "@piedpiper/contracts";
import { memo, type ComponentType, useState } from "react";
import { LockIcon, LockOpenIcon, SparklesIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { useComposerMenuFinalFocus } from "../ChatView.composerMenuFocus";
import { COMPOSER_ICON_ONLY_LABEL_CLASS_NAME } from "../composerFooterLayout";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

const COMPOSER_RUNTIME_MODE_OPTIONS: ReadonlyArray<{
  value: RuntimeMode;
  label: string;
  description: string;
  Icon: ComponentType<{ className?: string }>;
}> = [
  {
    value: "approval-required",
    label: "Supervised",
    description: "Asks before running commands or changing files.",
    Icon: LockIcon,
  },
  {
    value: "auto",
    label: "Auto",
    description: "An AI reviewer approves routine actions; risky ones still ask.",
    Icon: SparklesIcon,
  },
  {
    value: "full-access",
    label: "Full access",
    description: "Runs commands and changes files without asking.",
    Icon: LockOpenIcon,
  },
];

function runtimeModeOption(mode: RuntimeMode) {
  return (
    COMPOSER_RUNTIME_MODE_OPTIONS.find((option) => option.value === mode) ??
    COMPOSER_RUNTIME_MODE_OPTIONS[0]!
  );
}

export const ComposerRuntimeModePicker = memo(function ComposerRuntimeModePicker(props: {
  runtimeMode: RuntimeMode;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  shortcutLabel?: string | null | undefined;
  /** Shows only the icon; the footer sets this when the label no longer fits. */
  iconOnly?: boolean | undefined;
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
  const selected = runtimeModeOption(props.runtimeMode);
  const SelectedIcon = selected.Icon;
  const finalFocus = useComposerMenuFinalFocus();

  return (
    <Menu open={isOpen} onOpenChange={setIsOpen}>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            className="shrink-0 whitespace-nowrap px-2 text-[11px] text-foreground/60 hover:text-foreground/90"
            size="xs"
            type="button"
            data-chat-runtime-mode-picker="true"
            {...(props.iconOnly ? { "aria-label": `Access: ${selected.label}` } : {})}
            title={
              props.shortcutLabel
                ? `Access: ${selected.label} (${props.shortcutLabel})`
                : `Access: ${selected.label}`
            }
          />
        }
      >
        <SelectedIcon />
        <span
          data-composer-control-label
          className={cn(props.iconOnly && COMPOSER_ICON_ONLY_LABEL_CLASS_NAME)}
        >
          {selected.label}
        </span>
      </MenuTrigger>
      <MenuPopup align="start" className="max-w-72" finalFocus={finalFocus}>
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            const option = COMPOSER_RUNTIME_MODE_OPTIONS.find((entry) => entry.value === value);
            if (!option) return;
            setIsOpen(false);
            if (option.value !== props.runtimeMode) props.onRuntimeModeChange(option.value);
          }}
        >
          {COMPOSER_RUNTIME_MODE_OPTIONS.map(({ value, label, description, Icon }) => (
            <MenuRadioItem key={value} value={value}>
              <span className="flex min-w-0 items-start gap-2">
                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col">
                  <span>{label}</span>
                  <span className="whitespace-normal text-muted-foreground text-xs">
                    {description}
                  </span>
                </span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});
