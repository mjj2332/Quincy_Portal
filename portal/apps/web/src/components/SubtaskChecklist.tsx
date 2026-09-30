import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AnchoredPopover, useAnchoredPopover, POPOVER_ACTIONS, POPOVER_CONTENT, POPOVER_LABEL, RING_IN } from "./AnchoredPopover";
import { ApiError, apiDelete, apiPatch, apiPost } from "../lib/api";
import { useSession } from "../lib/auth";
import { invalidateProjectSurfaces, projectDataKeys, useOptionalProjectQueryClient, useProjectAccessTermination, useProjectSubtasksQuery, type ProjectSubtask } from "../lib/project-data";
import { createProjectDataInvalidationMessage, getProjectQueryRuntime } from "../lib/project-query-sync";
import { formatCivilSchedule } from "../lib/date-format";
import { CHECKLIST_SCHEDULE_ZONE, type ChecklistScheduleDto, type RangeChecklistScheduleInput, type Role } from "@quincy/shared";
import { foldToDisambiguation } from "../lib/fold-disambiguation";
import { reorderNeighbors } from "../lib/reorder-neighbors";
import { confirm } from "../lib/confirm";
import { cn } from "../lib/utils";
import { Eyebrow, META_TEXT } from "./quincy/Eyebrow";
import { EmptyState } from "./quincy/EmptyState";
import { Notice } from "./quincy/Notice";
import { Input } from "./reui/input";
import { NativeSelect } from "./quincy/NativeSelect";
import { Checkbox } from "./quincy/Checkbox";
import { StatusPill } from "./quincy/StatusPill";
import { Button, buttonClasses } from "./quincy/Button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./reui/collapsible";
import { Progress } from "./reui/progress";
import { IconButton, META_TRIGGER } from "./quincy/icon-button";
import { SubtaskAssigneePicker } from "./quincy/SubtaskAssigneePicker";

// TB8-07 §5.1 — the toggle's outward focus ring. Not exported: `RING_OUT` is deliberately
// written out at each new-class-string site rather than centralised (§4.3).
const RING_OUT =
  "focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] " +
  "focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-2";

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

// TB8-07 §5.4 — the composer's "+ Add an item" affordance. Outward ring: not inside
// an `AnchoredPopover`.
const ADD_BUTTON_CLASSES =
  "justify-self-start inline-flex items-center min-h-[38px] max-[721px]:min-h-[44px] " +
  "px-[var(--space-2)] py-[7px] bg-transparent " +
  "[border-style:solid] border-[length:var(--border-width-hair)] border-transparent " +
  "text-foreground-secondary [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] cursor-pointer " +
  "hover:border-border hover:bg-secondary hover:text-foreground " +
  "focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] " +
  "focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-2";

// TB8-07 §5.4 — the loading/empty checklist states. No `role` here today, and §9a #10
// says none may be added.
const CHECKLIST_STATE_CLASSES = "px-0 py-[var(--space-4)] text-left";

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

type Subtask = ProjectSubtask;
type PopoverKind = "schedule" | "actions";
type ActivePopover = { owner: string; kind: PopoverKind } | null;

function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
type EndpointDraft = { kind: "date" | "timed"; date: string; time: string; disambiguation?: "earlier" | "later" };
type ScheduleDraft = { kind: "date" | "timed"; start: EndpointDraft; end: EndpointDraft };
// A Subtask is always a range (ADR 0011), so the editor saves only that shape.
type RangeScheduleRequest = { expectedVersion: number; schedule: RangeChecklistScheduleInput };
type ScheduleError = { endpoint?: "start" | "end"; choices?: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }>; current?: ChecklistScheduleDto; currentSubtask?: Subtask };
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
/** A one-day range names its date once: "8 Oct 2026", or "8 Oct 2026 · 13:00 → 14:00" when timed. Lives in `lib/date-format.ts` (#376). */
export const formatSchedule = formatCivilSchedule;
function toEndpointInput(value: EndpointDraft): { kind: "date"; localCivil: string } | { kind: "timed"; localCivil: string; disambiguation?: "earlier" | "later" } {
  return value.kind === "date" ? { kind: "date", localCivil: value.date } : { kind: "timed", localCivil: `${value.date}T${value.time}`, ...(value.disambiguation ? { disambiguation: value.disambiguation } : {}) };
}
function scheduleInput(value: ScheduleDraft): RangeChecklistScheduleInput {
  return { state: "range", start: toEndpointInput({ ...value.start, kind: value.kind }), end: toEndpointInput({ ...value.end, kind: value.kind }) };
}
function scheduleComplete(value: ScheduleDraft): boolean {
  return [value.start, value.end].every((endpoint) => endpoint.date !== "" && (value.kind === "date" || endpoint.time !== ""));
}
function schedulePreview(input: RangeChecklistScheduleInput): ChecklistScheduleDto {
  const endpoint = (value: { kind: "date" | "timed"; localCivil: string }) => ({ kind: value.kind, localCivil: value.localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const });
  return { state: "range", version: 0, zone: CHECKLIST_SCHEDULE_ZONE, start: endpoint(input.start), end: endpoint(input.end), due: input.end.localCivil };
}

