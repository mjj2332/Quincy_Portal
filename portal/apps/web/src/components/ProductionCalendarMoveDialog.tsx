import { useId, useState, type JSX } from "react";
import type { ProjectDeadlineCalendarEventDto, ProjectDeadlineDisambiguation } from "@quincy/shared";
import { Modal } from "./Modal";
import { buttonClasses } from "./quincy/Button";
import { Input } from "./reui/input";
import { civilParts, validCivil } from "./ProductionEventCalendarDialogs";
import { FIELD_COMPACT } from "./ProductionCalendarScheduleEditorFields";
import { utcOffsetLabel } from "../lib/sydney-time-labels";

const MOVE_INPUTS = "grid grid-cols-2 gap-[12px]";
const MOVE_INPUT_LABEL = "grid gap-[5px] text-muted-foreground text-[11px]";
// FIELD_BOX (reui/input) already carries `min-h-[38px] max-[721px]:min-h-[44px]`, `border-border`,
// `rounded-[var(--radius-sm)]`, `bg-[var(--field-bg)]` and `w-full min-w-0`. Only the legacy
// compact type/padding and the coarse-pointer half of the 44px floor are local.
const MOVE_INPUT = FIELD_COMPACT;

export type ProductionCalendarMoveDialogProps = {
  open: boolean;
  event: ProjectDeadlineCalendarEventDto;
  initialCivil?: string;
  foldChoices?: Array<{ disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number }>;
  onSubmit: (localCivil: string, disambiguation?: ProjectDeadlineDisambiguation) => void;
  onCancel: () => void;
};

export function ProductionCalendarMoveDialog({ open, event, initialCivil, foldChoices, onSubmit, onCancel }: ProductionCalendarMoveDialogProps): JSX.Element {
  const initial = civilParts(initialCivil ?? event.deadlineLocalCivil);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [disambiguation, setDisambiguation] = useState<ProjectDeadlineDisambiguation | undefined>();
  const groupId = useId();
  const localCivil = `${date}T${time}`;
  const valid = validCivil(localCivil) && (!foldChoices || foldChoices.length === 0 || disambiguation !== undefined);

  return <Modal open={open} title="Move / Reschedule Deadline" eyebrow={event.project.street} onClose={onCancel} initialFocus={0} testId="calendar-move-dialog" variant="calendar" footer={<>
    <button className={buttonClasses("secondary")} type="button" data-testid="calendar-move-cancel" onClick={onCancel}>Cancel</button>
    <button className={buttonClasses()} type="button" data-testid="calendar-move-submit" disabled={!valid} onClick={() => onSubmit(localCivil, disambiguation)}>Save Deadline</button>
  </>}>
    <div className={MOVE_INPUTS}>
      <label className={MOVE_INPUT_LABEL}>Date<Input className={MOVE_INPUT} aria-label="Deadline date" type="date" value={date} onChange={(input) => setDate(input.target.value)} /></label>
      <label className={MOVE_INPUT_LABEL}>Time<Input className={MOVE_INPUT} aria-label="Deadline time" type="time" value={time} onChange={(input) => setTime(input.target.value)} /></label>
    </div>
    <p className="muted">Enter Sydney civil time. The value is not converted to this device’s time zone.</p>
    {foldChoices && foldChoices.length > 0 && <fieldset className="qc-calendar-move-dialog__fold">
      <legend>Choose which Sydney occurrence</legend>
      {foldChoices.map((choice) => <label key={choice.disambiguation}>
        <input type="radio" name={groupId} value={choice.disambiguation} checked={disambiguation === choice.disambiguation} onChange={() => setDisambiguation(choice.disambiguation)} />
        {choice.disambiguation === "earlier" ? "Earlier" : "Later"} occurrence ({utcOffsetLabel(choice.utcOffsetMinutes)})
      </label>)}
    </fieldset>}
  </Modal>;
}
