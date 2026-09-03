import * as React from "react";

import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "danger" | "text";

// Every text-color utility below is `!`-prefixed (Tailwind's important modifier). This is
// required, not decorative: `base.css` has an unlayered `a { color: inherit }` rule, and
// unlayered author CSS always wins over Tailwind's `@layer utilities` regardless of selector
// specificity (the same cascade-layer fact that keeps `.prow__thumb` in app.css — it cuts both
// ways). `buttonClasses()` is used on real `<a>` elements (via `InternalLink`, e.g. the two "New
// shoot" anchors) as well as real `<button>`s; `!important` is the only thing that reliably beats
// an unlayered declaration regardless of which element ends up wearing these classes, so every
// variant's text-color values carry it — not just the ones currently used on an anchor.
// `[font:var(--type-label)] text-[length:var(--text-xs)]` (two utilities touching `font-size`)
// depends on Tailwind's generated rule order for who wins — it was resolving to --type-label's
// own 14px, not the intended 12px. Merged into one explicit shorthand instead (§1.2's arbitrary
// property convention, applied to the whole shorthand rather than split across two utilities).
// 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token. §2.1a: the 38px desktop
// contract stays; only <=720px rises to the touch minimum, matching Modal.tsx's shipped footer.
const BASE = "inline-flex items-center justify-center gap-[var(--space-2)] min-h-[38px] max-[721px]:min-h-[44px] " +
  "px-[14px] py-[9px] rounded-[var(--radius-sm)] border-solid " +
  "border-[length:var(--border-width-hair)] " +
  "[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)] " +
  "uppercase tracking-[var(--tracking-wide)] no-underline " +
  "cursor-pointer transition-[background-color,color,border-color] " +
  "duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "active:not-disabled:translate-y-px " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "disabled:!text-foreground-secondary disabled:bg-surface-sunken disabled:border-border " +
  "disabled:cursor-not-allowed disabled:translate-y-0";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary !text-primary-foreground border-primary " +
    "hover:not-disabled:bg-primary-hover hover:not-disabled:border-primary-hover",
  secondary: "bg-card !text-foreground border-border " +
    "hover:not-disabled:bg-secondary hover:not-disabled:border-border-hover",
  danger: "bg-card !text-destructive border-destructive " +
    "hover:not-disabled:bg-destructive hover:not-disabled:!text-destructive-foreground",
  text: "min-h-[32px] px-0 py-[6px] bg-transparent border-transparent " +
    "!text-foreground-secondary hover:not-disabled:!text-foreground",
};

export function buttonClasses(
  variant: ButtonVariant = "primary",
  opts: { busy?: boolean; className?: string } = {},
) {
  return cn(BASE, VARIANT[variant], opts.busy && "cursor-wait", opts.className);
}

export type ButtonProps = React.ComponentProps<"button"> & {
  variant?: ButtonVariant;
  busy?: boolean;
};

export function Button({ variant = "primary", busy = false, className, ...props }: ButtonProps) {
  return <button className={buttonClasses(variant, { busy, className })} {...props} />;
}
