import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnchoredPopover, useAnchoredPopover, POPOVER_ACTIONS, POPOVER_CONTENT, POPOVER_LABEL, RING_IN } from "../AnchoredPopover";
import { formatCivilSchedule } from "../../lib/date-format";
import { type ChecklistScheduleDto, type RangeChecklistScheduleInput } from "@quincy/shared";
import { foldToDisambiguation } from "../../lib/fold-disambiguation";
import { cn } from "../../lib/utils";
import { META_TEXT } from "./Eyebrow";
import { Notice } from "./Notice";
import { Input } from "../reui/input";
import { NativeSelect } from "./NativeSelect";
import { StatusPill } from "./StatusPill";
import { buttonClasses } from "./Button";
import { META_TRIGGER } from "./icon-button";
import type { ProjectSubtask } from "../../lib/project-data";

const formatSchedule = formatCivilSchedule;
type Subtask = ProjectSubtask;

// `reui/input`'s FIELD_BOX still carries an outward ring (`focus-visible:ring-3
// focus-visible:ring-ring/50`) that twMerge cannot collapse against RING_IN's `!outline` —
// different property groups. `reui/button.tsx` had the same ring and divergence 5 there removed it
// outright; `reui/input.tsx` has NOT had that treatment yet, so the ring is zeroed here at the call
// site instead. Only the ring: NOT `focus-visible:border-ring`, because a border recolour sits
// inside the box and is never clipped by AnchoredPopover's `overflow:auto` panel, whereas blanking
// the border leaves the field borderless while focused. Not exported, per §4.3.
const FIELD_RING_IN = cn(RING_IN, "focus-visible:ring-0");
// The popover scrolls (AnchoredPopover caps its height), so Save/Cancel stay pinned to the bottom of the scroll area.
const POPOVER_ACTIONS_STICKY = cn(POPOVER_ACTIONS, "sticky bottom-0 z-[1] bg-popover pt-[var(--space-2)]");


// TB8-07 §5.4 — the composer trigger's compact-arm treatment. `META_TRIGGER`, not
// `ICON_BUTTON`/`IconButton`: the schedule/assignee triggers can hold a value chip
// (a formatted schedule string or an assignee's initials), same as the row triggers
// §5.2 gives `META_TRIGGER` to. A fixed-width glyph button would overflow. This
// The composer's trigger differs from the row's only in carrying a visible border:
// it sits in a control row rather than in a hovered list row, so it needs its own
// edge. Both arms are `META_TRIGGER` now; the hover-reveal both used to depend on
// is gone (§5.2).
const COMPOSER_TRIGGER_CLASSES = cn(META_TRIGGER, "border-solid border-[length:var(--border-width-hair)] border-border");


// TB8-07 §5.3 — the assignee popover's member row, ending in `RING_IN`'s four utilities like
// every other control inside a popover (§4.3).
// The DST-fold radio rows. `.subtask-schedule__fold label` was `display:flex; align-items:center;
// gap:5px` — a flex row, deliberately overriding `.subtask-popover__content label`'s grid. That
// override retires with the rule, so the row treatment moves here rather than being dropped.
// `min-h-[38px]`/44px is the same control floor the rest of this surface uses; the radio itself
// carries RING_IN because an outward ring clips inside the popover's `overflow: auto` panel.
const FOLD_CHOICE_LABEL =
  "flex items-center gap-[var(--space-1)] min-h-[38px] max-[721px]:min-h-[44px] cursor-pointer " +
  "[font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground";


type EndpointDraft = { kind: "date" | "timed"; date: string; time: string; disambiguation?: "earlier" | "later" };
type ScheduleDraft = { kind: "date" | "timed"; start: EndpointDraft; end: EndpointDraft };
// A Subtask is always a range (ADR 0011), so the editor saves only that shape.
export type RangeScheduleRequest = { expectedVersion: number; schedule: RangeChecklistScheduleInput };
export type ScheduleError = { endpoint?: "start" | "end"; choices?: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }>; current?: ChecklistScheduleDto; currentSubtask?: Subtask };
function civilParts(value: string | null) { const [date = "", time = ""] = (value ?? "").split("T"); return { date, time }; }
function endpointDraft(value: { kind: "date" | "timed"; localCivil: string } | null, fallbackKind: "date" | "timed" = "date"): EndpointDraft { const parts = civilParts(value?.localCivil ?? ""); return { kind: value?.kind ?? fallbackKind, date: parts.date, time: parts.time }; }
const BLANK_DRAFT: ScheduleDraft = { kind: "date", start: endpointDraft(null), end: endpointDraft(null) };
// A stored repeated-hour endpoint seeds its fold choice, so re-saving the range does not ask again.
function storedEndpointDraft(value: ChecklistScheduleDto["start"], fallbackKind: "date" | "timed"): EndpointDraft {
  const disambiguation = value.kind === "timed" ? foldToDisambiguation(value.fold) : undefined;
  return { ...endpointDraft(value, fallbackKind), ...(disambiguation ? { disambiguation } : {}) };
}
function scheduleDraft(value: ChecklistScheduleDto | null): ScheduleDraft {
  return value ? { kind: value.end.kind, start: storedEndpointDraft(value.start, value.end.kind), end: storedEndpointDraft(value.end, value.end.kind) } : BLANK_DRAFT;
}
function toEndpointInput(value: EndpointDraft): { kind: "date"; localCivil: string } | { kind: "timed"; localCivil: string; disambiguation?: "earlier" | "later" } {
  return value.kind === "date" ? { kind: "date", localCivil: value.date } : { kind: "timed", localCivil: `${value.date}T${value.time}`, ...(value.disambiguation ? { disambiguation: value.disambiguation } : {}) };
}
function scheduleInput(value: ScheduleDraft): RangeChecklistScheduleInput {
  return { state: "range", start: toEndpointInput({ ...value.start, kind: value.kind }), end: toEndpointInput({ ...value.end, kind: value.kind }) };
}
function scheduleComplete(value: ScheduleDraft): boolean {
  return [value.start, value.end].every((endpoint) => endpoint.date !== "" && (value.kind === "date" || endpoint.time !== ""));
}

