import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefCallback } from "react";
import { Plus, Send } from "lucide-react";
import { cn } from "../../lib/utils";
import { fitAtWord } from "../../lib/fit-at-word";
import { SCROLL_FADE_MASK_CLASSES, useScrollFade } from "../../lib/use-scroll-fade";
import { SHEET_TEXT_ATTR } from "./ReviewSheet";
import { PILL_ICON } from "./VideoPlayer";
import { SELECTED_HAIRLINE_PRESSED } from "./markup-toolbar";
import { Button as ReuiButton } from "../reui/button";
import { Collapsible, CollapsibleContent } from "../reui/collapsible";
import { RichTextToolbarSeparator } from "../reui/rich-text-editor/rich-text-toolbar";
import { Spinner } from "../reui/spinner";

/**
 * The phone compose strip's staff-free pieces (#879, the prototype's P6 / P7 `Composer`), shared by the staff composer (`video/VideoNoteComposer.tsx`) and the guest's
 * (`guest/GuestNoteComposer.tsx`, #879 PR 2). They moved here unchanged from the staff composer, so the staff strip renders as before; nothing in this file may reach a staff
 * store or `lib/api` (`guest-boundary.guard.test.ts` follows imports). The strip is a four-row grid: the line above the pill (hint, lock or problem), the + tray, the pill with
 * Send beside it, and Cancel.
 */

/** The strip's grid: the line, the tray, the pill and Send, Cancel. At rest (`data-compose="false"`) it has no row gap (#879 PR 3a round 2): the four tracks are explicit, so the
 * gaps between the empty ones (no hint, the closed tray, no Cancel) still rendered, 16px above the pill and 8px below it, an 85pt band where P1's is 61. The rows that can show at
 * rest (a problem line, the tray opened from rest) carry their own space below instead (`REST_ROW_SPACE`); compose mode keeps its gap, unchanged. */
export const STRIP_GRID = "@container grid min-h-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto_auto_auto] gap-x-[var(--space-2)] gap-y-[var(--space-2)] data-[compose=false]:gap-y-0 in-data-[immersive=compose]:grid-rows-[auto_auto_auto]";
/** A rest row's space before the pill, in place of the row gap the rest grid drops. */
const REST_ROW_SPACE = "in-data-[compose=false]:pb-[var(--space-2)]";
/** Marks the pill's text box for the review sheet's film floor (#879 fix r9). */
export const SHEET_TEXT = { [SHEET_TEXT_ATTR]: "" } as const;
/** The phone pill's text box (C4): one line at rest (the draft clamped to its first line), up to four while writing, then it scrolls. Line 24px + the box's 8px padding top and bottom.
 * The padding is on the box and the scroll on its child (the editor's scroller, `[&>*]`), so scrolled text clips inside the padding, never at the pill's hairline (#879 fix r9). */
/** At rest the draft is one unwrapped line that ends in an ellipsis at the field's edge, as the prototype's single-line `.composer-input input` clips (#879 fix r11):
 * cut at a word break with no ellipsis, a long draft read as the whole note. `pre` rather than `nowrap`, so the draft's spaces stay as typed. The empty field's placeholder (the editor root's
 * `::before`, `data-placeholder`) is clipped the same way (PR 2 fix round 1: P7's "Add a note with this drawing…" wrapped and was cut at a word). app.css draws it as a zero-height
 * float, and a zero-height box with `overflow: hidden` clips all of it (round 2: no placeholder at all on the iPhone), so here it is a one-line box of its own: absolute at its static
 * top (the first line's, so the caret's line does not move), across the content box (the root's inline padding inherited), its height freed (`!`: app.css's `:has()` rule outranks a utility). */
