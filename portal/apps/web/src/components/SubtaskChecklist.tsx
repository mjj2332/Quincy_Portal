import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AnchoredPopover, useAnchoredPopover, POPOVER_ACTIONS, POPOVER_CONTENT, POPOVER_LABEL, RING_IN } from "./AnchoredPopover";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";
import { externalApiGet } from "../lib/external-api-response";
import { useSession } from "../lib/auth";
import { invalidateProjectSurfaces, projectDataKeys, projectCollaborationDataGeneration, useOptionalProjectQueryClient, useProjectAccessTermination, useProjectSubtasksQuery, type ProjectSubtask } from "../lib/project-data";
import { createProjectDataInvalidationMessage, getProjectQueryRuntime } from "../lib/project-query-sync";
import { CHECKLIST_SCHEDULE_RANGES_ENABLED, CHECKLIST_SCHEDULE_ZONE, type ChecklistScheduleDto, type InitialChecklistScheduleInput, type SaveChecklistScheduleRequest } from "@quincy/shared";
import { initials } from "../lib/initials";
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
import { buttonClasses } from "./quincy/Button";
import { IconButton, META_TRIGGER } from "./quincy/icon-button";
import type { MentionableUser } from "./MentionAutocomplete";

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

const ASSIGNEE_MEMBER_CLASSES = cn(
  "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-[var(--space-3)] w-full text-left",
  // 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token.
  "min-h-[44px] px-[var(--space-3)] py-[var(--space-2)]",
  "bg-transparent border-0 [border-left-style:solid] border-l-[length:var(--border-width-bold)] border-l-transparent",
  "text-foreground [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] cursor-pointer",
  "hover:bg-secondary active:bg-surface-sunken",
  "aria-[current=true]:border-l-border-strong",
  "aria-selected:text-signal-positive",
  "disabled:bg-surface-sunken disabled:text-foreground-secondary disabled:cursor-not-allowed",
  RING_IN,
);

type Subtask = ProjectSubtask;
type PopoverKind = "schedule" | "assignee" | "actions";
type ActivePopover = { owner: string; kind: PopoverKind } | null;

