import { useId, useState, type JSX } from "react";
import type { ProjectDeadlineCalendarEventDto, ProjectDeadlineDisambiguation } from "@quincy/shared";
import { Modal } from "./Modal";

export type ProductionCalendarMoveDialogProps = {
  event: ProjectDeadlineCalendarEventDto;
  initialCivil?: string;
  foldChoices?: Array<{ disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number }>;
  onSubmit: (localCivil: string, disambiguation?: ProjectDeadlineDisambiguation) => void;
  onCancel: () => void;
};

function civilParts(value: string): { date: string; time: string } {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  return match ? { date: match[1] ?? "", time: match[2] ?? "" } : { date: "", time: "" };
}

function validCivil(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day >= 1 && day <= daysInMonth;
}

function utcOffsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

export function ProductionCalendarMoveDialog({ event, initialCivil, foldChoices, onSubmit, onCancel }: ProductionCalendarMoveDialogProps): JSX.Element {
  const initial = civilParts(initialCivil ?? event.deadlineLocalCivil);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [disambiguation, setDisambiguation] = useState<ProjectDeadlineDisambiguation | undefined>();
  const groupId = useId();
  const localCivil = `${date}T${time}`;
  const valid = validCivil(localCivil) && (!foldChoices || foldChoices.length === 0 || disambiguation !== undefined);

  return <Modal title="Move / Reschedule Deadline" eyebrow={event.project.street} onClose={onCancel} initialFocus={0} testId="calendar-move-dialog" footer={<>
    <button className="button button--secondary" type="button" data-testid="calendar-move-cancel" onClick={onCancel}>Cancel</button>
    <button className="button" type="button" data-testid="calendar-move-submit" disabled={!valid} onClick={() => onSubmit(localCivil, disambiguation)}>Save Deadline</button>
  </>}>
    <div className="qc-calendar-move-dialog__inputs">
      <label>Date<input aria-label="Deadline date" type="date" value={date} onChange={(input) => setDate(input.target.value)} /></label>
      <label>Time<input aria-label="Deadline time" type="time" value={time} onChange={(input) => setTime(input.target.value)} /></label>
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
