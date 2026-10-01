import type { ReactNode, Ref } from "react";
import { Button } from "@/components/reui/button";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { SYDNEY_TIME_ZONE } from "@quincy/shared";
import { Eyebrow } from "../Eyebrow";

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
  return (
    <Frame ref={bodyRef} spacing="sm" className="max-h-[var(--available-height)] min-h-0">
      <FrameHeader>
        <FrameTitle><Eyebrow>{label}</Eyebrow></FrameTitle>
        <FrameDescription id={zoneId} className="text-[length:var(--text-xs)]">{SYDNEY_TIME_ZONE}</FrameDescription>
      </FrameHeader>
      {pinned && <div className="shrink-0 px-(--frame-panel-header-px) pb-[var(--space-2)]">{pinned}</div>}
      {/* The body scrolls; the footer below stays pinned so Cancel / Apply are always visible. */}
      <FramePanel className="min-h-0 overflow-y-auto">{children}</FramePanel>
      <FrameFooter className="shrink-0 flex-row justify-end gap-[var(--space-2)]">
        <Button type="button" variant="outline" disabled={applying} onClick={onCancel}>Cancel</Button>
        <Button type="button" disabled={applying || applyDisabled} onClick={onApply}>Apply</Button>
      </FrameFooter>
    </Frame>
  );
}
