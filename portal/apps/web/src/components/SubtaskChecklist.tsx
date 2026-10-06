import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnchoredPopover, useAnchoredPopover, POPOVER_ACTIONS, POPOVER_CONTENT, RING_IN } from "./AnchoredPopover";
import { ApiError, apiDelete, apiPatch, apiPost } from "../lib/api";
import { useSession } from "../lib/auth";
import { invalidateProjectSurfaces, projectDataKeys, recordProjectArchivedRefusal, useOptionalProjectQueryClient, useProjectAccessTermination, useProjectSubtaskDefaultRange, useProjectSubtasksQuery, type ProjectSubtask } from "../lib/project-data";
import { createProjectDataInvalidationMessage, getProjectQueryRuntime } from "../lib/project-query-sync";
import { formatCivilRange, formatCivilSchedule } from "../lib/date-format";
import { sameReminderOffsets, shellAwarePopupPadding } from "../lib/date-time-field";
import { checklistScheduleToDto, normalizeChecklistSchedule, SUBTASK_REMINDER_DEFAULT_OFFSETS, type ChecklistScheduleDto, type RangeChecklistScheduleInput, type Role, type SubtaskRemindersDto } from "@quincy/shared";
import { reorderNeighbors } from "../lib/reorder-neighbors";
import { confirm } from "../lib/confirm";
import { cn } from "../lib/utils";
import { ARCHIVED_NOTICE_CLASS } from "./archived-notice";
import { Eyebrow } from "./quincy/Eyebrow";
import { EmptyState } from "./quincy/EmptyState";
import { Input } from "./reui/input";
import { Checkbox } from "./quincy/Checkbox";
import { Button, buttonClasses } from "./quincy/Button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./reui/collapsible";
import { Progress } from "./reui/progress";
import { IconButton } from "./quincy/icon-button";
import { SubtaskAssigneePicker } from "./quincy/SubtaskAssigneePicker";
import { SubtaskScheduleControl, subtaskPopoverId, type ScheduleError, type RetainedSchedule } from "./quincy/SubtaskScheduleControl";

// TB8-07 §5.1 — the toggle's outward focus ring. Not exported: `RING_OUT` is deliberately
// written out at each new-class-string site rather than centralised (§4.3).
const RING_OUT =
  "focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] " +
  "focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-2";

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

type Subtask = ProjectSubtask;
type PopoverKind = "schedule" | "actions";
type ActivePopover = { owner: string; kind: PopoverKind } | null;

/** The server refused a write because the Project is archived (#446/#448): a 409 with this code. */
function isArchivedRefusal(error: unknown) { return error instanceof ApiError && error.status === 409 && typeof error.details === "object" && error.details !== null && (error.details as { code?: unknown }).code === "subtask_project_archived"; }
const ARCHIVED_COPY = "Read-only while archived. Restore the project before changing the checklist.";
function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
/** A one-day range names its date once: "8 Oct 2026", or "8 Oct 2026 · 13:00 → 14:00" when timed. Lives in `lib/date-format.ts` (#376). */
export const formatSchedule = formatCivilSchedule;
/** The range the composer shows once the user has applied one: a real resolution of the request, never a hand-built DTO. */
function schedulePreview(input: RangeChecklistScheduleInput): ChecklistScheduleDto | null {
  const result = normalizeChecklistSchedule(input, 1);
  return result.ok ? checklistScheduleToDto(result.value) : null;
}

export function scheduleReorderFocus(grips: Map<string, HTMLButtonElement>, id: string, formerIndex: number, composerOpen: boolean, composerInput: HTMLInputElement | null, projectId: string, isBusy: () => boolean = () => false) {
  const attempt = () => { if (isBusy()) { window.setTimeout(attempt, 16); return; } const grip = grips.get(id) ?? [...grips.values()][Math.min(formerIndex, Math.max(grips.size - 1, 0))]; if (grip) grip.focus(); else if (composerOpen) composerInput?.focus(); else document.getElementById(`subtask-add-${projectId}`)?.focus(); };
  window.setTimeout(attempt, 0);
}


