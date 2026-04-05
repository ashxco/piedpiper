import type { ProviderKind, ServerProvider } from "@piedpiper/contracts";
import { resolveSelectableModel } from "@piedpiper/shared/model";
import { memo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { ClaudeAI } from "../Icons";
import { cn } from "~/lib/utils";

const PROVIDER: ProviderKind = "claudeAgent";

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onProviderModelChange: (provider: ProviderKind, model: string) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const modelOptions = props.modelOptionsByProvider[PROVIDER];
  const selectedModelLabel =
    modelOptions.find((option) => option.slug === props.model)?.name ?? props.model;
  const handleModelChange = (value: string) => {
    if (props.disabled) return;
    if (!value) return;
    const resolvedModel = resolveSelectableModel(PROVIDER, value, modelOptions);
    if (!resolvedModel) return;
    props.onProviderModelChange(PROVIDER, resolvedModel);
    setIsMenuOpen(false);
  };

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2 text-[11px] text-foreground/60 hover:text-foreground/90 [&_svg]:mx-0",
              props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn(
            "flex min-w-0 w-full box-border items-center gap-2 overflow-hidden",
            props.compact ? "max-w-36 sm:pl-1" : undefined,
          )}
        >
          <ClaudeAI
            aria-hidden="true"
            className={cn("size-4 shrink-0 text-[#d97757]", props.activeProviderIconClassName)}
          />
          <span className="min-w-0 flex-1 truncate">{selectedModelLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup value={props.model} onValueChange={handleModelChange}>
          {modelOptions.map((modelOption) => (
            <MenuRadioItem
              key={modelOption.slug}
              value={modelOption.slug}
              onClick={() => setIsMenuOpen(false)}
            >
              {modelOption.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});