function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
type EndpointDraft = { kind: "date" | "timed"; date: string; time: string; disambiguation?: "earlier" | "later" };
type ScheduleDraft = { state: "unscheduled" | "due_only" | "range"; kind: "date" | "timed"; start: EndpointDraft; end: EndpointDraft };
type ScheduleError = { endpoint?: "start" | "end"; choices?: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }>; current?: ChecklistScheduleDto; currentSubtask?: Subtask };
function civilParts(value: string | null) { const [date = "", time = ""] = (value ?? "").split("T"); return { date, time }; }
function endpointDraft(value: { kind: "date" | "timed"; localCivil: string } | null, fallbackKind: "date" | "timed" = "date"): EndpointDraft { const parts = civilParts(value?.localCivil ?? ""); return { kind: value?.kind ?? fallbackKind, date: parts.date, time: parts.time }; }
function scheduleDraft(value: ChecklistScheduleDto): ScheduleDraft {
  if (value.state === "invalid") return { state: "unscheduled", kind: "date", start: endpointDraft(null), end: endpointDraft(null) };
  if (value.state === "legacy_unresolved") return { state: "due_only", kind: value.due.includes("T") ? "timed" : "date", start: endpointDraft(null), end: endpointDraft({ kind: value.due.includes("T") ? "timed" : "date", localCivil: value.due }) };
  return { state: value.state, kind: value.end?.kind ?? "date", start: endpointDraft(value.start, value.end?.kind ?? "date"), end: endpointDraft(value.end, value.end?.kind ?? "date") };
}
function formatSchedule(value: ChecklistScheduleDto): string {
  if (value.state === "invalid") return "Schedule data needs repair";
  if (value.state === "legacy_unresolved") return `Due ${value.due}`;
  if (value.state === "unscheduled") return "Unscheduled";
  if (value.state === "due_only") return `Due ${displayCivil(value.end?.localCivil ?? value.due ?? "")}`;
  return `${displayCivil(value.start?.localCivil ?? "")} → ${displayCivil(value.end?.localCivil ?? value.due ?? "")}`;
}
function displayCivil(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?$/.exec(value);
  if (!match) return value;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(match[3])} ${months[Number(match[2]) - 1] ?? match[2]} ${match[1]}${match[4] ? ` · ${match[4]}` : ""}`;
}
function ensureSchedule(item: Subtask): Subtask {
  if (item.schedule) return item;
  const due = item.dueDate;
  const endpoint = due ? { kind: due.includes("T") ? "timed" as const : "date" as const, localCivil: due, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const } : null;
  return { ...item, schedule: due ? { state: "due_only", version: 0, zone: CHECKLIST_SCHEDULE_ZONE, start: null, end: endpoint, due } : { state: "unscheduled", version: 0, zone: CHECKLIST_SCHEDULE_ZONE, start: null, end: null, due: null } };
}
function toEndpointInput(value: EndpointDraft): { kind: "date"; localCivil: string } | { kind: "timed"; localCivil: string; disambiguation?: "earlier" | "later" } {
  return value.kind === "date" ? { kind: "date", localCivil: value.date } : { kind: "timed", localCivil: `${value.date}T${value.time}`, ...(value.disambiguation ? { disambiguation: value.disambiguation } : {}) };
}
function scheduleInput(value: ScheduleDraft): InitialChecklistScheduleInput {
  if (value.state === "unscheduled") return { state: "unscheduled" };
  if (value.state === "due_only") return { state: "due_only", end: toEndpointInput({ ...value.end, kind: value.kind }) };
  return { state: "range", start: toEndpointInput({ ...value.start, kind: value.kind }), end: toEndpointInput({ ...value.end, kind: value.kind }) };
}
function schedulePreview(input: InitialChecklistScheduleInput): ChecklistScheduleDto {
  const endpoint = (value: { kind: "date" | "timed"; localCivil: string }) => ({ kind: value.kind, localCivil: value.localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const });
  if (input.state === "unscheduled") return { state: "unscheduled", version: 0, zone: CHECKLIST_SCHEDULE_ZONE, start: null, end: null, due: null };
  if (input.state === "due_only") return { state: "due_only", version: 0, zone: CHECKLIST_SCHEDULE_ZONE, start: null, end: endpoint(input.end), due: input.end.localCivil };
  return { state: "range", version: 0, zone: CHECKLIST_SCHEDULE_ZONE, start: endpoint(input.start), end: endpoint(input.end), due: input.end.localCivil };
}

export function scheduleReorderFocus(grips: Map<string, HTMLButtonElement>, id: string, formerIndex: number, composerOpen: boolean, composerInput: HTMLInputElement | null, projectId: string, isBusy: () => boolean = () => false) {
  const attempt = () => { if (isBusy()) { window.setTimeout(attempt, 16); return; } const grip = grips.get(id) ?? [...grips.values()][Math.min(formerIndex, Math.max(grips.size - 1, 0))]; if (grip) grip.focus(); else if (composerOpen) composerInput?.focus(); else document.getElementById(`subtask-add-${projectId}`)?.focus(); };
  window.setTimeout(attempt, 0);
}

function popoverId(owner: string, kind: PopoverKind) { return `subtask-popover-${owner}-${kind}`; }

function ScheduleControl({ owner, label, value, open, setOpen, onSave, onUseLatest, onUseLatestItem, busy, compact = false, error }: { owner: string; label: string; value: ChecklistScheduleDto; open: boolean; setOpen: (open: boolean) => void; onSave: (value: SaveChecklistScheduleRequest) => void; onUseLatest?: (value: ChecklistScheduleDto) => void; onUseLatestItem?: (value: Subtask) => void; busy: boolean; compact?: boolean; error?: ScheduleError }) {
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
      if (draftBaseVersion.current === null) draftBaseVersion.current = value.version;
      return;
    }
    if (busy) return;
    if (error) { if (retainedDraft.current) setDraft(retainedDraft.current); return; }
    draftBaseVersion.current = null;
    retainedDraft.current = null;
    setDraft(scheduleDraft(value));
  }, [open, value, busy, error]);
  const id = popoverId(owner, "schedule");
  const readOnly = value.state === "invalid" || (!CHECKLIST_SCHEDULE_RANGES_ENABLED && value.state === "range");
  const setEndpoint = (which: "start" | "end", next: Partial<EndpointDraft>) => setDraft((current) => ({ ...current, [which]: { ...current[which], ...next } }));
  const endpointFields = (which: "start" | "end", endpoint: EndpointDraft) => <fieldset className="grid gap-[var(--space-2)] min-w-0 p-[var(--space-2)] [border-style:solid] border-[length:var(--border-width-hair)] border-border"><legend className="px-[var(--space-1)] [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground">{which === "start" ? "Start" : "End"}</legend><label className={POPOVER_LABEL}>Date <Input type="date" className={FIELD_RING_IN} value={endpoint.date} onChange={(event) => setEndpoint(which, { date: event.target.value })} /></label>{draft.kind === "timed" && <label className={POPOVER_LABEL}>Time <Input type="time" className={FIELD_RING_IN} step={60} value={endpoint.time} disabled={!endpoint.date} onChange={(event) => setEndpoint(which, { time: event.target.value })} /></label>}{error?.endpoint === which && error.choices && <fieldset className="grid gap-[var(--space-1)] m-0 min-w-0 p-[var(--space-2)] [border-style:dashed] border-[length:var(--border-width-hair)] border-border"><legend className="px-[var(--space-1)] [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary">Choose the Sydney occurrence</legend>{error.choices.map((choice) => <label key={choice.disambiguation} className={FOLD_CHOICE_LABEL}><input type="radio" className={cn("accent-[var(--accent)] cursor-pointer", RING_IN)} name={`${id}-${which}-fold`} checked={endpoint.disambiguation === choice.disambiguation} onChange={() => setEndpoint(which, { disambiguation: choice.disambiguation })} />{choice.disambiguation === "earlier" ? "Earlier" : "Later"} ({choice.utcOffsetMinutes >= 0 ? "+" : ""}{choice.utcOffsetMinutes} min)</label>)}</fieldset>}</fieldset>;
  return <>
    <button ref={floating.refs.setReference} type="button" className={compact ? COMPOSER_TRIGGER_CLASSES : META_TRIGGER} aria-label={label} aria-expanded={open && !readOnly} aria-controls={open && !readOnly ? id : undefined} disabled={readOnly || busy} title={readOnly && value.state === "invalid" ? "Schedule data needs repair" : undefined} onKeyDown={floating.onKeyDown} onClick={() => { if (!readOnly) setOpen(!open); }}>
      {value.state !== "unscheduled" ? <StatusPill tone="neutral" className="min-w-0"><span className="sr-only">Schedule </span><span className="block truncate min-w-0">{formatSchedule(value)}</span></StatusPill> : <span aria-hidden="true">◷</span>}
    </button>
    {floating.mounted && !readOnly && <AnchoredPopover context={floating.context} floatingStyles={floating.floatingStyles} initialFocus={0} onKeyDown={floating.onKeyDown} status={floating.status}><div id={id} className={POPOVER_CONTENT} role="group" aria-label={label}>
      <label className={POPOVER_LABEL}>State <NativeSelect className={FIELD_RING_IN} value={draft.state} onChange={(event) => setDraft((current) => ({ ...current, state: event.target.value as ScheduleDraft["state"] }))}><option value="unscheduled">Unscheduled</option><option value="due_only">Due only</option>{CHECKLIST_SCHEDULE_RANGES_ENABLED && <option value="range">Range</option>}</NativeSelect></label>
      {draft.state !== "unscheduled" && <><label className={POPOVER_LABEL}>Endpoint kind <NativeSelect className={FIELD_RING_IN} value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as "date" | "timed" }))}><option value="date">Date</option><option value="timed">Timed · Australia/Sydney</option></NativeSelect></label>{draft.state === "range" ? <>{endpointFields("start", draft.start)}{endpointFields("end", draft.end)}</> : endpointFields("end", draft.end)}</>}
      {error && !error.choices && !error.current && <Notice tone="critical" role="alert">The schedule could not be saved. Review the highlighted fields.</Notice>}
      {error?.currentSubtask ? <Notice tone="caution" role="status"><strong>Latest checklist item · schedule v{error.currentSubtask.schedule.version}</strong><dl className="grid gap-[var(--space-1)] m-0"><div className="flex items-baseline justify-between gap-[var(--space-3)]"><dt className={POPOVER_LABEL}>Title</dt><dd className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground">{error.currentSubtask.title}</dd></div><div className="flex items-baseline justify-between gap-[var(--space-3)]"><dt className={POPOVER_LABEL}>Done</dt><dd className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground">{error.currentSubtask.done ? "Complete" : "Open"}</dd></div><div className="flex items-baseline justify-between gap-[var(--space-3)]"><dt className={POPOVER_LABEL}>Assignee</dt><dd className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground">{error.currentSubtask.assignee?.name ?? "Unassigned"}</dd></div><div className="flex items-baseline justify-between gap-[var(--space-3)]"><dt className={POPOVER_LABEL}>Schedule</dt><dd className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground">{formatSchedule(error.currentSubtask.schedule)}</dd></div></dl><button type="button" className={buttonClasses("secondary", { className: cn("justify-self-start", RING_IN) })} disabled={busy} onClick={() => { onUseLatestItem?.(error.currentSubtask!); close(); }}>Use latest item (discard draft)</button><span className={cn(META_TEXT, "!normal-case")}>Save reapplies your retained schedule draft; Cancel discards it.</span></Notice> : error?.current && <Notice tone="caution" role="status"><strong>Latest schedule · v{error.current.version}</strong><span>{formatSchedule(error.current)}</span><button type="button" className={buttonClasses("secondary", { className: cn("justify-self-start", RING_IN) })} disabled={busy} onClick={() => { onUseLatest?.(error.current!); close(); }}>Use latest schedule (discard draft)</button><span className={cn(META_TEXT, "!normal-case")}>Save reapplies your retained schedule draft; Cancel discards it.</span></Notice>}
      <div className={POPOVER_ACTIONS}><button type="button" className={buttonClasses("primary", { className: RING_IN })} disabled={busy} onClick={() => { retainedDraft.current = draft; onSave({ expectedVersion: error?.current?.version ?? draftBaseVersion.current ?? value.version, schedule: scheduleInput(draft) }); close(); }}>Save</button><button type="button" className={buttonClasses("secondary", { className: RING_IN })} disabled={busy} onClick={() => { draftBaseVersion.current = null; retainedDraft.current = null; setDraft(scheduleDraft(value)); close(); }}>Cancel</button></div>
    </div></AnchoredPopover>}
  </>;
}

function AssigneeControl({ owner, label, assignee, users, open, setOpen, onSelect, busy, compact = false }: { owner: string; label: string; assignee: { id: string; name: string } | null; users: MentionableUser[]; open: boolean; setOpen: (open: boolean) => void; onSelect: (id: string | null) => void; busy: boolean; compact?: boolean }) {
  const [query, setQuery] = useState(""); const searchRef = useRef<HTMLInputElement>(null);
  // Keyboard highlight (§10.3) — mirrors the retired `ProjectTeamControl`'s `TeamPicker`
  // (`activeIndex`, Arrow navigation, `aria-current`), not previously wired up for this list.
  // `ProjectTeamControl` was replaced by `ProjectTeamCombobox` in #204, which delegates keyboard
  // highlighting to Base UI's Combobox instead of reimplementing it — this list's own wiring
  // stands alone now, but the pattern it borrowed came from there.
  const [activeIndex, setActiveIndex] = useState(0);
  const close = useCallback(() => setOpen(false), [setOpen]); const floating = useAnchoredPopover({ open, onClose: close, placement: "bottom-end" });
  useEffect(() => { if (!open) setQuery(""); else setActiveIndex(0); }, [open]);
  const id = popoverId(owner, "assignee"); const matches = users.filter((user) => `${user.name} ${user.role}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { if (activeIndex >= matches.length) setActiveIndex(Math.max(0, matches.length - 1)); }, [activeIndex, matches.length]);
  function onListKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, Math.max(0, matches.length - 1))); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
    if (event.key === "Enter" && matches[activeIndex] && !busy) { event.preventDefault(); const user = matches[activeIndex]!; onSelect(user.id === assignee?.id ? null : user.id); close(); }
    floating.onKeyDown(event);
  }
  return <>
    <button ref={floating.refs.setReference} type="button" className={compact ? COMPOSER_TRIGGER_CLASSES : META_TRIGGER} aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} onKeyDown={floating.onKeyDown} onClick={() => setOpen(!open)} title={assignee?.name}>
      {assignee ? <span className="grid place-items-center size-[var(--space-5)] shrink-0 rounded-[var(--radius-pill)] bg-primary text-[var(--accent-on)] [font:var(--weight-regular)_var(--text-2xs)/1_var(--font-sans)] tracking-[0.02em]"><span aria-hidden="true">{initials(assignee.name)}</span><span className="sr-only">Assigned to {assignee.name}</span></span> : <span aria-hidden="true">♙</span>}
    </button>
    {floating.mounted && <AnchoredPopover context={floating.context} floatingStyles={floating.floatingStyles} initialFocus={searchRef} onKeyDown={onListKeyDown} status={floating.status}><div id={id} className={POPOVER_CONTENT} role="group" aria-label={label}>
      <label className="sr-only" htmlFor={`${id}-search`}>Search assignees</label><Input ref={searchRef} id={`${id}-search`} type="search" className={FIELD_RING_IN} value={query} placeholder="Search members…" onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} />
      <div className="grid overflow-auto min-w-0" role="listbox" aria-label={label}>{matches.map((user, index) => <button key={user.id} type="button" role="option" aria-selected={user.id === assignee?.id} aria-current={index === activeIndex ? "true" : undefined} className={ASSIGNEE_MEMBER_CLASSES} disabled={busy} onMouseEnter={() => setActiveIndex(index)} onClick={() => { onSelect(user.id === assignee?.id ? null : user.id); close(); }}>{user.name}<small className="text-foreground-secondary">{user.role}</small></button>)}</div>
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

