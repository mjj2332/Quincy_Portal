/**
 * #222 — the checklist schedule editor's body and draft logic, extracted from
 * `ProductionCalendarScheduleEditor.tsx` so two shells could render it; the event-calendar
 * renderer's `reui/sheet` (`ProductionEventCalendarDialogs.tsx`) is now its only shell.
 *
 * #423 — every Subtask end is a moment (ADR 0016), so the Date / Timed select, the four native
 * endpoint inputs and the fold radios are gone: the body is one `quincy/DateTimeField` range field.
 * Its popup's Apply sets this DRAFT; the shell's footer ("Save schedule") is the only commit, which
 * calls `submit` from `useChecklistScheduleDraft` (normalised locally first, so the server's
 * validation is only ever the second line).
 *
 * #425 — the same popup carries the Subtask's reminder set (`RemindersStrip` inside `DateTimeRangePopup`). Its Apply puts the offsets in
 * this DRAFT beside the range, and "Save schedule" sends them only when they differ from the event's stored set, so a range-only save
 * never clobbers a set changed elsewhere.
 */
import { foldToDisambiguation } from "../lib/fold-disambiguation";
import { useId, useState, type JSX } from "react";
import {
  normalizeChecklistSchedule,
  resolveSydneyCivilMinute,
  type ChecklistCalendarEventDto,
  type ChecklistScheduleDto,
  type ChecklistScheduleValidationError,
  type RangeChecklistScheduleInput,
} from "@quincy/shared";
import type { ProjectDefaultRangeDto } from "@quincy/shared";
import { sameReminderOffsets } from "../lib/date-time-field";
import { DateTimeField, type DateTimeRangeApply } from "./quincy/DateTimeField";

// FIELD_BOX (shared by NativeSelect / reui/input) already carries the border, radius, field
// background and the `max-[721px]:min-h-[44px]` floor. This is the compact type/padding plus the
// coarse-pointer half of the 44px floor that the calendar dialogs layer on top of it.
export const FIELD_COMPACT =
  "text-foreground [font:400_13px/1.3_var(--font-sans)] tracking-normal px-[6px] py-[4px] pointer-coarse:min-h-[44px]";

// The Sydney-occurrence radios, shared with the Calendar's move and fold dialogs
// (`ProductionEventCalendarDialogs.tsx`) so every fold choice reads the same.
export const FOLD_RADIO_ROW = "flex items-center gap-[var(--space-2)] text-foreground text-[length:var(--text-xs)] max-[721px]:min-h-[44px]";
export const FOLD_RADIO = "size-[16px] accent-[var(--accent)]";
// `FieldLegend`'s own `data-[variant=legend]:text-base` outranks a plain size class (an attribute
// selector adds specificity, and tailwind-merge does not see the two as conflicting), so the size
// is set under the same variant.
export const FOLD_LEGEND = "mb-[var(--space-2)] text-foreground data-[variant=legend]:text-[length:var(--text-xs)] font-semibold";

const EDITOR = "grid gap-[16px]";
const EDITOR_INTRO = "m-0 text-foreground-secondary [font:400_14px/1.5_var(--font-body-serif)]";
// FIELD_BOX (shared by NativeSelect) already carries the border, radius, field background, the
// `max-[721px]:min-h-[44px]` floor and `w-full`, so the lone mode select lines up with the Start/End grid.
// #224: was `.qc-calendar-schedule-editor__fold` in the retired `production-calendar.css`. No
// hairline: a `<fieldset>` border runs through its `<legend>`, which drew a rule beside the text,
// and the endpoint's own fieldset already frames it. Matches the move dialog's fold.
const EDITOR_ERROR =
  "px-[12px] py-[10px] border-l-[3px] [border-left-style:solid] border-l-signal-critical " +
  "bg-[color-mix(in_srgb,var(--signal-critical)_8%,transparent)] text-signal-critical " +
  "[font:400_12px/1.4_var(--font-sans)]";

export type ChecklistScheduleEditorEvent = ChecklistCalendarEventDto;
/** The range half of a popup Apply; the offsets live beside it (`ChecklistScheduleDraftState.offsets`). */
export type ChecklistScheduleDraft = Pick<DateTimeRangeApply, "start" | "end">;

export type ProductionCalendarScheduleEditorError = { code: string; message: string; endpoint?: ChecklistScheduleValidationError["endpoint"]; choices?: ChecklistScheduleValidationError["choices"] };

/** The Earlier / Later choice a stored end carries, only while its minute happens twice in Sydney (a unique minute needs none). */
function foldChoiceFor(localCivil: string, fold: ChecklistScheduleDto["start"]["fold"]) {
  const resolution = resolveSydneyCivilMinute(localCivil);
  const choice = foldToDisambiguation(fold);
  return !resolution.ok && resolution.code === "repeated_local_time" && choice ? { disambiguation: choice } : {};
}

function scheduleDraft(value: ChecklistScheduleDto): ChecklistScheduleDraft {
  const endpoint = (end: ChecklistScheduleDto["start"]) => ({ localCivil: end.localCivil, ...foldChoiceFor(end.localCivil, end.fold) });
  return { start: endpoint(value.start), end: endpoint(value.end) };
}

