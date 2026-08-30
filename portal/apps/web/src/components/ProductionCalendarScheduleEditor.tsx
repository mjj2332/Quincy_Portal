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
} from "@quincy/shared";
import { Modal } from "./Modal";

type ScheduleEvent = ChecklistCalendarEventDto | ChecklistCalendarUnscheduledEntryDto;
type EndpointKind = "date" | "timed";
type EndpointDraft = { date: string; time: string; disambiguation?: "earlier" | "later" };
type ScheduleDraft = { state: "unscheduled" | "due_only" | "range"; kind: EndpointKind; start: EndpointDraft; end: EndpointDraft };

export type ProductionCalendarScheduleEditorError = { code: string; message: string; endpoint?: ChecklistScheduleValidationError["endpoint"]; choices?: ChecklistScheduleValidationError["choices"] };

export type ProductionCalendarScheduleEditorProps = {
  event: ScheduleEvent;
  rangesEnabled: boolean;
  onSubmit: (schedule: InitialChecklistScheduleInput) => void;
  onCancel: () => void;
  /** Used when a failed save must reopen the editor without discarding the draft. */
  initialSchedule?: InitialChecklistScheduleInput;
  validationError?: ProductionCalendarScheduleEditorError;
};

function civilParts(value: string): { date: string; time: string } {
  const [date = "", time = ""] = value.split("T");
  return { date, time };
}

function endpointDraft(value: ChecklistScheduleEndpointInput | { kind: EndpointKind; localCivil: string } | null, fallbackKind: EndpointKind): EndpointDraft {
  const parts = civilParts(value?.localCivil ?? "");
  const disambiguation = value && "disambiguation" in value
    ? value.disambiguation
    : value && "fold" in value && (value.fold === 0 || value.fold === 1)
      ? value.fold === 0 ? "earlier" : "later"
      : undefined;
  return { date: parts.date, time: parts.time, disambiguation };
}

function scheduleDraft(value: ChecklistScheduleDto): ScheduleDraft {
  if (value.state === "invalid") return { state: "unscheduled", kind: "date", start: endpointDraft(null, "date"), end: endpointDraft(null, "date") };
  if (value.state === "legacy_unresolved") {
    const kind = value.due.includes("T") ? "timed" : "date";
    return { state: "due_only", kind, start: endpointDraft(null, kind), end: endpointDraft({ kind, localCivil: value.due }, kind) };
  }
  const kind = value.end?.kind ?? value.start?.kind ?? "date";
  return { state: value.state, kind, start: endpointDraft(value.start, kind), end: endpointDraft(value.end, kind) };
}

function draftFromInput(value: InitialChecklistScheduleInput): ScheduleDraft {
  const blank = (kind: EndpointKind): EndpointDraft => ({ date: "", time: "" });
  if (value.state === "unscheduled") return { state: "unscheduled", kind: "date", start: blank("date"), end: blank("date") };
  const kind = value.end.kind;
  const start = value.state === "range" ? value.start : null;
  return { state: value.state, kind, start: start ? endpointDraft(start, kind) : blank(kind), end: endpointDraft(value.end, kind) };
}

function toEndpointInput(value: EndpointDraft, kind: EndpointKind): ChecklistScheduleEndpointInput {
  if (kind === "date") return { kind, localCivil: value.date };
  return { kind, localCivil: `${value.date}T${value.time}`, ...(value.disambiguation ? { disambiguation: value.disambiguation } : {}) };
}

function scheduleInput(value: ScheduleDraft): InitialChecklistScheduleInput {
  if (value.state === "unscheduled") return { state: "unscheduled" };
  const end = toEndpointInput(value.end, value.kind);
  if (value.state === "due_only") return { state: value.state, end };
  return { state: value.state, start: toEndpointInput(value.start, value.kind), end };
}

function entryLabel(event: ScheduleEvent): string {
  if ("reason" in event && event.reason === "schedule_needs_attention" && event.attentionReason === "legacy_unresolved") return "Repair schedule";
  return event.schedule.state === "unscheduled" ? "Schedule" : "Reschedule";
}

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "−" : "+";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
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

