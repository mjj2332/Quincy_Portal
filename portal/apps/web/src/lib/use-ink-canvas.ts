import { useLayoutEffect } from "react";

/** On `<html>` while a phone review screen is open: app.css paints html and body with the review surface's ink (#879 fix r11). */
export const INK_CANVAS_ATTR = "data-ink-canvas";

/**
 * While `on` (a phone review screen is open: the staff viewer, the guest's video screen, #879 PR 2), the document's canvas is ink: iOS shows it below the screen while it scrolls
 * the document back as the keyboard drops, and a cream band there read as a flash. Set in a layout effect, so it is on before the first paint, and removed when `on` turns off or
 * the screen unmounts.
 */
export function useInkCanvas(on: boolean): void {
  useLayoutEffect(() => {
    if (!on) return undefined;
    const html = document.documentElement;
    html.setAttribute(INK_CANVAS_ATTR, "");
    return () => { html.removeAttribute(INK_CANVAS_ATTR); };
  }, [on]);
}
