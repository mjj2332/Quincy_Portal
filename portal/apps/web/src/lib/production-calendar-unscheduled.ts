/**
 * #222 — the unscheduled-entry rules both Calendar renderers shared. Moved verbatim out of
 * `components/ProductionCalendarUnscheduledPanel.tsx` (deleted in #224), because that module
 * imported FullCalendar's `Draggable` and the event-calendar renderer must not pull FullCalendar
 * into its chunk to reach two predicates and a label map.
 */
import type { ChecklistCalendarUnscheduledEntryDto, ProjectCalendarUnscheduledEntryDto } from "@quincy/shared";

const STAGE_LABELS: Record<string, string> = {
  awaiting_raw: "Awaiting RAW",
  raw_review: "RAW review",
  editing_autohdr: "Editing · autoHDR",
  editing: "Editing",
  edited_review: "Edited review",
  delivered: "Delivered",
};

export function unscheduledStageLabel(stageKey: string): string {
  return STAGE_LABELS[stageKey] ?? stageKey;
}

export function unscheduledProjectDraggable(entry: ProjectCalendarUnscheduledEntryDto): boolean {
  return !entry.project.delivered && entry.permissions.canDrag;
}

export function unscheduledChecklistDraggable(entry: ChecklistCalendarUnscheduledEntryDto, rangesEnabled: boolean): boolean {
  return rangesEnabled && entry.reason === "unscheduled" && entry.permissions.canDrag && entry.permissions.canScheduleRange;
}
