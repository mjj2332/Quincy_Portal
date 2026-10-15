import { useLayoutEffect, type RefObject } from "react";

/**
 * On a phone the line between the notes and the composer is the composer's top border, but the head row it sits under is in the notes list (#879 fix r11).
 * While the keyboard drops the sheet's browse height is re-measured from what is left, so for a few frames the list is squeezed below the head row:
 * the row was cut away while its line stayed. The line goes with the row: it shows only while the middle of the row's text (`text`, the counts) is inside
 * the list's box. Not the whole text box: at rest its line-height overhangs the list's foot by a few px with nothing clipped. And not the row's own
 * box, which is taller than its text (its buttons' 44px hit area) and taller than the list at rest.
 * A ResizeObserver callback runs before the next paint, so the two change in the same frame; the list's scroll moves the text too.
 */
export function useHairlineWithHead(on: boolean, listRef: RefObject<HTMLDivElement | null>, textRef: RefObject<HTMLElement | null>, composerRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const list = listRef.current; const text = textRef.current; const composer = composerRef.current;
    if (!composer) return undefined;
    if (!on || !list || !text) { delete composer.dataset.headCut; return undefined; }
    const update = () => {
      const box = list.getBoundingClientRect(); const row = text.getBoundingClientRect();
      const middle = row.top + row.height / 2;
      const shown = row.height > 0 && middle >= box.top && middle <= box.bottom;
      if (shown) delete composer.dataset.headCut; else composer.dataset.headCut = "true";
    };
    update();
    list.addEventListener("scroll", update, { capture: true, passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(list);
    observer?.observe(text);
    return () => { observer?.disconnect(); list.removeEventListener("scroll", update, { capture: true }); delete composer.dataset.headCut; };
  }, [on, listRef, textRef, composerRef]);
}
