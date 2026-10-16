import { useRef, useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { Button } from "../reui/button";
import { Item, ItemContent, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from "../reui/item";
import { Sheet, SheetContent, SheetTitle } from "../reui/sheet";
import { SheetCloseButton } from "./SheetCloseButton";
import { cn } from "@/lib/utils";

/**
 * The phone ⋯ (#879, D5, P9/P10): a bottom action sheet, not a menu. The rows are `reui/item`s; the sheet portals into the viewer's slot so it sits inside the dark scope and the
 * viewer's focus trap. `children` gets `close`, so a row that hands focus on (Create Review link, a Remove confirmation) can close the sheet first.
 * The trigger is P1's plain `ibtn` (#879 PR 3a): a ghost `reui/button` with lucide's Ellipsis, 44px, no border.
 * P9's chrome (#879 PR 3b): no visible title or close. The title is for screen readers, the close is drawn only on keyboard focus, and the sheet itself takes
 * focus on open (so no row is focused, and pressed, by accident).
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
  const popupRef = useRef<HTMLDivElement | null>(null);
  // The viewer Dialog's `restoreFocus: "popup"` reclaims homeless focus a frame after a nested sheet closes, ahead of the sheet's own return (lessons, P3 / #669): so the trigger takes focus synchronously, before the close.
  const close = (hand = false) => { handOff.current = hand; if (!hand) triggerRef.current?.focus({ preventScroll: true }); setOpen(false); };
  const changeOpen = (next: boolean) => { if (!next && !handOff.current) triggerRef.current?.focus({ preventScroll: true }); setOpen(next); };
  return <>
    <Button ref={triggerRef} type="button" variant="ghost" size="icon" aria-label={triggerLabel} aria-haspopup="dialog" data-testid={triggerTestId} className="min-h-11 min-w-11 flex-none text-foreground" onClick={() => { handOff.current = false; setOpen(true); }}><Ellipsis aria-hidden="true" className="size-5" /></Button>
    <Sheet open={open} onOpenChange={changeOpen}>
      <SheetContent ref={popupRef} side="bottom" container={container} showCloseButton={false} overlayProps={{ className: SHEET_SCRIM, forceRender: true, "data-testid": "review-sheet-overlay" }} initialFocus={() => popupRef.current ?? true} finalFocus={() => (handOff.current ? false : triggerRef.current)} data-testid="review-action-sheet" className={`max-h-[80dvh] ${PHONE_SHEET_CHROME}`}>
        <SheetTitle data-testid="review-action-title" className="sr-only">{title}</SheetTitle>
        <ItemGroup role="group" aria-label={title} data-testid="review-action-rows" className={ACTION_ROWS}>{children(close)}</ItemGroup>
        <SheetCloseButton label="Close actions" data-testid="review-action-close" visuallyHidden />
      </SheetContent>
    </Sheet>
  </>;
}

/** The phone sheets sit on the dark inverse surface, where the default 50% scrim barely shows: a stronger one, the same for every sheet (staff and guest). */
export const SHEET_SCRIM = "bg-[color-mix(in_srgb,var(--ink-900)_75%,transparent)]";

/**
 * P8/P9's `.asheet` (#879 PR 3b): rounded top at `--radius-lg` (14px), `--space-2` above the rows, no side padding (the rows run edge to edge with their own gutters),
 * and 28px below or the home indicator's inset, whichever is taller. `focus-visible:!outline-none`: `initialFocus` lands on the sheet itself, and base.css's unlayered
 * `:focus-visible` outline would ring it (#607, see NotificationBell; `container-focus.guard.test.ts`).
 */
export const PHONE_SHEET_CHROME = "gap-0 rounded-t-[var(--radius-lg)] px-0 pt-[var(--space-2)] pb-[max(calc(var(--space-5)+var(--space-1)),env(safe-area-inset-bottom))] focus-visible:!outline-none";

/** P9's `.arow` box: 50pt (a 24pt body line, `--space-3` above and below, and the item's 1px border), 20pt gutters (`--space-4` + `--space-1`), square, edge to edge. A display row (Version details) takes the box alone. */
export const ACTION_ROW_BOX = "min-h-11 w-full gap-[var(--space-3)] rounded-none px-[calc(var(--space-4)+var(--space-1))] py-[var(--space-3)] text-start";

/** P9's `.arow`: the box, and a pointer that says it acts. */
export const ACTION_ROW = `${ACTION_ROW_BOX} cursor-pointer data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60`;

/** P8's quiet sheet title (`.ash-title`): label type in secondary ink, on the rows' gutter, `--space-2` above and below. */
export const PHONE_SHEET_TITLE = "m-0 px-[calc(var(--space-4)+var(--space-1))] pt-[var(--space-2)] pb-[var(--space-2)] text-foreground-secondary [font:var(--type-label)]";

/**
 * The rows' group: rows touch, as P8/P9's do. ItemGroup spaces `sm` items with `has-data-[size=sm]:gap-2.5`, which a plain `gap-0` cannot override (a different variant, so
 * tailwind-merge keeps both and the `has-` rule wins): that 10px made every row read 60pt in the Simulator (#879 PR 3b, F3).
 */
export const ACTION_ROWS = "min-h-0 gap-0 has-data-[size=sm]:gap-0 overflow-y-auto";

/** The row's label in body type (P9: 16pt, regular). */
export const ACTION_ROW_TITLE = "text-[length:var(--text-base)] leading-[var(--leading-normal)] font-normal";

/** One row of the action sheet: a button, or a real anchor (`href`, so the browser's own download runs on it). */
export function ActionRow({ icon, children, onSelect, href, download, danger = false, disabled = false, pressed, testId }: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect?: ((event?: unknown) => void) | undefined;
  href?: string | undefined;
  download?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** A toggle row (Social preview): its state, spoken as `aria-pressed`. */
  pressed?: boolean | undefined;
  testId?: string | undefined;
}) {
  // The visible label is the accessible name (#879 PR 3b): no row speaks a different one.
  // The geometry goes on the Item, whose `cn` merges it over the `sm` size (`px-3 py-2.5`, `rounded-lg`); on the rendered element it would only be concatenated beside them.
  const render = href !== undefined
    ? <a data-testid={testId} href={href} {...(download ? { download: true } : {})} onClick={onSelect} />
    : <button data-testid={testId} type="button" disabled={disabled} {...(pressed !== undefined ? { "aria-pressed": pressed } : {})} onClick={onSelect} />;
  return <Item size="sm" className={cn(ACTION_ROW, danger && "text-destructive-wash-foreground")} render={render}>
    {icon && <ItemMedia variant="icon">{icon}</ItemMedia>}
    <ItemContent><ItemTitle data-testid="review-action-row-label" className={ACTION_ROW_TITLE}>{children}</ItemTitle></ItemContent>
  </Item>;
}

/** The rule between groups of rows (P9's `.asep`). */
export function ActionSeparator() {
  return <ItemSeparator data-testid="review-action-separator" />;
}
