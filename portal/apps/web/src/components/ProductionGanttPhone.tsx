import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import type { GanttChecklistRowDto, GanttProjectRowDto, StagePresentationKey } from "@quincy/shared";
import { Button } from "@/components/reui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/reui/drawer";
import { lateLabel, stageTone } from "../lib/dashboard-appearance";
import { formatWeekdayDayOrToday, sydneyDayKey } from "../lib/date-format";
import type { ProductionGanttRowData } from "../lib/production-gantt-adapter";
import { TAP_SLOP } from "../lib/tap-slop";
import { cn } from "../lib/utils";
import { AvatarStack } from "./quincy/AvatarStack";
import { Button as QuincyButton } from "./quincy/Button";
import { StageToneSwatch } from "./quincy/StageKeyRow";

/**
 * #921 (#916, frame 3c, `design/prototypes/dashboard-views`, "Dashboard views v3"): the phone Timeline's parts.
 * At <= 720px the Timeline is view-only and draws no tree column (the vendor's `treePanel.placement: "inline"`):
 * each row's label (`.pl`: a mark, the name, a meta line) sits above its bar. The Stage key collapses to a 44px
 * "Key" button that opens a ReUI `Drawer` (owner decision D7: the Colour by switch lives in it too, not under
 * Display). `ProductionGantt.tsx` wires these; this file never imports the vendored gantt.
 */

/** A drawn row's facts: from its event when it has a bar, from the attention list when it has none. */
export type GanttPhoneRow =
  | { kind: "project"; dto: GanttProjectRowDto; data?: Extract<ProductionGanttRowData, { kind: "project" }>; end?: Date }
  | { kind: "task"; dto: GanttChecklistRowDto; data?: Extract<ProductionGanttRowData, { kind: "task" }>; end?: Date };

export type GanttPhoneMeta = { text: string; late: boolean };

/**
 * Frame 3c `.pm`, from the drawn bar's appearance (the same lateness the bar draws, so the two never disagree):
 * a Project reads "Editing · due Fri 18" (the Stage's short name, `stageShortLabelLookup`) or its late label; a Subtask reads "Done", its
 * late label, or "Due Mon 21". `null` for a row with no bar: its attention reason says why instead.
 */
export function phoneRowMeta(row: GanttPhoneRow, now: Date, stageShortLabelFor: (key: StagePresentationKey) => string | undefined): GanttPhoneMeta | null {
  if (!row.data || !row.end) return null;
  const late = lateLabel(row.data.appearance.lateness);
  if (late) return { text: late, late: true };
  if (row.kind === "task") {
    if (row.data.appearance.complete) return { text: "Done", late: false };
    return { text: `Due ${formatWeekdayDayOrToday(row.end, sydneyDayKey(now))}`, late: false };
  }
  const stage = stageShortLabelFor(row.data.appearance.tone.stage);
  const due = `due ${formatWeekdayDayOrToday(row.end, sydneyDayKey(now))}`;
  return { text: stage ? `${stage} · ${due}` : due.charAt(0).toUpperCase() + due.slice(1), late: false };
}

/** The Project a tap on this row's bar opens: its own, or a Subtask's parent. */
export function phoneRowProjectId(data: ProductionGanttRowData): string {
  return data.kind === "project" ? data.dto.id : data.dto.projectId;
}

/** Frame 3c `.pl`'s mark: a Project's Stage swatch, a Subtask's assignee (or the empty dashed circle). */
function GanttPhoneRowMark({ row }: { row: GanttPhoneRow }) {
  if (row.kind === "project") return <StageToneSwatch tone={row.data?.appearance.tone ?? stageTone(row.dto.stageKey)} />;
  return <AvatarStack people={row.dto.assignees} hiddenCount={row.dto.otherAssigneeCount} limit={1} personNoun="Assignee" emptyLabel="Unassigned" className="shrink-0" />;
}

/**
 * Frame 3c `.pl`: mark, name (14px, truncates), meta (12px; the late label in the late colour). `status` replaces the
 * meta for a row whose reason or error matters more (no Deadline, a failed child page with its Retry).
 */
export function GanttPhoneRowLabel({ row, name, meta, status }: { row: GanttPhoneRow; name: ReactNode; meta: GanttPhoneMeta | null; status?: ReactNode }) {
  return (
    <span data-testid="gantt-phone-label" className="flex min-w-0 flex-1 items-center gap-2 text-sm text-foreground">
      <GanttPhoneRowMark row={row} />
      <span className={cn("min-w-0 flex-1 truncate", row.kind === "task" && row.dto.done && "text-foreground-secondary")}>{name}</span>
      {status ?? (meta && (
        <span data-testid="gantt-phone-meta" className={cn("shrink-0 whitespace-nowrap text-xs", meta.late ? "text-late" : "text-foreground-secondary")}>
          {meta.text}
        </span>
      ))}
    </span>
  );
}

/**
 * A tap opens the Project; a press that travelled further than `TAP_SLOP` is a scroll and opens nothing. A keyboard click
 * (`detail` 0) has no press to measure and always counts. The capture handler goes on an ancestor of the bars.
 */
export function usePhoneTapGuard() {
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const onPointerDownCapture = useCallback((event: ReactPointerEvent) => {
    pressRef.current = { x: event.clientX, y: event.clientY };
  }, []);
  const isTap = useCallback((event: ReactMouseEvent) => {
    const press = pressRef.current;
    if (event.detail === 0 || !press) return true;
    return Math.hypot(event.clientX - press.x, event.clientY - press.y) < TAP_SLOP;
  }, []);
  return { onPointerDownCapture, isTap };
}

/**
 * The phone's key: a 44px "Key" button opening a bottom `Drawer` that holds the same key row the wider layouts draw
 * (`children`: the `StageKeyRow`, whose chips still write the Filter, or #920's `PeopleKeyRow`), and the Colour by switch.
 *
 * `colourBySlot` is the Colour by switch's place (D7). #920 owns that control and its state (`useTimelineColourBy`, held by
 * `ProductionGantt`); this drawer only gives it a home. Never a second Colour by state here.
 */
export function GanttKeyDrawer({ children, colourBySlot }: { children: ReactNode; colourBySlot?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Drawer open={open} onOpenChange={setOpen} swipeDirection="down" showSwipeHandle>
      <DrawerTrigger
        data-testid="production-gantt-key-button"
        render={<QuincyButton type="button" variant="secondary" className="h-11 min-w-11" />}
      >
        Key
      </DrawerTrigger>
      <DrawerContent
        data-testid="production-gantt-key-drawer"
        className="border-border bg-background text-foreground shadow-[var(--shadow-lg)] data-[swipe-direction=down]:rounded-t-[var(--radius-lg)]"
      >
        <div className="flex shrink-0 items-center justify-between gap-[var(--space-2)] ps-[var(--space-4)] pe-[var(--space-2)] pt-[var(--space-2)]">
          <DrawerTitle className="m-0 text-foreground [font:var(--weight-regular)_var(--text-md)/var(--leading-snug)_var(--font-display)]">Key</DrawerTitle>
          <DrawerClose aria-label="Close key" render={<Button type="button" variant="ghost" size="icon-header" className="shrink-0 rounded-[var(--radius-pill)]" />}>
            <XIcon aria-hidden="true" />
          </DrawerClose>
        </div>
        <div className="flex min-h-0 flex-col gap-[var(--space-4)] overflow-y-auto px-[var(--space-4)] pt-[var(--space-2)] pb-[calc(var(--space-6)+env(safe-area-inset-bottom))]">
          {children}
          {colourBySlot}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
