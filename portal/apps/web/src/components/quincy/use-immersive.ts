import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { ImmersiveState } from "../../lib/immersive";

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * The side effects of Quincy's Full screen (#880), shared by the staff viewer and the guest page. The screen owns the state (`null | "button" | "turn"`) and the layout it drives; this hook is
 * what the mode does to the page.
 *
 * - **Element full screen** (button entry only, where the browser has one: desktop, Android): the whole page, not the player, so every portalled popup and toast stays visible. A rotation never
 *   asks for it. A rejected request leaves the in-app layer working; the browser's own Escape arrives as `fullscreenchange` and leaves the mode, so nothing ever double-leaves.
 * - **Focus**: entering moves it to Exit full screen (unless the person is typing: a turn mid-note keeps the keyboard up); leaving puts it back, synchronously in the commit that drops the
 *   layer (lesson P3: never a timer), on what had it if that is still there, else on the Full screen button.
 */
export function useImmersive({ rootRef, state, setState }: { rootRef: RefObject<HTMLElement | null>; state: ImmersiveState; setState: (next: ImmersiveState) => void }): {
  /** The button or the F key: enter, or leave if already in. */
  toggle(): void;
  enter(): void;
  leave(): void;
} {
  const stateRef = useRef(state);
  stateRef.current = state;
  const setStateRef = useRef(setState);
  setStateRef.current = setState;
  const recorded = useRef<Element | null>(null);
  // The page's element full screen is ours (we asked, and it was granted).
  const ours = useRef(false);

  const releasePage = useCallback(() => {
    if (!ours.current) return;
    ours.current = false;
    if (document.fullscreenElement !== null && typeof document.exitFullscreen === "function") void Promise.resolve(document.exitFullscreen()).catch(() => undefined);
  }, []);

  const enter = useCallback(() => {
    if (stateRef.current !== null) return;
    recorded.current = document.activeElement;
    setStateRef.current("button");
    // Inside the press: a user gesture. Rejected (or unsupported): the in-app layer is the full screen.
    const page = document.documentElement;
    if (document.fullscreenEnabled === true && typeof page.requestFullscreen === "function") {
      try {
        ours.current = true;
        void Promise.resolve(page.requestFullscreen()).catch(() => { ours.current = false; });
      } catch { ours.current = false; }
    }
  }, []);

  const leave = useCallback(() => {
    if (stateRef.current === null) return;
    releasePage();
    setStateRef.current(null);
  }, [releasePage]);

  const toggle = useCallback(() => { if (stateRef.current === null) enter(); else leave(); }, [enter, leave]);

  useEffect(() => {
    const onChange = () => {
      if (!ours.current || document.fullscreenElement !== null) return;
      // The browser left element full screen itself (its own Escape): the mode goes with it.
      ours.current = false;
      if (stateRef.current !== null) setStateRef.current(null);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => { document.removeEventListener("fullscreenchange", onChange); };
  }, []);
  useEffect(() => releasePage, [releasePage]);

  const previous = useRef<ImmersiveState>(null);
  useLayoutEffect(() => {
    const was = previous.current;
    previous.current = state;
    const root = rootRef.current;
    if (was === null && state !== null) {
      if (recorded.current === null) recorded.current = document.activeElement;
      const active = document.activeElement;
      if (!(active instanceof Element && active.matches(EDITABLE))) root?.querySelector<HTMLElement>('[data-testid="video-exit-fullscreen"]')?.focus({ preventScroll: true });
    } else if (was !== null && state === null) {
      const back = recorded.current;
      recorded.current = null;
      // A field recorded at the way in (a turn made while typing) gets the focus back only if it still has it (#880 S5): one the person left in Full screen is not refocused,
      // since iOS would not raise the keyboard for a focus outside a gesture and the sheet would sit in compose mode with none.
      const leftField = back instanceof Element && back.matches(EDITABLE) && document.activeElement !== back;
      const target = back instanceof HTMLElement && back.isConnected && back !== document.body && back !== root && !leftField ? back : root?.querySelector<HTMLElement>('[data-testid="video-fullscreen"]') ?? null;
      target?.focus({ preventScroll: true });
    }
  }, [state, rootRef]);

  return { toggle, enter, leave };
}