function draftFromInput(value: RangeChecklistScheduleInput): ChecklistScheduleDraft {
  const endpoint = (end: RangeChecklistScheduleInput["start"]) => ({ localCivil: end.localCivil, ...(end.disambiguation ? { disambiguation: end.disambiguation } : {}) });
  return { start: endpoint(value.start), end: endpoint(value.end) };
}

function scheduleInput(value: ChecklistScheduleDraft): RangeChecklistScheduleInput {
  return { state: "range", start: value.start, end: value.end };
}

function errorText(error: ProductionCalendarScheduleEditorError): string {
  switch (error.code) {
    case "subtask_schedule_nonexistent_local_time": return "That time does not exist in Sydney on that date (daylight-saving gap). Choose another time.";
    case "subtask_schedule_invalid_order": return "The range start must be before its end.";
    case "subtask_schedule_time_required": return "Every end needs a date and a time.";
    case "subtask_schedule_repeated_local_time": return "That time occurs twice in Sydney that day. Open the schedule and choose Earlier or Later.";
    default: return error.message || "Review the schedule values and try again.";
  }
}

export type ChecklistScheduleDraftInput = {
  event: ChecklistScheduleEditorEvent;
  /** `reminderOffsetsMinutes` only when the draft set differs from the event's stored one (#425). */
  onSubmit: (schedule: RangeChecklistScheduleInput, reminderOffsetsMinutes?: number[]) => void;
  initialSchedule?: RangeChecklistScheduleInput;
  /** The offsets a failed save attempted, so the reopened editor keeps them (#425). */
  initialReminderOffsets?: number[];
  validationError?: ProductionCalendarScheduleEditorError;
};

export type ChecklistScheduleDraftState = {
  draft: ChecklistScheduleDraft;
  /** The draft reminder set (#425). */
  offsets: number[];
  /** Set by the range popup's Apply; nothing is saved until `submit`. */
  setDraft: (next: DateTimeRangeApply) => void;
  error: ProductionCalendarScheduleEditorError | undefined;
  /** Validates locally; calls `onSubmit` only when the draft normalises. */
  submit: () => void;
  /** The event the draft belongs to (its stored schedule seeds the field's value). */
  event: ChecklistScheduleEditorEvent;
};

/** The editor's draft state and its submit, shared by both shells. */
export function useChecklistScheduleDraft({ event, onSubmit, initialSchedule, initialReminderOffsets, validationError }: ChecklistScheduleDraftInput): ChecklistScheduleDraftState {
  const [draft, setDraftState] = useState<ChecklistScheduleDraft>(() => initialSchedule ? draftFromInput(initialSchedule) : scheduleDraft(event.schedule));
  const [offsets, setOffsets] = useState<number[]>(() => [...(initialReminderOffsets ?? event.reminders.offsetsMinutes)]);
  const [error, setError] = useState<ProductionCalendarScheduleEditorError | undefined>(validationError);

  const setDraft = (next: DateTimeRangeApply) => {
    setDraftState({ start: next.start, end: next.end });
    if (next.reminderOffsetsMinutes) setOffsets(next.reminderOffsetsMinutes);
    setError(undefined);
  };

  const submit = () => {
    const input = scheduleInput(draft);
    const result = normalizeChecklistSchedule(input, event.schedule.version);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(undefined);
    if (sameReminderOffsets(offsets, event.reminders.offsetsMinutes)) onSubmit(input);
    else onSubmit(input, offsets);
  };

  return { draft, offsets, setDraft, error, submit, event };
}

export type ProductionCalendarScheduleEditorFieldsProps = {
  state: ChecklistScheduleDraftState;
  /** The Project's default range, for the popup's "Project default" shortcut; null hides it. */
  projectDefault?: ProjectDefaultRangeDto | null;
};

const asRange = (value: ChecklistScheduleDraft) => ({
  start: { localCivil: value.start.localCivil, fold: (value.start.disambiguation === "later" ? 1 : 0) as 0 | 1 },
  end: { localCivil: value.end.localCivil, fold: (value.end.disambiguation === "later" ? 1 : 0) as 0 | 1 },
});

/** The editor body: intro, the range field (a Start | End popup), error. */
export function ProductionCalendarScheduleEditorFields({ state, projectDefault = null }: ProductionCalendarScheduleEditorFieldsProps): JSX.Element {
  const { draft, offsets, setDraft, error, event } = state;
  const id = useId();
  const saved = event.reminders.offsetsMinutes;
  // Reopened after an Apply that changed the set, the popup starts from the draft, not from the stored set. The popup mounts fresh
  // on every open, so the seed is read then; no `seedKey` (a changing key would remount the draft mid-Apply and skip its close).
  const seed = sameReminderOffsets(offsets, saved) ? undefined : { ...draft, reminderOffsetsMinutes: offsets };
  return <div className={EDITOR}>
    <p className={EDITOR_INTRO}>Sydney civil time is saved exactly as entered. Every end is a date and a time.</p>
    <DateTimeField
      variant="range"
      id={`${id}-schedule`}
      label="Schedule"
      value={asRange(draft)}
      projectDefault={projectDefault}
      positionerClassName="z-[calc(var(--z-dialog)+1)]"
      popupAlign="end"
      reminders={{ offsets: saved, next: event.reminders.nextOccurrence }}
      seed={seed}
      onApply={setDraft}
    />
    {error && <div className={EDITOR_ERROR} role="alert">{errorText(error)}</div>}
  </div>;
}
