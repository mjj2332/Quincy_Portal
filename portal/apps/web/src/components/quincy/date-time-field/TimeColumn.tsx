import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/reui/button";
import { ScrollArea } from "@/components/reui/scroll-area";
import { timeSlots } from "@/lib/date-time-field";

const SLOTS = timeSlots();

/**
 * schedule-10's time column: one `reui/button` per 15-minute slot in a `reui/scroll-area`, the
 * selected one pressed. The column is scrolled to the selection by writing the viewport's
 * `scrollTop`, never `scrollIntoView`, which would also scroll the page behind the popup
 * (docs/lessons.md, "Gantt landing row"). A slot inside a daylight-saving gap is disabled and says
 * so, since that wall-clock time does not exist on the chosen day. Below `sm` the slots wrap as a
 * four-column grid in a short (`h-36`) window of their own; from `sm` up it is a single column in
 * a taller one (`sm:h-72`). #422 had dropped the column's own scroll below `sm` so the popup body
 * scrolled once; #447 restores it, because the body's window was ~165px on a phone and the reminders
 * below it were unreachable.
 */
export function TimeColumn({ selected, skipped, onPick }: {
  /** The picked time (`HH:mm`), highlighted only when it is on the 15-minute grid. */
  selected: string | null;
  /** Slots that do not exist on the chosen Sydney day. */
  skipped: ReadonlySet<string>;
  onPick: (time: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const centre = useCallback(() => {
    const list = listRef.current;
    const pressed = list?.querySelector<HTMLElement>('button[aria-pressed="true"]');
    const viewport = list?.parentElement;
    if (!pressed || !viewport) return;
    const offset = pressed.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    viewport.scrollTop = Math.max(0, offset - viewport.clientHeight / 2 + pressed.offsetHeight / 2);
  }, []);

  useLayoutEffect(centre, [centre, selected]);

  // Crossing `sm` swaps the four-column h-36 grid for the single h-72 column; the selection has not
  // changed, so re-centre when the viewport's size does.
  useEffect(() => {
    const viewport = listRef.current?.parentElement;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(centre);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [centre]);

  return (
    <ScrollArea className="h-36 w-full [--fade-size:var(--space-8)] sm:h-72 sm:w-28 sm:shrink-0 max-sm:*:data-[slot=scroll-area-scrollbar]:hidden max-sm:*:data-[slot=scroll-area-viewport]:mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] max-sm:*:data-[slot=scroll-area-viewport]:mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))]">
      <div ref={listRef} role="group" aria-label="Time slots" className="grid grid-cols-4 gap-[var(--space-1)] sm:flex sm:flex-col pr-[var(--space-3)]">
        {SLOTS.map((slot) => {
          const isSkipped = skipped.has(slot);
          const isSelected = selected === slot;
          return (
            <Button
              key={slot}
              type="button"
              size="sm"
              variant={isSelected ? "default" : "ghost"}
              className="w-full justify-center"
              aria-pressed={isSelected}
              disabled={isSkipped}
              onClick={() => onPick(slot)}
            >
              {slot}
              {isSkipped && <span className="sr-only"> (skipped, the clocks go forward)</span>}
            </Button>
          );
        })}
      </div>
    </ScrollArea>
  );
}
