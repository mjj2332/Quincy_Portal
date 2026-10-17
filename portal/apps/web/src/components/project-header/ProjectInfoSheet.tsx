import { useContext, useRef, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/reui/button";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/reui/sheet";
import { OverlayContainerContext } from "../OverlayContainerContext";
import { INFO_EYEBROW } from "./info-sections";

/**
 * #914 D2 — Project info (prototype project-header-revamp `.d-sheet`): a 440px sheet docked to the Project sheet's right edge.
 *
 * Reuse: `reui/sheet` (`side="right"`). Docking: the Project sheet's popup is `position: fixed` and must create no other containing
 * block (ProjectSheet's header), so this sheet portals into the Project sheet's overlay slot (`OverlayContainerContext`) and its
 * popup and scrim are `absolute`: they dock to the Project sheet, not the window. `z-[40]` puts both above the Project sheet's own
 * Close (`z-[30]`), as the frame draws it; the popovers inside (`--z-popover`) still stack above. The width goes through the vendor's
 * own `data-[side=right]` variant, or it loses (lessons § "A plain width on a SheetContent loses to the sheet's data-side width").
 * This Root is nested in the Project sheet's, so its scrim needs `forceRender` (lessons § "The Project sheet: four traps").
 *
 * Modal: Esc and a scrim press close it first (the Project sheet counts it as an inner layer, `project-sheet-layers.ts`). Focus goes
 * back to the opener synchronously in `onOpenChange(false)`, because the Project sheet reclaims homeless focus a frame later (#669).
 */
export function ProjectInfoSheet({ open, onClose, initialFocus, returnFocus, street, place, children, footer }: {
  open: boolean;
  onClose: () => void;
  /** The element to focus when it opens (the section it was opened at), or null for the sheet itself. */
  initialFocus: () => HTMLElement | null;
  returnFocus: () => HTMLElement | null;
  street: string;
  place: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const container = useContext(OverlayContainerContext);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const changeOpen = (next: boolean) => {
    if (next) return;
    returnFocus()?.focus({ preventScroll: true });
    onClose();
  };
  return <Sheet open={open} onOpenChange={changeOpen}>
    <SheetContent
      ref={popupRef}
      side="right"
      container={container}
      showCloseButton={false}
      data-testid="project-info-sheet"
      initialFocus={() => {
        const target = initialFocus();
        if (target) { target.focus({ preventScroll: true }); return false; }
        return popupRef.current ?? true;
      }}
      finalFocus={() => returnFocus() ?? true}
      overlayProps={{ forceRender: true, "data-testid": "project-info-scrim", className: "absolute z-[40]" }}
      // `focus-visible:!outline-none`: initialFocus can land on the sheet itself (#607, container-focus.guard).
      className="absolute z-[40] gap-0 p-0 bg-popover focus-visible:!outline-none data-[side=right]:w-[440px] data-[side=right]:max-w-full data-[side=right]:sm:max-w-none"
    >
      <header className="flex shrink-0 items-start gap-[var(--space-3)] border-b border-border px-[var(--space-5)] pt-[var(--space-5)] pb-[var(--space-4)]">
        <div className="grid min-w-0 flex-1 gap-[var(--space-1)]">
          <span className={INFO_EYEBROW}>Project info</span>
          <SheetTitle className="m-0 [font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground [overflow-wrap:anywhere]">{street}</SheetTitle>
          {place && <span className="[font:var(--type-label)] text-foreground-secondary">{place}</span>}
        </div>
        <SheetClose
          data-testid="project-info-close"
          aria-label="Close Project info"
          render={<Button type="button" variant="ghost" size="icon-header" className="-me-[var(--space-2)] -mt-[var(--space-2)]" />}
        >
          <XIcon aria-hidden="true" className="size-[18px]" />
        </SheetClose>
      </header>
      <div data-testid="project-info-body" className="grid min-h-0 flex-1 content-start overflow-y-auto overscroll-contain px-[var(--space-5)]">{children}</div>
      {footer && <footer className="flex shrink-0 flex-wrap gap-[var(--space-2)] border-t border-border px-[var(--space-5)] py-[var(--space-4)]">{footer}</footer>}
    </SheetContent>
  </Sheet>;
}