export const REST_CLAMP = "max-h-[calc(var(--space-6)+var(--space-2))] overflow-hidden [&>*]:overflow-hidden [&_p]:overflow-hidden [&_p]:text-ellipsis [&_p]:whitespace-pre [&_[data-placeholder]]:relative [&_[data-placeholder]]:before:absolute [&_[data-placeholder]]:before:inset-x-0 [&_[data-placeholder]]:before:[padding-inline:inherit] [&_[data-placeholder]]:before:h-auto! [&_[data-placeholder]]:before:overflow-hidden [&_[data-placeholder]]:before:text-ellipsis [&_[data-placeholder]]:before:whitespace-nowrap";
/** In the review sheet the four lines give way to the film's floor first (#879 fix r9): the sheet publishes `--sheet-text-room` (`useSheetTextRoom`), clamped here to one line at least.
 * The room is rounded down to whole 24px lines (`--space-5`) inside the box's 16px of padding (#879 fix r10), so the window never shows a sliver of a line. */
export const COMPOSE_CLAMP = "max-h-[clamp(calc(var(--space-6)+var(--space-2)),calc(round(down,calc(var(--sheet-text-room,calc(var(--space-9)+var(--space-4)))-var(--space-4)),var(--space-5))+var(--space-4)),calc(var(--space-9)+var(--space-4)))] [&>*]:overflow-y-auto";
/** The phone line under the film (hint, lock, problem): one meta line, two at most, at P6's 12px. */
export const PHONE_LINE = "col-span-2 row-start-1 in-data-[compose=false]:pb-[var(--space-2)] [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)]";
/** Cancel's row: its own under the pill (P6). */
export const STRIP_CANCEL_ROW = "col-span-2 row-start-4 flex justify-end";
/** The floating strip's head (F1, #880 review 6): the hint line and Cancel in one flex row spanning both columns. F1 floats a compact composer over the film, and a row holding
 * Cancel alone left ~60pt of empty card under the pill; Cancel in grid column 2 instead widened that column to its own width, shrinking the pill and pushing Send in from the edge.
 * The grid drops its fourth track there, so no empty row keeps its gap. */
export const STRIP_HEAD_ROW = "col-span-2 row-start-1 flex items-start gap-x-[var(--space-2)]";
/** The line inside the head row: it takes the width Cancel leaves. */
export const STRIP_HEAD_LINE = "min-w-0 flex-1";
/** The pill's timecode chip (quincy.css `.tc-chip`): small mono, so the text keeps the pill's width (#879 fix). */
// The `.tc-chip` amber tint on the caution token: on the viewer's inverse surface `--warning-foreground` is `--signal-caution-on-inverse` (star-amber), elsewhere the caution text ochre.
export const PILL_CHIP = "shrink-0 whitespace-nowrap rounded-md bg-[color-mix(in_oklch,var(--warning-foreground)_18%,transparent)] px-[var(--space-2)] py-[var(--space-1)] text-warning-foreground [font:var(--weight-regular)_var(--text-xs)/1_var(--font-mono)] tabular-nums";
/** A text control in the phone strip (Cancel, kit.jsx `ibtn sm`): drawn 32px tall, with a 44px hit area from a transparent pseudo-element. */
export const STRIP_TEXT_BUTTON = "relative min-h-8 px-[var(--space-2)] after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']";
/** The pill's shell (#879 PR 2, the guest strip): the editor's pill group (`QuincyRichTextEditorBase` `PILL_GROUP`, on `InputGroup variant="pill"`) without the editor, at its
 * size, for while the editor's chunk loads and for a guest who has not verified. Keep it in step with `PILL_GROUP`. */
export const PILL_SHELL = "h-auto flex-row items-end bg-surface-sunken border-transparent hover:border-transparent";
/** The shell's placeholder line: the editor's text box as the pill draws it (16px on one 24px line, the field's side padding) and its placeholder colour. */
export const PILL_SHELL_TEXT = "block w-full min-w-0 truncate px-[var(--space-3)] text-base text-foreground-secondary";
/** Keeps the focus where it is: a press on these controls must not take it from the field, or iOS drops the keyboard (#879 fix, §3.4). */
export const keepFocus = (event: { preventDefault: () => void }) => { event.preventDefault(); };

