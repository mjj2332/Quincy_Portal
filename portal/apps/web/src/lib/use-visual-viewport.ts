import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type VisualViewportBox = { height: number; offsetTop: number };

/** How far the visual viewport must have shrunk below the layout viewport before its growing back counts as the software keyboard going away. */
export const KEYBOARD_MIN_PX = 150;
/** How long the box keeps following the visual viewport after compose mode ends, while the keyboard animates away. */
const SETTLE_MS = 1000;

/**
 * The visual viewport's height and offset (#879, D10): what is left above the on-screen keyboard. `enabled` is the phone compose mode; off (or with no `visualViewport`, as in a
 * desktop test), the returned box is `null`. The viewer's root takes `height` and shifts by `offsetTop` (once: nothing else adds a keyboard inset), so the film stays above the
 * keyboard and the compose strip, the root's last child, ends on the keyboard's top edge.
 *
 * - `root` and `track` (#879 fix r5): the hook alone writes the root's `height`, `transform` and `transition`, inside the viewport's own events, for as long as `track` is on
 *   (the phone viewer is open; it defaults to `enabled`). Compose mode decides what the strip shows, never whether the root follows the viewport. The caller renders no style of
 *   its own for these three.
 * - What iOS does on focus (#879 fix r8, measured on the iPhone 18 Pro Simulator, iOS 27.0 runtime): about 120-190ms after the tap it scrolls the document by the keyboard height (scrollY, the html's
 *   scrollTop and the viewport's `offsetTop` all 330), carrying the fixed viewer up with it; a `preventScroll` focus does not stop it on this runtime. The write here lands in
 *   that same task and puts the root back (`translateY(offsetTop)`), which is fine as long as nothing animates it.
 * - `transition: none` (#879 fix r8): set with every write and cleared on release, so no caller can animate these writes. The phone viewer's popup carried reui DialogContent's
 *   `duration-100` with transition-property left at `all`, so each write eased over 100ms and the viewer slid in from 330px off its place: that was the first-focus flash.
 * - Leaving compose mode keeps the box while the keyboard animates away (until it is back to the layout height, a second at most), then puts back the page scroll iOS can leave
 *   panned, and only then drops the box.
 * - A pinch zoom (`scale > 1`) is not the keyboard: the last box is kept.
 * - `onKeyboardGone`: the software keyboard went away while compose mode is still on (the viewport shrank by 150px or more, then grew back to the layout height). Some iOS
 *   paths dismiss the keyboard without blurring the field; the caller blurs it. Never called with a hardware keyboard, which never shrinks the viewport.
 */
