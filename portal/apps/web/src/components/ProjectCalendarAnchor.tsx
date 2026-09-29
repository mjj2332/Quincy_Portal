import { useRef, type ReactNode } from "react";

const PROJECT_ANCHOR_LINK = "text-inherit no-underline hover:underline hover:underline-offset-2 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-current focus-visible:outline-offset-2";

export type ProjectCalendarAnchorProps = {
  href: string;
  onOpenProject?: () => void;
  children: ReactNode;
};

/**
 * A real project anchor for the Calendar's rails, including the draggable Unscheduled rows. Native
 * modified clicks keep their browser behavior; an ordinary click or keyboard activation is
 * enhanced by the Calendar route owner. The small movement threshold stops a drag that starts on
 * the anchor from turning its terminating click into a sheet open.
 *
 * #224: moved out of the retired FullCalendar card (`ProductionCalendarEvent.tsx`); behaviour is
 * unchanged, pinned by `ProjectCalendarAnchor.dom.test.tsx`.
 */
export function ProjectCalendarAnchor({ href, onOpenProject, children }: ProjectCalendarAnchorProps) {
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const resetSuppression = () => {
    if (!suppressClickRef.current) return;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };
  const startPointer = (x: number, y: number) => {
    originRef.current = { x, y };
    suppressClickRef.current = false;
  };
  const movePointer = (x: number, y: number) => {
    const origin = originRef.current;
    if (!origin) return;
    // 4px: any gesture a drag source could recognise as a drag (FullCalendar's was 5px) must never
    // also open the sheet via this anchor's terminating click.
    if (Math.hypot(x - origin.x, y - origin.y) >= 4) suppressClickRef.current = true;
  };
  const endPointer = () => {
    originRef.current = null;
    resetSuppression();
  };
  return <a
    className={PROJECT_ANCHOR_LINK}
    data-testid="calendar-project-link"
    href={href}
    onMouseDown={(event) => startPointer(event.clientX, event.clientY)}
    onMouseMove={(event) => movePointer(event.clientX, event.clientY)}
    onMouseUp={endPointer}
    onTouchStart={(event) => { const point = event.touches[0]; if (point) startPointer(point.clientX, point.clientY); }}
    onTouchMove={(event) => { const point = event.touches[0]; if (point) movePointer(point.clientX, point.clientY); }}
    onTouchEnd={endPointer}
    onDragStart={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      // Space deliberately keeps native anchor behavior (page scroll, no
      // activation) per the approved plan — only Enter is synthesized here.
      if (event.key !== "Enter" || event.repeat) return;
      event.preventDefault();
      event.currentTarget.click();
    }}
    onClick={(event) => {
      if (suppressClickRef.current) {
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = false;
        return;
      }
      if (!onOpenProject || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenProject();
    }}
  >{children}</a>;
}
