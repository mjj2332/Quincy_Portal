import type { Ref } from "react";
import { XIcon } from "lucide-react";

import { Button } from "@/components/reui/button";
import { SheetClose } from "@/components/reui/sheet";

/**
 * #462 — the Quincy close for a `reui/sheet` whose header is wide enough to collide with the
 * vendored close (`SheetContent`'s `showCloseButton`, which sits at top/right 12px over the header).
 * Callers pass `showCloseButton={false}` and render this instead.
 *
 * Render it as the LAST child of `SheetContent`: Base UI's default initial focus is the first
 * tabbable in the popup, so a close placed first would take focus on open.
 *
 * The target is `icon-sm` (`size-7`, 28px) on desktop and 44px at <=721px. `SHEET_CLOSE_CLEARANCE`
 * reserves the header's end padding for it (inset `--space-3` + target + `--space-2`: 48px desktop,
 * 64px phone), so the size and the reserved room live together: 28px here must match the 28px in
 * the clearance. Merge it AFTER any `p-*` class in `cn()` so it wins.
 */
export const SHEET_CLOSE_CLEARANCE =
  "pe-[calc(var(--space-3)+28px+var(--space-2))] max-[721px]:pe-[calc(var(--space-3)+44px+var(--space-2))]";

/** `buttonRef` lets a sheet name this button as its `initialFocus` target (#652). */
export function SheetCloseButton({ label, "data-testid": testId, buttonRef }: { label: string; "data-testid"?: string; buttonRef?: Ref<HTMLButtonElement> }) {
  return (
    <SheetClose
      ref={buttonRef}
      data-testid={testId}
      aria-label={label}
      render={<Button variant="ghost" size="icon-sm" className="absolute top-[var(--space-3)] right-[var(--space-3)] max-[721px]:size-11" />}
    >
      <XIcon aria-hidden />
    </SheetClose>
  );
}
