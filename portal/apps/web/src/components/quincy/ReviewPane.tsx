import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { PANE_MIN, clampPaneWidth, paneCeiling } from "../../lib/review-pane-prefs";
import { Button } from "../reui/button";

/**
 * The review viewers' split (#859): the player on the left, a collapsible, resizable side pane on the right, one flex row for the staff viewer
 * and the Review-link guest page. Quincy-owned: base-nova's `resizable` (react-resizable-panels 4.14.5) was tried first and failed the spike
 * (in happy-dom the group measures 0 wide, reports no layout and throws on the first key; it sizes from a measured group, with no px width
 * to persist), so the handle is the WAI-ARIA window splitter below.
 *
 * The player cell is always the first child and is never remounted by collapsing, expanding or crossing the phone breakpoint: the pane
 * unmounts when collapsed, the film does not. Width is a pixel preference clamped at use time (`clampPaneWidth`) against the row's
 * measured width, never a percentage inside the flex row. `stacked` (phone) drops the handle and the width: the pane wraps below the player.
 */
export const REVIEW_PANE_WIDTH_VAR = "--review-pane-w";
const STEP = 16;
const STEP_BIG = 64;

export function ReviewSplit({ player, pane, open, width, onWidth, paneId, handleLabel, stacked, rowClassName, playerClassName }: {
  player: ReactNode;
  pane: ReactNode;
  open: boolean;
  /** The saved (preferred) width in px. */
  width: number;
  /** Commit a new preferred width: on a key, and when a drag ends. */
  onWidth: (next: number) => void;
  paneId: string;
  handleLabel: string;
  stacked: boolean;
  rowClassName?: string;
  playerClassName?: string;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [hostWidth, setHostWidth] = useState(0);
  const measure = useCallback((): number => {
    const measured = rowRef.current?.clientWidth ?? 0;
    setHostWidth((held) => (held === measured ? held : measured));
    return measured;
  }, []);
  useLayoutEffect(() => {
    measure();
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => { measure(); });
    observer.observe(row);
    return () => { observer.disconnect(); };
  }, [measure]);

  const [drag, setDrag] = useState<number | null>(null);
  const dragRef = useRef<{ x: number; width: number; now: number } | null>(null);
  const shown = drag ?? clampPaneWidth(width, hostWidth);
  const ceiling = paneCeiling(hostWidth);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const live = measure();
    const current = clampPaneWidth(width, live);
    const step = event.shiftKey ? STEP_BIG : STEP;
    let next: number | null = null;
    // The pane is on the right: the separator moving left makes it wider.
    if (event.key === "ArrowLeft") next = current + step;
    else if (event.key === "ArrowRight") next = current - step;
    else if (event.key === "Home") next = PANE_MIN;
    else if (event.key === "End") next = paneCeiling(live);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    onWidth(clampPaneWidth(next, live));
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== undefined && event.button !== 0) return;
    const live = measure();
    const start = clampPaneWidth(width, live);
    dragRef.current = { x: event.clientX, width: start, now: start };
    setDrag(start);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the pointer is gone, or the test runtime has no capture: the move events still arrive */ }
    event.preventDefault();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = dragRef.current;
    if (!gesture) return;
    gesture.now = clampPaneWidth(gesture.width + (gesture.x - event.clientX), measure());
    setDrag(gesture.now);
  };
  const finish = () => {
    const gesture = dragRef.current;
    if (!gesture) return;
    dragRef.current = null;
    setDrag(null);
    onWidth(gesture.now);
  };
  useEffect(() => { if (!open || stacked) { dragRef.current = null; setDrag(null); } }, [open, stacked]);

  const showPane = (stacked || open) && pane !== null;
  return <div ref={rowRef} data-testid="video-review-split" className={`flex min-h-0 flex-1 flex-wrap min-[721px]:flex-nowrap min-[721px]:overflow-hidden ${rowClassName ?? ""}`}>
    <div data-testid="video-review-player" className={`flex min-h-0 min-w-0 flex-[999_1_640px] flex-col p-[var(--space-5)] min-[721px]:flex-1 ${playerClassName ?? ""}`}>{player}</div>
    {showPane && !stacked && <div
      role="separator"
      data-testid="video-review-handle"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={handleLabel}
      aria-controls={paneId}
      aria-valuemin={PANE_MIN}
      aria-valuemax={ceiling}
      aria-valuenow={shown}
      data-dragging={drag !== null}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      className="relative z-10 w-0 flex-none cursor-col-resize touch-none before:absolute before:inset-y-0 before:-right-2 before:-left-2 before:content-[''] pointer-coarse:before:-right-3 pointer-coarse:before:-left-3 after:absolute after:inset-y-0 after:left-0 after:w-0.5 after:bg-transparent after:transition-colors hover:after:bg-ring data-[dragging=true]:after:bg-ring"
    />}
    {showPane && <div
      id={paneId}
      data-testid="video-review-pane"
      style={stacked ? undefined : { [REVIEW_PANE_WIDTH_VAR]: `${shown}px` } as CSSProperties}
      className="flex min-h-0 flex-col max-[721px]:flex-[1_1_360px] min-[721px]:w-[var(--review-pane-w)] min-[721px]:flex-none min-[721px]:overflow-hidden"
    >{pane}</div>}
  </div>;
}

/** The header button that shows or hides the pane. Collapsing while focus is inside the pane moves focus here first, so it is not dropped on the body. */
export function ReviewPaneToggle({ open, onOpenChange, paneId, label, className }: { open: boolean; onOpenChange: (next: boolean) => void; paneId: string; label: string; className?: string }) {
  return <Button
    type="button"
    variant="outline"
    data-testid="video-pane-toggle"
    aria-expanded={open}
    {...(open ? { "aria-controls": paneId } : {})}
    className={className}
    onClick={(event) => {
      const button = event.currentTarget;
      if (open && document.getElementById(paneId)?.contains(document.activeElement)) button.focus({ preventScroll: true });
      onOpenChange(!open);
    }}
  >{open ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}{label}</Button>;
}