export function ProductionCalendarScheduleEditor({ event, rangesEnabled, onSubmit, onCancel, initialSchedule, validationError }: ProductionCalendarScheduleEditorProps): JSX.Element | null {
  const initial = initialSchedule ? draftFromInput(initialSchedule) : scheduleDraft(event.schedule);
  const [draft, setDraft] = useState<ScheduleDraft>(initial);
  const [error, setError] = useState<ProductionCalendarScheduleEditorError | undefined>(validationError);
  const groupId = useId();

  if (event.schedule.state === "invalid") return null;

  const setEndpoint = (which: "start" | "end", next: Partial<EndpointDraft>) => {
    setDraft((current) => ({ ...current, [which]: { ...current[which], ...next } }));
    setError((current) => current?.endpoint === which ? undefined : current);
  };

  const endpointFields = (which: "start" | "end", value: EndpointDraft): JSX.Element => <fieldset className="qc-calendar-schedule-editor__endpoint">
    <legend>{endpointLabel(which)}</legend>
    <label>{draft.kind === "timed" ? "Date" : "Date"}<input aria-label={`Checklist ${which} date`} type="date" value={value.date} onChange={(input) => setEndpoint(which, { date: input.target.value })} /></label>
    {draft.kind === "timed" && <label>Time<input aria-label={`Checklist ${which} time`} type="time" step={60} value={value.time} onChange={(input) => setEndpoint(which, { time: input.target.value })} /></label>}
    {(() => {
      const localCivil = `${value.date}T${value.time}`;
      const resolved = draft.kind === "timed" && value.date && value.time ? resolveSydneyCivilMinute(localCivil) : null;
      const choices = error?.endpoint === which && error.choices?.length ? error.choices : resolved && !resolved.ok && resolved.code === "repeated_local_time" ? resolved.choices : undefined;
      return choices && choices.length > 0 ? <fieldset className="qc-calendar-schedule-editor__fold">
      <legend>Choose the Sydney occurrence</legend>
      {choices.map((choice) => <label key={`${which}-${choice.disambiguation}`}>
        <input type="radio" name={`${groupId}-${which}-fold`} value={choice.disambiguation} checked={value.disambiguation === choice.disambiguation} onChange={() => setEndpoint(which, { disambiguation: choice.disambiguation })} />
        {choice.disambiguation === "earlier" ? "Earlier" : "Later"} occurrence ({offsetLabel(choice.utcOffsetMinutes)})
      </label>)}
    </fieldset> : null;
    })()}
  </fieldset>;

  const submit = () => {
    const input = scheduleInput(draft);
    if (!rangesEnabled && input.state === "range") {
      setError({ code: "subtask_schedule_mixed_endpoint_kinds", message: "Range scheduling is unavailable in this app version." });
      return;
    }
    const result = normalizeChecklistSchedule(input, event.schedule.version);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(undefined);
    onSubmit(input);
  };

  return <Modal title="Schedule checklist item" eyebrow={event.project.street} onClose={onCancel} wide initialFocus={0} testId="calendar-schedule-editor" footer={<>
    <button className="button button--secondary" type="button" data-testid="calendar-schedule-cancel" onClick={onCancel}>Cancel</button>
    <button className="button" type="button" data-testid="calendar-schedule-submit" onClick={submit}>Save schedule</button>
  </>}>
    <div className="qc-calendar-schedule-editor">
      <p className="qc-calendar-schedule-editor__intro">Sydney civil time is saved exactly as entered. Both endpoints use the same mode.</p>
      <label className="qc-calendar-schedule-editor__state">State
        <select aria-label="Checklist schedule state" value={draft.state} onChange={(input) => setDraft((current) => ({ ...current, state: input.target.value as ScheduleDraft["state"] }))}>
          <option value="unscheduled">Unscheduled</option>
          <option value="due_only">Due date only</option>
          <option value="range" disabled={!rangesEnabled}>Range{!rangesEnabled ? " · unavailable" : ""}</option>
        </select>
      </label>
      {draft.state !== "unscheduled" && <>
        <label className="qc-calendar-schedule-editor__state">Endpoint mode
          <select aria-label="Checklist endpoint mode" value={draft.kind} onChange={(input) => setDraft((current) => ({ ...current, kind: input.target.value as EndpointKind }))}>
            <option value="date">Date</option>
            <option value="timed">Timed · Australia/Sydney</option>
          </select>
        </label>
        {draft.state === "range" ? <div className="qc-calendar-schedule-editor__endpoints">{endpointFields("start", draft.start)}{endpointFields("end", draft.end)}</div> : endpointFields("end", draft.end)}
      </>}
      {error && <div className="qc-calendar-schedule-editor__error" role="alert">{errorText(error)}</div>}
    </div>
  </Modal>;
}

export function checklistScheduleEditorButtonLabel(event: ScheduleEvent): string {
  return entryLabel(event);
}
