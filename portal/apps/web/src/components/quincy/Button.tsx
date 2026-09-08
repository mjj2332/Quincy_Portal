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
// (TB8-07 §4.3). Call sites that push it through `buttonClasses`: `SubtaskChecklist.tsx:172,173,208`
// and inline equivalents at `ProjectKanbanBoard.tsx:229-231`.
//
// Under the LEGACY `ui/button.tsx` `buttonClasses`, `RING_IN` alone was enough: the base's
// `focus-visible:outline-*` and `RING_IN`'s `focus-visible:!outline-*` are the same CSS property
// (`outline`), so twMerge collapsed them to one winner. Over THIS cva-derived base that is no
// longer true — ReUI's ring (`focus-visible:border-ring focus-visible:ring-3
// focus-visible:ring-ring/50`) lives in a different property group (`border-color`/`box-shadow`,
// not `outline`), so twMerge cannot resolve the conflict and BOTH survive: ReUI's outward ring
// reappears alongside `RING_IN`'s inward one and gets clipped by the popover panel.
//
// `insetFocus` neutralises ReUI's outward ring so only the inward outline paints. The BORDER half
// of that is variant-sensitive, and getting it wrong deletes a real border rather than restoring
// resting paint: `secondary` maps to ReUI's `outline` variant, which rests on `border-border`
// (`reui/button.tsx:37`). Every other variant rests on the cva base's `border-transparent`, so
// blanking the focus border does restore their resting state. This lives here, keyed by variant,
// rather than as a constant callers pair by hand — a caller cannot see which variant needs which
// border, and a hand-paired token shipped exactly that defect (Sol, slice C).
const INSET_FOCUS: Record<ButtonVariant, string> = {
  primary: "focus-visible:ring-0 focus-visible:border-transparent",
  secondary: "focus-visible:ring-0 focus-visible:border-border",
  danger: "focus-visible:ring-0 focus-visible:border-transparent",
  text: "focus-visible:ring-0 focus-visible:border-transparent",
};

const VARIANT_MAP: Record<ButtonVariant, "default" | "outline" | "destructive" | "ghost"> = {
  primary: "default",
  secondary: "outline",
  danger: "destructive",
  text: "ghost",
};

export function buttonClasses(
  variant: ButtonVariant = "primary",
  opts: { className?: string; insetFocus?: boolean } = {},
): string {
  return cn(
    buttonVariants({ variant: VARIANT_MAP[variant] }),
    opts.insetFocus && INSET_FOCUS[variant],
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

// `insetFocus` was reachable only through `buttonClasses`, not through this component. Forwarded
// here (and not spread onto the DOM `<button>`) so a component-rendered button can wear the same
// inward focus treatment as a hand-called `buttonClasses` site.
function Button({ variant = "primary", className, insetFocus, ...props }: React.ComponentProps<"button"> & { variant?: ButtonVariant; insetFocus?: boolean }) {
  return <button className={buttonClasses(variant, { className, insetFocus })} {...props} />;
}

export { Button };