function ActionsControl({ owner, title, open, setOpen, busy, onDelete }: { owner: string; title: string; open: boolean; setOpen: (open: boolean) => void; busy: boolean; onDelete: () => void }) {
  const close = useCallback(() => setOpen(false), [setOpen]); const floating = useAnchoredPopover({ open, onClose: close }); const id = subtaskPopoverId(owner, "actions");
  return <>
    <IconButton ref={floating.refs.setReference} aria-label={`Actions for ${title}`} aria-expanded={open} aria-controls={open ? id : undefined} onKeyDown={floating.onKeyDown} onClick={() => setOpen(!open)}>⋯</IconButton>
    {floating.mounted && <AnchoredPopover context={floating.context} floatingStyles={floating.floatingStyles} initialFocus={0} onKeyDown={floating.onKeyDown} status={floating.status}><div id={id} className={POPOVER_CONTENT} role="group" aria-label={`Actions for ${title}`}><button type="button" className={buttonClasses("danger", { className: RING_IN })} disabled={busy} onClick={() => { void (async () => { if (!await confirm({ title: "Delete subtask?", message: "Delete this subtask?", confirmLabel: "Delete", danger: true })) return; close(); onDelete(); })(); }}>Delete</button></div></AnchoredPopover>}
  </>;
}

function SortableSubtaskRow({ item, projectId, role, busy, editing, draftTitle, popover, setPopover, scheduleError, retainedSchedule, onUpdate, onCommitAssignees, onUseLatest, onUseLatestItem, onRemove, onBeginEditing, onEndEditing, titleInputRef, itemRef, gripRef, sortable, twoLine, readOnly }: { readOnly: boolean; twoLine: boolean; sortable: boolean; item: Subtask; projectId: string; role: Role; busy: boolean; editing: boolean; draftTitle: string; popover: ActivePopover; setPopover: (value: ActivePopover) => void; scheduleError?: ScheduleError; retainedSchedule: RetainedSchedule; onUpdate: (body: Record<string, unknown>, action: string) => void; onCommitAssignees: (ids: string[], baseline: { ids: string[]; version: number | undefined }) => Promise<void>; onUseLatest: (schedule: ChecklistScheduleDto, reminders?: SubtaskRemindersDto) => void; onUseLatestItem: (item: Subtask) => void; onRemove: () => void; onBeginEditing: () => void; onEndEditing: () => void; titleInputRef: (element: HTMLInputElement | null) => void; itemRef: (element: HTMLElement | null) => void; gripRef: (element: HTMLButtonElement | null) => void }) {
  const projectDefault = useProjectSubtaskDefaultRange(projectId);
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
    data-row-layout={twoLine ? "two-line" : undefined}
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
      if (event.currentTarget.contains(next) || (activeKind && document.getElementById(subtaskPopoverId(item.id, activeKind))?.contains(next))) return;
      if (editing) onEndEditing();
    }}>
    <div className={cn(
      "min-w-0",
      // The rail (360px) is as narrow as a phone, so it takes the phone row's two-line arrangement at any viewport (#377).
      twoLine
        ? cn("grid items-center gap-[var(--space-2)]", sortable ? "grid-cols-[auto_auto_minmax(0,1fr)]" : "grid-cols-[auto_minmax(0,1fr)]")
        : cn("max-[721px]:grid", sortable ? "max-[721px]:grid-cols-[auto_auto_minmax(0,1fr)]" : "max-[721px]:grid-cols-[auto_minmax(0,1fr)]", "max-[721px]:items-center max-[721px]:gap-[var(--space-2)]", "min-[721px]:flex min-[721px]:items-center min-[721px]:gap-[var(--space-2)]"),
    )}>
      {sortable && <IconButton ref={combinedGripRef} aria-label={`Reorder ${item.title}`} className="cursor-grab active:cursor-grabbing" {...dragProps}>⠿</IconButton>}
      <label className={cn("grid place-items-center min-h-[28px] max-[721px]:min-h-[44px] max-[721px]:min-w-[44px]", readOnly ? "cursor-default max-[721px]:justify-items-start" : "cursor-pointer")}><Checkbox checked={item.done} disabled={busy || readOnly} onChange={(event) => onUpdate({ done: event.target.checked }, "done")} /><span className="sr-only">Mark {item.title} complete</span></label>
      {readOnly ? <span
        data-testid="subtask-checklist-title"
        className={cn(
          "flex-1 min-w-0 text-left [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]",
          "[overflow-wrap:anywhere] min-h-[28px] max-[721px]:min-h-[44px] flex items-center",
          item.done ? "text-foreground-secondary line-through" : "text-foreground",
        )}
      >{item.title}</span> : editing ? <Input ref={titleInputRef} className="flex-1 min-w-0" aria-label="Subtask title" value={draftTitle} disabled={busy} onChange={(event) => onUpdate({ __draft: event.target.value }, "draft")} onBlur={() => onUpdate({ __saveTitle: true }, "title")} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.preventDefault(); onUpdate({ __cancelTitle: true }, "title"); event.currentTarget.blur(); } }} /> : <button
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
      <div data-testid="subtask-checklist-meta" className={cn(
        "min-w-0",
        twoLine
          ? "col-span-full flex flex-wrap items-center gap-[var(--space-1)] pt-[var(--space-1)] [&>:last-child]:ms-auto"
          : cn("max-[721px]:col-span-full max-[721px]:flex max-[721px]:flex-wrap max-[721px]:items-center", "max-[721px]:gap-[var(--space-1)] max-[721px]:pt-[var(--space-1)] max-[721px]:[&>:last-child]:ms-auto", "min-[721px]:contents"),
      )}>
        <SubtaskScheduleControl owner={item.id} label={`Schedule for ${item.title}`} popupCollisionPadding={shellAwarePopupPadding} value={item.schedule} error={scheduleError} retained={retainedSchedule} open={activeKind === "schedule"} setOpen={(open) => setKind("schedule", open)} onSave={(schedule) => onUpdate({ schedule }, "schedule")} onUseLatest={onUseLatest} onUseLatestItem={onUseLatestItem} busy={busy} projectDefault={projectDefault} reminders={{ offsets: item.reminders.offsetsMinutes, next: item.reminders.nextOccurrence }} readOnly={readOnly} />
        <SubtaskAssigneePicker projectId={projectId} role={role} label={`Assignees for ${item.title}`} selected={item.assignees} version={item.assignmentVersion} hiddenCount={item.otherAssigneeCount ?? 0} busy={busy} readOnly={readOnly} onCommit={(ids, _people, baseline) => onCommitAssignees(ids, baseline)} />
        {!readOnly && <ActionsControl owner={item.id} title={item.title} open={activeKind === "actions"} setOpen={(open) => setKind("actions", open)} busy={busy} onDelete={onRemove} />}
      </div>
    </div>
  </article>;
}

