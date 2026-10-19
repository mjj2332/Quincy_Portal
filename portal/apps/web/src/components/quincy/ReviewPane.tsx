import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { PANE_MIN, PLAYER_MIN, TABLET_MAX, clampPaneWidth, paneCeiling, resolvePaneOpen } from "../../lib/review-pane-geometry";
import { REVIEW_PANE_KEY, normalizeReviewPane } from "../../lib/review-pane-prefs";
import { useMediaQuery } from "../../lib/use-media-query";
import { useUiPref } from "../../lib/ui-prefs";
import { Badge } from "../reui/badge";
import { Button } from "../reui/button";
import { IconTip } from "./IconTip";
import { SHEET_COLLAPSED_MIN, SheetGrabber, SheetModeContext, isComposerField, isInComposer, useSheetPane, useSheetTextRoom, type ReviewSheetControl, type SheetModeValue, type SheetRoom } from "./ReviewSheet";

/**
 * The review viewers' split (#859): the player on the left, a collapsible, resizable side pane on the right, one flex row for the staff viewer
 * and the Review-link guest page. Quincy-owned: base-nova's `resizable` (react-resizable-panels 4.14.5) was tried first and failed the spike
 * (in happy-dom the group measures 0 wide, reports no layout and throws on the first key; it sizes from a measured group, with no px width
 * to persist), so the handle is the WAI-ARIA window splitter below.
 *
 * The player cell is always the first child and is never remounted by collapsing, expanding or crossing the phone breakpoint, and the pane
 * is hidden and inert when collapsed, never unmounted. Width is a pixel preference clamped at use time (`clampPaneWidth`) against the row's
 * measured width, never a percentage inside the flex row. `stacked` (phone) drops the handle and the width: the pane wraps below the player.
 */
export const REVIEW_PANE_WIDTH_VAR = "--review-pane-w";