export function scheduleReorderFocus(grips: Map<string, HTMLButtonElement>, id: string, formerIndex: number, composerOpen: boolean, composerInput: HTMLInputElement | null, projectId: string, isBusy: () => boolean = () => false) {
  const attempt = () => { if (isBusy()) { window.setTimeout(attempt, 16); return; } const grip = grips.get(id) ?? [...grips.values()][Math.min(formerIndex, Math.max(grips.size - 1, 0))]; if (grip) grip.focus(); else if (composerOpen) composerInput?.focus(); else document.getElementById(`subtask-add-${projectId}`)?.focus(); };
  window.setTimeout(attempt, 0);
}

function popoverId(owner: string, kind: PopoverKind) { return `subtask-popover-${owner}-${kind}`; }

function ScheduleControl({ owner, label, value, open, setOpen, onSave, onUseLatest, onUseLatestItem, busy, compact = false, error, defaultLabel }: { owner: string; label: string; value: ChecklistScheduleDto | null; defaultLabel?: string; open: boolean; setOpen: (open: boolean) => void; onSave: (value: RangeScheduleRequest) => void; onUseLatest?: (value: ChecklistScheduleDto) => void; onUseLatestItem?: (value: Subtask) => void; busy: boolean; compact?: boolean; error?: ScheduleError }) {
  const [draft, setDraft] = useState(() => scheduleDraft(value));
  const retainedDraft = useRef<ScheduleDraft | null>(null);
  const draftBaseVersion = useRef<number | null>(null);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const floating = useAnchoredPopover({ open, onClose: close, placement: "bottom-start" });
  // A refetch can complete after the editor opened. While it is open, the
  // local draft belongs to this control and must not be replaced by that
  // authoritative response. Keep it through a failed save too, because the
  // conflict is shown after the popover closes and the user must be able to
  // reopen it and reapply the retained draft.
  useEffect(() => {
    if (open) {
      if (draftBaseVersion.current === null) draftBaseVersion.current = value?.version ?? 0;
      return;
    }
    if (busy) return;
    if (error) { if (retainedDraft.current) setDraft(retainedDraft.current); return; }
    draftBaseVersion.current = null;
    retainedDraft.current = null;
    setDraft(scheduleDraft(value));
  }, [open, value, busy, error]);
  const id = popoverId(owner, "schedule");
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
      <div className={POPOVER_ACTIONS_STICKY}><button type="button" className={buttonClasses("primary", { className: RING_IN })} disabled={busy || !scheduleComplete(draft)} onClick={() => { retainedDraft.current = draft; onSave({ expectedVersion: error?.current?.version ?? draftBaseVersion.current ?? value?.version ?? 0, schedule: scheduleInput(draft) }); close(); }}>Save</button><button type="button" className={buttonClasses("secondary", { className: RING_IN })} disabled={busy} onClick={() => { draftBaseVersion.current = null; retainedDraft.current = null; setDraft(scheduleDraft(value)); close(); }}>Cancel</button></div>
    </div></AnchoredPopover>}
  </>;
}

function ActionsControl({ owner, title, open, setOpen, busy, onDelete }: { owner: string; title: string; open: boolean; setOpen: (open: boolean) => void; busy: boolean; onDelete: () => void }) {
  const close = useCallback(() => setOpen(false), [setOpen]); const floating = useAnchoredPopover({ open, onClose: close }); const id = popoverId(owner, "actions");
  return <>
    <IconButton ref={floating.refs.setReference} aria-label={`Actions for ${title}`} aria-expanded={open} aria-controls={open ? id : undefined} onKeyDown={floating.onKeyDown} onClick={() => setOpen(!open)}>⋯</IconButton>
    {floating.mounted && <AnchoredPopover context={floating.context} floatingStyles={floating.floatingStyles} initialFocus={0} onKeyDown={floating.onKeyDown} status={floating.status}><div id={id} className={POPOVER_CONTENT} role="group" aria-label={`Actions for ${title}`}><button type="button" className={buttonClasses("danger", { className: RING_IN })} disabled={busy} onClick={() => { void (async () => { if (!await confirm({ title: "Delete subtask?", message: "Delete this subtask?", confirmLabel: "Delete", danger: true })) return; close(); onDelete(); })(); }}>Delete</button></div></AnchoredPopover>}
  </>;
}