export function SubtaskChecklist({ projectId, onAccessFailure, layout = "rail", archived = false }: { projectId: string; /** The Project is archived (#450): the checklist is read-only. Restore (true to false) turns editing back on. */ archived?: boolean; onAccessFailure?: (error: unknown) => void; /** "rail" (default) opens the checklist; "stacked" collapses it to its count. The panel derives it from the one 1100px breakpoint (#377). */ layout?: "rail" | "stacked" }) {
  const queryClient = useOptionalProjectQueryClient();
  const session = useSession();
  const role: Role = session.data?.user.role === "external_editor" ? "external_editor" : "admin";
  const subtasksQuery = useProjectSubtasksQuery(projectId, true, false, role);
  const projectDefault = useProjectSubtaskDefaultRange(projectId);
  const queryRuntime = queryClient ? getProjectQueryRuntime(queryClient) : undefined;
  const terminateOnUnauthorized = useProjectAccessTermination();
  const onAccessFailureRef = useRef(onAccessFailure);
  onAccessFailureRef.current = onAccessFailure;
  const [subtasks, setSubtasks] = useState<Subtask[]>([]); const [adding, setAdding] = useState(false); const [busy, setBusy] = useState<Set<string>>(new Set());
  const [newTitle, setNewTitle] = useState(""); const [newAssignees, setNewAssignees] = useState<Array<{ id: string; name: string }>>([]); const [newSchedule, setNewSchedule] = useState<RangeChecklistScheduleInput | null>(null); const [newSchedulePreview, setNewSchedulePreview] = useState<ChecklistScheduleDto | null>(null); const [newReminders, setNewReminders] = useState<number[]>([...SUBTASK_REMINDER_DEFAULT_OFFSETS]); const [composerOpen, setComposerOpen] = useState(false); const [activePopover, setActivePopover] = useState<ActivePopover>(null);
  const [draftTitles, setDraftTitles] = useState<Record<string, string>>({}); const [notice, setNotice] = useState(""); const [open, setOpen] = useState(layout === "rail"); const [completedOpen, setCompletedOpen] = useState(false); const [editingId, setEditingId] = useState<string | null>(null);
  // Read-only comes from the `archived` prop alone. A write refused as archived records the fact in the cache (#566), which feeds the prop at once.
  const readOnly = archived; const priorReadOnly = useRef(readOnly); const focusAfterFlip = useRef<{ inRail: boolean } | null>(null); const [refusalGeneration, setRefusalGeneration] = useState(0); const collapseTriggerRef = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState(false); const [scheduleErrors, setScheduleErrors] = useState<Record<string, ScheduleError>>({});
  // Held above the grouped rows so a Done toggle (row remount) cannot discard a retained schedule draft; entries are dropped when the item is deleted.
  const retainedSchedules = useRef(new Map<string, RetainedSchedule>());
  const retainedScheduleFor = (id: string) => { let entry = retainedSchedules.current.get(id); if (!entry) { entry = { draft: null, baseVersion: null }; retainedSchedules.current.set(id, entry); } return entry; };
  const sectionRef = useRef<HTMLElement>(null); const completedTriggerRef = useRef<HTMLButtonElement>(null); const priorLayout = useRef(layout); const itemRefs = useRef(new Map<string, HTMLElement>()); const titleInputRefs = useRef(new Map<string, HTMLInputElement>()); const gripRefs = useRef(new Map<string, HTMLButtonElement>()); const composerInputRef = useRef<HTMLInputElement>(null); const priorEditingId = useRef<string | null>(null); const cancelledTitles = useRef(new Set<string>()); const restoreAddFocus = useRef(false); const busyRef = useRef(new Set<string>());
  const itemRef = (id: string) => (element: HTMLElement | null) => { if (element) itemRefs.current.set(id, element); else itemRefs.current.delete(id); };
  const titleInputRef = (id: string) => (element: HTMLInputElement | null) => { if (element) titleInputRefs.current.set(id, element); else titleInputRefs.current.delete(id); };
  const gripRef = (id: string) => (element: HTMLButtonElement | null) => { if (element) gripRefs.current.set(id, element); else gripRefs.current.delete(id); };
  useEffect(() => { if (!dragging && subtasksQuery.data) setSubtasks(subtasksQuery.data); }, [dragging, subtasksQuery.data]);
  useEffect(() => { if (!subtasksQuery.error) return; terminateOnUnauthorized(subtasksQuery.error); onAccessFailureRef.current?.(subtasksQuery.error); if (!(subtasksQuery.error instanceof Error && subtasksQuery.error.name === "AbortError")) setNotice(message(subtasksQuery.error, "Checklist could not be loaded.")); }, [subtasksQuery.error, terminateOnUnauthorized]);
  useEffect(() => { if (!queryRuntime) return; const owns = dragging || activePopover?.kind === "schedule" || [...busy].some((key) => key.endsWith(":schedule") || key.endsWith(":assignees")); if (!owns) return; return queryRuntime.acquireOwner(projectDataKeys.subtasks(projectId)); }, [activePopover?.kind, busy, dragging, projectId, queryRuntime]);
  useLayoutEffect(() => { const changed = editingId !== priorEditingId.current; priorEditingId.current = editingId; if (!editingId || !changed || [...busy].some((key) => key.startsWith(`${editingId}:`))) return; const input = titleInputRefs.current.get(editingId); if (input && !input.disabled) input.focus(); }, [busy, editingId]);
  // A flip to read-only removes the focused control (or disables it, which Chrome only resolves to <body> a frame later), and a modal Project sheet
  // reclaims body focus on the next frame, so this runs in the layout phase: focus the always-mounted collapse button instead (#450).
  // Only when focus was genuinely lost (body, disabled, disconnected, or an ancestor of the rail): a connected, enabled control elsewhere keeps it.
  useLayoutEffect(() => { const flip = focusAfterFlip.current; if (!readOnly || !flip) return; focusAfterFlip.current = null; const active = document.activeElement; const section = sectionRef.current; if (!active || active === document.body || active.matches(":disabled") || (flip.inRail && (!active.isConnected || !section || active.contains(section)))) collapseTriggerRef.current?.focus(); }, [readOnly, refusalGeneration]);
  // Whenever the rail turns read-only, by the latch or by the `archived` prop arriving with a refetch, drop everything mid-edit: an open composer,
  // title edit, drafts and schedule popover would otherwise outlive the controls that own them (a held popover also keeps the subtasks poll off) (#450).
  useLayoutEffect(() => { const was = priorReadOnly.current; priorReadOnly.current = readOnly; if (was || !readOnly) return; resetComposer(false); setEditingId(null); setDraftTitles({}); setScheduleErrors({}); retainedSchedules.current.clear(); setActivePopover(null); }, [readOnly]);
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
  // can flip whether this project matches an active Dashboard search. #429: so can a done or assignee edit
  // (an OPEN Subtask's assignee is what People and My tasks match), so those converge the filtered lists too;
  // a schedule edit, a reorder and the rest cannot, so `dashboard` stays `false` for them.
  // `dashboardSearchOnly` keeps a baseline (unfiltered) query from refetching for nothing. `gantt: true` (#218) always invalidates the Gantt surface regardless of search
  // relevance, since a checklist mutation can affect Gantt density independent of the Dashboard search.
  async function invalidateAfterMutation(searchRelevant = false) { if (queryClient) await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "subtasks" }, { kind: "activity" }], dashboard: searchRelevant, calendar: true, dashboardSearchOnly: searchRelevant, gantt: true, people: searchRelevant }); }
  // Ticking a row moves it to the other group, which remounts it: focus follows it (an item that reopens) or lands on the next open row's
  // checkbox, else the previous one, else the "Completed" trigger (every open row is done). Never `<body>`, inside a modal sheet.
  function followDoneToggle(saved: Subtask, openIndex: number) {
    const checkboxOf = (id: string | undefined) => id ? itemRefs.current.get(id)?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null : null;
    const nextOpenId = openItems[openIndex + 1]?.id ?? openItems[openIndex - 1]?.id;
    window.setTimeout(() => { (saved.done ? checkboxOf(nextOpenId) ?? completedTriggerRef.current : checkboxOf(saved.id))?.focus(); }, 0);
  }
  function itemIsBusy(id: string) { return [...busy].some((key) => key.startsWith(`${id}:`)); }
  function beginEditing(item: Subtask) { if (itemIsBusy(item.id)) return; cancelledTitles.current.delete(item.id); setDraftTitles((current) => ({ ...current, [item.id]: current[item.id] ?? item.title })); setEditingId(item.id); }
  function useLatestSchedule(item: Subtask, schedule: ChecklistScheduleDto, reminders?: SubtaskRemindersDto) { replace({ ...item, schedule, dueDate: schedule.due, ...(reminders ? { reminders } : {}) }); setScheduleErrors((current) => { const next = { ...current }; delete next[item.id]; return next; }); }
  function useLatestItem(item: Subtask) { replace(item); setScheduleErrors((current) => { const next = { ...current }; delete next[item.id]; return next; }); }
  async function update(item: Subtask, body: Record<string, unknown>, action: string) { const railFocus = focusInRail(); const key = `${item.id}:${action}`; const hadFocus = action === "done" && itemRefs.current.get(item.id)?.contains(document.activeElement) === true; const openIndex = openItems.findIndex((candidate) => candidate.id === item.id); setAction(key, true); setNotice(""); try { const saved = await apiPatch<Subtask, Record<string, unknown>>(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(item.id)}`, body); replace(saved, false); await invalidateAfterMutation(action === "title" || action === "assignees" || action === "done"); if (hadFocus) followDoneToggle(saved, openIndex); if (action === "schedule") setScheduleErrors((current) => { const next = { ...current }; delete next[item.id]; return next; }); } catch (error) { terminateOnUnauthorized(error); if (isArchivedRefusal(error)) { void enterArchived(railFocus); return; } if (action === "schedule" && error instanceof ApiError && error.details && typeof error.details === "object") { const details = error.details as { code?: string; details?: ScheduleError; current?: ChecklistScheduleDto; currentSubtask?: Subtask }; if (details.current || details.details || details.currentSubtask) setScheduleErrors((current) => ({ ...current, [item.id]: { ...(details.details ?? {}), ...(details.current ? { current: details.current } : {}), ...(details.currentSubtask?.reminders ? { currentReminders: details.currentSubtask.reminders } : {}), ...(details.currentSubtask && details.code !== "subtask_schedule_version_conflict" ? { currentSubtask: details.currentSubtask } : {}) } })); } if (action === "assignees" && error instanceof ApiError && error.details && typeof error.details === "object") { const details = error.details as { code?: string; currentSubtask?: Subtask }; if (details.code === "subtask_assignment_version_conflict" && details.currentSubtask) { replace(details.currentSubtask); await invalidateAfterMutation(false); setNotice("Assignees changed elsewhere — showing the latest."); return; } if (details.code === "subtask_item_conflict" && details.currentSubtask) { replace(details.currentSubtask); await invalidateAfterMutation(false); } } setNotice(message(error, "Subtask could not be updated.")); } finally { setAction(key, false); } }
  async function commitAssignees(item: Subtask, ids: string[], baseline: { ids: string[]; version: number | undefined }) { const current = baseline.ids; const add = ids.filter((id) => !current.includes(id)); const remove = current.filter((id) => !ids.includes(id)); if (!add.length && !remove.length) return; await update(item, { assignees: { expectedVersion: baseline.version ?? item.assignmentVersion, add, remove } }, "assignees"); }
  function titleAction(item: Subtask, body: Record<string, unknown>) { if ("__draft" in body) { setDraftTitles((current) => ({ ...current, [item.id]: String(body.__draft) })); return; } if ("__cancelTitle" in body) { cancelledTitles.current.add(item.id); setDraftTitles((current) => ({ ...current, [item.id]: item.title })); return; } if ("__saveTitle" in body) { const title = draftTitles[item.id] ?? item.title; if (cancelledTitles.current.delete(item.id)) return; if (title !== item.title && title.trim()) void update(item, { title }, "title"); } }
  function resetComposer(focus = true) { setNewTitle(""); setNewAssignees([]); setNewSchedule(null); setNewSchedulePreview(null); setNewReminders([...SUBTASK_REMINDER_DEFAULT_OFFSETS]); setActivePopover(null); if (focus) restoreAddFocus.current = true; setComposerOpen(false); }
  // The server refused a write because the Project is archived: nothing in the rail is optimistic, so rolling back is clearing the drafts and refetching.
  // Whether focus is in the rail when a write starts: the refusal can land after the focused control is gone and the sheet moved focus (#450).
  const focusInRail = () => sectionRef.current?.contains(document.activeElement) === true;
  async function enterArchived(inRail: boolean) {
    focusAfterFlip.current = { inRail }; setNotice(""); setRefusalGeneration((generation) => generation + 1);
    if (queryClient) await recordProjectArchivedRefusal(queryClient, projectId);
    if (queryClient) void invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "detail" }, { kind: "collaboration-summary" }, { kind: "subtasks" }, { kind: "activity" }], dashboard: true, calendar: true, gantt: true });
  }
  // No chosen range (null): omit it and the server copies the Project's default range (ADR 0011).
  async function add(event: React.FormEvent) { event.preventDefault(); const railFocus = focusInRail(); if (!newTitle.trim()) return; setAdding(true); setNotice(""); const body: { title: string; assigneeIds?: string[]; schedule?: RangeChecklistScheduleInput; reminderOffsetsMinutes?: number[] } = { title: newTitle }; if (newSchedule) body.schedule = newSchedule; if (!sameReminderOffsets(newReminders, SUBTASK_REMINDER_DEFAULT_OFFSETS)) body.reminderOffsetsMinutes = newReminders; if (newAssignees.length) body.assigneeIds = newAssignees.map((person) => person.id); try { const task = await apiPost<Subtask, typeof body>(`/api/projects/${encodeURIComponent(projectId)}/subtasks`, body); setSubtasks((current) => [...current, task].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))); queryClient?.setQueryData<Subtask[]>(projectDataKeys.subtasks(projectId), (current) => [...(current ?? []), task].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))); await invalidateAfterMutation(true); resetComposer(); } catch (error) { terminateOnUnauthorized(error); if (isArchivedRefusal(error)) { void enterArchived(railFocus); return; } setNotice(message(error, "Subtask could not be added.")); } finally { setAdding(false); } }
  async function remove(item: Subtask) { const railFocus = focusInRail(); const key = `${item.id}:delete`; setAction(key, true); setNotice(""); const group = item.done ? doneItems : openItems; const groupIndex = group.findIndex((candidate) => candidate.id === item.id); const nextFocusId = group[groupIndex + 1]?.id ?? group[groupIndex - 1]?.id; try { await apiDelete(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(item.id)}`); setActivePopover(null); retainedSchedules.current.delete(item.id); setEditingId((current) => current === item.id ? null : current); setSubtasks((current) => current.filter((candidate) => candidate.id !== item.id)); queryClient?.setQueryData<Subtask[]>(projectDataKeys.subtasks(projectId), (current) => current?.filter((candidate) => candidate.id !== item.id)); await invalidateAfterMutation(true); window.setTimeout(() => { if (nextFocusId) itemRefs.current.get(nextFocusId)?.querySelector<HTMLButtonElement>(".subtask-checklist__title-trigger")?.focus(); else if (composerOpen) composerInputRef.current?.focus(); else document.getElementById(`subtask-add-${projectId}`)?.focus(); }, 0); } catch (error) { terminateOnUnauthorized(error); if (isArchivedRefusal(error)) { void enterArchived(railFocus); return; } setNotice(message(error, "Subtask could not be deleted.")); } finally { setAction(key, false); } }
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  async function onDragEnd(event: DragEndEvent) { const railFocus = focusInRail(); const activeId = String(event.active.id); const neighbors = reorderNeighbors(subtasks.map((item) => item.id), activeId, event.over ? String(event.over.id) : null); setDragging(false); if (!neighbors) return; const formerIndex = openItems.findIndex((item) => item.id === activeId); const key = `${activeId}:reorder`; setAction(key, true); setNotice(""); let reload = false; try { await apiPost<{ position: number }, { beforeId: string | null; afterId: string | null }>(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(activeId)}/reorder`, { beforeId: neighbors.beforeId, afterId: neighbors.afterId }); const refreshed = await subtasksQuery.refetch(); if (refreshed.data) setSubtasks(refreshed.data); reload = !refreshed.error; } catch (error) { terminateOnUnauthorized(error); if (isArchivedRefusal(error)) void enterArchived(railFocus); else if (error instanceof ApiError && error.status === 409) { setNotice("Subtask order changed; reload and try again"); const refreshed = await subtasksQuery.refetch(); if (refreshed.data) setSubtasks(refreshed.data); reload = !refreshed.error; } else setNotice(message(error, "Subtask could not be reordered.")); } finally { setAction(key, false); if (reload) scheduleReorderFocus(gripRefs.current, activeId, formerIndex, composerOpen, composerInputRef.current, projectId, () => busyRef.current.has(key)); } }
  const doneCount = doneItems.length; const total = subtasks.length;
  const loading = subtasksQuery.isPending && !subtasks.length;
  const rowFor = (item: Subtask, sortable: boolean) => <SortableSubtaskRow key={item.id} readOnly={readOnly} twoLine={layout === "rail"} sortable={sortable} item={item} projectId={projectId} role={role} busy={itemIsBusy(item.id)} editing={editingId === item.id} draftTitle={draftTitles[item.id] ?? item.title} popover={activePopover} setPopover={setActivePopover} scheduleError={scheduleErrors[item.id]} retainedSchedule={retainedScheduleFor(item.id)} onUpdate={(body, action) => action === "draft" || action === "title" ? titleAction(item, body) : void update(item, body, action)} onCommitAssignees={(ids, baseline) => commitAssignees(item, ids, baseline)} onUseLatest={(schedule, reminders) => useLatestSchedule(item, schedule, reminders)} onUseLatestItem={useLatestItem} onRemove={() => void remove(item)} onBeginEditing={() => beginEditing(item)} onEndEditing={() => { if (editingId === item.id) setEditingId(null); }} titleInputRef={titleInputRef(item.id)} itemRef={itemRef(item.id)} gripRef={sortable ? gripRef(item.id) : () => undefined} />;
  return <section ref={sectionRef} className={cn("grid gap-[var(--space-3)]", layout === "rail" ? "ps-[var(--space-5)] [border-left-style:solid] border-l-[length:var(--border-width-hair)] border-l-border" : "pb-[var(--space-4)] [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border")} aria-label="Project checklist">
    <Collapsible open={open} onOpenChange={setOpen} className="grid gap-[var(--space-3)]">
      <header className={cn("flex items-center gap-[var(--space-3)] min-w-0", layout === "stacked" && "max-[721px]:pe-[calc(var(--space-4)+44px)]")}>
        <h3 className="m-0"><Eyebrow>Checklist</Eyebrow></h3>
        <span data-testid="subtask-checklist-count" className="flex-1 min-w-0 [font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] tabular-nums text-foreground">{doneCount} / {total}<span className="sr-only"> complete</span></span>
        <CollapsibleTrigger ref={collapseTriggerRef} data-disclosure="" render={<IconButton aria-label={open ? "Collapse checklist" : "Expand checklist"} />}>{open ? "−" : "+"}</CollapsibleTrigger>
      </header>
      <Progress value={doneCount} max={Math.max(total, 1)} aria-label="Checklist progress" getAriaValueText={() => `${doneCount} of ${total} complete`} className="gap-0" />
      <div className="min-h-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)]" aria-live="polite">{readOnly && <p className={ARCHIVED_NOTICE_CLASS}>{ARCHIVED_COPY}</p>}{notice && <span className="text-destructive">{notice}</span>}</div>
      <CollapsibleContent keepMounted className="grid gap-[var(--space-3)]">{loading ? <EmptyState aria-live="polite" size="compact" title="Loading checklist…" /> : <>
        <DndContext sensors={sensors} onDragStart={() => { setDragging(true); setActivePopover(null); }} onDragEnd={(event) => void onDragEnd(event)}>
          <SortableContext items={openItems.map((item) => item.id)} strategy={verticalListSortingStrategy}><div>{openItems.map((item) => rowFor(item, !readOnly))}</div></SortableContext>
          {doneItems.length > 0 && <Collapsible open={completedOpen} onOpenChange={setCompletedOpen} className="grid gap-[var(--space-1)]">
            <CollapsibleTrigger ref={completedTriggerRef} data-disclosure="" render={<Button variant="text" className="justify-self-start" />}>Completed ({doneItems.length})</CollapsibleTrigger>
            <CollapsibleContent><div>{doneItems.map((item) => rowFor(item, false))}</div></CollapsibleContent>
          </Collapsible>}
        </DndContext>
        {readOnly ? null : composerOpen ? <form className="grid gap-[var(--space-2)]" onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); resetComposer(); } }} onSubmit={(event) => void add(event)}><label className="sr-only" htmlFor={`subtask-composer-${projectId}`}>Add a subtask</label><Input ref={composerInputRef} id={`subtask-composer-${projectId}`} autoFocus value={newTitle} maxLength={500} disabled={adding} onChange={(event) => setNewTitle(event.target.value)} placeholder="Add a subtask…" /><div className={POPOVER_ACTIONS}><SubtaskAssigneePicker projectId={projectId} role={role} label="Assignees for new subtask" selected={newAssignees} disabled={adding} compact onCommit={(_ids, people) => setNewAssignees(people)} /><SubtaskScheduleControl owner="composer" label="Schedule for new subtask" value={newSchedulePreview} defaultLabel={newSchedule ? undefined : (projectDefault ? formatCivilRange(projectDefault) : "Project default")} open={activePopover?.owner === "composer" && activePopover.kind === "schedule"} setOpen={(value) => setActivePopover(value ? { owner: "composer", kind: "schedule" } : null)} onSave={(request) => { setNewSchedule(request.schedule); setNewSchedulePreview(schedulePreview(request.schedule)); if (request.reminderOffsetsMinutes) setNewReminders(request.reminderOffsetsMinutes); }} projectDefault={projectDefault} busy={adding} compact reminders={{ offsets: newReminders }} /><span className="flex-1 max-[601px]:hidden" /><button className={buttonClasses("secondary")} type="button" disabled={adding} onClick={() => resetComposer()}>Cancel</button><button className={buttonClasses("primary")} type="submit" disabled={adding || !newTitle.trim()}>{adding ? "Adding…" : "Add"}</button></div></form> : <button id={`subtask-add-${projectId}`} type="button" className={ADD_BUTTON_CLASSES} onClick={() => setComposerOpen(true)}>+ Add an item</button>}
        {!subtasks.length && <EmptyState size="compact" title={readOnly ? "No checklist items." : "Break the shoot into steps anyone on the project can tick off."} />}
      </>}</CollapsibleContent>
    </Collapsible>
  </section>;
}
