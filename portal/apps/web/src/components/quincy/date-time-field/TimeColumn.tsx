import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { RING_IN } from "@/components/AnchoredPopover";
import { Button } from "@/components/reui/button";
import { ScrollArea } from "@/components/reui/scroll-area";
import { cn } from "@/lib/utils";
import { measureFade, POPUP_STACKED_QUERY, scrollTopClearOfFade, timeSlots } from "@/lib/date-time-field";
import { useMediaQuery } from "@/lib/use-media-query";

const SLOTS = timeSlots();
const slotIndex = (el: EventTarget | null) => {
  const index = Number((el as HTMLElement | null)?.closest<HTMLElement>("[data-index]")?.dataset.index);
  return Number.isInteger(index) ? index : -1;
};

/**
 * schedule-10's time column: one `reui/button` per 15-minute slot in a `reui/scroll-area`, the
 * selected one pressed. The column is scrolled to the selection by writing the viewport's
 * `scrollTop`, never `scrollIntoView`, which would also scroll the page behind the popup
 * (docs/lessons.md, "Gantt landing row"). A slot inside a daylight-saving gap is disabled and says
 * so, since that wall-clock time does not exist on the chosen day. Below 721px the slots wrap as a
 * four-column grid in a short (`h-36`) window of their own; from 721px up it is a single column in
 * a taller one (`min-[721px]:h-72`). #422 had dropped the column's own scroll below 721px so the popup body
 * scrolled once; #447 restores it, because the body's window was ~165px on a phone and the reminders
 * below it were unreachable.
 *
 * The list is ONE roving Tab stop (#660, after `quincy/PriorityStars.tsx`), not 96: the pressed slot, else the next
 * enabled slot at or after the time (17:07 gives 17:15), else the first enabled slot; it resets to that when focus leaves.
 * Arrows move focus only (Enter/Space on the native button picks): Up/Down by the column count (4 when stacked, from
 * `POPUP_STACKED_QUERY`, else 1), Left/Right by 1, Home/End to the ends, clamped, skipping disabled slots. The column's own
 * viewport is `tabIndex -1`, so Base UI's overflow stop never doubles it. Slots ring inward (`RING_IN`): the viewport is
 * masked, and a mask clips an outline drawn outside it.
 */