/** The collapsed sheet's whole height: the grabber, the head and the composer, plus the padding, borders and flex/grid gaps of every box between them and the pane (#879). */
function collapsedHeight(row: HTMLElement): number {
  const pane = row.querySelector<HTMLElement>('[data-testid="video-review-pane"]');
  const px = (value: string) => { const n = parseFloat(value); return Number.isFinite(n) ? n : 0; };
  // The grabber as drawn (#879 PR 3a: it is a token height now, so it is measured rather than assumed).
  const grabber = pane?.querySelector<HTMLElement>('[data-testid="review-sheet-grabber"]');
  let total = (grabber?.offsetHeight ?? 0) + (pane ? px(getComputedStyle(pane).borderTopWidth) + px(getComputedStyle(pane).borderBottomWidth) : 0);
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

/** A tablet held upright (D18): from the phone breakpoint up to `TABLET_MAX` wide, taller than wide. No pointer gate, so a tall narrow desktop window counts too (the same narrow film). */
const TABLET_WIDE_QUERY = `(max-width: ${TABLET_MAX}px)`;
const PORTRAIT_QUERY = "(aspect-ratio < 1)"; // strictly taller than wide (D18): a square viewport is not portrait, though `(orientation: portrait)` says it is

/**
 * The pane's state for a screen: the saved preference (open, width), plus the narrow rule. A row too narrow for the smallest pane AND the
 * 480px player lays out collapsed without touching the saved preference; the toggle then shows it for this visit only (`narrowOpen`),
 * and the player may shrink below 480 while it does.
 *
 * Until the person makes a choice (`open: null`, #881) the screen decides, live: a portrait tablet starts collapsed, so turning an iPad with no
 * remembered choice opens or collapses the pane. The first show or hide writes a boolean, and from then on that choice wins (`resolvePaneOpen`).
 */
export function useReviewPane(phone: boolean) {
  const [pref, setPref] = useUiPref(REVIEW_PANE_KEY, normalizeReviewPane);
  const prefRef = useRef(pref);
  prefRef.current = pref;
  const portrait = useMediaQuery(PORTRAIT_QUERY);
  const tabletWide = useMediaQuery(TABLET_WIDE_QUERY);
  const resolved = resolvePaneOpen(pref.open, !phone && portrait && tabletWide);
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;
  const [narrow, setNarrow] = useState(false);
  const narrowRef = useRef(false);
  narrowRef.current = narrow;
  const [narrowOpen, setNarrowOpen] = useState(false);
  // A reveal (a marker, an I/O mark, a note link) shows the pane for this visit only: it is not a choice, so it never writes (owner, #881 — a portrait tablet keeps D18's collapsed start).
  const [revealed, setRevealed] = useState(false);
  const open = narrow ? narrowOpen : revealed || resolved;
  const setOpen = useCallback((next: boolean) => {
    if (phone) return; // a phone has its own layout and must not rewrite the desktop choice
    if (narrowRef.current) { setNarrowOpen(next); return; }
    setRevealed(false);
    // Against the remembered or default state, not the stored value: showing a pane that is already shown is not a choice, so a never-chosen state stays live,
    // and hiding a revealed pane only drops the reveal when that lands back on the remembered state.
    if (resolvedRef.current !== next) setPref({ ...prefRef.current, open: next });
  }, [phone, setPref]);
  const reveal = useCallback(() => {
    if (phone) return;
    if (narrowRef.current) { setNarrowOpen(true); return; }
    setRevealed(true);
  }, [phone]);
  // A resize keeps `open` as stored: a never-chosen state stays `null`.
  const setWidth = useCallback((width: number) => { setPref({ ...prefRef.current, width }); }, [setPref]);
  return { open, setOpen, reveal, width: pref.width, setWidth, onNarrow: setNarrow };
}
const STEP = 16;
const STEP_BIG = 64;
/** A desktop width's Full screen compose has no sheet to hold. */
const NO_HOLD = () => undefined;

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
  // One gesture at a time, owned by the pointer that started it (#881): a second finger or pen neither moves nor ends it.
  const dragRef = useRef<{ pointerId: number; x: number; width: number; now: number } | null>(null);
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
    // Another pointer's gesture is under way; the same pointer pressing again (its release was never seen) starts over.
    if (dragRef.current && dragRef.current.pointerId !== event.pointerId) return;
    const live = measure();
    const start = clampPaneWidth(width, live);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, width: start, now: start };
    setDrag(start);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the pointer is gone, or the test runtime has no capture: the move events still arrive */ }
    event.preventDefault();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = dragRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.now = clampPaneWidth(gesture.width + (gesture.x - event.clientX), measure());
    setDrag(gesture.now);
  };
  // Release, a cancelled pointer and a lost capture all end the gesture where it was drawn, and commit that width once.
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = dragRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    onWidth(gesture.now);
  };
  const full = immersive !== "off";
  // The handle goes away mid-gesture (the pane collapses, by N or the button; the row crosses 721px or turns narrow; Full screen): no release will come, so the gesture is dropped, uncommitted.
  useEffect(() => { if (!open || stacked || narrow || full) { dragRef.current = null; setDrag(null); } }, [open, stacked, narrow, full]);

  const showPane = full ? immersive === "compose" : stacked || open;
  const phoneSheet = stacked && sheet !== undefined && !full;
  const sheetPane = useSheetPane({ enabled: phoneSheet, control: sheet, room, paneRef, immersive });
  // The sheet's height follows what is measured: a layout pass after the stop, the mode or the film changes (the part sizes are those of the stop being shown).
  useLayoutEffect(() => { if (phoneSheet) measure(); });
  useSheetTextRoom(phoneSheet && sheet.mode === "compose", rowRef, paneRef);
  const sheetStyle = phoneSheet && sheetPane.height !== undefined ? { height: sheetPane.height } : undefined;
  // The composer reads the mode from here (#879 fix): one source for the sheet's layout and the composer's. Provided on the phone sheet and in Full screen compose (null otherwise),
  // so the pane's subtree never changes shape across the 721px crossing.
  // Full screen compose (#927 F1) floats the box at every width: `floating` tells the composer to draw F1's surface. A phone's (#880 S4, owner decision 1) is the sheet's compose mode
  // too (draw while the pen is down), so its holds (a post) are the sheet's and its give-back of an untouched stamp cannot run while it is shown. A desktop width has no sheet: the
  // composer reads no mode there (its layout is the desktop form), so the mode is nominal and holds go nowhere. Watch provides none. F1's box has no Cancel: Add note and Escape close it.
  const floating = full && immersive === "compose";
  const sheetMode = phoneSheet ? sheet.mode : floating ? (stacked && sheet?.mode === "draw" ? "draw" : "compose") : null;
  const setHold = sheet?.setHold ?? NO_HOLD;
  const modeValue = useMemo<SheetModeValue | null>(() => (sheetMode !== null ? { mode: sheetMode, setHold, ...(floating ? { floating: true as const } : {}) } : null), [sheetMode, setHold, floating]);
  // The dock's scrim reaches up behind the composer (F1: the composer sits inside the bottom scrim): its height is published on the row, which the player reads.
  useLayoutEffect(() => {
    const row = rowRef.current; const box = paneRef.current;
    if (!floating || !row || !box) return undefined;
    const write = () => { row.style.setProperty("--immersive-composer-h", `${box.offsetHeight}px`); };
    write();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(write);
    observer?.observe(box);
    return () => { observer?.disconnect(); row.style.removeProperty("--immersive-composer-h"); };
  }, [floating]);
  const onComposing = sheet?.onComposing;
  // Leaving the field ends compose mode unless the focus went somewhere inside the composer (its tray, Send, Cancel). iOS often reports no `relatedTarget` even then,
  // so with none the check waits a frame and looks at where the focus actually is. Ending it never touches the draft: the composer and its editor stay mounted.
  const leaveCheck = useRef<number | null>(null);
  useEffect(() => () => { if (leaveCheck.current !== null) cancelAnimationFrame(leaveCheck.current); }, []);
  const onPaneBlur = (event: { target: EventTarget | null; relatedTarget: EventTarget | null }) => {
    if (!onComposing || !isInComposer(event.target) || isInComposer(event.relatedTarget)) return;
    if (event.relatedTarget instanceof Element) { onComposing(false); return; }
    if (leaveCheck.current !== null) cancelAnimationFrame(leaveCheck.current);
    leaveCheck.current = requestAnimationFrame(() => { leaveCheck.current = null; if (!isInComposer(document.activeElement)) onComposing(false); });
  };
  const rowClass = full
    ? "relative flex min-h-0 flex-1 flex-col flex-nowrap overflow-hidden"
    : phoneSheet
    ? "flex min-h-0 flex-1 flex-col flex-nowrap overflow-hidden"
    : "flex min-h-0 flex-1 flex-wrap min-[721px]:flex-nowrap min-[721px]:overflow-hidden";
  // In search mode (#879 PR 3b, F1) the film is held at compose's floor (`SHEET_FILM_FLOOR`, spelled out for Tailwind) and the sheet fills the rest, so the field and the results
  // stand above the keyboard; the transport is hidden by the screen, as in compose.
  // In compose mode the strip is fixed and the film flexes (plan §3, #879 fix r4): the sheet may take the whole split, so the hint, tray, pill and Cancel always fit whole above
  // the keyboard, and the film (its transport hidden) gives up its height first, never painting past its cell.
  const playerClass = full
    ? "flex min-h-0 min-w-0 flex-1 flex-col p-0"
    : phoneSheet
    ? `flex min-w-0 flex-col p-0${sheet.mode === "compose" ? " min-h-0 flex-1 overflow-hidden" : sheet.mode === "search" ? " h-[var(--space-9)] flex-none overflow-hidden" : " min-h-0 flex-1"}`
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
      onBlurCapture={phoneSheet ? onPaneBlur : undefined}
      style={{ ...(stacked || full ? {} : { [REVIEW_PANE_WIDTH_VAR]: `${shown}px` }), ...sheetStyle, ...(showPane ? {} : { display: "none" }) } as CSSProperties}
      className={full
        // The composer alone, F1's box (#880 fix round 1, #927 T9): inside the dock's scrim, a space above the scrubber (`--immersive-controls-h` is the controls' height without the
        // scrim's top padding, published by the player), centred: inset like the dock (safe areas included) and at most F1's 560px, `mx-auto` splitting what is left. 560 is on no
        // single token, so it is spelled from the scale: the small container less --space-8 and --space-4. The box draws F1's surface (`floating`: translucent, blurred, rounded),
        // so the pane adds none, and no padding. Every other part of the pane is inert and hidden. Its height is bounded by the room above the controls.
        ? "absolute right-[max(var(--space-3),env(safe-area-inset-right))] bottom-[calc(var(--immersive-controls-h,0px)+var(--space-2))] left-[max(var(--space-3),env(safe-area-inset-left))] z-10 mx-auto flex max-h-[calc(100%-var(--immersive-controls-h,0px)-var(--space-2))] max-w-[calc(var(--container-sm)-var(--space-8)-var(--space-4))] min-h-0 flex-col overflow-y-auto [&_[data-sheet-part][inert]]:hidden"
        : phoneSheet
        ? "relative flex min-h-0 flex-none flex-col overflow-hidden border-t border-border bg-card motion-safe:transition-[height] motion-safe:duration-[var(--dur-base)] motion-safe:ease-[var(--ease-entrance)] data-[dragging=true]:transition-none data-[mode=compose]:max-h-full data-[mode=search]:flex-1 [&_[data-sheet-part][inert]]:hidden"
        : "flex min-h-0 flex-col max-[721px]:flex-[1_1_360px] min-[721px]:w-[var(--review-pane-w)] min-[721px]:flex-none min-[721px]:overflow-hidden"}
    >
      {phoneSheet && <SheetGrabber control={sheet} stops={sheetPane.stops} getHeight={() => sheetPane.drag ?? sheetPane.stops[sheet.stop]} onDrag={sheetPane.setDrag} />}
      <SheetModeContext.Provider value={modeValue}>{pane}</SheetModeContext.Provider>
    </div>}
    {!stacked && !showPane && !full && strip}
  </div>;
}

