import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonClasses } from "@/components/ui/button";
import { OverlayContainerContext } from "@/components/OverlayContainerContext";

// Built on @base-ui/react's Select primitives — already a dependency (portal/package.json) and
// the foundation this repo's `base-sera` shadcn config is configured against (see input.tsx for
// the established `X as XPrimitive` import convention). Base UI's Positioner supplies real
// collision/flip handling so the popup stays on-screen at 390×844 without any custom viewport
// math, and the trigger reuses `buttonClasses("secondary", …)` so it carries the exact same
// press/disabled/focus state set as `Button` — no separate hand-rolled listbox.

export type SelectOption<T extends string> = { value: T; label: string };

export type SelectProps<T extends string> = {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  triggerClassName?: string;
};

export function Select<T extends string>({
  value,
  onValueChange,
  options,
  disabled = false,
  ariaLabel,
  className,
  triggerClassName,
}: SelectProps<T>) {
  // §4.2a nested-overlay container: null at page level (today's behavior, byte-identical),
  // the dialog's slot when this Select is opened from inside a Modal. Normalised to `undefined`
  // — the portal treats an explicit `null` as "wait forever", never falling back to `body`.
  const container = React.useContext(OverlayContainerContext) ?? undefined;
  return (
    <SelectPrimitive.Root
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next as T);
      }}
    >
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          buttonClasses("secondary"),
          "w-full justify-between normal-case tracking-normal",
          className,
          triggerClassName,
        )}
      >
        <SelectPrimitive.Value className="truncate" />
        <SelectPrimitive.Icon className="shrink-0">
          <ChevronDown aria-hidden="true" className="stroke-[1.5] size-[var(--space-3)]" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal container={container}>
        <SelectPrimitive.Positioner
          className="z-[var(--z-popover)] outline-none"
          positionMethod={container ? "fixed" : "absolute"}
          alignItemWithTrigger={container ? false : undefined}
          sideOffset={4}
          collisionPadding={8}
        >
          <SelectPrimitive.Popup
            className="min-w-[var(--anchor-width)] max-h-[min(320px,var(--available-height))] overflow-auto bg-popover border-solid border-[length:var(--border-width-hair)] border-border rounded-none shadow-[var(--shadow-md)]"
          >
            <SelectPrimitive.List aria-label={ariaLabel}>
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  className={cn(
                    "flex items-center px-[var(--space-3)] py-[var(--space-2)] cursor-pointer",
                    // Explicit merged font shorthand, not `[font:var(--type-label)]` (--text-sm)
                    // plus a separate `text-[length:var(--text-xs)]` override — Tailwind's build
                    // order between two utilities touching the same `font-size` sub-property is
                    // not guaranteed, and the shorthand was winning, computing to 14px instead of
                    // the intended 12px. One declaration, no ordering ambiguity.
                    "[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)]",
                    // Sentence case throughout, matching the trigger's `normal-case` (below) and
                    // the original native <option> labels — not uppercase, which read as a
                    // mismatched second casing convention inside one control.
                    "data-[highlighted]:bg-secondary data-[selected]:bg-primary data-[selected]:text-primary-foreground",
                    "min-h-[44px]" /* 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token */,
                  )}
                >
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
