import { useState, type ReactNode } from "react";

import { SheetContent, SheetTitle } from "@/components/reui/sheet";
import { OverlayContainerContext } from "../OverlayContainerContext";

/**
 * The narrow-window rail — issue #112. Always mounted; its popup renders nothing while
 * `RailedShell`'s `mode` is not `"sheet"` (below 772px). A thin composition over
 * `reui/sheet.tsx`'s base-nova `SheetContent`, itself on `@base-ui/react/dialog` — `sheet` and
 * `breadcrumb` are shadcn base-nova primitives vendored into `components/reui/`, not registry
 * installs (see `reui/sidebar.tsx`'s own header for why).
 *
 * This component owns no `Dialog.Root` — `RailedShell`'s `Sheet` wraps both the rail slot and the
 * content column, so this and `ShellHeader`'s trigger are descendants of the SAME Root, and this
 * composes only the popup: no `open`/`onOpenChange`, no Escape or backdrop-dismiss wiring of its
 * own, all inherited from the Root's default modal behaviour.
 *
 * `NavigationRail`'s account menu (`quincy/menu.tsx`) portals to `document.body` by default, which
 * is OUTSIDE this modal Sheet's focus trap — a modal dialog makes everything outside it inert, so
 * an unrelocated menu panel would become unreachable the moment it opened. `Modal.tsx` (~163) solves
 * the identical problem with an `OverlayContainerContext.Provider` wrapping a plain `<div>` ref
 * inside the popup; this does the same, so the account menu portals inside the Sheet instead of
 * past it.
 *
 * `finalFocus` (#122 P3) forwards straight through to `SheetContent`'s own `...props` spread onto
 * `SheetPrimitive.Popup` — `Dialog.Popup` already accepts it (`@base-ui/react/dialog`), so no edit
 * to `reui/sheet.tsx` is needed. `RailedShell` uses it to suppress the Sheet's own close-focuses-
 * the-trigger behaviour for exactly one close: a ⌘K search tap inside the Sheet needs the
 * Dashboard's own input focused instead, once it mounts, not the (about to vanish) sheet trigger.
 */
export type RailSheetProps = {
  children: ReactNode;
  finalFocus?: React.ComponentProps<typeof SheetContent>["finalFocus"];
};

export function RailSheet({ children, finalFocus }: RailSheetProps) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);

  return (
    <SheetContent
      side="left"
      showCloseButton={false}
      data-testid="rail-sheet"
      className="z-[var(--z-dialog)] gap-0 bg-sidebar p-0 text-sidebar-foreground border-sidebar-border data-[side=left]:w-[288px]"
      finalFocus={finalFocus}
      overlayProps={{
        "data-testid": "rail-sheet-scrim",
        // The token plus a 3px blur — the same scrim `Modal.tsx`'s own `SCRIM` reaches for, not an
        // invented colour. Not the rest of `SCRIM`'s class string: that also centres a panel and
        // carries `max-[721px]:…` responsive variants for a DIALOG's own layout, neither of which
        // applies to a side-anchored Sheet, and the latter would trip
        // `shell-breakpoint.guard.test.ts`'s ban on a second, CSS-owned breakpoint.
        className: "z-[var(--z-dialog)] bg-[var(--scrim-overlay)] backdrop-blur-[3px]",
      }}
    >
      {/* sr-only: the Sheet IS the rail, and its contents already say so visibly. A screen reader
          entering the dialog still needs a name, which Base UI's own `aria-labelledby` wiring
          points at this. */}
      <SheetTitle className="sr-only">Navigation</SheetTitle>
      <OverlayContainerContext.Provider value={slot}>
        {children}
      </OverlayContainerContext.Provider>
      <div ref={setSlot} />
    </SheetContent>
  );
}
