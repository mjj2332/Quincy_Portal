import * as React from "react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/reui/button";

// Composed over `reui/button`'s `buttonVariants`, not the vendored `Button` component: that
// primitive renders Base UI's `ButtonPrimitive`, which defaults to a real `<button>` — the
// rendered element type is not at stake here — but it layers its own `type="button"` default and
// event handling on top. Slice C's ~95 call sites have not been individually audited against that
// behaviour, so this wrapper stays a plain `<button>` until they are swapped one at a time.
//
// Variant map follows #53's shipped precedent exactly (`screens/Admin.tsx:11,91-96`,
// `screens/CreateProject.tsx:62`, which already call `buttonVariants({ variant: "outline" | "ghost" | ... })`
// directly): `primary`->`default`, `secondary`->`outline`, `danger`->`destructive`, `text`->`ghost`
// plus `TEXT_BUTTON`'s box metrics restored on top, exactly as Admin.tsx does today by splicing
// `className={TEXT_BUTTON}` alongside `variant="ghost"` at each call site — folded in here instead
// of at every call site.
export type ButtonVariant = "primary" | "secondary" | "danger" | "text";

// Ported verbatim from `Admin.tsx:96`. Nova's nearest analogue to Quincy's compact, padding-free
// `text` variant is `ghost`, a fully padded 38px button; these metrics restore the 32px box.
// `max-[721px]:min-h-[44px]` in the cva base is a different modifier and survives the merge
// unchanged, exactly as it did under `ui/button.tsx`'s own `text` variant.
export const TEXT_BUTTON = "min-h-[32px] px-0 py-[6px]";

// `AnchoredPopover.tsx`'s `RING_IN` is an inward, `!`-prefixed outline that popover-hosted
// controls wear so their focus ring doesn't clip against the panel's `overflow-auto` edge
// (TB8-07 §4.3). It is still needed, and it is now the ONLY focus utility that has to merge here:
// `reui/button.tsx` no longer emits a ring of its own (divergence 5 there), so `RING_IN`'s
// `!outline` and the global `:focus-visible` outline are once again the same property, and
// tailwind-merge collapses them to one winner exactly as it did under `ui/button.tsx`.
//
// The `insetFocus` option this file used to carry is GONE. It existed only to zero nova's ring
// per variant; with no ring emitted it neutralised nothing, and a variant-keyed border map that
// no longer has a border to restore is rot, not API.

const VARIANT_MAP: Record<ButtonVariant, "default" | "outline" | "destructive" | "ghost"> = {
  primary: "default",
  secondary: "outline",
  danger: "destructive",
  text: "ghost",
};

export function buttonClasses(
  variant: ButtonVariant = "primary",
  opts: { className?: string } = {},
): string {
  return cn(
    buttonVariants({ variant: VARIANT_MAP[variant] }),
    // `ui/button.tsx:25` carried `no-underline`: `base.css` has an unlayered `a { color: inherit }`
    // rule (see `reui/button.tsx`'s own comment block for the full cascade-layer reasoning), and
    // `buttonClasses()` renders on real `<a>` elements via `InternalLink`
    // (`screens/Dashboard.tsx:948,1031`) as well as real `<button>`s. Without it an anchor wearing
    // these classes would render underlined.
    "no-underline",
    variant === "text" && TEXT_BUTTON,
    opts.className,
  );
}

function Button({ variant = "primary", className, ...props }: React.ComponentProps<"button"> & { variant?: ButtonVariant }) {
  return <button className={buttonClasses(variant, { className })} {...props} />;
}

export { Button };
