/**
 * #222 — the checklist schedule editor's field body and draft logic, extracted from
 * `ProductionCalendarScheduleEditor.tsx` so two shells could render it: the FullCalendar renderer's
 * `Modal` (`ProductionCalendarScheduleEditor`, deleted in #224) and the event-calendar
 * renderer's `reui/sheet` (`ProductionEventCalendarDialogs.tsx`), now its only shell.
 *
 * The draft/seed/normalise/validate code and every DOM hook the tests select
 * (`aria-label="Checklist … date|time"`, `Checklist endpoint mode`,
 * the fold radios and the `role="alert"` error) moved unchanged; #224 re-framed the fold radios
 * in `reui/field` `FieldSet`/`FieldLegend`, because their only styling lived in the retired
 * `production-calendar.css`. The shell owns only its frame and its footer (Cancel / Save schedule), which call `submit` from
 * `useChecklistScheduleDraft`.
 */
import { foldToDisambiguation } from "../lib/fold-disambiguation";
import { useId, useState, type JSX } from "react";
import {
  normalizeChecklistSchedule,
  resolveSydneyCivilMinute,
  type ChecklistCalendarEventDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type ChecklistScheduleDto,
  type ChecklistScheduleEndpointInput,
  type ChecklistScheduleValidationError,
  type InitialChecklistScheduleInput,
  type RangeChecklistScheduleInput,
  oneDaySubtaskRange,
} from "@quincy/shared";
import { cn } from "@/lib/utils";
import { FieldLegend, FieldSet } from "./reui/field";
import { Input } from "./reui/input";
import { POPOVER_LABEL } from "./AnchoredPopover";
import { NativeSelect } from "./quincy/NativeSelect";
import { utcOffsetLabel } from "../lib/sydney-time-labels";

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
const EDITOR_SELECT = FIELD_COMPACT;
const EDITOR_ENDPOINTS = "grid grid-cols-2 gap-[16px] max-[721px]:grid-cols-1";
const EDITOR_ENDPOINT = "grid gap-[10px] min-w-0 m-0 p-[14px] border border-solid border-border";
const EDITOR_ENDPOINT_LEGEND = "px-[4px] text-foreground text-[12px] font-semibold";
const EDITOR_ENDPOINT_LABEL = "grid gap-[5px] text-muted-foreground text-[11px]";
// #224: was `.qc-calendar-schedule-editor__fold` in the retired `production-calendar.css`. No
// hairline: a `<fieldset>` border runs through its `<legend>`, which drew a rule beside the text,
// and the endpoint's own fieldset already frames it. Matches the move dialog's fold.
const EDITOR_FOLD = "gap-[var(--space-1)]";
const EDITOR_INPUT = FIELD_COMPACT;
const EDITOR_ERROR =
  "px-[12px] py-[10px] border-l-[3px] [border-left-style:solid] border-l-signal-critical " +
  "bg-[color-mix(in_srgb,var(--signal-critical)_8%,transparent)] text-signal-critical " +
  "[font:400_12px/1.4_var(--font-sans)]";

export type ChecklistScheduleEditorEvent = ChecklistCalendarEventDto | ChecklistCalendarUnscheduledEntryDto;
type EndpointKind = "date" | "timed";
type EndpointDraft = { date: string; time: string; disambiguation?: "earlier" | "later" };
export type ChecklistScheduleDraft = { kind: EndpointKind; start: EndpointDraft; end: EndpointDraft };

export type ProductionCalendarScheduleEditorError = { code: string; message: string; endpoint?: ChecklistScheduleValidationError["endpoint"]; choices?: ChecklistScheduleValidationError["choices"] };

function civilParts(value: string): { date: string; time: string } {
  const [date = "", time = ""] = value.split("T");
  return { date, time };
}

function endpointDraft(value: ChecklistScheduleEndpointInput | { kind: EndpointKind; localCivil: string } | null, fallbackKind: EndpointKind): EndpointDraft {
  const parts = civilParts(value?.localCivil ?? "");
  const disambiguation = value && "disambiguation" in value
    ? value.disambiguation
    : value && "fold" in value ? foldToDisambiguation(value.fold) : undefined;
  return { date: parts.date, time: parts.time, disambiguation };
}

const blankDraft = (): ChecklistScheduleDraft => ({ kind: "date", start: { date: "", time: "" }, end: { date: "", time: "" } });