/** The pane's own ⇥ button, for a lazily loaded panel that cannot take it as a prop: the screen that owns the pane provides it, the panel's header renders it. `null` = place none. */
export const ReviewPaneHideContext = createContext<ReactNode>(null);

/** Renders the hide button the owning screen provided, if any; for a panel built where the provider is not above it (Compare's panel is made by its lazy host and rendered by the body). */
export function ReviewPaneHideSlot() { return <>{useContext(ReviewPaneHideContext)}</>; }

const PANE_ICON = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";

export type ReviewPaneNoun = "notes" | "details" | "delivery";

/**
 * The pane's collapse control (#877, #881): ⇥ "Hide {noun}" is placed by the screen inside the pane (`hideButton`); once the pane is collapsed a slim
 * strip on the right edge (`strip`, handed to `ReviewSplit`) is one full-height ⇤ "Show {noun}" button, with the open-note count under the icon
 * (W2, D22: hidden at 0 and while unknown). A screen that learns the count below this hook (the staff viewer's lazy notes host) draws `stripFor(count)` instead. Collapsing moves focus to the strip's button when the focus was in the pane (or nowhere), expanding by the
 * button moves it back to ⇥ (a hidden-and-inert pane would otherwise drop focus on the body); showing the pane any other way (`revealNotes`, the
 * shortcut through `toggle`) moves no focus. `shortcut` is the key both tooltips name.
 */
