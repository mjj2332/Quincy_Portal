import { useLayoutEffect, useRef, type ReactNode, type Ref, type RefObject } from "react";
import { scrollTopClearOfFade } from "@/lib/date-time-field";
import { Button } from "@/components/reui/button";
import { ScrollArea } from "@/components/reui/scroll-area";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { SYDNEY_TIME_ZONE } from "@quincy/shared";
import { Eyebrow } from "../Eyebrow";

/** The picked day and the pressed time slot: what must read as solid ink, never under the body's fade. */
const SELECTED = '[aria-selected="true"] button, [role="group"][aria-label="Time slots"] button[aria-pressed="true"]';

/**
 * #537 — the body opens at scroll 0 (#528) with its bottom edge faded, so a selected day or time slot
 * sitting there reads muddy. This nudges the body down by the least amount that clears the fade.
 *
 * Opt-out rule: once the person scrolls the body themselves (`userScrolled`, latched), the AUTOMATIC
 * nudge (mount, and the resize that follows Base UI sizing the popup) stops for good, even after a
 * selection nudge has since put the body somewhere this hook chose. A change of selection is not an automatic
 * nudge, and a click is not a manual scroll: whenever the selection changes (a day, a time slot) the
 * newly selected item is always cleared of the fade, by the least scroll from where the body is, in
 * either direction.
 */
function useSelectedClearOfFade(contentRef: RefObject<HTMLDivElement | null>) {
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
    const nudge = (fromTop: boolean) => {
      const fade = measure();
      if (fromTop) viewport.scrollTop = 0;
      const items = [...viewport.querySelectorAll<HTMLElement>(SELECTED)].map((item) => item.getBoundingClientRect());
      viewport.scrollTop = scrollTopClearOfFade({ viewport: viewport.getBoundingClientRect(), scrollTop: viewport.scrollTop, maxScrollTop: viewport.scrollHeight - viewport.clientHeight, fade, items });
      applied = viewport.scrollTop; // the browser may round it
    };
    const automatic = () => { noticeScroll(); if (!userScrolled) nudge(true); };
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(automatic);
    resize?.observe(viewport);
    viewport.addEventListener("scroll", noticeScroll, { passive: true });
    // A selection change: the day's `aria-selected`, a slot's `aria-pressed`, or a re-rendered grid (another month).
    const selection = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(() => { const now = signature(); if (now === selected) return; selected = now; noticeScroll(); nudge(false); });
    selection?.observe(content, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected", "aria-pressed"] });
    automatic();
    return () => { resize?.disconnect(); selection?.disconnect(); viewport.removeEventListener("scroll", noticeScroll); };
  }, [contentRef]);
}

/**
 * The popup shell both forms of `DateTimeField` share: a `reui/frame` with the label, the zone, a
 * scrolling body and a footer pinned below it so Cancel / Apply are always visible (#421). The
 * body is the caller's; the footer's two actions are the same for every form.
 */
export function PopupFrame({ label, zoneId, bodyRef, applying, applyDisabled = false, pinned, onCancel, onApply, children }: {
  label: string;
  zoneId: string;
  bodyRef: Ref<HTMLDivElement>;
  applying: boolean;
  applyDisabled?: boolean;
  /** Controls drawn between the header and the scrolling body, so they stay visible while it scrolls. */
  pinned?: ReactNode;
  onCancel: () => void;
  onApply: () => void;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  useSelectedClearOfFade(contentRef);
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
