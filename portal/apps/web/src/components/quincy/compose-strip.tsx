import { useLayoutEffect, useState, type RefCallback } from "react";
import { fitAtWord } from "../../lib/fit-at-word";
import { SHEET_TEXT_ATTR } from "./ReviewSheet";

/**
 * What is left of the phone compose strip (#879) once the note composer box replaced it (#927): the + tray, the pill's + and Send, and the strip's grid went with it. These pieces
 * are shared by the staff and guest screens; nothing in this file may reach a staff store or `lib/api` (`guest-boundary.guard.test.ts` follows imports).
 */

/** Marks the box's text region for the review sheet's film floor (#879 fix r9). */
export const SHEET_TEXT = { [SHEET_TEXT_ATTR]: "" } as const;
/** A text control on the phone screen (kit.jsx `ibtn sm`): drawn 32px tall, with a 44px hit area from a transparent pseudo-element. */
export const STRIP_TEXT_BUTTON = "relative min-h-8 px-[var(--space-2)] after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']";

/** The field a pill host holds: the rich field's root (its placeholder is `data-placeholder`), or a native field. */
const PLACEHOLDER_FIELD = "[data-placeholder], [placeholder]";
let measureCanvas: HTMLCanvasElement | null = null;
const px = (value: string) => { const n = parseFloat(value); return Number.isFinite(n) ? n : 0; };

/** `full` as it fits the field's text room (its width less its inline padding) in its computed font, or `full` when there is nothing to measure yet. */
function fitPlaceholder(host: HTMLElement, full: string): string {
  const field = host.querySelector<HTMLElement>(PLACEHOLDER_FIELD);
  if (!field) return full;
  const style = getComputedStyle(field);
  const room = field.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
  if (!(room > 0)) return full;
  measureCanvas ??= document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (!context) return full;
  context.font = style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return fitAtWord(full, (candidate) => context.measureText(candidate).width <= room);
}

/**
 * The pill's rest placeholder (#879 PR 3a): one line that ends at a word with one "…" (`fitAtWord`), where the CSS ellipsis cut P7's "Add a note with this drawing…" mid-word.
 * `ref` goes on the element holding the field; the text is refitted when that element resizes, when the field arrives (the editor's chunk loads late) and when the fonts are in.
 * Compose mode (`atRest` false) keeps `full`, as does a typed draft's line, which the CSS ellipsis still clips (the placeholder does not show then).
 */
export function useRestPlaceholder(full: string, atRest: boolean): { ref: RefCallback<HTMLElement>; text: string } {
  const [host, setHost] = useState<HTMLElement | null>(null);
  // Kept with the text it was fitted from, so a new `full` never shows an old fit for a frame.
  const [fitted, setFitted] = useState({ full, text: full });
  useLayoutEffect(() => {
    if (!atRest || !host) return undefined;
    const update = () => { const text = fitPlaceholder(host, full); setFitted((held) => (held.full === full && held.text === text ? held : { full, text })); };
    update();
    let live = true;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resize?.observe(host);
    // The field mounts inside the host after it (a lazy chunk): its arrival is a child-list change, not a resize, because the shell it replaces has the same size.
    const arrival = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    arrival?.observe(host, { childList: true, subtree: true });
    void document.fonts?.ready.then(() => { if (live) update(); });
    return () => { live = false; resize?.disconnect(); arrival?.disconnect(); };
  }, [host, full, atRest]);
  return { ref: setHost, text: atRest && fitted.full === full ? fitted.text : full };
}
