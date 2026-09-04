import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The shared field box: input, textarea and native select all render this geometry.
 * min-h 38px is TB8-01's retained legacy control height; the 44px at <=720px is a
 * 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token.
 */
const FIELD_BOX =
  "w-full min-h-[38px] max-[721px]:min-h-[44px] " +
  "border-solid border-[length:var(--border-width-hair)] border-border rounded-[var(--radius-sm)] " +
  "bg-[var(--field-bg)] text-foreground px-[10px] py-[8px] " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] tracking-normal " +
  "placeholder:text-foreground-secondary " +
  "transition-[border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "hover:not-disabled:border-border-hover " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "aria-invalid:border-destructive " +
  "disabled:bg-surface-sunken disabled:text-foreground-secondary disabled:cursor-not-allowed " +
  // `:not(select)` is load-bearing: a <select> matches `:read-only` unconditionally
  // (only input/textarea/contenteditable are ever `:read-write`), so a bare
  // `read-only:` variant would paint every NativeSelect as if it were read-only.
  "[&:read-only:not(select)]:bg-surface-sunken [&:read-only:not(select)]:text-foreground-secondary";

function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" className={cn(FIELD_BOX, className)} {...props} />;
}

export { Input, FIELD_BOX };
