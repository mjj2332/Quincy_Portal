import { useLayoutEffect, useRef, type ReactNode, type Ref, type RefObject } from "react";
import { scrollTopClearOfFade, type FadeItem } from "@/lib/date-time-field";
import { Button } from "@/components/reui/button";
import { ScrollArea } from "@/components/reui/scroll-area";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { SYDNEY_TIME_ZONE } from "@quincy/shared";
import { Eyebrow } from "../Eyebrow";

/** The picked day and the pressed time slot: what must read as solid ink, never under the body's fade. */
const SELECTED = '[aria-selected="true"] button, [role="group"][aria-label="Time slots"] button[aria-pressed="true"]';

/** The day the person is about to edit when nothing narrower is given: the picked day. The time slot is never revealed, only cleared of the fade. */
export const REVEAL_SELECTED_DAY = '[aria-selected="true"] button';

/**
 * #537 — the body opens at scroll 0 (#528) with its bottom edge faded, so a selected day or time slot
 * sitting there reads muddy. This nudges the body down by the least amount that clears the fade.
 *
 * #587 — "wholly outside the body" is no longer a reason to leave the day alone. The `reveal` day (the
 * picked day, or a range's ACTIVE end) and the focused element inside the body are REQUIRED: they are
 * scrolled into view, and anything else selected gives way when the two cannot both be cleared. On mount
 * and resize the reveal day and the focused element are required; on a selection change only the focused
 * element is, so changing the month with the month select focused never scrolls the select away. A new
 * `focusin` listener covers focus that arrives with `preventScroll` (opening focus, the Start/End handoff):
 * it scrolls only when the element is not already fully visible, so an arrow key's own native scroll is
 * never doubled. Writes are to `scrollTop` only (never `scrollIntoView`, which also moves the page and the
 * popup's ancestors) and every one is marked `applied`, so a programmatic move is never read as the person's.
 *
 * Opt-out rule: once the person scrolls the body themselves (`userScrolled`, latched), the AUTOMATIC
 * nudge (mount, and the resize that follows Base UI sizing the popup) stops for good, even after a
 * selection nudge has since put the body somewhere this hook chose. A change of selection is not an automatic
 * nudge, and a click is not a manual scroll: whenever the selection changes (a day, a time slot) the
 * newly selected item is always cleared of the fade, by the least scroll from where the body is, in
 * either direction. Focus is never latched out: focus has to be visible. Neither is an explicit change of the
 * `reveal` selector (the range's Start/End toggle): it reveals the newly active end's day once, even after a
 * manual scroll, and leaves the latch as it was.
 */
function useSelectedClearOfFade(contentRef: RefObject<HTMLDivElement | null>, reveal: string) {
  // Read live by the observers below, so the Start/End toggle changing `reveal` does not re-run the effect (which would reset its latch).
  const revealRef = useRef(reveal);
  // Set by the effect below: reveals the current `reveal` day on demand, outside the manual-scroll latch.
  const revealNow = useRef<() => void>(() => {});
  const shown = useRef(reveal);
  useLayoutEffect(() => {
    revealRef.current = reveal;
    if (shown.current === reveal) return;
    shown.current = reveal;
    // An explicit Start/End toggle is a deliberate request to see that end, so it reveals even after a manual scroll; the latch itself is untouched, so later resizes still leave the body alone.
    revealNow.current();
  }, [reveal]);
  useLayoutEffect(() => {
    const content = contentRef.current;
    const viewport = content?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!content || !viewport) return;
    let applied = 0;
    // Set the first time the body is found somewhere this hook did not put it, and never cleared: from then on resize leaves it alone.
    let userScrolled = false;
    const noticeScroll = () => { if (viewport.scrollTop !== applied) userScrolled = true; };
    const measure = () => {
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;visibility:hidden;width:0;height:var(--fade-size)";
      viewport.append(probe);
      const fade = probe.getBoundingClientRect().height;
      probe.remove();
      return fade;
    };
    const signature = () => [...viewport.querySelectorAll<HTMLElement>(SELECTED)].map((item) => item.closest("[data-day]")?.getAttribute("data-day") ?? item.textContent).join("|");
    let selected = signature();
    const focused = () => { const active = document.activeElement; return active instanceof HTMLElement && active !== viewport && viewport.contains(active) ? active : null; };
    const write = (top: number) => { viewport.scrollTop = top; applied = viewport.scrollTop; /* the browser may round it */ };
    const solve = (items: FadeItem[], fade: number) => scrollTopClearOfFade({ viewport: viewport.getBoundingClientRect(), scrollTop: viewport.scrollTop, maxScrollTop: viewport.scrollHeight - viewport.clientHeight, fade, items });
    const nudge = (fromTop: boolean, withReveal: boolean) => {
      const fade = measure();
      if (fromTop) viewport.scrollTop = 0;
      const required = new Set<Element>(withReveal ? viewport.querySelectorAll(revealRef.current) : []);
      const focus = focused();
      if (focus) required.add(focus);
      const elements = new Set<Element>([...viewport.querySelectorAll(SELECTED), ...required]);
      write(solve([...elements].map((item) => { const { top, bottom } = item.getBoundingClientRect(); return { top, bottom, required: required.has(item) }; }), fade));
    };
    revealNow.current = () => { noticeScroll(); nudge(false, true); };
    const automatic = () => { noticeScroll(); if (!userScrolled) nudge(true, true); };
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(automatic);
    resize?.observe(viewport);
    viewport.addEventListener("scroll", noticeScroll, { passive: true });
    // Focus that arrived without scrolling (`preventScroll`): bring it into view, by the least amount, unless it already is.
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === viewport || !viewport.contains(target)) return;
      noticeScroll();
      const box = viewport.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      if (rect.top >= box.top && rect.bottom <= box.bottom) return;
      write(solve([{ top: rect.top, bottom: rect.bottom, required: true }], measure()));
    };
    viewport.addEventListener("focusin", onFocusIn);
    // A selection change: the day's `aria-selected`, a slot's `aria-pressed`, or a re-rendered grid (another month).
    const selection = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(() => { const now = signature(); if (now === selected) return; selected = now; noticeScroll(); nudge(false, false); });
    selection?.observe(content, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected", "aria-pressed"] });
    automatic();
    return () => { revealNow.current = () => {}; resize?.disconnect(); selection?.disconnect(); viewport.removeEventListener("scroll", noticeScroll); viewport.removeEventListener("focusin", onFocusIn); };
  }, [contentRef]);
}

