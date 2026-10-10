import type { ReactNode } from "react";
import { SHEET_CLOSE_CLEARANCE } from "../quincy/SheetCloseButton";
import { cn } from "@/lib/utils";

/** The step title in the display font, as `VideoNotePasteDialog` sets it. `reui/dialog` itself is not restyled. */
export const DIALOG_TITLE = "text-[length:var(--text-lg)] leading-[var(--leading-snug)] font-normal font-[family-name:var(--font-display)]";

/**
 * One step of the Review links dialog (#741 11b): the header and the footer stay put, only the body scrolls, and the close control (rendered
 * once by `ReviewLinksDialogHost`, as `SheetCloseButton`) never scrolls away. The structure of `Modal` and `VideoNotePasteDialog`: the
 * `DialogContent` is `flex flex-col`; the header reserves the close control's room (`SHEET_CLOSE_CLEARANCE`, 28px on desktop, 44px on a phone).
 */
export function ReviewLinkDialogFrame({ header, footer, children, className }: { header: ReactNode; footer?: ReactNode; children?: ReactNode; className?: string }) {
  return <>
    <div className={SHEET_CLOSE_CLEARANCE}>{header}</div>
    {/* The small negative margin and padding keep a focused field's ring from being clipped by the scroll box. */}
    <div data-testid="review-links-dialog-body" className={cn("-mx-[var(--space-1)] grid min-h-0 flex-1 content-start gap-[var(--space-4)] overflow-y-auto px-[var(--space-1)]", className)}>{children}</div>
    {footer}
  </>;
}
