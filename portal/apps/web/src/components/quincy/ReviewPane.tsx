import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { PANE_MIN, PLAYER_MIN, REVIEW_PANE_KEY, clampPaneWidth, normalizeReviewPane, paneCeiling } from "../../lib/review-pane-prefs";
import { useUiPref } from "../../lib/ui-prefs";
import { Button } from "../reui/button";
import { IconTip } from "./IconTip";
import { SHEET_COLLAPSED_MIN, SheetGrabber, isComposerField, useSheetPane, type ReviewSheetControl, type SheetRoom } from "./ReviewSheet";

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

/** The collapsed sheet's whole height: the grabber, the head and the composer, plus the padding, borders and flex/grid gaps of every box between them and the pane (#879). */
function collapsedHeight(row: HTMLElement): number {
  const pane = row.querySelector<HTMLElement>('[data-testid="video-review-pane"]');
  const px = (value: string) => { const n = parseFloat(value); return Number.isFinite(n) ? n : 0; };
  let total = 24 + (pane ? px(getComputedStyle(pane).borderTopWidth) + px(getComputedStyle(pane).borderBottomWidth) : 0);
  if (!pane) return total;
  const parts = ["head", "composer"].map((name) => pane.querySelector<HTMLElement>(`[data-sheet-part="${name}"]`)).filter((part): part is HTMLElement => part !== null);
  const boxes = new Set<HTMLElement>();
  for (const part of parts) {
    total += part.offsetHeight;
    for (let node = part.parentElement; node && node !== pane; node = node.parentElement) boxes.add(node);
  }
  const onPath = new Set<Element>([...boxes, ...parts]);
  for (const box of boxes) {
    const style = getComputedStyle(box);
    total += px(style.paddingTop) + px(style.paddingBottom) + px(style.borderTopWidth) + px(style.borderBottomWidth);
    const gap = px(style.rowGap);
    const shown = [...box.children].filter((child) => onPath.has(child)).length;
    if (gap > 0 && shown > 1) total += gap * (shown - 1);
  }
  return total;
}

/**
 * The pane's state for a screen: the saved preference (open, width), plus the narrow rule. A row too narrow for the smallest pane AND the
 * 480px player lays out collapsed without touching the saved preference; the toggle then shows it for this visit only (`narrowOpen`),
 * and the player may shrink below 480 while it does.
 */
export function useReviewPane(phone: boolean) {
  const [pref, setPref] = useUiPref(REVIEW_PANE_KEY, normalizeReviewPane);
  const prefRef = useRef(pref);
  prefRef.current = pref;
  const [narrow, setNarrow] = useState(false);
  const narrowRef = useRef(false);
  narrowRef.current = narrow;
  const [narrowOpen, setNarrowOpen] = useState(false);
  const open = narrow ? narrowOpen : pref.open;
  const setOpen = useCallback((next: boolean) => {
    if (phone) return; // a phone has its own layout and must not rewrite the desktop choice
    if (narrowRef.current) { setNarrowOpen(next); return; }
    if (prefRef.current.open !== next) setPref({ ...prefRef.current, open: next });
  }, [phone, setPref]);
  const setWidth = useCallback((width: number) => { setPref({ ...prefRef.current, width }); }, [setPref]);
  return { open, setOpen, width: pref.width, setWidth, onNarrow: setNarrow };
}
const STEP = 16;
const STEP_BIG = 64;