export function useReviewPaneControls({ open, onOpenChange, paneId, noun, shortcut, openCount }: { open: boolean; onOpenChange: (next: boolean) => void; paneId: string; noun: ReviewPaneNoun; shortcut?: string; /** Open notes on the Version on screen; `null` while unknown. */ openCount?: number | null }): { hideButton: ReactNode; strip: ReactNode; stripFor: (openCount?: number | null) => ReactNode; toggle: () => void } {
  const pendingFocus = useRef<"strip" | "hide" | null>(null);
  const hideRef = useRef<HTMLButtonElement | null>(null);
  const showRef = useRef<HTMLButtonElement | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "strip") showRef.current?.focus({ preventScroll: true });
    else if (target === "hide") hideRef.current?.focus({ preventScroll: true });
  }, [open]);
  const collapse = useCallback(() => {
    const inside = document.getElementById(paneId)?.contains(document.activeElement) ?? false;
    if (inside || document.activeElement === document.body) pendingFocus.current = "strip";
    onOpenChange(false);
  }, [paneId, onOpenChange]);
  const toggle = useCallback(() => { if (openRef.current) collapse(); else onOpenChange(true); }, [collapse, onOpenChange]);
  const hideLabel = `Hide ${noun}`;
  const showLabel = `Show ${noun}`;
  const hideButton = <IconTip label={hideLabel} {...(shortcut ? { keys: shortcut } : {})}>
    <Button
      ref={hideRef}
      type="button"
      variant="ghost"
      size="icon"
      data-testid="video-pane-hide"
      aria-label={hideLabel}
      aria-expanded={open}
      aria-controls={paneId}
      {...(shortcut ? { "aria-keyshortcuts": shortcut } : {})}
      className={PANE_ICON}
      onClick={collapse}
    ><PanelRightClose aria-hidden="true" /></Button>
  </IconTip>;
  const stripFor = (shownCount?: number | null): ReactNode => {
    if (open) return null;
    const count = noun === "notes" && shownCount != null && shownCount > 0 ? shownCount : null;
    // W2's strip (prototype 44px, the icon then the count): the whole column is the one reopen target, so it is a single ghost button filling the strip.
    // Adaptation (prototype over ReUI rule 1): the button fills the column inside a --space-1 gutter, which is exactly room for the app-wide focus outline (2px at a 2px offset):
    // the row clips its overflow, so an edge-to-edge button would lose its ring on three sides. Its side padding gives way to the 36px column; the gap and block padding are spacing tokens.
    return <div data-testid="video-review-strip" className="flex w-11 flex-none flex-col border-l border-border bg-card p-[var(--space-1)] max-[721px]:hidden">
      <IconTip label={showLabel} {...(shortcut ? { keys: shortcut } : {})}>
        <Button
          ref={showRef}
          type="button"
          variant="ghost"
          data-testid="video-pane-show"
          aria-label={count === null ? showLabel : `${showLabel}, ${count} open`}
          aria-expanded={false}
          aria-controls={paneId}
          {...(shortcut ? { "aria-keyshortcuts": shortcut } : {})}
          className="w-full flex-1 flex-col justify-start gap-[var(--space-2)] px-0 py-[var(--space-2)]"
          onClick={() => { pendingFocus.current = "hide"; onOpenChange(true); }}
        >
          <PanelRightOpen aria-hidden="true" />
          {count !== null && <Badge variant="secondary" aria-hidden="true" data-testid="video-pane-strip-count" className="tabular-nums">{count}</Badge>}
        </Button>
      </IconTip>
    </div>;
  };
  return { hideButton, strip: stripFor(openCount), stripFor, toggle };
}