function SortableSubtaskRow({ item, projectId, role, busy, editing, draftTitle, popover, setPopover, scheduleError, onUpdate, onCommitAssignees, onUseLatest, onUseLatestItem, onRemove, onBeginEditing, onEndEditing, titleInputRef, itemRef, gripRef, sortable }: { sortable: boolean; item: Subtask; projectId: string; role: Role; busy: boolean; editing: boolean; draftTitle: string; popover: ActivePopover; setPopover: (value: ActivePopover) => void; scheduleError?: ScheduleError; onUpdate: (body: Record<string, unknown>, action: string) => void; onCommitAssignees: (ids: string[], baseline: { ids: string[]; version: number | undefined }) => Promise<void>; onUseLatest: (schedule: ChecklistScheduleDto) => void; onUseLatestItem: (item: Subtask) => void; onRemove: () => void; onBeginEditing: () => void; onEndEditing: () => void; titleInputRef: (element: HTMLInputElement | null) => void; itemRef: (element: HTMLElement | null) => void; gripRef: (element: HTMLButtonElement | null) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: busy || !sortable });
  const activeKind = popover?.owner === item.id ? popover.kind : null;
  const setKind = (kind: PopoverKind, open: boolean) => setPopover(open ? { owner: item.id, kind } : null);
  const style = { transform: CSS.Transform.toString(transform), transition };
  const combinedNodeRef = (element: HTMLElement | null) => { setNodeRef(element); itemRef(element); };
  const combinedGripRef = (element: HTMLButtonElement | null) => { setActivatorNodeRef(element); gripRef(element); };
  const dragProps = { ...attributes, ...listeners, ...(busy ? { "aria-disabled": true } : {}) };
  return <article
    ref={combinedNodeRef}
    style={style}
    data-done={item.done ? "true" : undefined}
    data-dragging={isDragging ? "true" : undefined}
    data-popover-open={activeKind ? "true" : undefined}
    className={cn(
      "grid gap-[var(--space-2)] py-[var(--space-2)] -mx-[var(--space-2)] px-[var(--space-2)]",
      "[border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border",
      "last:border-b-0",
      "transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
      "hover:bg-secondary focus-within:bg-secondary",
      "data-[dragging=true]:opacity-45 data-[dragging=true]:shadow-[var(--shadow-sm)]",
    )}
    onBlur={(event) => {
      const next = event.relatedTarget as Node | null;
      if (event.currentTarget.contains(next) || (activeKind && document.getElementById(popoverId(item.id, activeKind))?.contains(next))) return;
      if (editing) onEndEditing();
    }}>
    <div className={cn(
      "min-w-0",
      "max-[721px]:grid", sortable ? "max-[721px]:grid-cols-[auto_auto_minmax(0,1fr)]" : "max-[721px]:grid-cols-[auto_minmax(0,1fr)]",
      "max-[721px]:items-center max-[721px]:gap-[var(--space-2)]",
      "min-[721px]:flex min-[721px]:items-center min-[721px]:gap-[var(--space-2)]",
    )}>
      {sortable && <IconButton ref={combinedGripRef} aria-label={`Reorder ${item.title}`} className="cursor-grab active:cursor-grabbing" {...dragProps}>⠿</IconButton>}
      <label className="grid place-items-center min-h-[28px] max-[721px]:min-h-[44px] max-[721px]:min-w-[44px] cursor-pointer"><Checkbox checked={item.done} disabled={busy} onChange={(event) => onUpdate({ done: event.target.checked }, "done")} /><span className="sr-only">Mark {item.title} complete</span></label>
      {editing ? <Input ref={titleInputRef} className="flex-1 min-w-0" aria-label="Subtask title" value={draftTitle} disabled={busy} onChange={(event) => onUpdate({ __draft: event.target.value }, "draft")} onBlur={() => onUpdate({ __saveTitle: true }, "title")} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.preventDefault(); onUpdate({ __cancelTitle: true }, "title"); event.currentTarget.blur(); } }} /> : <button
        type="button"
        data-testid="subtask-checklist-title"
        // `.subtask-checklist__title-trigger` no longer carries any CSS (its app.css rule is
        // retired) — it stays on this element only as a runtime hook: `remove()` below queries
        // for it (`.querySelector(".subtask-checklist__title-trigger")`) to restore focus to the
        // next row's title after a delete. Do not delete the class as dead.
        className={cn(
          "subtask-checklist__title-trigger",
          "flex-1 min-w-0 p-0 border-0 bg-transparent text-left cursor-pointer",
          "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]",
          "[overflow-wrap:anywhere] min-h-[28px] max-[721px]:min-h-[44px]",
          item.done ? "text-foreground-secondary line-through" : "text-foreground",
          RING_OUT,
        )}
        disabled={busy}
        onClick={onBeginEditing}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onBeginEditing(); } }}
      >{item.title}</button>}
      <div className={cn(
        "min-w-0",
        "max-[721px]:col-span-full max-[721px]:flex max-[721px]:items-center",
        "max-[721px]:gap-[var(--space-1)] max-[721px]:pt-[var(--space-1)]",
        "min-[721px]:contents",
      )}>
        <ScheduleControl owner={item.id} label={`Schedule for ${item.title}`} value={item.schedule} error={scheduleError} open={activeKind === "schedule"} setOpen={(open) => setKind("schedule", open)} onSave={(schedule) => onUpdate({ schedule }, "schedule")} onUseLatest={onUseLatest} onUseLatestItem={onUseLatestItem} busy={busy} />
        <SubtaskAssigneePicker projectId={projectId} role={role} label={`Assignees for ${item.title}`} selected={item.assignees} version={item.assignmentVersion} hiddenCount={item.otherAssigneeCount ?? 0} busy={busy} onCommit={(ids, _people, baseline) => onCommitAssignees(ids, baseline)} />
        <ActionsControl owner={item.id} title={item.title} open={activeKind === "actions"} setOpen={(open) => setKind("actions", open)} busy={busy} onDelete={onRemove} />
      </div>
    </div>
  </article>;
}