export function ReviewSplit({ player, pane, strip, open, width, onWidth, onNarrow, paneId, handleLabel, stacked, sheet, immersive = "off", rowClassName, playerClassName }: {
  player: ReactNode;
  /** The slim column that stands in for a collapsed pane (`useReviewPaneControls().strip`); the row's last child while the pane is hidden on a wide screen. */
  strip?: ReactNode;
  pane: ReactNode;
  open: boolean;
  /** The saved (preferred) width in px. */
  width: number;
  /** Commit a new preferred width: on a key, and when a drag ends. */
  onWidth: (next: number) => void;
  /** Told whether the row is too narrow for the smallest pane plus the minimum player (measured; never while unmeasured). */
  onNarrow: (narrow: boolean) => void;
  paneId: string;
  handleLabel: string;
  stacked: boolean;
  /** The phone sheet (#879): with `stacked`, the pane becomes the three-stop sheet under the film. Absent, a stacked pane wraps below the player as before. */
  sheet?: ReviewSheetControl;
  /**
   * Full screen (#880), applied in place: the player fills the row, the handle and strip go, and the pane (never unmounted) is hidden and inert while watching, or floats just above the player's
   * controls with only the composer showing while a note is written. Nothing is reparented, so the film's clock and the editor are the same nodes throughout.
   */
  immersive?: "off" | "watch" | "compose";
  rowClassName?: string;
  playerClassName?: string;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [hostWidth, setHostWidth] = useState(0);
  const [room, setRoom] = useState<SheetRoom>({ available: 0, width: 0, transport: 0, collapsed: SHEET_COLLAPSED_MIN });
  const transportHeld = useRef(0);
  const measure = useCallback((): number => {
    const row = rowRef.current;
    const measured = row?.clientWidth ?? 0;
    setHostWidth((held) => (held === measured ? held : measured));
    if (row) {
      // The room for the sheet stops: the row's height, its width, the transport block under the picture (kept while drawing replaces it) and what the collapsed bar needs (head + composer + grabber).
      const transport = row.querySelector<HTMLElement>('[data-testid="video-scrubber"]')?.parentElement?.offsetHeight ?? 0;
      if (transport > 0) transportHeld.current = transport;
      const next = { available: row.clientHeight, width: measured, transport: transportHeld.current, collapsed: collapsedHeight(row) };
      setRoom((held) => (held.available === next.available && held.width === next.width && held.transport === next.transport && held.collapsed === next.collapsed ? held : next));
    }
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

  const narrow = hostWidth > 0 && hostWidth < PANE_MIN + PLAYER_MIN;
  useEffect(() => { onNarrow(narrow); }, [narrow, onNarrow]);

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

  const full = immersive !== "off";
  const showPane = full ? immersive === "compose" : stacked || open;
  const phoneSheet = stacked && sheet !== undefined && !full;
  const sheetPane = useSheetPane({ enabled: phoneSheet, control: sheet, room, paneRef, immersive });
  // The sheet's height follows what is measured: a layout pass after the stop, the mode or the film changes (the part sizes are those of the stop being shown).
  useLayoutEffect(() => { if (phoneSheet) measure(); });
  const sheetStyle = phoneSheet && sheetPane.height !== undefined ? { height: sheetPane.height } : undefined;
  const rowClass = full
    ? "relative flex min-h-0 flex-1 flex-col flex-nowrap overflow-hidden"
    : phoneSheet
    ? "flex min-h-0 flex-1 flex-col flex-nowrap overflow-hidden"
    : "flex min-h-0 flex-1 flex-wrap min-[721px]:flex-nowrap min-[721px]:overflow-hidden";
  const playerClass = full || phoneSheet
    ? "flex min-h-0 min-w-0 flex-1 flex-col p-0"
    : "flex min-h-0 min-w-0 flex-[999_1_640px] flex-col p-[var(--space-5)] min-[721px]:flex-1";
  return <div ref={rowRef} data-testid="video-review-split" className={`${rowClass} ${full ? "" : rowClassName ?? ""}`}>
    <div data-testid="video-review-player" className={`${playerClass} ${full ? "" : playerClassName ?? ""}`}>{player}</div>
    {showPane && !stacked && !narrow && !full && <div
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
    {/* Collapsing hides the pane, it does not unmount it: an upload in flight, a pending reply and a draft all live in it. */}
    {pane !== null && <div
      ref={paneRef}
      id={paneId}
      data-testid="video-review-pane"
      hidden={!showPane}
      inert={!showPane}
      {...(phoneSheet ? { "data-stop": sheet.stop, "data-mode": sheet.mode, "data-dragging": sheetPane.drag !== null } : {})}
      {...(full ? { "data-immersive": immersive } : {})}
      onFocusCapture={phoneSheet ? (event) => { if (isComposerField(event.target)) sheet.onComposing(true); } : undefined}
      onBlurCapture={phoneSheet ? (event) => { if (isComposerField(event.target) && !isComposerField(event.relatedTarget)) sheet.onComposing(false); } : undefined}
      onSubmitCapture={phoneSheet ? () => { sheet.onComposing(false); } : undefined}
      style={{ ...(stacked || full ? {} : { [REVIEW_PANE_WIDTH_VAR]: `${shown}px` }), ...sheetStyle, ...(showPane ? {} : { display: "none" }) } as CSSProperties}
      className={full
        // The composer alone, floating just above the player's controls (`--immersive-controls-h` is measured and published by the player); every other part of the pane is inert and hidden.
        ? "absolute inset-x-[var(--space-3)] bottom-[var(--immersive-controls-h,0px)] z-10 mb-[var(--space-2)] flex max-h-[60%] min-h-0 flex-col overflow-y-auto rounded-[var(--radius-md)] border border-border bg-card p-[var(--space-3)] [&_[data-sheet-part][inert]]:hidden"
        : phoneSheet
        ? "relative flex min-h-0 flex-none flex-col overflow-hidden border-t border-border bg-card motion-safe:transition-[height] motion-safe:duration-[var(--dur-base)] motion-safe:ease-[var(--ease-entrance)] data-[dragging=true]:transition-none data-[mode=compose]:max-h-[60%] [&_[data-sheet-part][inert]]:hidden"
        : "flex min-h-0 flex-col max-[721px]:flex-[1_1_360px] min-[721px]:w-[var(--review-pane-w)] min-[721px]:flex-none min-[721px]:overflow-hidden"}
    >
      {phoneSheet && <SheetGrabber control={sheet} stops={sheetPane.stops} getHeight={() => sheetPane.drag ?? sheetPane.stops[sheet.stop]} onDrag={sheetPane.setDrag} />}
      {pane}
    </div>}
    {!stacked && !showPane && !full && strip}
  </div>;
}

/** The pane's own ⇥ button, for a lazily loaded panel that cannot take it as a prop: the screen that owns the pane provides it, the panel's header renders it. `null` = place none. */
export const ReviewPaneHideContext = createContext<ReactNode>(null);

/** Renders the hide button the owning screen provided, if any; for a panel built where the provider is not above it (Compare's panel is made by its lazy host and rendered by the body). */
export function ReviewPaneHideSlot() { return <>{useContext(ReviewPaneHideContext)}</>; }

const PANE_ICON = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";

/**
 * The pane's collapse control (#877): ⇥ "Hide {noun}" is placed by the screen inside the pane (`hideButton`); once the pane is collapsed a slim
 * strip on the right edge (`strip`, handed to `ReviewSplit`) holds ⇤ "Show {noun}". Collapsing moves focus to the strip's button, expanding moves it
 * back to ⇥ (a hidden-and-inert pane would otherwise drop focus on the body); showing the pane any other way (`revealNotes`) moves no focus.
 */
export function useReviewPaneControls({ open, onOpenChange, paneId, noun }: { open: boolean; onOpenChange: (next: boolean) => void; paneId: string; noun: "notes" | "details" }): { hideButton: ReactNode; strip: ReactNode } {
  const pendingFocus = useRef<"strip" | "hide" | null>(null);
  const hideRef = useRef<HTMLButtonElement | null>(null);
  const showRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "strip") showRef.current?.focus({ preventScroll: true });
    else if (target === "hide") hideRef.current?.focus({ preventScroll: true });
  }, [open]);
  const hideLabel = `Hide ${noun}`;
  const showLabel = `Show ${noun}`;
  const hideButton = <IconTip label={hideLabel}>
    <Button
      ref={hideRef}
      type="button"
      variant="ghost"
      size="icon"
      data-testid="video-pane-hide"
      aria-label={hideLabel}
      aria-expanded={open}
      aria-controls={paneId}
      className={PANE_ICON}
      onClick={() => {
        const inside = document.getElementById(paneId)?.contains(document.activeElement) ?? false;
        if (inside || document.activeElement === document.body) pendingFocus.current = "strip";
        onOpenChange(false);
      }}
    ><PanelRightClose aria-hidden="true" /></Button>
  </IconTip>;
  const strip = open ? null : <div data-testid="video-review-strip" className="flex w-10 flex-none flex-col items-center border-l border-border bg-card py-[var(--space-2)] max-[721px]:hidden">
    <IconTip label={showLabel}>
      <Button
        ref={showRef}
        type="button"
        variant="ghost"
        size="icon"
        data-testid="video-pane-show"
        aria-label={showLabel}
        aria-expanded={false}
        aria-controls={paneId}
        className={PANE_ICON}
        onClick={() => { pendingFocus.current = "hide"; onOpenChange(true); }}
      ><PanelRightOpen aria-hidden="true" /></Button>
    </IconTip>
  </div>;
  return { hideButton, strip };
}
