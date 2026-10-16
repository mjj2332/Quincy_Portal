import { useRef, type ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "../reui/sheet";
import { PHONE_SHEET_CHROME, PHONE_SHEET_TITLE, SHEET_SCRIM } from "../quincy/ReviewActionSheet";
import { SheetCloseButton } from "../quincy/SheetCloseButton";

/** Where the header's ⋯ trigger is: the sheet hands focus back to it (the row that opened the sheet has gone with the ⋯ sheet). */
const HEADER_MENU = '[data-testid="video-header-menu"]';

/**
 * The phone's Version details (#879 PR 3b, C12, no frame): the ⋯ sheet's Version details row opens the same rows the desktop notes panel shows behind its details button,
 * in a bottom sheet with the P8/P9 chrome (the sheet takes focus on itself, the close is drawn only on keyboard focus). Closing it gives focus back to the header ⋯.
 * P8's look (#879 PR 3b, F5): the quiet label-type title and P8's one-line rows; the viewer hands the rows in their `line` layout, which scrolls itself.
 * Reuse: `reui/sheet` (`side="bottom"`, portalled into the viewer's slot like the other phone sheets); the rows are the viewer's own `detailsRows`, so there is no new read.
 */
export function VideoDetailsSheet({ open, onOpenChange, container, version, children }: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  container: HTMLElement | null;
  /** The Version number, for the title. */
  version: number;
  /** The Version details rows in their `line` layout (their own scrolling `reui/item` group). */
  children: ReactNode;
}) {
  const popupRef = useRef<HTMLDivElement | null>(null);
  // The viewer Dialog's `restoreFocus: "popup"` reclaims homeless focus a frame after a nested sheet closes (lessons, P3 / #669): the ⋯ takes focus synchronously, before the close.
  const changeOpen = (next: boolean) => { if (!next) document.querySelector<HTMLElement>(HEADER_MENU)?.focus({ preventScroll: true }); onOpenChange(next); };
  return <Sheet open={open} onOpenChange={changeOpen}>
    <SheetContent ref={popupRef} side="bottom" container={container} showCloseButton={false} overlayProps={{ className: SHEET_SCRIM, forceRender: true, "data-testid": "review-sheet-overlay" }} initialFocus={() => popupRef.current ?? true} finalFocus={() => document.querySelector<HTMLElement>(HEADER_MENU) ?? true} data-testid="video-details-sheet" className={`max-h-[70dvh] ${PHONE_SHEET_CHROME}`}>
      <SheetTitle data-testid="video-details-title" className={PHONE_SHEET_TITLE}>{`Version ${version} details`}</SheetTitle>
      {children}
      <SheetCloseButton label="Close details" data-testid="video-details-close" visuallyHidden />
    </SheetContent>
  </Sheet>;
}