export function SubtaskChecklist({ projectId, onAccessFailure, layout = "rail" }: { projectId: string; onAccessFailure?: (error: unknown) => void; /** "rail" (default) opens the checklist; "stacked" collapses it to its count. The panel derives it from the one 1100px breakpoint (#377). */ layout?: "rail" | "stacked" }) {
  const queryClient = useOptionalProjectQueryClient();
  const session = useSession();
  const role: Role = session.data?.user.role === "external_editor" ? "external_editor" : "admin";
  const subtasksQuery = useProjectSubtasksQuery(projectId, true, false, role);
  const queryRuntime = queryClient ? getProjectQueryRuntime(queryClient) : undefined;
  const terminateOnUnauthorized = useProjectAccessTermination();
  const onAccessFailureRef = useRef(onAccessFailure);
  onAccessFailureRef.current = onAccessFailure;
  const [subtasks, setSubtasks] = useState<Subtask[]>([]); const [adding, setAdding] = useState(false); const [busy, setBusy] = useState<Set<string>>(new Set());
  const [newTitle, setNewTitle] = useState(""); const [newAssignees, setNewAssignees] = useState<Array<{ id: string; name: string }>>([]); const [newSchedule, setNewSchedule] = useState<RangeChecklistScheduleInput | null>(null); const [newSchedulePreview, setNewSchedulePreview] = useState<ChecklistScheduleDto | null>(null); const [composerOpen, setComposerOpen] = useState(false); const [activePopover, setActivePopover] = useState<ActivePopover>(null);
  const [draftTitles, setDraftTitles] = useState<Record<string, string>>({}); const [notice, setNotice] = useState(""); const [open, setOpen] = useState(layout === "rail"); const [completedOpen, setCompletedOpen] = useState(false); const [editingId, setEditingId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false); const [scheduleErrors, setScheduleErrors] = useState<Record<string, ScheduleError>>({});
  const sectionRef = useRef<HTMLElement>(null); const completedTriggerRef = useRef<HTMLButtonElement>(null); const priorLayout = useRef(layout); const itemRefs = useRef(new Map<string, HTMLElement>()); const titleInputRefs = useRef(new Map<string, HTMLInputElement>()); const gripRefs = useRef(new Map<string, HTMLButtonElement>()); const composerInputRef = useRef<HTMLInputElement>(null); const priorEditingId = useRef<string | null>(null); const cancelledTitles = useRef(new Set<string>()); const restoreAddFocus = useRef(false); const busyRef = useRef(new Set<string>());
  const itemRef = (id: string) => (element: HTMLElement | null) => { if (element) itemRefs.current.set(id, element); else itemRefs.current.delete(id); };
  const titleInputRef = (id: string) => (element: HTMLInputElement | null) => { if (element) titleInputRefs.current.set(id, element); else titleInputRefs.current.delete(id); };
  const gripRef = (id: string) => (element: HTMLButtonElement | null) => { if (element) gripRefs.current.set(id, element); else gripRefs.current.delete(id); };
  useEffect(() => { if (!dragging && subtasksQuery.data) setSubtasks(subtasksQuery.data); }, [dragging, subtasksQuery.data]);
  useEffect(() => { if (!subtasksQuery.error) return; terminateOnUnauthorized(subtasksQuery.error); onAccessFailureRef.current?.(subtasksQuery.error); if (!(subtasksQuery.error instanceof Error && subtasksQuery.error.name === "AbortError")) setNotice(message(subtasksQuery.error, "Checklist could not be loaded.")); }, [subtasksQuery.error, terminateOnUnauthorized]);
  useEffect(() => { if (!queryRuntime) return; const owns = dragging || activePopover?.kind === "schedule" || [...busy].some((key) => key.endsWith(":schedule") || key.endsWith(":assignees")); if (!owns) return; return queryRuntime.acquireOwner(projectDataKeys.subtasks(projectId)); }, [activePopover?.kind, busy, dragging, projectId, queryRuntime]);
  useLayoutEffect(() => { const changed = editingId !== priorEditingId.current; priorEditingId.current = editingId; if (!editingId || !changed || [...busy].some((key) => key.startsWith(`${editingId}:`))) return; const input = titleInputRefs.current.get(editingId); if (input && !input.disabled) input.focus(); }, [busy, editingId]);
  useLayoutEffect(() => { if (!composerOpen && restoreAddFocus.current) { restoreAddFocus.current = false; document.getElementById(`subtask-add-${projectId}`)?.focus(); } }, [composerOpen, projectId]);
  // Open rows sort and reorder; done rows sit in a collapsed group. Both keep `position` order (`subtasks` is sorted).
  const openItems = subtasks.filter((item) => !item.done); const doneItems = subtasks.filter((item) => item.done);
  // A layout change resets the collapse to the new layout's default, unless the checklist is being used: a composer,
  // a title edit or an open popover (the assignee picker owns its own state, so it is read off its trigger) keeps it open.
  useEffect(() => {
    if (priorLayout.current === layout) return;
    priorLayout.current = layout;
    const inUse = composerOpen || editingId !== null || activePopover !== null || sectionRef.current?.querySelector('[aria-expanded="true"]:not([data-disclosure])') != null;
    if (!inUse) setOpen(layout === "rail");
  }, [activePopover, composerOpen, editingId, layout]);
  function setAction(id: string, value: boolean) { const next = new Set(busyRef.current); if (value) next.add(id); else next.delete(id); busyRef.current = next; setBusy(next); }
  function replace(updated: Subtask, broadcast = true) { const next = updated; setSubtasks((current) => current.map((item) => item.id === next.id ? next : item).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))); queryClient?.setQueryData<Subtask[]>(projectDataKeys.subtasks(projectId), (current) => current?.map((item) => item.id === next.id ? next : item)); if (broadcast) queryRuntime?.publish(createProjectDataInvalidationMessage(projectId, [{ kind: "subtasks" }])); }
  // `searchRelevant` (#217 fix round 1, item 4): a checklist TITLE change (create/rename/delete)
  // can flip whether this project matches an active Dashboard search -- every other subtask
  // mutation (done, schedule, assignee, reorder) cannot, so `dashboard` stays `false` for those,
  // byte-identical to before. `dashboardSearchOnly` keeps a q-less baseline query from refetching
  // for nothing. `gantt: true` (#218) always invalidates the Gantt surface regardless of search
  // relevance, since a checklist mutation can affect Gantt density independent of the Dashboard search.
  async function invalidateAfterMutation(searchRelevant = false) { if (queryClient) await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "subtasks" }, { kind: "activity" }], dashboard: searchRelevant, calendar: true, dashboardSearchOnly: searchRelevant, gantt: true }); }
  // Ticking a row moves it to the other group, which remounts it: focus follows it (an item that reopens) or lands on the next open row's
  // checkbox, else the previous one, else the "Completed" trigger (every open row is done). Never `<body>`, inside a modal sheet.
  function followDoneToggle(saved: Subtask, openIndex: number) {
    const checkboxOf = (id: string | undefined) => id ? itemRefs.current.get(id)?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null : null;
    const nextOpenId = openItems[openIndex + 1]?.id ?? openItems[openIndex - 1]?.id;
    window.setTimeout(() => { (saved.done ? checkboxOf(nextOpenId) ?? completedTriggerRef.current : checkboxOf(saved.id))?.focus(); }, 0);
  }
  function itemIsBusy(id: string) { return [...busy].some((key) => key.startsWith(`${id}:`)); }
  function beginEditing(item: Subtask) { if (itemIsBusy(item.id)) return; cancelledTitles.current.delete(item.id); setDraftTitles((current) => ({ ...current, [item.id]: current[item.id] ?? item.title })); setEditingId(item.id); }
  function useLatestSchedule(item: Subtask, schedule: ChecklistScheduleDto) { replace({ ...item, schedule, dueDate: schedule.due }); setScheduleErrors((current) => { const next = { ...current }; delete next[item.id]; return next; }); }
  function useLatestItem(item: Subtask) { replace(item); setScheduleErrors((current) => { const next = { ...current }; delete next[item.id]; return next; }); }
  async function update(item: Subtask, body: Record<string, unknown>, action: string) { const key = `${item.id}:${action}`; const hadFocus = action === "done" && itemRefs.current.get(item.id)?.contains(document.activeElement) === true; const openIndex = openItems.findIndex((candidate) => candidate.id === item.id); setAction(key, true); setNotice(""); try { const saved = await apiPatch<Subtask, Record<string, unknown>>(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(item.id)}`, body); replace(saved, false); await invalidateAfterMutation(action === "title"); if (hadFocus) followDoneToggle(saved, openIndex); if (action === "schedule") setScheduleErrors((current) => { const next = { ...current }; delete next[item.id]; return next; }); } catch (error) { terminateOnUnauthorized(error); if (action === "schedule" && error instanceof ApiError && error.details && typeof error.details === "object") { const details = error.details as { details?: ScheduleError; current?: ChecklistScheduleDto; currentSubtask?: Subtask }; if (details.current || details.details || details.currentSubtask) setScheduleErrors((current) => ({ ...current, [item.id]: { ...(details.details ?? {}), ...(details.current ? { current: details.current } : {}), ...(details.currentSubtask ? { currentSubtask: details.currentSubtask } : {}) } })); } if (action === "assignees" && error instanceof ApiError && error.details && typeof error.details === "object") { const details = error.details as { code?: string; currentSubtask?: Subtask }; if (details.code === "subtask_assignment_version_conflict" && details.currentSubtask) { replace(details.currentSubtask); await invalidateAfterMutation(false); setNotice("Assignees changed elsewhere — showing the latest."); return; } if (details.code === "subtask_multi_assignee_disabled") { void queryClient?.invalidateQueries({ queryKey: projectDataKeys.subtaskAssigneeOptions(projectId) }); setNotice("Only one assignee is allowed right now."); return; } if (details.code === "subtask_item_conflict" && details.currentSubtask) { replace(details.currentSubtask); await invalidateAfterMutation(false); } } setNotice(message(error, "Subtask could not be updated.")); } finally { setAction(key, false); } }
  async function commitAssignees(item: Subtask, ids: string[], baseline: { ids: string[]; version: number | undefined }) { const current = baseline.ids; const add = ids.filter((id) => !current.includes(id)); const remove = current.filter((id) => !ids.includes(id)); if (!add.length && !remove.length) return; await update(item, { assignees: { expectedVersion: baseline.version ?? item.assignmentVersion, add, remove } }, "assignees"); }
  function titleAction(item: Subtask, body: Record<string, unknown>) { if ("__draft" in body) { setDraftTitles((current) => ({ ...current, [item.id]: String(body.__draft) })); return; } if ("__cancelTitle" in body) { cancelledTitles.current.add(item.id); setDraftTitles((current) => ({ ...current, [item.id]: item.title })); return; } if ("__saveTitle" in body) { const title = draftTitles[item.id] ?? item.title; if (cancelledTitles.current.delete(item.id)) return; if (title !== item.title && title.trim()) void update(item, { title }, "title"); } }
  function resetComposer(focus = true) { setNewTitle(""); setNewAssignees([]); setNewSchedule(null); setNewSchedulePreview(null); setActivePopover(null); if (focus) restoreAddFocus.current = true; setComposerOpen(false); }
  // No chosen range (null): omit it and the server copies the Project's default range (ADR 0011).
  async function add(event: React.FormEvent) { event.preventDefault(); if (!newTitle.trim()) return; setAdding(true); setNotice(""); const body: { title: string; assigneeIds?: string[]; schedule?: RangeChecklistScheduleInput } = { title: newTitle }; if (newSchedule) body.schedule = newSchedule; if (newAssignees.length) body.assigneeIds = newAssignees.map((person) => person.id); try { const task = await apiPost<Subtask, typeof body>(`/api/projects/${encodeURIComponent(projectId)}/subtasks`, body); setSubtasks((current) => [...current, task].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))); queryClient?.setQueryData<Subtask[]>(projectDataKeys.subtasks(projectId), (current) => [...(current ?? []), task].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))); await invalidateAfterMutation(true); resetComposer(); } catch (error) { terminateOnUnauthorized(error); setNotice(message(error, "Subtask could not be added.")); } finally { setAdding(false); } }
  async function remove(item: Subtask) { const key = `${item.id}:delete`; setAction(key, true); setNotice(""); const group = item.done ? doneItems : openItems; const groupIndex = group.findIndex((candidate) => candidate.id === item.id); const nextFocusId = group[groupIndex + 1]?.id ?? group[groupIndex - 1]?.id; try { await apiDelete(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(item.id)}`); setActivePopover(null); setEditingId((current) => current === item.id ? null : current); setSubtasks((current) => current.filter((candidate) => candidate.id !== item.id)); queryClient?.setQueryData<Subtask[]>(projectDataKeys.subtasks(projectId), (current) => current?.filter((candidate) => candidate.id !== item.id)); await invalidateAfterMutation(true); window.setTimeout(() => { if (nextFocusId) itemRefs.current.get(nextFocusId)?.querySelector<HTMLButtonElement>(".subtask-checklist__title-trigger")?.focus(); else if (composerOpen) composerInputRef.current?.focus(); else document.getElementById(`subtask-add-${projectId}`)?.focus(); }, 0); } catch (error) { terminateOnUnauthorized(error); setNotice(message(error, "Subtask could not be deleted.")); } finally { setAction(key, false); } }
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  async function onDragEnd(event: DragEndEvent) { const activeId = String(event.active.id); const neighbors = reorderNeighbors(subtasks.map((item) => item.id), activeId, event.over ? String(event.over.id) : null); setDragging(false); if (!neighbors) return; const formerIndex = openItems.findIndex((item) => item.id === activeId); const key = `${activeId}:reorder`; setAction(key, true); setNotice(""); let reload = false; try { await apiPost<{ position: number }, { beforeId: string | null; afterId: string | null }>(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(activeId)}/reorder`, { beforeId: neighbors.beforeId, afterId: neighbors.afterId }); const refreshed = await subtasksQuery.refetch(); if (refreshed.data) setSubtasks(refreshed.data); reload = !refreshed.error; } catch (error) { terminateOnUnauthorized(error); if (error instanceof ApiError && error.status === 409) { setNotice("Subtask order changed; reload and try again"); const refreshed = await subtasksQuery.refetch(); if (refreshed.data) setSubtasks(refreshed.data); reload = !refreshed.error; } else setNotice(message(error, "Subtask could not be reordered.")); } finally { setAction(key, false); if (reload) scheduleReorderFocus(gripRefs.current, activeId, formerIndex, composerOpen, composerInputRef.current, projectId, () => busyRef.current.has(key)); } }
  const doneCount = doneItems.length; const total = subtasks.length;
  const loading = subtasksQuery.isPending && !subtasks.length;
  const rowFor = (item: Subtask, sortable: boolean) => <SortableSubtaskRow key={item.id} sortable={sortable} item={item} projectId={projectId} role={role} busy={itemIsBusy(item.id)} editing={editingId === item.id} draftTitle={draftTitles[item.id] ?? item.title} popover={activePopover} setPopover={setActivePopover} scheduleError={scheduleErrors[item.id]} onUpdate={(body, action) => action === "draft" || action === "title" ? titleAction(item, body) : void update(item, body, action)} onCommitAssignees={(ids, baseline) => commitAssignees(item, ids, baseline)} onUseLatest={(schedule) => useLatestSchedule(item, schedule)} onUseLatestItem={useLatestItem} onRemove={() => void remove(item)} onBeginEditing={() => beginEditing(item)} onEndEditing={() => { if (editingId === item.id) setEditingId(null); }} titleInputRef={titleInputRef(item.id)} itemRef={itemRef(item.id)} gripRef={sortable ? gripRef(item.id) : () => undefined} />;
  return <section ref={sectionRef} className={cn("grid gap-[var(--space-3)]", layout === "rail" ? "ps-[var(--space-5)] [border-left-style:solid] border-l-[length:var(--border-width-hair)] border-l-border" : "pb-[var(--space-4)] [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border")} aria-label="Project checklist">
    <Collapsible open={open} onOpenChange={setOpen} className="grid gap-[var(--space-3)]">
      <header className="flex items-center gap-[var(--space-3)] min-w-0">
        <h3 className="m-0"><Eyebrow>Checklist</Eyebrow></h3>
        <span data-testid="subtask-checklist-count" className="flex-1 min-w-0 [font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] tabular-nums text-foreground">{doneCount} / {total}<span className="sr-only"> complete</span></span>
        <CollapsibleTrigger data-disclosure="" render={<IconButton aria-label={open ? "Collapse checklist" : "Expand checklist"} />}>{open ? "−" : "+"}</CollapsibleTrigger>
      </header>
      <Progress value={doneCount} max={Math.max(total, 1)} aria-label="Checklist progress" getAriaValueText={() => `${doneCount} of ${total} complete`} className="gap-0" />
      <div className="min-h-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-destructive" aria-live="polite">{notice}</div>
      <CollapsibleContent keepMounted className="grid gap-[var(--space-3)]">{loading ? <EmptyState aria-live="polite" size="compact" title="Loading checklist…" /> : <>
        <DndContext sensors={sensors} onDragStart={() => { setDragging(true); setActivePopover(null); }} onDragEnd={(event) => void onDragEnd(event)}>
          <SortableContext items={openItems.map((item) => item.id)} strategy={verticalListSortingStrategy}><div>{openItems.map((item) => rowFor(item, true))}</div></SortableContext>
          {doneItems.length > 0 && <Collapsible open={completedOpen} onOpenChange={setCompletedOpen} className="grid gap-[var(--space-1)]">
            <CollapsibleTrigger ref={completedTriggerRef} data-disclosure="" render={<Button variant="text" className="justify-self-start" />}>Completed ({doneItems.length})</CollapsibleTrigger>
            <CollapsibleContent><div>{doneItems.map((item) => rowFor(item, false))}</div></CollapsibleContent>
          </Collapsible>}
        </DndContext>
        {composerOpen ? <form className="grid gap-[var(--space-2)]" onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); resetComposer(); } }} onSubmit={(event) => void add(event)}><label className="sr-only" htmlFor={`subtask-composer-${projectId}`}>Add a subtask</label><Input ref={composerInputRef} id={`subtask-composer-${projectId}`} autoFocus value={newTitle} maxLength={500} disabled={adding} onChange={(event) => setNewTitle(event.target.value)} placeholder="Add a subtask…" /><div className={POPOVER_ACTIONS}><SubtaskAssigneePicker projectId={projectId} role={role} label="Assignees for new subtask" selected={newAssignees} disabled={adding} compact onCommit={(_ids, people) => setNewAssignees(people)} /><ScheduleControl owner="composer" label="Schedule for new subtask" value={newSchedulePreview} defaultLabel={newSchedule ? undefined : "Project default"} open={activePopover?.owner === "composer" && activePopover.kind === "schedule"} setOpen={(value) => setActivePopover(value ? { owner: "composer", kind: "schedule" } : null)} onSave={(request) => { setNewSchedule(request.schedule); setNewSchedulePreview(schedulePreview(request.schedule)); }} busy={adding} compact /><span className="flex-1 max-[601px]:hidden" /><button className={buttonClasses("secondary")} type="button" disabled={adding} onClick={() => resetComposer()}>Cancel</button><button className={buttonClasses("primary")} type="submit" disabled={adding || !newTitle.trim()}>{adding ? "Adding…" : "Add"}</button></div></form> : <button id={`subtask-add-${projectId}`} type="button" className={ADD_BUTTON_CLASSES} onClick={() => setComposerOpen(true)}>+ Add an item</button>}
        {!subtasks.length && <EmptyState size="compact" title="Break the shoot into steps anyone on the project can tick off." />}
      </>}</CollapsibleContent>
    </Collapsible>
  </section>;
}