export type SubtaskPopoverKind = "schedule" | "actions";
export function subtaskPopoverId(owner: string, kind: SubtaskPopoverKind) { return `subtask-popover-${owner}-${kind}`; }

// The draft a failed schedule save retains, and the version it was opened against. #377 moves a row between the open list and the
// "Completed" group when Done toggles, which remounts its ScheduleControl, so SubtaskChecklist owns one of these per item id.
export type RetainedSchedule = { draft: ScheduleDraft | null; baseVersion: number | null };

export function SubtaskScheduleControl({ owner, label, value, open, setOpen, onSave, onUseLatest, onUseLatestItem, busy, compact = false, error, defaultLabel, retained: retainedProp }: { owner: string; label: string; value: ChecklistScheduleDto | null; defaultLabel?: string; open: boolean; setOpen: (open: boolean) => void; onSave: (value: RangeScheduleRequest) => void; onUseLatest?: (value: ChecklistScheduleDto) => void; onUseLatestItem?: (value: Subtask) => void; busy: boolean; compact?: boolean; error?: ScheduleError; retained?: RetainedSchedule }) {
  const ownRetained = useRef<RetainedSchedule>({ draft: null, baseVersion: null });
  const retained = retainedProp ?? ownRetained.current;
  const [draft, setDraft] = useState(() => (error && retained.draft) || scheduleDraft(value));
  const close = useCallback(() => setOpen(false), [setOpen]);
  const floating = useAnchoredPopover({ open, onClose: close, placement: "bottom-start" });
  // A refetch can complete after the editor opened. While it is open, the
  // local draft belongs to this control and must not be replaced by that
  // authoritative response. Keep it through a failed save too, because the
  // conflict is shown after the popover closes and the user must be able to
  // reopen it and reapply the retained draft.
  useEffect(() => {
    if (open) {
      if (retained.baseVersion === null) retained.baseVersion = value?.version ?? 0;
      return;
    }
    if (busy) return;
    if (error) { if (retained.draft) setDraft(retained.draft); return; }
    retained.baseVersion = null;
    retained.draft = null;
    setDraft(scheduleDraft(value));
  }, [open, value, busy, error, retained]);
  const id = subtaskPopoverId(owner, "schedule");
  const setEndpoint = (which: "start" | "end", next: Partial<EndpointDraft>) => setDraft((current) => ({ ...current, [which]: { ...current[which], ...next } }));
  const endpointFields = (which: "start" | "end", endpoint: EndpointDraft) => <fieldset className="grid gap-[var(--space-2)] min-w-0 p-[var(--space-2)] [border-style:solid] border-[length:var(--border-width-hair)] border-border"><legend className="px-[var(--space-1)] [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground">{which === "start" ? "Start" : "End"}</legend><label className={POPOVER_LABEL}>Date <Input type="date" className={FIELD_RING_IN} value={endpoint.date} onChange={(event) => setEndpoint(which, { date: event.target.value })} /></label>{draft.kind === "timed" && <label className={POPOVER_LABEL}>Time <Input type="time" className={FIELD_RING_IN} step={60} value={endpoint.time} disabled={!endpoint.date} onChange={(event) => setEndpoint(which, { time: event.target.value })} /></label>}{error?.endpoint === which && error.choices && <fieldset className="grid gap-[var(--space-1)] m-0 min-w-0 p-[var(--space-2)] [border-style:dashed] border-[length:var(--border-width-hair)] border-border"><legend className="px-[var(--space-1)] [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary">Choose the Sydney occurrence</legend>{error.choices.map((choice) => <label key={choice.disambiguation} className={FOLD_CHOICE_LABEL}><input type="radio" className={cn("accent-[var(--accent)] cursor-pointer", RING_IN)} name={`${id}-${which}-fold`} checked={endpoint.disambiguation === choice.disambiguation} onChange={() => setEndpoint(which, { disambiguation: choice.disambiguation })} />{choice.disambiguation === "earlier" ? "Earlier" : "Later"} ({choice.utcOffsetMinutes >= 0 ? "+" : ""}{choice.utcOffsetMinutes} min)</label>)}</fieldset>}</fieldset>;
  return <>
    <button ref={floating.refs.setReference} type="button" className={compact ? COMPOSER_TRIGGER_CLASSES : META_TRIGGER} aria-label={compact && defaultLabel ? `${label}: ${value ? formatSchedule(value) : defaultLabel}` : label} aria-expanded={open} aria-controls={open ? id : undefined} disabled={busy} onKeyDown={floating.onKeyDown} onClick={() => setOpen(!open)}>
      {value || defaultLabel ? <StatusPill tone="neutral" className="min-w-0"><span className="sr-only">Schedule </span><span className="block truncate min-w-0">{value ? formatSchedule(value) : defaultLabel}</span></StatusPill> : <span aria-hidden="true">◷</span>}
    </button>
    {floating.mounted && <AnchoredPopover context={floating.context} floatingStyles={floating.floatingStyles} initialFocus={0} onKeyDown={floating.onKeyDown} status={floating.status}><div id={id} className={POPOVER_CONTENT} role="group" aria-label={label}>
      <label className={POPOVER_LABEL}>Date or time <NativeSelect className={cn(FIELD_RING_IN, "text-foreground")} value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as "date" | "timed" }))}><option value="date">Date</option><option value="timed">Timed · Australia/Sydney</option></NativeSelect></label>{endpointFields("start", draft.start)}{endpointFields("end", draft.end)}
      {error && !error.choices && !error.current && <Notice tone="critical" role="alert">The schedule could not be saved. Review the highlighted fields.</Notice>}
      {error?.currentSubtask ? <Notice tone="caution" role="status"><strong>Latest checklist item · schedule v{error.currentSubtask.schedule.version}</strong><dl className="grid gap-[var(--space-1)] m-0"><div className="flex items-baseline justify-between gap-[var(--space-3)]"><dt className={POPOVER_LABEL}>Title</dt><dd className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground">{error.currentSubtask.title}</dd></div><div className="flex items-baseline justify-between gap-[var(--space-3)]"><dt className={POPOVER_LABEL}>Done</dt><dd className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground">{error.currentSubtask.done ? "Complete" : "Open"}</dd></div><div className="flex items-baseline justify-between gap-[var(--space-3)]"><dt className={POPOVER_LABEL}>Assignees</dt><dd className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground">{error.currentSubtask.assignees.length ? error.currentSubtask.assignees.map((person) => person.name).join(", ") : "Unassigned"}{error.currentSubtask.otherAssigneeCount ? ` and ${error.currentSubtask.otherAssigneeCount} other${error.currentSubtask.otherAssigneeCount === 1 ? "" : "s"}` : ""}</dd></div><div className="flex items-baseline justify-between gap-[var(--space-3)]"><dt className={POPOVER_LABEL}>Schedule</dt><dd className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground">{formatSchedule(error.currentSubtask.schedule)}</dd></div></dl><button type="button" className={buttonClasses("secondary", { className: cn("justify-self-start", RING_IN) })} disabled={busy} onClick={() => { onUseLatestItem?.(error.currentSubtask!); close(); }}>Use latest item (discard draft)</button><span className={cn(META_TEXT, "!normal-case")}>Save reapplies your retained schedule draft; Cancel discards it.</span></Notice> : error?.current && <Notice tone="caution" role="status"><strong>Latest schedule · v{error.current.version}</strong><span>{formatSchedule(error.current)}</span><button type="button" className={buttonClasses("secondary", { className: cn("justify-self-start", RING_IN) })} disabled={busy} onClick={() => { onUseLatest?.(error.current!); close(); }}>Use latest schedule (discard draft)</button><span className={cn(META_TEXT, "!normal-case")}>Save reapplies your retained schedule draft; Cancel discards it.</span></Notice>}
      <div className={POPOVER_ACTIONS_STICKY}><button type="button" className={buttonClasses("primary", { className: RING_IN })} disabled={busy || !scheduleComplete(draft)} onClick={() => { retained.draft = draft; onSave({ expectedVersion: error?.current?.version ?? retained.baseVersion ?? value?.version ?? 0, schedule: scheduleInput(draft) }); close(); }}>Save</button><button type="button" className={buttonClasses("secondary", { className: RING_IN })} disabled={busy} onClick={() => { retained.baseVersion = null; retained.draft = null; setDraft(scheduleDraft(value)); close(); }}>Cancel</button></div>
    </div></AnchoredPopover>}
  </>;
}