function draftFromRange(value: RangeChecklistScheduleInput): ChecklistScheduleDraft {
  const kind = value.end.kind;
  return { kind, start: endpointDraft(value.start, kind), end: endpointDraft(value.end, kind) };
}

// A legacy row (unscheduled, due only) seeds a one-day range on its due for the user to confirm.
// The Project's shoot date and Deadline are not on the calendar entry, so the shared default range is not available here.
// An unusable due seeds blank fields rather than garbage.
function seedFromDue(end: ChecklistScheduleEndpointInput | null): ChecklistScheduleDraft {
  const range = end ? oneDaySubtaskRange(end) : null;
  return range ? draftFromRange(range) : blankDraft();
}

function scheduleDraft(value: ChecklistScheduleDto): ChecklistScheduleDraft {
  if (value.state === "invalid" || value.state === "unscheduled") return blankDraft();
  if (value.state === "legacy_unresolved") return seedFromDue({ kind: value.due.includes("T") ? "timed" : "date", localCivil: value.due });
  if (value.state === "due_only") {
    const end = value.end;
    if (!end) return blankDraft();
    // Keep a stored fold as the end's occurrence, as a range end would.
    const disambiguation = end.kind === "timed" ? foldToDisambiguation(end.fold) : undefined;
    return seedFromDue(end.kind === "timed" ? { kind: "timed", localCivil: end.localCivil, ...(disambiguation ? { disambiguation } : {}) } : { kind: "date", localCivil: end.localCivil });
  }
  const kind = value.end?.kind ?? value.start?.kind ?? "date";
  return { kind, start: endpointDraft(value.start, kind), end: endpointDraft(value.end, kind) };
}

// A retained or server-returned draft can still carry a legacy shape: it seeds a one-day range too.
function draftFromInput(value: InitialChecklistScheduleInput): ChecklistScheduleDraft {
  if (value.state === "range") return draftFromRange(value);
  return value.state === "due_only" ? seedFromDue(value.end) : blankDraft();
}

function toEndpointInput(value: EndpointDraft, kind: EndpointKind): ChecklistScheduleEndpointInput {
  if (kind === "date") return { kind, localCivil: value.date };
  return { kind, localCivil: `${value.date}T${value.time}`, ...(value.disambiguation ? { disambiguation: value.disambiguation } : {}) };
}

function scheduleInput(value: ChecklistScheduleDraft): RangeChecklistScheduleInput {
  return { state: "range", start: toEndpointInput(value.start, value.kind), end: toEndpointInput(value.end, value.kind) };
}

function errorText(error: ProductionCalendarScheduleEditorError): string {
  switch (error.code) {
    case "subtask_schedule_nonexistent_local_time": return "That time does not exist in Sydney on that date (daylight-saving gap). Choose another time.";
    case "subtask_schedule_invalid_order": return "The range start must be before its end.";
    case "subtask_schedule_mixed_endpoint_kinds": return "Range endpoints must use the same Date or Timed mode.";
    case "subtask_schedule_repeated_local_time": return "That time occurs twice in Sydney that day. Choose the occurrence for this endpoint.";
    default: return error.message || "Review the schedule values and try again.";
  }
}

function endpointLabel(which: "start" | "end"): string { return which === "start" ? "Start" : "End"; }

export type ChecklistScheduleDraftInput = {
  event: ChecklistScheduleEditorEvent;
  onSubmit: (schedule: RangeChecklistScheduleInput) => void;
  initialSchedule?: InitialChecklistScheduleInput;
  validationError?: ProductionCalendarScheduleEditorError;
};

export type ChecklistScheduleDraftState = {
  draft: ChecklistScheduleDraft;
  setDraft: (update: (current: ChecklistScheduleDraft) => ChecklistScheduleDraft) => void;
  error: ProductionCalendarScheduleEditorError | undefined;
  setEndpoint: (which: "start" | "end", next: Partial<EndpointDraft>) => void;
  /** Validates locally; calls `onSubmit` only when the draft normalises. */
  submit: () => void;
};

/** The editor's draft state and its submit, shared by both shells. */
export function useChecklistScheduleDraft({ event, onSubmit, initialSchedule, validationError }: ChecklistScheduleDraftInput): ChecklistScheduleDraftState {
  const initial = initialSchedule ? draftFromInput(initialSchedule) : scheduleDraft(event.schedule);
  const [draft, setDraft] = useState<ChecklistScheduleDraft>(initial);
  const [error, setError] = useState<ProductionCalendarScheduleEditorError | undefined>(validationError);

  const setEndpoint = (which: "start" | "end", next: Partial<EndpointDraft>) => {
    setDraft((current) => ({ ...current, [which]: { ...current[which], ...next } }));
    setError((current) => current?.endpoint === which ? undefined : current);
  };

  const submit = () => {
    const input = scheduleInput(draft);
    const result = normalizeChecklistSchedule(input, event.schedule.version);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(undefined);
    onSubmit(input);
  };

  return { draft, setDraft, error, setEndpoint, submit };
}