export function useVisualViewport(enabled: boolean, onKeyboardGone?: () => void, root?: HTMLElement | null, track: boolean = enabled): VisualViewportBox | null {
  const [box, setBox] = useState<VisualViewportBox | null>(null);
  const goneRef = useRef(onKeyboardGone);
  goneRef.current = onKeyboardGone;
  // The root follows the visual viewport for as long as it is tracked, written inside the viewport's events (a frame behind iOS's own pan at best, see above), never through a render.
  useLayoutEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!track || !viewport || !root) return undefined;
    const element = root;
    const write = () => {
      if (viewport.scale > 1.01) return;
      // No transition on these writes: an inherited `duration-*` (reui DialogContent's `duration-100`, with transition-property left at `all`) eased each one over 100ms,
      // which was the phone viewer's first-focus flash (#879 fix r8).
      element.style.transition = "none";
      element.style.height = `${viewport.height}px`; element.style.transform = `translateY(${viewport.offsetTop}px)`;
    };
    write();
    viewport.addEventListener("resize", write);
    viewport.addEventListener("scroll", write);
    // iOS may also scroll the page itself to bring the field into view; that moves the visual viewport too, so it is read in the same task.
    window.addEventListener("scroll", write, { passive: true });
    return () => {
      viewport.removeEventListener("resize", write);
      viewport.removeEventListener("scroll", write);
      window.removeEventListener("scroll", write);
      element.style.height = ""; element.style.transform = ""; element.style.transition = "";
    };
    // The root is a dependency, not a ref: a dialog popup mounts a commit after its host, and the box must land on it the moment it exists.
  }, [track, root]);
  // Whether the box is still following after compose mode ended (the keyboard is on its way down).
  const settling = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!enabled || !viewport) return undefined;
    settling.current?.();
    const scrollY = window.scrollY;
    let shrunk = false;
    const read = () => {
      if (viewport.scale > 1.01) return;
      setBox((held) => (held && held.height === viewport.height && held.offsetTop === viewport.offsetTop ? held : { height: viewport.height, offsetTop: viewport.offsetTop }));
    };
    const onResize = () => {
      read();
      if (viewport.scale > 1.01) return;
      const layout = window.innerHeight;
      if (layout - viewport.height >= KEYBOARD_MIN_PX) shrunk = true;
      else if (shrunk && layout - viewport.height <= 1) { shrunk = false; goneRef.current?.(); }
    };
    read();
    if (window.innerHeight - viewport.height >= KEYBOARD_MIN_PX) shrunk = true;
    viewport.addEventListener("resize", onResize);
    viewport.addEventListener("scroll", read);
    return () => {
      viewport.removeEventListener("resize", onResize);
      viewport.removeEventListener("scroll", read);
      // Keep following while the keyboard goes down; then put back any pan iOS left behind, and only then drop the box (the other way round shows a frame of the panned page).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        viewport.removeEventListener("resize", follow);
        viewport.removeEventListener("scroll", follow);
        clearTimeout(timer);
        settling.current = null;
        if (viewport.offsetTop !== 0 || window.scrollY !== scrollY) window.scrollTo(0, scrollY);
        setBox(null);
      };
      const follow = () => { if (window.innerHeight - viewport.height <= 1) finish(); else read(); };
      if (window.innerHeight - viewport.height <= 1) { finish(); return; }
      timer = setTimeout(finish, SETTLE_MS);
      settling.current = () => { viewport.removeEventListener("resize", follow); viewport.removeEventListener("scroll", follow); clearTimeout(timer); settling.current = null; };
      viewport.addEventListener("resize", follow);
      viewport.addEventListener("scroll", follow);
    };
  }, [enabled]);
  useEffect(() => () => { settling.current?.(); }, []);
  return box;
}

/** The gap kept above and below a fitted box (`--space-2`); the box's class carries it as `scroll-margin-bottom` too. */
const FIT_MARGIN_PX = 8;
/** The fitted text never drops below two of its 24px lines (`--space-5`), however little room the keyboard leaves. */
const FIT_MIN_PX = 48;

/**
 * Keeps a box that grows with its text (the Notice board's tall note box, owner decision N1) inside the visual viewport (review of #951). `60dvh` alone does not see
 * the on-screen keyboard (iOS shrinks the visual viewport, never the `dvh` unit), so a tall notice pushed Send under it.
 *
 * What Safari does, measured on the iPhone 18 Pro Simulator (iOS 27 runtime, #951 keyboard pass 2), and what each part of this answers:
 * - It clamps the page scroll to the document's height less `innerHeight`, and `innerHeight` does not shrink with the keyboard. The box sits near the page's
 *   foot, so the page could not scroll far enough to lift it above the keyboard (asked for 302px, it moved 69), and stayed with a gap or the box's top off screen.
 *   While the focus is in the box and the keyboard is up, the body gets that much room at its foot (padding under the keyboard, never seen), given back when the
 *   focus leaves.
 * - `innerHeight` is no measure of the keyboard (one settle read 519 against a 384px visual viewport), and `visualViewport.offsetTop` did not match where the rects
 *   were measured from (182 to 388 while they read from the top of the screen). So the keyboard is read as the visual viewport's drop from its height with the focus
 *   out of the box, and the box is placed with `scrollIntoView`, which WebKit aligns to what is visible, less the box's `scroll-margin-bottom`.
 *
 * - The text region's `--note-box-fit` follows the visual viewport: its height, less the box's own rows and padding around the text (measured, so a preview card or the
 *   media strip counts), less a margin above and below. The region's class caps it at `min(60dvh, var(--note-box-fit))`.
 * - With the keyboard up, each viewport resize re-caps the text, brings the caret back into sight inside the text's own scroller (shrinking it keeps its scrollTop,
 *   which hid the caret's line), then sets the box's foot a margin above the keyboard. iOS scrolls again 120-190ms after the tap (see `useVisualViewport`): for
 *   `FIT_SETTLE_MS` after the last resize a page or viewport scroll does the same again. After that a scroll is the person's own pan, and is left alone.
 * - The box growing with the text, with the focus in it, only scrolls as far as its foot needs to be seen; this keeps Send above a hardware keyboard's bar too.
 *
 * Unlike `useVisualViewport` it writes no root and puts back no page scroll: the box sits in an ordinary scrolling page, not a fixed screen.
 */
