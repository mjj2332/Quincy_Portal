import { deadlineOffsetLabel, type ProjectDeadlineReminderConsequence } from "@quincy/shared";

export type ProductionCalendarMoveConfirmationProps = {
  street: string;
  oldCivil: string;
  newCivil: string;
  consequences: ProjectDeadlineReminderConsequence[];
};

function civil(value: string): string {
  return value.replace("T", " ");
}

function consequenceLabel(label: ProjectDeadlineReminderConsequence["label"]): string {
  if (label === "elapsed_at_save") return "will have already passed when saved";
  if (label === "shifted_wall_clock_hour") return "fires an hour earlier/later (daylight-saving)";
  return "future";
}

function offsetLabel(offsetMinutes: number): string {
  return `${deadlineOffsetLabel(offsetMinutes)} before`;
}

export function ProductionCalendarMoveConfirmation({ street, oldCivil, newCivil, consequences }: ProductionCalendarMoveConfirmationProps) {
  return (
    <div className="qc-calendar-confirmation" data-testid="calendar-move-confirmation">
      <p className="qc-calendar-confirmation__summary"><strong>{street}</strong><br />{civil(oldCivil)} <span aria-hidden="true">→</span> {civil(newCivil)} Sydney time</p>
      {consequences.length === 0 ? <p className="muted">No reminders are set.</p> : <ul className="qc-calendar-confirmation__list">
        {consequences.map((consequence) => (
          <li key={`${consequence.offsetMinutes}:${consequence.newFireAt}`}>
            <span className="qc-calendar-confirmation__offset">{offsetLabel(consequence.offsetMinutes)}</span>
            <span>{civil(consequence.oldLocalCivil)} <span aria-hidden="true">→</span> {civil(consequence.newLocalCivil)}</span>
            <span className={`qc-calendar-pill qc-calendar-pill--${consequence.label}`}>{consequenceLabel(consequence.label)}</span>
          </li>
        ))}
      </ul>}
    </div>
  );
}