export type ProductionCalendarScheduleEditorFieldsProps = {
  state: ChecklistScheduleDraftState;
};

/** The editor body: intro, endpoint mode select, start and end fieldsets, fold radios, error. */
export function ProductionCalendarScheduleEditorFields({ state }: ProductionCalendarScheduleEditorFieldsProps): JSX.Element {
  const { draft, setDraft, error, setEndpoint } = state;
  const groupId = useId();

  const endpointFields = (which: "start" | "end", value: EndpointDraft): JSX.Element => <fieldset className={EDITOR_ENDPOINT}>
    <legend className={EDITOR_ENDPOINT_LEGEND}>{endpointLabel(which)}</legend>
    <label className={EDITOR_ENDPOINT_LABEL} htmlFor={`${groupId}-${which}-date`}>Date<Input className={EDITOR_INPUT} id={`${groupId}-${which}-date`} aria-label={`Checklist ${which} date`} type="date" value={value.date} onChange={(input) => setEndpoint(which, { date: input.target.value })} /></label>
    {draft.kind === "timed" && <label className={EDITOR_ENDPOINT_LABEL} htmlFor={`${groupId}-${which}-time`}>Time<Input className={EDITOR_INPUT} id={`${groupId}-${which}-time`} aria-label={`Checklist ${which} time`} type="time" step={60} value={value.time} onChange={(input) => setEndpoint(which, { time: input.target.value })} /></label>}
    {(() => {
      const localCivil = `${value.date}T${value.time}`;
      const resolved = draft.kind === "timed" && value.date && value.time ? resolveSydneyCivilMinute(localCivil) : null;
      const choices = error?.endpoint === which && error.choices?.length ? error.choices : resolved && !resolved.ok && resolved.code === "repeated_local_time" ? resolved.choices : undefined;
      return choices && choices.length > 0 ? <FieldSet className={EDITOR_FOLD}>
      <FieldLegend className={FOLD_LEGEND}>Choose the Sydney occurrence</FieldLegend>
      {choices.map((choice) => <label key={`${which}-${choice.disambiguation}`} className={FOLD_RADIO_ROW}>
        <input className={FOLD_RADIO} type="radio" name={`${groupId}-${which}-fold`} value={choice.disambiguation} checked={value.disambiguation === choice.disambiguation} onChange={() => setEndpoint(which, { disambiguation: choice.disambiguation })} />
        {choice.disambiguation === "earlier" ? "Earlier" : "Later"} occurrence ({utcOffsetLabel(choice.utcOffsetMinutes)})
      </label>)}
    </FieldSet> : null;
    })()}
  </fieldset>;

  return <div className={EDITOR}>
    <p className={EDITOR_INTRO}>Sydney civil time is saved exactly as entered. Both endpoints use the same mode.</p>
    <label className={POPOVER_LABEL} htmlFor={`${groupId}-mode`}>Date or time
      <NativeSelect className={EDITOR_SELECT} id={`${groupId}-mode`} aria-label="Checklist endpoint mode" value={draft.kind} onChange={(input) => setDraft((current) => ({ ...current, kind: input.target.value as EndpointKind }))}>
        <option value="date">Date</option>
        <option value="timed">Timed · Australia/Sydney</option>
      </NativeSelect>
    </label>
    <div className={EDITOR_ENDPOINTS}>{endpointFields("start", draft.start)}{endpointFields("end", draft.end)}</div>
    {error && <div className={EDITOR_ERROR} role="alert">{errorText(error)}</div>}
  </div>;
}

function entryLabel(event: ChecklistScheduleEditorEvent): string {
  if ("reason" in event && event.reason === "schedule_needs_attention" && event.attentionReason === "legacy_unresolved") return "Repair schedule";
  return event.schedule.state === "unscheduled" ? "Schedule" : "Reschedule";
}

export function checklistScheduleEditorButtonLabel(event: ChecklistScheduleEditorEvent): string {
  return entryLabel(event);
}
