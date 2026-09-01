import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AnchoredPopover, useAnchoredPopover } from "./AnchoredPopover";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";
import { externalApiGet } from "../lib/external-api-response";
import { useSession } from "../lib/auth";
import { invalidateProjectSurfaces, projectDataKeys, projectCollaborationDataGeneration, useOptionalProjectQueryClient, useProjectAccessTermination, useProjectSubtasksQuery, type ProjectSubtask } from "../lib/project-data";
import { createProjectDataInvalidationMessage, getProjectQueryRuntime } from "../lib/project-query-sync";
import { CHECKLIST_SCHEDULE_RANGES_ENABLED, CHECKLIST_SCHEDULE_ZONE, type ChecklistScheduleDto, type InitialChecklistScheduleInput, type SaveChecklistScheduleRequest } from "@quincy/shared";
import { initials } from "../lib/initials";
import { reorderNeighbors } from "../lib/reorder-neighbors";
import { confirm } from "../lib/confirm";
import type { MentionableUser } from "./MentionAutocomplete";

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
  const endpointFields = (which: "start" | "end", endpoint: EndpointDraft) => <fieldset className="subtask-schedule__endpoint"><legend>{which === "start" ? "Start" : "End"}</legend><label>Date <input type="date" value={endpoint.date} onChange={(event) => setEndpoint(which, { date: event.target.value })} /></label>{draft.kind === "timed" && <label>Time <input type="time" step={60} value={endpoint.time} disabled={!endpoint.date} onChange={(event) => setEndpoint(which, { time: event.target.value })} /></label>}{error?.endpoint === which && error.choices && <fieldset className="subtask-schedule__fold"><legend>Choose the Sydney occurrence</legend>{error.choices.map((choice) => <label key={choice.disambiguation}><input type="radio" name={`${id}-${which}-fold`} checked={endpoint.disambiguation === choice.disambiguation} onChange={() => setEndpoint(which, { disambiguation: choice.disambiguation })} />{choice.disambiguation === "earlier" ? "Earlier" : "Later"} ({choice.utcOffsetMinutes >= 0 ? "+" : ""}{choice.utcOffsetMinutes} min)</label>)}</fieldset>}</fieldset>;
  return <>
    <button ref={floating.refs.setReference} type="button" className={`subtask-checklist__metadata-trigger${value.state !== "unscheduled" ? " subtask-checklist__metadata-trigger--filled" : ""}${compact ? " subtask-checklist__composer-trigger" : ""}`} aria-label={label} aria-expanded={open && !readOnly} aria-controls={open && !readOnly ? id : undefined} disabled={readOnly || busy} title={readOnly && value.state === "invalid" ? "Schedule data needs repair" : undefined} onKeyDown={floating.onKeyDown} onClick={() => { if (!readOnly) setOpen(!open); }}>
      {value.state !== "unscheduled" ? <span className="subtask-checklist__due"><span className="sr-only">Schedule </span>{formatSchedule(value)}</span> : <span aria-hidden="true">◷</span>}
    </button>
    {floating.mounted && !readOnly && <AnchoredPopover context={floating.context} floatingStyles={floating.floatingStyles} initialFocus={0} onKeyDown={floating.onKeyDown} status={floating.status}><div id={id} className="subtask-popover__content" role="group" aria-label={label}>
      <label>State <select value={draft.state} onChange={(event) => setDraft((current) => ({ ...current, state: event.target.value as ScheduleDraft["state"] }))}><option value="unscheduled">Unscheduled</option><option value="due_only">Due only</option>{CHECKLIST_SCHEDULE_RANGES_ENABLED && <option value="range">Range</option>}</select></label>
      {draft.state !== "unscheduled" && <><label>Endpoint kind <select value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as "date" | "timed" }))}><option value="date">Date</option><option value="timed">Timed · Australia/Sydney</option></select></label>{draft.state === "range" ? <>{endpointFields("start", draft.start)}{endpointFields("end", draft.end)}</> : endpointFields("end", draft.end)}</>}
      {error && !error.choices && !error.current && <div className="subtask-schedule__error" role="alert">The schedule could not be saved. Review the highlighted fields.</div>}
      {error?.currentSubtask ? <div className="subtask-schedule__conflict" role="status"><strong>Latest checklist item · schedule v{error.currentSubtask.schedule.version}</strong><dl><div><dt>Title</dt><dd>{error.currentSubtask.title}</dd></div><div><dt>Done</dt><dd>{error.currentSubtask.done ? "Complete" : "Open"}</dd></div><div><dt>Assignee</dt><dd>{error.currentSubtask.assignee?.name ?? "Unassigned"}</dd></div><div><dt>Schedule</dt><dd>{formatSchedule(error.currentSubtask.schedule)}</dd></div></dl><button type="button" className="button button--secondary" disabled={busy} onClick={() => { onUseLatestItem?.(error.currentSubtask!); close(); }}>Use latest item (discard draft)</button><span>Save reapplies your retained schedule draft; Cancel discards it.</span></div> : error?.current && <div className="subtask-schedule__conflict" role="status"><strong>Latest schedule · v{error.current.version}</strong><span>{formatSchedule(error.current)}</span><button type="button" className="button button--secondary" disabled={busy} onClick={() => { onUseLatest?.(error.current!); close(); }}>Use latest schedule (discard draft)</button><span>Save reapplies your retained schedule draft; Cancel discards it.</span></div>}
      <div className="subtask-popover__actions"><button type="button" className="button" disabled={busy} onClick={() => { retainedDraft.current = draft; onSave({ expectedVersion: error?.current?.version ?? draftBaseVersion.current ?? value.version, schedule: scheduleInput(draft) }); close(); }}>Save</button><button type="button" className="button button--secondary" disabled={busy} onClick={() => { draftBaseVersion.current = null; retainedDraft.current = null; setDraft(scheduleDraft(value)); close(); }}>Cancel</button></div>
    </div></AnchoredPopover>}
  </>;
}

