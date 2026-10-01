import { useLayoutEffect, useRef } from "react";
import { Button } from "@/components/reui/button";
import { ScrollArea } from "@/components/reui/scroll-area";
import { timeSlots } from "@/lib/date-time-field";

const SLOTS = timeSlots();

/**
 * schedule-10's time column: one `reui/button` per 15-minute slot in a `reui/scroll-area`, the
 * selected one pressed. The column is scrolled to the selection by writing the viewport's
 * `scrollTop`, never `scrollIntoView`, which would also scroll the page behind the popup
 * (docs/lessons.md, "Gantt landing row"). A slot inside a daylight-saving gap is disabled and says
 * so, since that wall-clock time does not exist on the chosen day. Below `sm` the column has no height
 * or scroll of its own: the slots wrap as a grid inside the popup body's single scroll (#422).
 */
export function TimeColumn({ selected, skipped, onPick }: {
  /** The picked time (`HH:mm`), highlighted only when it is on the 15-minute grid. */
  selected: string | null;
  /** Slots that do not exist on the chosen Sydney day. */
  skipped: ReadonlySet<string>;
  onPick: (time: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    const pressed = list?.querySelector<HTMLElement>('button[aria-pressed="true"]');
    const viewport = list?.parentElement;
    if (!pressed || !viewport) return;
    const offset = pressed.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    viewport.scrollTop = Math.max(0, offset - viewport.clientHeight / 2 + pressed.offsetHeight / 2);
  }, [selected]);

  return (
    <ScrollArea className="w-full sm:h-72 sm:w-28 sm:shrink-0">
      <div ref={listRef} role="group" aria-label="Time slots" className="grid grid-cols-4 gap-[var(--space-1)] sm:flex sm:flex-col sm:pr-[var(--space-3)]">
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