/** A range the pill can hold (C6): the out point drops the hours the in point already shows. */
export function shortRange(from: string, to: string): string {
  const same = /^\d{2}:\d{2}:/.test(from) && /^\d{2}:\d{2}:/.test(to) && from.slice(0, 3) === to.slice(0, 3);
  return `${from} – ${same ? to.slice(3) : to}`;
}

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

/** The pill's + (Note options): opens the tray. A press never takes the focus from the field. */
export function PillPlus({ testId, open, controls, disabled, onToggle }: { testId: string; open: boolean; controls: string; disabled: boolean; onToggle: () => void }) {
  return <ReuiButton
    type="button" variant="ghost" size="icon" data-testid={testId} aria-label="Note options" aria-expanded={open} aria-pressed={open} aria-controls={controls}
    disabled={disabled} className={cn("aria-pressed:bg-secondary", SELECTED_HAIRLINE_PRESSED, PILL_ICON)}
    onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={onToggle}
  ><Plus aria-hidden="true" /></ReuiButton>;
}

/** The round Send (C5), icon-only; its phase is a spinner and its name. A press never takes the focus, so the keyboard stays and nothing jumps before the post. */
export function PillSend({ testId, label, disabled, pending }: { testId: string; label: string; disabled: boolean; pending: boolean }) {
  return <ReuiButton type="submit" size="icon-round" data-testid={testId} aria-label={label} disabled={disabled} onPointerDown={keepFocus} onMouseDown={keepFocus} className="col-start-2 row-start-3 self-end">
    {pending ? <Spinner aria-hidden="true" /> : <Send aria-hidden="true" />}
  </ReuiButton>;
}

/**
 * The + tray (Q1, C1), inline above the pill and inside the strip, so it is always above the keyboard. Mounted for the whole phone layout (the toolbar's portal target stays put).
 * One row (#879 fix r3): the host's controls, the toolbar's separator, then the formatting toolbar portalled into `toolbarRef`, scrolling sideways rather than wrapping, so all of
 * it is reachable above the keyboard. The row takes its full height (the scroller is the outer node, the row inside it carries a pixel of room for the borders), and a fade at the
 * edge says there is more. `testId` names the region; its scroller, row and toolbar target are `-scroller`, `-row` and `-toolbar`.
 */
export function ComposeTray({ open, id, testId, toolbarRef, children }: { open: boolean; id: string; testId: string; toolbarRef: (element: HTMLDivElement | null) => void; children: ReactNode }) {
  const trayRef = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const { fade, onScroll } = useScrollFade(scroller);
  // The tray's controls (and the toolbar portalled into it, whose React parent is elsewhere) keep the focus in the field: a native listener sees them all. A popup trigger (heading, link) opens its popup as usual.
  useEffect(() => {
    const tray = trayRef.current;
    if (!tray) return undefined;
    const keep = (event: Event) => { if (!(event.target instanceof Element && event.target.closest("[aria-haspopup]"))) event.preventDefault(); };
    tray.addEventListener("pointerdown", keep);
    tray.addEventListener("mousedown", keep);
    return () => { tray.removeEventListener("pointerdown", keep); tray.removeEventListener("mousedown", keep); };
  }, []);
  return <Collapsible open={open} className="col-span-2 row-start-2 min-w-0">
    <CollapsibleContent ref={trayRef} keepMounted id={id} role="region" aria-label="Note options" data-testid={testId} inert={!open} className={cn("min-w-0 [&[hidden]]:hidden", REST_ROW_SPACE)}>
      <div ref={scroller} data-testid={`${testId}-scroller`} data-fade={fade} onScroll={onScroll} className={cn("min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", SCROLL_FADE_MASK_CLASSES)}>
      <div data-testid={`${testId}-row`} className="flex w-max flex-nowrap items-center gap-[var(--space-2)] py-px [&>*]:shrink-0">
        {children}
        <RichTextToolbarSeparator />
        <div ref={toolbarRef} data-testid={`${testId}-toolbar`} />
      </div>
      </div>
    </CollapsibleContent>
  </Collapsible>;
}
