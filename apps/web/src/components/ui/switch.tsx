"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "~/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "group relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full outline-none transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-offset-2 focus-visible:ring-offset-background data-checked:bg-white data-unchecked:bg-white/10 data-disabled:cursor-not-allowed data-disabled:opacity-40 dark:data-checked:bg-white dark:data-unchecked:bg-white/10 not-dark:data-checked:bg-neutral-900 not-dark:data-unchecked:bg-neutral-200",
        className,
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className="pointer-events-none block size-5 rounded-full transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] data-checked:translate-x-[21px] data-unchecked:translate-x-[2px] data-checked:scale-100 data-unchecked:scale-90 dark:data-checked:bg-neutral-900 dark:data-unchecked:bg-white/50 not-dark:data-checked:bg-white not-dark:data-unchecked:bg-neutral-400"
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
