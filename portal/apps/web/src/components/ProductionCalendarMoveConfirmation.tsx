import { deadlineOffsetLabel, type ProjectDeadlineReminderConsequence } from "@quincy/shared";
import { StatusPill, type StatusTone } from "./quincy/StatusPill";

export type ProductionCalendarMoveConfirmationProps = {
  street: string;
  oldCivil: string;
  newCivil: string;
  consequences: ProjectDeadlineReminderConsequence[];
};

const CONFIRM_PILL = "w-fit px-[6px] py-[2px] text-[10px]";
const CONFIRMATION = "grid gap-[12px]";
const CONFIRMATION_SUMMARY = "m-0 leading-[1.45]";
const CONFIRMATION_LIST = "grid gap-[9px] m-0 ps-[18px]";
const CONFIRMATION_ITEM = "grid gap-[2px] text-foreground-secondary text-[12px]";
const CONFIRMATION_OFFSET = "text-foreground font-semibold";

const CONSEQUENCE_TONE: Record<ProjectDeadlineReminderConsequence["label"], StatusTone> = {
  future: "positive",
  elapsed_at_save: "caution",
  shifted_wall_clock_hour: "info",
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
    <div className={CONFIRMATION} data-testid="calendar-move-confirmation">
      <p className={CONFIRMATION_SUMMARY}><strong>{street}</strong><br />{civil(oldCivil)} <span aria-hidden="true">→</span> {civil(newCivil)} Sydney time</p>
      {consequences.length === 0 ? <p className="muted">No reminders are set.</p> : <ul className={CONFIRMATION_LIST}>
        {consequences.map((consequence) => (
          <li key={`${consequence.offsetMinutes}:${consequence.newFireAt}`} className={CONFIRMATION_ITEM}>
            <span className={CONFIRMATION_OFFSET}>{offsetLabel(consequence.offsetMinutes)}</span>
            <span>{civil(consequence.oldLocalCivil)} <span aria-hidden="true">→</span> {civil(consequence.newLocalCivil)}</span>
            <StatusPill tone={CONSEQUENCE_TONE[consequence.label]} className={CONFIRM_PILL}>{consequenceLabel(consequence.label)}</StatusPill>
          </li>
        ))}
      </ul>}
    </div>
  );
}
