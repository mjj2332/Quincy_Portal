/**
 * #614 PR B (Sol r2) - where focus goes for an event whose chip may be folded into a month cell's
 * "+N more". Quincy-authored (not vendored), beside `event-calendar-keyboard.ts`: it reads the
 * vendor's `data-ec-*` contract, which the skin guard confines to this directory. The keyboard
 * session's `refocus` (event-calendar-dnd.tsx) uses it; the scheduling controller, which may not
 * read `data-ec-*` or import this tree, finds the same trigger through the Portal's own marker
 * (`findMoreForEvent`, lib/calendar-more-anchor.ts). DOM lookup only.
 *
 * Under `autoFit` a month cell folds a bar (or any chip) into its overflow trigger and unmounts the
 * chip, so "focus the chip" has nothing to find. The trigger of a day the occurrence covers is
 * where the event lives then. The occurrence is intersected with the RENDERED days: it may start
 * before the displayed grid, so its own start is not a day to look for.
 */

/** The occurrence's [start, end) as epoch ms (or Dates); `edge` names the end the user was adjusting. */
export type EventFocusSpan = {
  start: number | Date;
  end: number | Date;
  /** The adjusted edge: a resized end prefers the last covered day; anything else, the first. */
  edge?: "start" | "end";
};

const OVERFLOW_TRIGGER = '[data-slot="event-calendar-more"]';
/** Upper bound on a day's length (a DST day is 23-25h) for the last rendered cell, which has no successor. */
const LAST_CELL_SPAN_MS = 25 * 60 * 60 * 1000;

const ms = (value: number | Date) => (typeof value === "number" ? value : value.getTime());

/** The event's drawn chip, ignoring a drag-preview copy. */
function chipFor(root: ParentNode, eventId: string): HTMLElement | null {
  return (
    [...root.querySelectorAll<HTMLElement>("[data-ec-event-id]")].find(
      (el) => el.dataset.ecEventId === eventId && !el.dataset.preview
    ) ?? null
  );
}

/** Rendered month cells that carry an overflow trigger, in day order, with the day each one ends. */
function overflowDays(root: ParentNode): Array<{ trigger: HTMLElement; from: number; to: number }> {
  const days = [...root.querySelectorAll<HTMLElement>("[data-ec-day]")]
    .map((cell) => ({ cell, from: Number(cell.dataset.ecDay) }))
    .filter(({ from }) => Number.isFinite(from))
    .sort((a, b) => a.from - b.from);
  const out: Array<{ trigger: HTMLElement; from: number; to: number }> = [];
  days.forEach(({ cell, from }, index) => {
    const trigger = cell.querySelector<HTMLElement>(OVERFLOW_TRIGGER);
    if (!trigger) return;
    const next = days.slice(index + 1).find((later) => later.from > from);
    out.push({ trigger, from, to: next ? next.from : from + LAST_CELL_SPAN_MS });
  });
  return out;
}

/**
 * The element focus should land on for `eventId`: its chip when drawn; otherwise the overflow
 * trigger of a rendered day the occurrence covers (the adjusted edge's day when `span.edge` says
 * which, else the first covered day). Null when none resolves.
 */
export function resolveEventFocusTarget(root: ParentNode, eventId: string, span: EventFocusSpan): HTMLElement | null {
  const chip = chipFor(root, eventId);
  if (chip) return chip;
  const start = ms(span.start);
  const end = ms(span.end);
  const covered = overflowDays(root).filter((day) => day.from < end && day.to > start);
  if (covered.length === 0) return null;
  return (span.edge === "end" ? covered[covered.length - 1] : covered[0])!.trigger;
}

/** Focus the resolved target without scrolling. True when something was focused. */
export function focusEventOrOverflow(root: ParentNode, eventId: string, span: EventFocusSpan): boolean {
  const target = resolveEventFocusTarget(root, eventId, span);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}
