import type { CustomModelEntry, ProviderKind, ServerProviderModel } from "@piedpiper/contracts";
import { useState } from "react";

import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import {
  buildCustomModelEntry,
  customModelNameError,
  customModelOptionsLike,
  findOptionsLikeModel,
} from "./customModelDetailsLogic";

const NO_OPTIONS = "none";
const KEEP_OPTIONS = "keep";

/** Mount with a `key` per slug so reopening starts from the saved entry. */
export function CustomModelDetailsDialog(props: {
  readonly open: boolean;
  readonly entry: CustomModelEntry;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly provider?: ProviderKind | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (entry: CustomModelEntry) => void;
}) {
  const { entry, models, provider } = props;
  const [name, setName] = useState(entry.name ?? "");
  // Frozen at mount: models can load later, and the chosen row must stay in the list.
  const [initialOptions] = useState(() =>
    entry.capabilities
      ? (findOptionsLikeModel(entry.capabilities, models) ?? KEEP_OPTIONS)
      : NO_OPTIONS,
  );
  const [optionsLike, setOptionsLike] = useState(initialOptions);

  const builtInModels = models.filter((model) => !model.isCustom && model.capabilities);
  const nameError = customModelNameError(name, entry.slug, models, provider);
  const optionItems = [
    { value: NO_OPTIONS, label: "Default" },
    ...(initialOptions === KEEP_OPTIONS ? [{ value: KEEP_OPTIONS, label: "Current options" }] : []),
    ...builtInModels.map((model) => ({ value: model.slug, label: model.name })),
  ];

  const save = () => {
    if (nameError) return;
    const source = builtInModels.find((model) => model.slug === optionsLike);
    props.onSave(
      buildCustomModelEntry({
        slug: entry.slug,
        name,
        capabilities:
          optionsLike === KEEP_OPTIONS
            ? entry.capabilities
            : source
              ? customModelOptionsLike(source)
              : undefined,
      }),
    );
    props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit custom model</DialogTitle>
          <DialogDescription className="break-all">{entry.slug}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Display name</span>
            <Input
              placeholder={entry.slug}
              value={name}
              aria-invalid={nameError !== null}
              onChange={(event) => setName(event.target.value)}
            />
            {nameError ? <span className="text-xs text-destructive">{nameError}</span> : null}
          </label>
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Options like</span>
            <Select
              value={optionsLike}
              onValueChange={(value) => {
                if (value) setOptionsLike(value);
              }}
            >
              <SelectTrigger aria-label="Options like">
                <SelectValue>
                  {optionItems.find((item) => item.value === optionsLike)?.label ?? "Default"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {optionItems.map((item) => (
                  <SelectItem hideIndicator key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <span className="text-xs text-muted-foreground">
              Offers that model's effort, fast mode and thinking options. Choose one only if this
              model supports them. Default applies the provider's default options.
            </span>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={nameError !== null} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
