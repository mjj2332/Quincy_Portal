import * as React from "react";
import { cn } from "@/lib/utils";

const CHECKBOX_INPUT =
  "size-[18px] shrink-0 m-0 accent-[var(--accent)] cursor-pointer " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "disabled:cursor-not-allowed";

/* A bordered, selectable tile: the services grid and the create-mode team checklist. */
const CHECK_TILE =
  "flex items-start gap-[var(--space-3)] cursor-pointer " +
  "min-h-[var(--space-7)] p-[12px] bg-card text-foreground-secondary " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] " +
  "transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "hover:bg-secondary has-[:checked]:bg-surface-sunken " +
  "has-[:focus-visible]:outline-[length:var(--border-width-bold)] has-[:focus-visible]:outline-solid " +
  "has-[:focus-visible]:outline-ring has-[:focus-visible]:-outline-offset-2 " +
  "has-[:disabled]:cursor-default has-[:disabled]:text-foreground-secondary " +
  "has-[:disabled]:bg-surface-sunken has-[:disabled]:hover:bg-surface-sunken";

/* A single row toggle: the impersonation switch and the per-stage active checkbox. */
const TOGGLE_ROW =
  "flex items-center gap-[var(--space-2)] cursor-pointer " +
  "min-h-[38px] max-[721px]:min-h-[44px] text-foreground-secondary " + // 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]";

function Checkbox({ className, ...props }: React.ComponentProps<"input">) {
  return <input type="checkbox" data-slot="checkbox" className={cn(CHECKBOX_INPUT, className)} {...props} />;
}

export { Checkbox, CHECKBOX_INPUT, CHECK_TILE, TOGGLE_ROW };