function SortableSubtaskRow({ item, users, busy, editing, draftTitle, popover, setPopover, scheduleError, onUpdate, onUseLatest, onUseLatestItem, onRemove, onBeginEditing, onEndEditing, titleInputRef, itemRef, gripRef }: { item: Subtask; users: MentionableUser[]; busy: boolean; editing: boolean; draftTitle: string; popover: ActivePopover; setPopover: (value: ActivePopover) => void; scheduleError?: ScheduleError; onUpdate: (body: Record<string, unknown>, action: string) => void; onUseLatest: (schedule: ChecklistScheduleDto) => void; onUseLatestItem: (item: Subtask) => void; onRemove: () => void; onBeginEditing: () => void; onEndEditing: () => void; titleInputRef: (element: HTMLInputElement | null) => void; itemRef: (element: HTMLElement | null) => void; gripRef: (element: HTMLButtonElement | null) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: busy });
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
      "max-[721px]:grid max-[721px]:grid-cols-[auto_auto_minmax(0,1fr)]",
      "max-[721px]:items-center max-[721px]:gap-[var(--space-2)]",
      "min-[721px]:flex min-[721px]:items-center min-[721px]:gap-[var(--space-2)]",
    )}>
      <IconButton ref={combinedGripRef} aria-label={`Reorder ${item.title}`} className="cursor-grab active:cursor-grabbing" {...dragProps}>⠿</IconButton>
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
        <AssigneeControl owner={item.id} label={`Assignee for ${item.title}`} assignee={item.assignee} users={users} open={activeKind === "assignee"} setOpen={(open) => setKind("assignee", open)} onSelect={(assigneeId) => onUpdate({ assigneeId }, "assignee")} busy={busy} />
        <ActionsControl owner={item.id} title={item.title} open={activeKind === "actions"} setOpen={(open) => setKind("actions", open)} busy={busy} onDelete={onRemove} />
      </div>
    </div>
  </article>;
}