function AssigneeControl({ owner, label, assignee, users, open, setOpen, onSelect, busy, compact = false }: { owner: string; label: string; assignee: { id: string; name: string } | null; users: MentionableUser[]; open: boolean; setOpen: (open: boolean) => void; onSelect: (id: string | null) => void; busy: boolean; compact?: boolean }) {
  const [query, setQuery] = useState(""); const searchRef = useRef<HTMLInputElement>(null);
  // Keyboard highlight (§10.3) — mirrors `ProjectTeamControl`'s `TeamPicker` (`activeIndex`,
  // Arrow navigation, `aria-current`), not previously wired up for this list.
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
    <button ref={floating.refs.setReference} type="button" className={`subtask-checklist__metadata-trigger${assignee ? " subtask-checklist__metadata-trigger--filled" : ""}${compact ? " subtask-checklist__composer-trigger" : ""}`} aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} onKeyDown={floating.onKeyDown} onClick={() => setOpen(!open)} title={assignee?.name}>
      {assignee ? <span className="subtask-checklist__assignee avatar"><span aria-hidden="true">{initials(assignee.name)}</span><span className="sr-only">Assigned to {assignee.name}</span></span> : <span aria-hidden="true">♙</span>}
    </button>
    {floating.mounted && <AnchoredPopover context={floating.context} floatingStyles={floating.floatingStyles} initialFocus={searchRef} onKeyDown={onListKeyDown} status={floating.status}><div id={id} className="subtask-popover__content" role="group" aria-label={label}>
      <label className="sr-only" htmlFor={`${id}-search`}>Search assignees</label><input ref={searchRef} id={`${id}-search`} type="search" value={query} placeholder="Search members…" onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} />
      <div className="subtask-popover__members" role="listbox" aria-label={label}>{matches.map((user, index) => <button key={user.id} type="button" role="option" aria-selected={user.id === assignee?.id} aria-current={index === activeIndex ? "true" : undefined} className="subtask-popover__member" disabled={busy} onMouseEnter={() => setActiveIndex(index)} onClick={() => { onSelect(user.id === assignee?.id ? null : user.id); close(); }}>{user.name}<small>{user.role}</small></button>)}</div>
    </div></AnchoredPopover>}
  </>;
}