export function useFitAboveKeyboard(enabled: boolean, box: HTMLElement | null, text: HTMLElement | null) {
  useLayoutEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!enabled || !viewport || !box || !text) return undefined;
    const zoomed = () => viewport.scale > 1.01;
    const focused = () => box.contains(document.activeElement);
    // The visual viewport's height with the focus out of the box: what the screen shows with no keyboard for this box.
    let open = viewport.height;
    const keyboardUp = () => !zoomed() && focused() && open - viewport.height >= KEYBOARD_MIN_PX;
    const page = document.body;
    const padding = page.style.paddingBottom;
    let room = 0;
    /** Room at the page's foot for as long as the keyboard is up, so the page can scroll the box above it; given back, as the page had it, after. */
    const makeRoom = () => {
      const want = keyboardUp() ? Math.round(open - viewport.height) : 0;
      if (want === room) return;
      room = want;
      page.style.paddingBottom = want ? `${want}px` : padding;
    };
    const fit = () => {
      if (zoomed()) return;
      const rows = box.getBoundingClientRect().height - text.getBoundingClientRect().height;
      text.style.setProperty("--note-box-fit", `${Math.max(FIT_MIN_PX, Math.round(viewport.height - rows - 2 * FIT_MARGIN_PX))}px`);
    };
    const keepCaret = () => {
      const caret = caretRect(text);
      if (!caret) return;
      const region = text.getBoundingClientRect();
      if (caret.bottom > region.bottom) text.scrollTop += caret.bottom - region.bottom;
      else if (caret.top < region.top) text.scrollTop -= region.top - caret.top;
    };
    const place = (block: "end" | "nearest") => { box.scrollIntoView?.({ block, inline: "nearest" }); };
    let settling: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      if (!zoomed() && !focused()) open = viewport.height;
      makeRoom();
      fit();
      if (!keyboardUp()) return;
      keepCaret(); place("end");
      clearTimeout(settling);
      settling = setTimeout(() => { settling = undefined; }, FIT_SETTLE_MS);
    };
    const onScroll = () => { if (settling !== undefined && keyboardUp()) { keepCaret(); place("end"); } };
    const onGrow = () => { if (!zoomed() && focused()) place("nearest"); };
    const onFocusIn = () => { if (room === 0 && !zoomed() && viewport.height > open) open = viewport.height; };
    // Focus moving between the field and Send stays in the box: the room is looked at once the focus has landed.
    let leaving = 0;
    const onFocusOut = () => { cancelAnimationFrame(leaving); leaving = requestAnimationFrame(makeRoom); };
    fit();
    box.addEventListener("focusin", onFocusIn);
    box.addEventListener("focusout", onFocusOut);
    viewport.addEventListener("resize", onResize);
    viewport.addEventListener("scroll", onScroll);
    window.addEventListener("scroll", onScroll, { passive: true });
    const grows = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onGrow);
    grows?.observe(box);
    return () => {
      box.removeEventListener("focusin", onFocusIn);
      box.removeEventListener("focusout", onFocusOut);
      viewport.removeEventListener("resize", onResize);
      viewport.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(leaving);
      clearTimeout(settling);
      grows?.disconnect();
      if (room) page.style.paddingBottom = padding;
      text.style.removeProperty("--note-box-fit");
    };
  }, [enabled, box, text]);
}

/** How long after the keyboard's last resize a scroll still counts as iOS's own (it lands 120-190ms after the tap), not the person's pan. */
const FIT_SETTLE_MS = 400;

/** The caret's rect when the selection is in `region`; a collapsed range on an empty line can measure as nothing, so its line's element stands in. */
function caretRect(region: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const node = range.endContainer;
  if (!region.contains(node)) return null;
  const rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
  if (rect && (rect.height > 0 || rect.top !== 0)) return rect;
  const line = node instanceof Element ? node : node.parentElement;
  return line ? line.getBoundingClientRect() : null;
}
