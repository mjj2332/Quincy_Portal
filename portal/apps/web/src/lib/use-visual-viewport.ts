import { useEffect, useRef, useState, type RefObject } from "react";

export type VisualViewportBox = { height: number; offsetTop: number };

/** How far the visual viewport must have shrunk below the layout viewport before its growing back counts as the software keyboard going away. */
export const KEYBOARD_MIN_PX = 150;
/** How long the box keeps following the visual viewport after compose mode ends, while the keyboard animates away. */
const SETTLE_MS = 1000;

/**
 * The visual viewport's height and offset (#879, D10): what is left above the on-screen keyboard. `enabled` is the phone compose mode; off (or with no `visualViewport`, as in a
 * desktop test), it is `null` and the caller keeps its own `100dvh` layout. The viewer's root takes `height` and shifts by `offsetTop` (once: nothing else adds a keyboard inset),
 * so the film stays above the keyboard and the compose strip, the root's last child, ends on the keyboard's top edge.
 *
 * The #879 fix adds three things:
 * - Leaving compose mode keeps following the viewport while the keyboard animates away (until it is back to the layout height, a second at most), then puts back the page
 *   scroll iOS can leave panned after the keyboard closes.
 * - A pinch zoom (`scale > 1`) is not the keyboard: the last box is kept.
 * - `root` (#879 fix r3): the element that takes the box. The hook writes its `height` and `transform` itself, inside the viewport event, so iOS's pan and
 *   the box land in the same frame: through a React render alone they arrive a frame apart and the viewer flashes off screen while the keyboard rises.
 *   The caller still renders the same style from the returned box, so React and the hook never disagree.
 * - `onKeyboardGone`: the software keyboard went away while compose mode is still on (the viewport shrank by 150px or more, then grew back to the layout height). Some iOS
 *   paths dismiss the keyboard without blurring the field; the caller blurs it. Never called with a hardware keyboard, which never shrinks the viewport.
 */
export function useVisualViewport(enabled: boolean, onKeyboardGone?: () => void, root?: RefObject<HTMLElement | null>): VisualViewportBox | null {
  const [box, setBox] = useState<VisualViewportBox | null>(null);
  const goneRef = useRef(onKeyboardGone);
  goneRef.current = onKeyboardGone;
  const rootRef = useRef(root);
  rootRef.current = root;
  // Whether the box is still following after compose mode ended (the keyboard is on its way down).
  const settling = useRef<(() => void) | null>(null);
  useEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!enabled || !viewport) return undefined;
    settling.current?.();
    const scrollY = window.scrollY;
    let shrunk = false;
    const read = () => {
      if (viewport.scale > 1.01) return;
      const element = rootRef.current?.current;
      if (element) { element.style.height = `${viewport.height}px`; element.style.transform = `translateY(${viewport.offsetTop}px)`; }
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
      // Keep following while the keyboard goes down; then drop the box and undo any pan iOS left behind.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        viewport.removeEventListener("resize", follow);
        viewport.removeEventListener("scroll", follow);
        clearTimeout(timer);
        settling.current = null;
        const element = rootRef.current?.current;
        if (element) { element.style.height = ""; element.style.transform = ""; }
        setBox(null);
        if (viewport.offsetTop !== 0 || window.scrollY !== scrollY) window.scrollTo(0, scrollY);
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
