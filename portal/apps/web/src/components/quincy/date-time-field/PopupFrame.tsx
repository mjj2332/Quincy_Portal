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
 * sitting there reads muddy. Nudges the body down by the least amount that clears the fade, and only
 * until the person scrolls it themselves. The body's height settles after Base UI positions the popup,
 * so it re-runs when the body is resized.
 */
function useSelectedClearOfFade(contentRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const viewport = contentRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    let applied = 0;
    const clear = () => {
      if (viewport.scrollTop !== applied) { observer?.disconnect(); return; } // the person scrolled
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;visibility:hidden;width:0;height:var(--fade-size)";
      viewport.append(probe);
      const fade = probe.getBoundingClientRect().height;
      probe.remove();
      viewport.scrollTop = 0;
      const box = viewport.getBoundingClientRect();
      const items = [...viewport.querySelectorAll<HTMLElement>(SELECTED)].map((item) => item.getBoundingClientRect());
      viewport.scrollTop = scrollTopClearOfFade({ viewport: box, scrollTop: 0, maxScrollTop: viewport.scrollHeight - viewport.clientHeight, fade, items });
      applied = viewport.scrollTop; // the browser may round it
    };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(clear);
    observer?.observe(viewport);
    clear();
    return () => observer?.disconnect();
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