function ActionsControl({ owner, title, open, setOpen, busy, onDelete }: { owner: string; title: string; open: boolean; setOpen: (open: boolean) => void; busy: boolean; onDelete: () => void }) {
  const close = useCallback(() => setOpen(false), [setOpen]); const floating = useAnchoredPopover({ open, onClose: close }); const id = popoverId(owner, "actions");
  return <>
    <button ref={floating.refs.setReference} type="button" className="subtask-checklist__overflow" aria-label={`Actions for ${title}`} aria-expanded={open} aria-controls={open ? id : undefined} onKeyDown={floating.onKeyDown} onClick={() => setOpen(!open)}>⋯</button>
    {floating.mounted && <AnchoredPopover context={floating.context} floatingStyles={floating.floatingStyles} initialFocus={0} onKeyDown={floating.onKeyDown} status={floating.status}><div id={id} className="subtask-popover__content" role="group" aria-label={`Actions for ${title}`}><button type="button" className="button button--secondary" disabled={busy} onClick={() => { void (async () => { if (!await confirm({ title: "Delete subtask?", message: "Delete this subtask?", confirmLabel: "Delete", danger: true })) return; close(); onDelete(); })(); }}>Delete</button></div></AnchoredPopover>}
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
  return <article ref={combinedNodeRef} style={style} className={`subtask-checklist__item${item.done ? " subtask-checklist__item--done" : ""}${activeKind ? " subtask-checklist__item--popover-open" : ""}${isDragging ? " subtask-checklist__item--dragging" : ""}`} onBlur={(event) => {
    const next = event.relatedTarget as Node | null;
    if (event.currentTarget.contains(next) || (activeKind && document.getElementById(popoverId(item.id, activeKind))?.contains(next))) return;
    if (editing) onEndEditing();
  }}>
    <div className="subtask-checklist__summary">
      <button ref={combinedGripRef} type="button" className="subtask-checklist__grip" aria-label={`Reorder ${item.title}`} {...dragProps}>⠿</button>
      <label className="subtask-checklist__done"><input type="checkbox" checked={item.done} disabled={busy} onChange={(event) => onUpdate({ done: event.target.checked }, "done")} /><span className="sr-only">Mark {item.title} complete</span></label>
      {editing ? <input ref={titleInputRef} className="subtask-checklist__title" aria-label="Subtask title" value={draftTitle} disabled={busy} onChange={(event) => onUpdate({ __draft: event.target.value }, "draft")} onBlur={() => onUpdate({ __saveTitle: true }, "title")} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.preventDefault(); onUpdate({ __cancelTitle: true }, "title"); event.currentTarget.blur(); } }} /> : <button type="button" className="subtask-checklist__title-trigger" disabled={busy} onClick={onBeginEditing} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onBeginEditing(); } }}>{item.title}</button>}
      <ScheduleControl owner={item.id} label={`Schedule for ${item.title}`} value={item.schedule} error={scheduleError} open={activeKind === "schedule"} setOpen={(open) => setKind("schedule", open)} onSave={(schedule) => onUpdate({ schedule }, "schedule")} onUseLatest={onUseLatest} onUseLatestItem={onUseLatestItem} busy={busy} />
      <AssigneeControl owner={item.id} label={`Assignee for ${item.title}`} assignee={item.assignee} users={users} open={activeKind === "assignee"} setOpen={(open) => setKind("assignee", open)} onSelect={(assigneeId) => onUpdate({ assigneeId }, "assignee")} busy={busy} />
      <ActionsControl owner={item.id} title={item.title} open={activeKind === "actions"} setOpen={(open) => setKind("actions", open)} busy={busy} onDelete={onRemove} />
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
  return <section className="subtask-checklist" aria-label="Project checklist"><header className="subtask-checklist__head"><h3><button type="button" className="subtask-checklist__toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}><span className="ey">Checklist</span><span className="subtask-checklist__toggle-meta"><span className="subtask-checklist__progress-text">{doneCount} of {total} complete · {percent}%</span><span className="subtask-checklist__chevron" aria-hidden="true">{open ? "−" : "+"}</span></span><progress value={doneCount} max={Math.max(total, 1)} aria-hidden="true" /></button></h3></header><div className="subtask-checklist__notice" aria-live="polite">{notice}</div><div id={panelId} className={`subtask-checklist__panel${open ? "" : " is-collapsed"}`} aria-hidden={!open}>{loading ? <div className="project-collaboration__state" aria-live="polite">Loading checklist…</div> : <>{!subtasks.length && <div className="project-collaboration__state">No subtasks yet.</div>}<DndContext sensors={sensors} onDragStart={() => { setDragging(true); setActivePopover(null); }} onDragEnd={(event) => void onDragEnd(event)}><SortableContext items={subtasks.map((item) => item.id)} strategy={verticalListSortingStrategy}><div className="subtask-checklist__items">{subtasks.map((item, index) => <SortableSubtaskRow key={item.id} item={item} users={users} busy={itemIsBusy(item.id)} editing={editingId === item.id} draftTitle={draftTitles[item.id] ?? item.title} popover={activePopover} setPopover={setActivePopover} scheduleError={scheduleErrors[item.id]} onUpdate={(body, action) => action === "draft" || action === "title" ? titleAction(item, body) : void update(item, body, action)} onUseLatest={(schedule) => useLatestSchedule(item, schedule)} onUseLatestItem={useLatestItem} onRemove={() => void remove(item, index)} onBeginEditing={() => beginEditing(item)} onEndEditing={() => { if (editingId === item.id) setEditingId(null); }} titleInputRef={titleInputRef(item.id)} itemRef={itemRef(item.id)} gripRef={gripRef(item.id)} />)}</div></SortableContext></DndContext>{composerOpen ? <form className="subtask-checklist__composer" onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); resetComposer(); } }} onSubmit={(event) => void add(event)}><label className="sr-only" htmlFor={`subtask-composer-${projectId}`}>Add a subtask</label><input ref={composerInputRef} id={`subtask-composer-${projectId}`} autoFocus value={newTitle} maxLength={500} disabled={adding} onChange={(event) => setNewTitle(event.target.value)} placeholder="Add a subtask…" /><div className="subtask-checklist__composer-controls"><AssigneeControl owner="composer" label="Assignee for new subtask" assignee={composerAssignee} users={users} open={activePopover?.owner === "composer" && activePopover.kind === "assignee"} setOpen={(value) => setActivePopover(value ? { owner: "composer", kind: "assignee" } : null)} onSelect={setNewAssigneeId} busy={adding} compact /><ScheduleControl owner="composer" label="Schedule for new subtask" value={newSchedulePreview} open={activePopover?.owner === "composer" && activePopover.kind === "schedule"} setOpen={(value) => setActivePopover(value ? { owner: "composer", kind: "schedule" } : null)} onSave={(request) => { setNewSchedule(request.schedule); setNewSchedulePreview(schedulePreview(request.schedule)); }} busy={adding} compact /><span /><button className="button button--secondary" type="button" disabled={adding} onClick={() => resetComposer()}>Cancel</button><button className="button" type="submit" disabled={adding || !newTitle.trim()}>{adding ? "Adding…" : "Add"}</button></div></form> : <button id={`subtask-add-${projectId}`} type="button" className="subtask-checklist__add-button" onClick={() => setComposerOpen(true)}>+ Add an item</button>}</>}</div></section>;
}
