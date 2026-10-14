import { useRef, useState, type ReactNode } from "react";
import { IconButton } from "./icon-button";
import { Item, ItemContent, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from "../reui/item";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../reui/sheet";
import { SheetCloseButton, SHEET_CLOSE_CLEARANCE } from "./SheetCloseButton";
import { cn } from "@/lib/utils";

/**
 * The phone ⋯ (#879, D5, P9/P10): a bottom action sheet, not a menu. The rows are `reui/item`s; the sheet portals into the viewer's slot so it sits inside the dark scope and the
 * viewer's focus trap. `children` gets `close`, so a row that hands focus on (Create Review link, a Remove confirmation) can close the sheet first.
 */
export function ReviewActionSheet({ container, triggerTestId = "video-header-menu", triggerLabel = "Video actions", title = "Video actions", children }: {
  container: HTMLElement | null;
  triggerTestId?: string;
  triggerLabel?: string;
  title?: string;
  /** `close(true)` hands focus to what the row opens instead of back to the trigger. */
  children: (close: (handOff?: boolean) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const handOff = useRef(false);
  const close = (hand = false) => { handOff.current = hand; setOpen(false); };
  return <>
    <IconButton ref={triggerRef} type="button" aria-label={triggerLabel} aria-haspopup="dialog" data-testid={triggerTestId} className="rounded-lg border border-solid border-border bg-background text-foreground" onClick={() => { handOff.current = false; setOpen(true); }}><span aria-hidden="true">⋯</span></IconButton>
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="bottom" container={container} showCloseButton={false} finalFocus={() => (handOff.current ? false : triggerRef.current)} data-testid="review-action-sheet" className="max-h-[80dvh] p-[var(--space-4)]">
        <SheetHeader className={`p-0 ${SHEET_CLOSE_CLEARANCE}`}><SheetTitle className="m-0 text-foreground [font:var(--type-h3)]">{title}</SheetTitle></SheetHeader>
        <ItemGroup role="group" aria-label={title} className="min-h-0 gap-0 overflow-y-auto">{children(close)}</ItemGroup>
        <SheetCloseButton label="Close actions" data-testid="review-action-close" />
      </SheetContent>
    </Sheet>
  </>;
}

const ROW = "min-h-11 w-full cursor-pointer text-start data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

/** One row of the action sheet: a button, or a real anchor (`href`, so the browser's own download runs on it). */
export function ActionRow({ icon, children, onSelect, href, download, label, danger = false, disabled = false, pressed, testId }: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect?: ((event?: unknown) => void) | undefined;
  href?: string | undefined;
  download?: boolean;
  /** Accessible name when it differs from the text. */
  label?: string | undefined;
  danger?: boolean;
  disabled?: boolean;
  /** A toggle row (Social preview): its state, spoken as `aria-pressed`. */
  pressed?: boolean | undefined;
  testId?: string | undefined;
}) {
  const common = { "data-testid": testId, "aria-label": label, className: cn(ROW, danger && "text-destructive-wash-foreground") };
  const render = href !== undefined
    ? <a {...common} href={href} {...(download ? { download: true } : {})} onClick={onSelect} />
    : <button {...common} type="button" disabled={disabled} {...(pressed !== undefined ? { "aria-pressed": pressed } : {})} onClick={onSelect} />;
  return <Item size="sm" render={render}>
    {icon && <ItemMedia variant="icon">{icon}</ItemMedia>}
    <ItemContent><ItemTitle>{children}</ItemTitle></ItemContent>
  </Item>;
}

export const ActionSeparator = ItemSeparator;