/**
 * The popup shell both forms of `DateTimeField` share: a `reui/frame` with the label, the zone, a
 * scrolling body and a footer pinned below it so Cancel / Apply are always visible (#421). The
 * body is the caller's; the footer's two actions are the same for every form.
 */
export function PopupFrame({ label, zoneId, bodyRef, applying, applyDisabled = false, pinned, reveal = REVEAL_SELECTED_DAY, onCancel, onApply, children }: {
  label: string;
  zoneId: string;
  bodyRef: Ref<HTMLDivElement>;
  applying: boolean;
  applyDisabled?: boolean;
  /** Controls drawn between the header and the scrolling body, so they stay visible while it scrolls. */
  pinned?: ReactNode;
  /** CSS selector, within the body, for the day that must be scrolled into view when the popup opens or resizes (#587). A range passes its active end's day. */
  reveal?: string;
  onCancel: () => void;
  onApply: () => void;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  useSelectedClearOfFade(contentRef, reveal);
  return (
    <Frame ref={bodyRef} spacing="sm" className="max-h-[var(--available-height)] min-h-0">
      <FrameHeader>
        <FrameTitle className="min-w-0 [contain:inline-size]"><Eyebrow className="block truncate" title={label}>{label}</Eyebrow></FrameTitle>
        <FrameDescription id={zoneId} className="text-[length:var(--text-xs)]">{SYDNEY_TIME_ZONE}</FrameDescription>
      </FrameHeader>
      {pinned && <div className="shrink-0 px-(--frame-panel-header-px) pb-[var(--space-2)]">{pinned}</div>}
      {/* The body scrolls; the footer below stays pinned so Cancel / Apply are always visible. */}
      <FramePanel className="flex min-h-0 flex-col p-0">
        <ScrollArea className="flex min-h-0 grow flex-col [--fade-size:var(--space-8)] sm:[--fade-size:var(--space-5)] *:data-[slot=scroll-area-viewport]:mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] *:data-[slot=scroll-area-viewport]:mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] *:data-[slot=scroll-area-viewport]:focus-visible:ring-0 has-[[data-slot=scroll-area-viewport]:focus-visible]:ring-[3px] has-[[data-slot=scroll-area-viewport]:focus-visible]:ring-ring/50">
          <div ref={contentRef} className="px-(--frame-panel-px) py-(--frame-panel-py)">{children}</div>
        </ScrollArea>
      </FramePanel>
      <FrameFooter className="shrink-0 flex-row justify-end gap-[var(--space-2)]">
        <Button type="button" variant="outline" disabled={applying} onClick={onCancel}>Cancel</Button>
        <Button type="button" disabled={applying || applyDisabled} onClick={onApply}>Apply</Button>
      </FrameFooter>
    </Frame>
  );
}
