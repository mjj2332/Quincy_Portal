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
 * - `root` and `track` (#879 fix r5): the hook alone writes the root's `height` and `transform`, inside the viewport's own events, for as long as `track` is on (the phone viewer
 *   is open; it defaults to `enabled`). Compose mode decides what the strip shows, never whether the root follows the viewport: iOS starts its scroll-into-view and keyboard pan
 *   synchronously on focus, before React has turned compose mode on, so a listener that waited for compose mode missed the first rise and the viewer flashed off screen once.
 *   (Base UI's scroll lock is `overflow: hidden` only on iOS, which iOS ignores when it brings a focused field into view.) The caller renders no style of its own for these two.
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
  // The root follows the visual viewport for as long as it is tracked, written inside the viewport's events (the same frame as iOS's pan), never through a render.
  useLayoutEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!track || !viewport || !root) return undefined;
    const element = root;
    const write = () => {
      if (viewport.scale > 1.01) return;
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
      element.style.height = ""; element.style.transform = "";
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