export function SubtaskChecklist({ projectId, onAccessFailure }: { projectId: string; onAccessFailure?: (error: unknown) => void }) {
  const queryClient = useOptionalProjectQueryClient();
  const session = useSession();
  const subtasksQuery = useProjectSubtasksQuery(projectId, true, false, session.data?.user.role === "external_editor" ? "external_editor" : "admin");
  const queryRuntime = queryClient ? getProjectQueryRuntime(queryClient) : undefined;
  const terminateOnUnauthorized = useProjectAccessTermination();
  const onAccessFailureRef = useRef(onAccessFailure);
  onAccessFailureRef.current = onAccessFailure;
  const [subtasks, setSubtasks] = useState<Subtask[]>([]); const [users, setUsers] = useState<MentionableUser[]>([]); const [adding, setAdding] = useState(false); const [busy, setBusy] = useState<Set<string>>(new Set());
  const [newTitle, setNewTitle] = useState(""); const [newAssigneeId, setNewAssigneeId] = useState<string | null>(null); const [newSchedule, setNewSchedule] = useState<InitialChecklistScheduleInput>({ state: "unscheduled" }); const [newSchedulePreview, setNewSchedulePreview] = useState<ChecklistScheduleDto>(() => schedulePreview({ state: "unscheduled" })); const [composerOpen, setComposerOpen] = useState(false); const [activePopover, setActivePopover] = useState<ActivePopover>(null);
  const [draftTitles, setDraftTitles] = useState<Record<string, string>>({}); const [notice, setNotice] = useState(""); const [open, setOpen] = useState(true); const [editingId, setEditingId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false); const [scheduleErrors, setScheduleErrors] = useState<Record<string, ScheduleError>>({});
  const panelId = useId(); const itemRefs = useRef(new Map<string, HTMLElement>()); const titleInputRefs = useRef(new Map<string, HTMLInputElement>()); const gripRefs = useRef(new Map<string, HTMLButtonElement>()); const composerInputRef = useRef<HTMLInputElement>(null); const priorEditingId = useRef<string | null>(null); const cancelledTitles = useRef(new Set<string>()); const restoreAddFocus = useRef(false); const busyRef = useRef(new Set<string>());
  const itemRef = (id: string) => (element: HTMLElement | null) => { if (element) itemRefs.current.set(id, element); else itemRefs.current.delete(id); };
  const titleInputRef = (id: string) => (element: HTMLInputElement | null) => { if (element) titleInputRefs.current.set(id, element); else titleInputRefs.current.delete(id); };
  const gripRef = (id: string) => (element: HTMLButtonElement | null) => { if (element) gripRefs.current.set(id, element); else gripRefs.current.delete(id); };
  useEffect(() => { if (!dragging && subtasksQuery.data) setSubtasks(subtasksQuery.data.map(ensureSchedule)); }, [dragging, subtasksQuery.data]);
  useEffect(() => { if (!subtasksQuery.error) return; terminateOnUnauthorized(subtasksQuery.error); onAccessFailureRef.current?.(subtasksQuery.error); if (!(subtasksQuery.error instanceof Error && subtasksQuery.error.name === "AbortError")) setNotice(message(subtasksQuery.error, "Checklist could not be loaded.")); }, [subtasksQuery.error, terminateOnUnauthorized]);
  useEffect(() => { if (!queryRuntime) return; const owns = dragging || activePopover?.kind === "schedule" || [...busy].some((key) => key.endsWith(":schedule")); if (!owns) return; return queryRuntime.acquireOwner(projectDataKeys.subtasks(projectId)); }, [activePopover?.kind, busy, dragging, projectId, queryRuntime]);
  useEffect(() => {
    const generation = queryClient ? projectCollaborationDataGeneration(queryClient, projectId) : null;
    const request = session.data?.user.role === "external_editor"
      ? externalApiGet("mentionable", `/api/mentionable-users?projectId=${encodeURIComponent(projectId)}&q=`) as Promise<{ users: MentionableUser[] }>
      : apiGet<{ users: MentionableUser[] }>(`/api/mentionable-users?projectId=${encodeURIComponent(projectId)}&q=`);
    void request.then((response) => {
      if (queryClient && projectCollaborationDataGeneration(queryClient, projectId) !== generation) return;
      setUsers(response.users ?? []);
    }).catch((error) => {
      if (queryClient && projectCollaborationDataGeneration(queryClient, projectId) !== generation) return;
      terminateOnUnauthorized(error); onAccessFailureRef.current?.(error); if (!(error instanceof Error && error.name === "AbortError")) setNotice("Assignees could not be loaded.");
    });
  }, [projectId, queryClient, session.data?.user.role, terminateOnUnauthorized]);
  useLayoutEffect(() => { const changed = editingId !== priorEditingId.current; priorEditingId.current = editingId; if (!editingId || !changed || [...busy].some((key) => key.startsWith(`${editingId}:`))) return; const input = titleInputRefs.current.get(editingId); if (input && !input.disabled) input.focus(); }, [busy, editingId]);
  useLayoutEffect(() => { if (!composerOpen && restoreAddFocus.current) { restoreAddFocus.current = false; document.getElementById(`subtask-add-${projectId}`)?.focus(); } }, [composerOpen, projectId]);
  function setAction(id: string, value: boolean) { const next = new Set(busyRef.current); if (value) next.add(id); else next.delete(id); busyRef.current = next; setBusy(next); }
  function replace(updated: Subtask, broadcast = true) { const next = ensureSchedule(updated); setSubtasks((current) => current.map((item) => item.id === next.id ? next : item).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))); queryClient?.setQueryData<Subtask[]>(projectDataKeys.subtasks(projectId), (current) => current?.map((item) => item.id === next.id ? next : item)); if (broadcast) queryRuntime?.publish(createProjectDataInvalidationMessage(projectId, [{ kind: "subtasks" }])); }
  async function invalidateAfterMutation() { if (queryClient) await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "subtasks" }, { kind: "activity" }], dashboard: false, calendar: true }); }
  function itemIsBusy(id: string) { return [...busy].some((key) => key.startsWith(`${id}:`)); }
  function beginEditing(item: Subtask) { if (itemIsBusy(item.id)) return; cancelledTitles.current.delete(item.id); setDraftTitles((current) => ({ ...current, [item.id]: current[item.id] ?? item.title })); setEditingId(item.id); }
  function useLatestSchedule(item: Subtask, schedule: ChecklistScheduleDto) { replace({ ...item, schedule, dueDate: schedule.due }); setScheduleErrors((current) => { const next = { ...current }; delete next[item.id]; return next; }); }
  function useLatestItem(item: Subtask) { replace(item); setScheduleErrors((current) => { const next = { ...current }; delete next[item.id]; return next; }); }
  async function update(item: Subtask, body: Record<string, unknown>, action: string) { const key = `${item.id}:${action}`; setAction(key, true); setNotice(""); try { replace(await apiPatch<Subtask, Record<string, unknown>>(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(item.id)}`, body), false); await invalidateAfterMutation(); if (action === "schedule") setScheduleErrors((current) => { const next = { ...current }; delete next[item.id]; return next; }); } catch (error) { terminateOnUnauthorized(error); if (action === "schedule" && error instanceof ApiError && error.details && typeof error.details === "object") { const details = error.details as { details?: ScheduleError; current?: ChecklistScheduleDto; currentSubtask?: Subtask }; if (details.current || details.details || details.currentSubtask) setScheduleErrors((current) => ({ ...current, [item.id]: { ...(details.details ?? {}), ...(details.current ? { current: details.current } : {}), ...(details.currentSubtask ? { currentSubtask: details.currentSubtask } : {}) } })); } setNotice(message(error, "Subtask could not be updated.")); } finally { setAction(key, false); } }
  function titleAction(item: Subtask, body: Record<string, unknown>) { if ("__draft" in body) { setDraftTitles((current) => ({ ...current, [item.id]: String(body.__draft) })); return; } if ("__cancelTitle" in body) { cancelledTitles.current.add(item.id); setDraftTitles((current) => ({ ...current, [item.id]: item.title })); return; } if ("__saveTitle" in body) { const title = draftTitles[item.id] ?? item.title; if (cancelledTitles.current.delete(item.id)) return; if (title !== item.title && title.trim()) void update(item, { title }, "title"); } }
  function resetComposer(focus = true) { setNewTitle(""); setNewAssigneeId(null); setNewSchedule({ state: "unscheduled" }); setNewSchedulePreview(schedulePreview({ state: "unscheduled" })); setActivePopover(null); if (focus) restoreAddFocus.current = true; setComposerOpen(false); }
  async function add(event: React.FormEvent) { event.preventDefault(); if (!newTitle.trim()) return; setAdding(true); setNotice(""); const body: { title: string; assigneeId?: string; schedule: InitialChecklistScheduleInput } = { title: newTitle, schedule: newSchedule }; if (newAssigneeId) body.assigneeId = newAssigneeId; try { const task = ensureSchedule(await apiPost<Subtask, typeof body>(`/api/projects/${encodeURIComponent(projectId)}/subtasks`, body)); setSubtasks((current) => [...current, task].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))); queryClient?.setQueryData<Subtask[]>(projectDataKeys.subtasks(projectId), (current) => [...(current ?? []), task].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))); await invalidateAfterMutation(); resetComposer(); } catch (error) { terminateOnUnauthorized(error); setNotice(message(error, "Subtask could not be added.")); } finally { setAdding(false); } }
  async function remove(item: Subtask, index: number) { const key = `${item.id}:delete`; setAction(key, true); setNotice(""); const nextFocusId = subtasks[index + 1]?.id ?? subtasks[index - 1]?.id; try { await apiDelete(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(item.id)}`); setActivePopover(null); setEditingId((current) => current === item.id ? null : current); setSubtasks((current) => current.filter((candidate) => candidate.id !== item.id)); queryClient?.setQueryData<Subtask[]>(projectDataKeys.subtasks(projectId), (current) => current?.filter((candidate) => candidate.id !== item.id)); await invalidateAfterMutation(); window.setTimeout(() => { if (nextFocusId) itemRefs.current.get(nextFocusId)?.querySelector<HTMLButtonElement>(".subtask-checklist__title-trigger")?.focus(); else if (composerOpen) composerInputRef.current?.focus(); else document.getElementById(`subtask-add-${projectId}`)?.focus(); }, 0); } catch (error) { terminateOnUnauthorized(error); setNotice(message(error, "Subtask could not be deleted.")); } finally { setAction(key, false); } }
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  async function onDragEnd(event: DragEndEvent) { const activeId = String(event.active.id); const neighbors = reorderNeighbors(subtasks.map((item) => item.id), activeId, event.over ? String(event.over.id) : null); setDragging(false); if (!neighbors) return; const formerIndex = subtasks.findIndex((item) => item.id === activeId); const key = `${activeId}:reorder`; setAction(key, true); setNotice(""); let reload = false; try { await apiPost<{ position: number }, { beforeId: string | null; afterId: string | null }>(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(activeId)}/reorder`, { beforeId: neighbors.beforeId, afterId: neighbors.afterId }); const refreshed = await subtasksQuery.refetch(); if (refreshed.data) setSubtasks(refreshed.data.map(ensureSchedule)); reload = !refreshed.error; } catch (error) { terminateOnUnauthorized(error); if (error instanceof ApiError && error.status === 409) { setNotice("Subtask order changed; reload and try again"); const refreshed = await subtasksQuery.refetch(); if (refreshed.data) setSubtasks(refreshed.data.map(ensureSchedule)); reload = !refreshed.error; } else setNotice(message(error, "Subtask could not be reordered.")); } finally { setAction(key, false); if (reload) scheduleReorderFocus(gripRefs.current, activeId, formerIndex, composerOpen, composerInputRef.current, projectId, () => busyRef.current.has(key)); } }
  const doneCount = subtasks.filter((item) => item.done).length; const total = subtasks.length; const percent = total === 0 ? 0 : Math.round((doneCount / total) * 100); const composerAssignee = users.find((user) => user.id === newAssigneeId) ?? null;
  const loading = subtasksQuery.isPending && !subtasks.length;
  return <section className="grid gap-[var(--space-3)] pb-[var(--space-4)] [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border" aria-label="Project checklist"><header><h3 className="m-0"><button type="button" className={cn("grid grid-cols-[auto_minmax(0,1fr)] w-full gap-x-[var(--space-3)] gap-y-[var(--space-1)] p-[var(--space-2)] min-h-[38px] max-[721px]:min-h-[44px] bg-transparent border-0 text-left cursor-pointer text-foreground transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:bg-secondary", RING_OUT)} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}><Eyebrow>Checklist</Eyebrow><span className="flex items-center justify-end gap-[var(--space-2)] min-w-0"><span className="[font:var(--type-h3)] max-[721px]:!text-[length:var(--text-md)] tracking-[var(--tracking-tight)] text-foreground min-w-0 text-right">{doneCount} of {total} complete · {percent}%</span><span className="[font:var(--weight-regular)_var(--text-md)/1_var(--font-sans)] text-foreground-secondary" aria-hidden="true">{open ? "−" : "+"}</span></span><progress value={doneCount} max={Math.max(total, 1)} aria-hidden="true" className="col-span-full w-full h-[5px] [accent-color:var(--accent)]" /></button></h3></header><div className="min-h-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-destructive" aria-live="polite">{notice}</div><div id={panelId} className={cn("grid gap-[var(--space-3)]", !open && "hidden")} aria-hidden={!open}>{loading ? <EmptyState aria-live="polite" title="Loading checklist…" className={CHECKLIST_STATE_CLASSES} /> : <>{!subtasks.length && <EmptyState title="No subtasks yet." className={CHECKLIST_STATE_CLASSES} />}<DndContext sensors={sensors} onDragStart={() => { setDragging(true); setActivePopover(null); }} onDragEnd={(event) => void onDragEnd(event)}><SortableContext items={subtasks.map((item) => item.id)} strategy={verticalListSortingStrategy}><div>{subtasks.map((item, index) => <SortableSubtaskRow key={item.id} item={item} users={users} busy={itemIsBusy(item.id)} editing={editingId === item.id} draftTitle={draftTitles[item.id] ?? item.title} popover={activePopover} setPopover={setActivePopover} scheduleError={scheduleErrors[item.id]} onUpdate={(body, action) => action === "draft" || action === "title" ? titleAction(item, body) : void update(item, body, action)} onUseLatest={(schedule) => useLatestSchedule(item, schedule)} onUseLatestItem={useLatestItem} onRemove={() => void remove(item, index)} onBeginEditing={() => beginEditing(item)} onEndEditing={() => { if (editingId === item.id) setEditingId(null); }} titleInputRef={titleInputRef(item.id)} itemRef={itemRef(item.id)} gripRef={gripRef(item.id)} />)}</div></SortableContext></DndContext>{composerOpen ? <form className="grid gap-[var(--space-2)]" onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); resetComposer(); } }} onSubmit={(event) => void add(event)}><label className="sr-only" htmlFor={`subtask-composer-${projectId}`}>Add a subtask</label><Input ref={composerInputRef} id={`subtask-composer-${projectId}`} autoFocus value={newTitle} maxLength={500} disabled={adding} onChange={(event) => setNewTitle(event.target.value)} placeholder="Add a subtask…" /><div className={POPOVER_ACTIONS}><AssigneeControl owner="composer" label="Assignee for new subtask" assignee={composerAssignee} users={users} open={activePopover?.owner === "composer" && activePopover.kind === "assignee"} setOpen={(value) => setActivePopover(value ? { owner: "composer", kind: "assignee" } : null)} onSelect={setNewAssigneeId} busy={adding} compact /><ScheduleControl owner="composer" label="Schedule for new subtask" value={newSchedulePreview} open={activePopover?.owner === "composer" && activePopover.kind === "schedule"} setOpen={(value) => setActivePopover(value ? { owner: "composer", kind: "schedule" } : null)} onSave={(request) => { setNewSchedule(request.schedule); setNewSchedulePreview(schedulePreview(request.schedule)); }} busy={adding} compact /><span className="flex-1 max-[601px]:hidden" /><button className={buttonClasses("secondary")} type="button" disabled={adding} onClick={() => resetComposer()}>Cancel</button><button className={buttonClasses("primary")} type="submit" disabled={adding || !newTitle.trim()}>{adding ? "Adding…" : "Add"}</button></div></form> : <button id={`subtask-add-${projectId}`} type="button" className={ADD_BUTTON_CLASSES} onClick={() => setComposerOpen(true)}>+ Add an item</button>}</>}</div></section>;
}