export function TimeColumn({ selected, skipped, onPick }: {
  /** The picked time (`HH:mm`), highlighted only when it is on the 15-minute grid. */
  selected: string | null;
  /** Slots that do not exist on the chosen Sydney day. */
  skipped: ReadonlySet<string>;
  onPick: (time: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const stacked = useMediaQuery(POPUP_STACKED_QUERY);
  // The roving position while focus is inside the list; null means "the default stop".
  const [roving, setRoving] = useState<number | null>(null);

  const enabled = useCallback((index: number) => !skipped.has(SLOTS[index]!), [skipped]);

  // The default stop: the pressed slot; else the next enabled slot at or after `selected`; else (a time after the last
  // enabled slot, e.g. 23:50) the first enabled slot; else -1, no stop at all, when every slot is disabled.
  const defaultStop = useMemo(() => {
    const pressed = selected === null ? -1 : SLOTS.indexOf(selected);
    if (pressed >= 0 && enabled(pressed)) return pressed;
    const from = selected === null ? 0 : SLOTS.findIndex((slot) => slot >= selected);
    for (let index = Math.max(from, 0); index < SLOTS.length; index++) if (enabled(index)) return index;
    return SLOTS.findIndex((_, index) => enabled(index));
  }, [selected, enabled]);
  const stop = roving ?? defaultStop;

  // Keep the focused slot inside the column viewport and clear of the stacked fade. The popup body's own `focusin`
  // handler (PopupFrame) brings the column into view in the body.
  const reveal = useCallback((slotEl: HTMLElement) => {
    const viewport = listRef.current?.parentElement;
    if (!viewport) return;
    const fade = stacked ? measureFade(viewport) : 0;
    const { top, bottom } = slotEl.getBoundingClientRect();
    // The pressed slot is not required to be clear, but must not end up partly under a fade (#662): `noSliver`, no `snaps`.
    const pressed = listRef.current?.querySelector<HTMLElement>('button[aria-pressed="true"]')?.getBoundingClientRect();
    viewport.scrollTop = scrollTopClearOfFade({ viewport: viewport.getBoundingClientRect(), scrollTop: viewport.scrollTop, maxScrollTop: viewport.scrollHeight - viewport.clientHeight, fade, items: [{ top, bottom, required: true, priority: true }], noSliver: pressed ? [{ top: pressed.top, bottom: pressed.bottom }] : undefined });
  }, [stacked]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = slotIndex(event.target);
    if (current < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    const columns = stacked ? 4 : 1;
    const step = ({ ArrowDown: columns, ArrowUp: -columns, ArrowRight: 1, ArrowLeft: -1 } as Record<string, number | undefined>)[event.key];
    let target = -1;
    if (event.key === "Home") target = SLOTS.findIndex((_, index) => enabled(index));
    else if (event.key === "End") { for (let index = SLOTS.length - 1; index >= 0 && target < 0; index--) if (enabled(index)) target = index; }
    else if (step !== undefined) {
      // Clamp at the ends (no wrap), and step over a disabled slot in the same direction.
      for (let index = current + step; index >= 0 && index < SLOTS.length; index += step) if (enabled(index)) { target = index; break; }
      if (target < 0) target = current;
    } else return;
    event.preventDefault();
    if (target < 0) return;
    const el = listRef.current?.querySelectorAll<HTMLElement>("button")[target];
    if (!el) return;
    setRoving(target);
    // Reveal first, then focus: PopupFrame's `focusin` handler solves against the slot's position when focus lands, so the
    // column must already be at its final scroll (#662). preventScroll: the column is scrolled by writing scrollTop (never scrollIntoView).
    reveal(el);
    el.focus({ preventScroll: true });
  };

  // A click (or any other focus) moves the stop to the slot that took focus, so Shift+Tab leaves the list from there.
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const index = slotIndex(event.target);
    if (index >= 0) setRoving(index);
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRoving(null);
  };

  // The slot a pick (pointer or Enter) just chose; the next centre for exactly that selection is skipped, because the slot
  // is already where the user put it (#662). Null when the picked slot was already pressed (no selection change follows).
  const pickedRef = useRef<string | null>(null);

  const centre = useCallback(() => {
    const list = listRef.current;
    // An off-grid time (17:07) presses nothing, so centre its tab stop (17:15). No time at all (a cleared field, or a
    // typed prefix that does not parse yet) leaves the column where it is rather than jumping to 00:00 and back.
    const pressed = list?.querySelector<HTMLElement>('button[aria-pressed="true"]') ?? (selected === null ? null : list?.querySelector<HTMLElement>('button[tabindex="0"]'));
    const viewport = list?.parentElement;
    if (!pressed || !viewport) return;
    const offset = pressed.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    viewport.scrollTop = Math.max(0, offset - viewport.clientHeight / 2 + pressed.offsetHeight / 2);
  }, [selected]);

  useLayoutEffect(() => {
    const skip = pickedRef.current !== null && pickedRef.current === selected;
    pickedRef.current = null;
    if (!skip) centre();
  }, [centre, selected]);

  // Crossing 721px swaps the four-column h-36 grid for the single h-72 column; the selection has not
  // changed, so re-centre when the viewport's size does.
  useEffect(() => {
    const viewport = listRef.current?.parentElement;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(centre);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [centre]);

  return (
    <ScrollArea className="h-36 w-full [--fade-size:var(--space-5)] min-[721px]:h-72 min-[721px]:w-28 min-[721px]:shrink-0 max-[721px]:*:data-[slot=scroll-area-scrollbar]:hidden max-[721px]:*:data-[slot=scroll-area-viewport]:mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] max-[721px]:*:data-[slot=scroll-area-viewport]:mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))]" viewportProps={{ tabIndex: -1 }}>
      <div ref={listRef} role="group" aria-label="Time slots" onKeyDown={onKeyDown} onFocus={onFocus} onBlur={onBlur} className="grid grid-cols-4 gap-[var(--space-1)] min-[721px]:flex min-[721px]:flex-col pr-[var(--space-3)]">
        {SLOTS.map((slot, index) => {
          const isSkipped = skipped.has(slot);
          const isSelected = selected === slot;
          return (
            <Button
              key={slot}
              type="button"
              size="sm"
              variant={isSelected ? "default" : "ghost"}
              data-index={index}
              tabIndex={index === stop ? 0 : -1}
              className={cn("w-full justify-center pointer-coarse:min-h-[44px] max-[721px]:min-h-[44px]", RING_IN, "aria-pressed:outline-offset-[-4px] aria-pressed:focus-visible:!outline-[var(--primary-foreground)] aria-pressed:focus-visible:!outline-offset-[-4px]")}
              aria-pressed={isSelected}
              disabled={isSkipped}
              onClick={() => { pickedRef.current = isSelected ? null : slot; onPick(slot); }}
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
