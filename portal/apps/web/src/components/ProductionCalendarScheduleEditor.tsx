import type { JSX } from "react";
import type { InitialChecklistScheduleInput } from "@quincy/shared";
import { Modal } from "./Modal";
import { buttonClasses } from "./quincy/Button";
import {
  ProductionCalendarScheduleEditorFields,
  useChecklistScheduleDraft,
  type ChecklistScheduleEditorEvent,
  type ProductionCalendarScheduleEditorError,
} from "./ProductionCalendarScheduleEditorFields";

// #222: the field body and draft logic live in `ProductionCalendarScheduleEditorFields.tsx`,
// shared with the event-calendar renderer's sheet; this file is the FullCalendar renderer's Modal
// frame around them, unchanged in behaviour.
export type { ProductionCalendarScheduleEditorError } from "./ProductionCalendarScheduleEditorFields";

type ScheduleEvent = ChecklistScheduleEditorEvent;

export type ProductionCalendarScheduleEditorProps = {
  open: boolean;
  event: ScheduleEvent;
  rangesEnabled: boolean;
  onSubmit: (schedule: InitialChecklistScheduleInput) => void;
  onCancel: () => void;
  /** Used when a failed save must reopen the editor without discarding the draft. */
  initialSchedule?: InitialChecklistScheduleInput;
  validationError?: ProductionCalendarScheduleEditorError;
};

function entryLabel(event: ScheduleEvent): string {
  if ("reason" in event && event.reason === "schedule_needs_attention" && event.attentionReason === "legacy_unresolved") return "Repair schedule";
  return event.schedule.state === "unscheduled" ? "Schedule" : "Reschedule";
}

export function ProductionCalendarScheduleEditor({ open, event, rangesEnabled, onSubmit, onCancel, initialSchedule, validationError }: ProductionCalendarScheduleEditorProps): JSX.Element | null {
  const state = useChecklistScheduleDraft({ event, rangesEnabled, onSubmit, initialSchedule, validationError });

  if (event.schedule.state === "invalid") return null;

  return <Modal open={open} title="Schedule checklist item" eyebrow={event.project.street} onClose={onCancel} wide initialFocus={0} testId="calendar-schedule-editor" variant="calendar" footer={<>
    <button className={buttonClasses("secondary")} type="button" data-testid="calendar-schedule-cancel" onClick={onCancel}>Cancel</button>
    <button className={buttonClasses()} type="button" data-testid="calendar-schedule-submit" onClick={state.submit}>Save schedule</button>
  </>}>
    <ProductionCalendarScheduleEditorFields rangesEnabled={rangesEnabled} state={state} />
  </Modal>;
}

export function checklistScheduleEditorButtonLabel(event: ScheduleEvent): string {
  return entryLabel(event);
}
