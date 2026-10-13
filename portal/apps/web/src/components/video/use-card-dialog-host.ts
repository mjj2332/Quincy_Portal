import { useCallback, useRef, useState } from "react";

/**
 * A dialog opened from a Video card but hosted above the filtered list (the panel), so a refresh that filters the card out cannot unmount the dialog or the draft in it (#867; #868 Delete uses the same host).
 * Every opening gets its own `openingId`: whatever a dialog does when an async step finishes is fenced on it (`close(openingId)` is a no-op for an opening that has since been replaced or closed).
 * `lastTarget` keeps the final target while the dialog animates out, so a mounted-but-closed dialog always has something to render.
 */
export type CardDialogOpening<T> = { openingId: number; target: T };
export function useCardDialogHost<T>() {
  const counter = useRef(0);
  const last = useRef<T | null>(null);
  const [opening, setOpening] = useState<CardDialogOpening<T> | null>(null);
  const open = useCallback((target: T) => { counter.current += 1; last.current = target; setOpening({ openingId: counter.current, target }); }, []);
  const close = useCallback((openingId: number) => { setOpening((current) => (current?.openingId === openingId ? null : current)); }, []);
  return { opening, open, close, lastTarget: last.current };
}
