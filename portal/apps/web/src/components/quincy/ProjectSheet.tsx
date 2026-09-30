import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { XIcon } from "lucide-react";

import { Button } from "@/components/reui/button";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/reui/sheet";
import { shouldInterceptInternalLink } from "../../lib/router";
import { OverlayContainerContext } from "../OverlayContainerContext";
import { hasOpenInnerLayer } from "./project-sheet-layers";

/**
 * The Project sheet — #366. The Project route floating over the live Dashboard: a right-anchored
 * modal on `reui/sheet.tsx`'s base-nova `Sheet`, inset 24px on every side (edge to edge at
 * <=720px), composed the way `RailSheet` composes it.
 *
 * **Controlled by the route, never by local state.** `open` is derived from the location by the
 * dashboard layer; every dismissal (close button, Esc, an inset press) calls `onRequestClose`,
 * which navigates, and the route change is what actually closes the sheet.
 *
 * `overlayProps.forceRender` is mandatory: `RailedShell` wraps the whole content column in its own
 * `<Sheet>` Root, so this Root is NESTED, and Base UI renders no backdrop for a nested dialog by
 * default (`dialog/backdrop/DialogBackdrop.js`, `enabled: forceRender || !nested`) — without a
 * scrim an inset press would do nothing.
 *
 * Nothing on the popup may create a containing block (`transform`, `filter`, `contain`,
 * `will-change`): the Lightbox and `ToastViewport` are `position: fixed` descendants.
 *
 * `finalFocus` is supplied by the layer, which captured the opener at the moment the location
 * went Dashboard -> sheet.
 */
export type ProjectSheetProps = {
  open: boolean;
  /** `"edit"` arrives with #374; the sheet already takes it so that change adds no props. */
  kind: "project" | "edit";
  /** Remounts the body when the sheet's subject changes. */
  sheetKey: string;
  /** The Dashboard location the sheet floats over: what a "Back to dashboard" link means here. */
  backdropHref: string;
  onRequestClose: () => void;
  impersonating?: boolean;
  finalFocus?: () => HTMLElement | true;
  children: ReactNode;
};

type ProjectSheetContextValue = { close(): void; backdropHref: string };
const ProjectSheetContext = createContext<ProjectSheetContextValue | null>(null);

/**
 * Props for an `InternalLink` that returns to the Dashboard: inside a sheet it closes it (landing
 * on the backdrop the sheet floats over); outside one it is the plain `/` link it always was. A
 * modified click still opens natively (`shouldInterceptInternalLink`).
 */
export function useDashboardReturnLink(): { to: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void } {
  const sheet = useContext(ProjectSheetContext);
  if (!sheet) return { to: "/" };
  return {
    to: sheet.backdropHref,
    onClick(event) {
      if (shouldInterceptInternalLink(event, window.location.origin)) {
        event.preventDefault();
        sheet.close();
      }
    },
  };
}

export function ProjectSheet({ open, kind, sheetKey, backdropHref, onRequestClose, impersonating = false, finalFocus, children }: ProjectSheetProps) {
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const snapshotRef = useRef(false);

  // D8: an inner layer (Lightbox, confirm) owns Esc and outside presses. Base UI's own dismissal
  // listens on `document` and stops propagation, so it cannot be asked "who owns this?" after the
  // fact — the question is answered at window-capture time, before any handler has run, and
  // consulted from `onOpenChange`.
  useEffect(() => {
    if (!open) return;
    const snap = () => { snapshotRef.current = hasOpenInnerLayer(popupRef.current, slot, document); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") snap(); };
    window.addEventListener("pointerdown", snap, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", snap, true);
      window.removeEventListener("keydown", onKeyDown, true);
      snapshotRef.current = false;
    };
  }, [open, slot]);

  const handleOpenChange = useCallback((next: boolean, details: { reason: string; cancel: () => void; allowPropagation: () => void }) => {
    if (next) return;
    if (details.reason === "escape-key" || details.reason === "outside-press") {
      // Read, NOT consumed: Base UI reports one Escape to `onOpenChange` more than once (verified:
      // two calls per keydown), and consuming on the first would let the second close the sheet.
      // The snapshot is retaken at the start of every gesture, so it is never stale.
      if (snapshotRef.current) { details.cancel(); details.allowPropagation(); return; }
    }
    onRequestClose();
  }, [onRequestClose]);

  const context = useMemo<ProjectSheetContextValue>(() => ({ close: onRequestClose, backdropHref }), [onRequestClose, backdropHref]);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        data-testid="project-sheet"
        data-impersonating={impersonating ? "" : undefined}
        ref={popupRef}
        initialFocus={() => popupRef.current ?? true}
        finalFocus={finalFocus}
        className="z-[var(--z-dialog)] gap-0 p-0 bg-background data-[side=right]:inset-[var(--space-5)] data-[side=right]:h-auto data-[side=right]:w-auto data-[side=right]:max-w-none data-[side=right]:sm:max-w-none data-[side=right]:border data-[impersonating]:data-[side=right]:top-[calc(42px+var(--space-5))] max-[721px]:data-[side=right]:inset-0 max-[721px]:data-[side=right]:border-0 max-[721px]:data-[impersonating]:data-[side=right]:top-[42px] data-ending-style:duration-0"
        overlayProps={{
          forceRender: true,
          "data-testid": "project-sheet-scrim",
          className: "z-[var(--z-dialog)] bg-[var(--scrim-overlay)] backdrop-blur-[3px] data-ending-style:duration-0",
        }}
      >
        <SheetTitle className="sr-only">{kind === "edit" ? "Edit project details" : "Project workspace"}</SheetTitle>
        {/* Outside the scroller, above `.worktools` (z-20). */}
        <SheetClose
          data-testid="project-sheet-close"
          aria-label="Close project"
          render={<Button variant="ghost" size="icon" className="absolute top-[var(--space-2)] right-[var(--space-2)] z-[30] min-h-[44px] min-w-[44px]" />}
        >
          <XIcon aria-hidden />
        </SheetClose>
        <div key={sheetKey} data-testid="project-sheet-body" className="project-sheet__body min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <ProjectSheetContext.Provider value={context}>
            <OverlayContainerContext.Provider value={slot}>{children}</OverlayContainerContext.Provider>
          </ProjectSheetContext.Provider>
        </div>
        {/* §4.2a: every popover / select / menu portals here — inside the trap, above z-95's floor. */}
        <div ref={setSlot} data-testid="project-sheet-overlay-slot" />
      </SheetContent>
    </Sheet>
  );
}
