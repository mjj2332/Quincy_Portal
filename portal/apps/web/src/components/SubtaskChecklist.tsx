import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AnchoredPopover, useAnchoredPopover } from "./AnchoredPopover";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";
import { initials } from "../lib/initials";
import type { MentionableUser } from "./MentionAutocomplete";

type Subtask = { id: string; title: string; done: boolean; position: number; assignee: { id: string; name: string } | null; assignmentVersion: number; dueDate: string | null; createdBy: string; createdAt: string; updatedAt: string; };
type ChecklistResponse = { subtasks?: Subtask[] };
type PopoverKind = "due" | "assignee" | "actions";
type ActivePopover = { owner: string; kind: PopoverKind } | null;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function dueDateParts(value: string | null) { const [date = "", time = ""] = (value ?? "").split("T"); return { date, time }; }
function formatDueDate(value: string) {
  const { date, time } = dueDateParts(value); const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date); if (!match) return value;
  const [, year, month, day] = match; const monthIndex = Number(month) - 1; const yearNumber = Number(year);
  const maxDay = [31, yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthIndex] ?? 0;
  if (monthIndex < 0 || monthIndex > 11 || Number(day) < 1 || Number(day) > maxDay || (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) return value;
  const display = `${Number(day)} ${MONTHS[monthIndex]}${Number(year) === new Date().getFullYear() ? "" : ` ${year}`}`;
  return time ? `${display} · ${time}` : display;
}

export function reorderNeighbors(ids: string[], activeId: string, overId: string | null) {
  if (!overId || overId === activeId) return null;
  const activeIndex = ids.indexOf(activeId); const overIndex = ids.indexOf(overId);
  if (activeIndex < 0 || overIndex < 0) return null;
  const desired = [...ids]; desired.splice(activeIndex, 1); desired.splice(overIndex, 0, activeId);
  const destinationIndex = desired.indexOf(activeId);
  return { beforeId: desired[destinationIndex - 1] ?? null, afterId: desired[destinationIndex + 1] ?? null, destinationIndex };
}

export function scheduleReorderFocus(grips: Map<string, HTMLButtonElement>, id: string, formerIndex: number, composerOpen: boolean, composerInput: HTMLInputElement | null, projectId: string, isBusy: () => boolean = () => false) {
  const attempt = () => { if (isBusy()) { window.setTimeout(attempt, 16); return; } const grip = grips.get(id) ?? [...grips.values()][Math.min(formerIndex, Math.max(grips.size - 1, 0))]; if (grip) grip.focus(); else if (composerOpen) composerInput?.focus(); else document.getElementById(`subtask-add-${projectId}`)?.focus(); };
  window.setTimeout(attempt, 0);
}

function popoverId(owner: string, kind: PopoverKind) { return `subtask-popover-${owner}-${kind}`; }

function DueDateControl({ owner, label, value, open, setOpen, onSave, busy, compact = false }: { owner: string; label: string; value: string | null; open: boolean; setOpen: (open: boolean) => void; onSave: (value: string | null) => void; busy: boolean; compact?: boolean }) {
  const [draft, setDraft] = useState(() => dueDateParts(value));
  const close = useCallback(() => setOpen(false), [setOpen]);
  const floating = useAnchoredPopover({ open, onClose: close, placement: "bottom-start" });
  useEffect(() => { if (!open) setDraft(dueDateParts(value)); }, [open, value]);
  const id = popoverId(owner, "due");
  return <>
    <button ref={floating.refs.setReference} type="button" className={`subtask-checklist__metadata-trigger${value ? " subtask-checklist__metadata-trigger--filled" : ""}${compact ? " subtask-checklist__composer-trigger" : ""}`} aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} onKeyDown={floating.onKeyDown} onClick={() => setOpen(!open)}>
      {value ? <time className="subtask-checklist__due" dateTime={value}><span className="sr-only">Due </span>{formatDueDate(value)}</time> : <span aria-hidden="true">◷</span>}
    </button>
    {open && <AnchoredPopover context={floating.context} floatingStyles={floating.floatingStyles} initialFocus={0} onKeyDown={floating.onKeyDown}><div id={id} className="subtask-popover__content" role="group" aria-label={label}>
      <label>Date <input type="date" value={draft.date} onChange={(event) => setDraft((current) => ({ ...current, date: event.target.value }))} /></label>
      <label>Time <input type="time" value={draft.time} disabled={!draft.date} onChange={(event) => setDraft((current) => ({ ...current, time: event.target.value }))} /></label>
      <div className="subtask-popover__actions"><button type="button" className="button" disabled={busy} onClick={() => { onSave(draft.date ? `${draft.date}${draft.time ? `T${draft.time}` : ""}` : null); close(); }}>Save</button><button type="button" className="button button--secondary" disabled={busy} onClick={() => { onSave(null); close(); }}>Remove</button></div>
    </div></AnchoredPopover>}
  </>;
}

function AssigneeControl({ owner, label, assignee, users, open, setOpen, onSelect, busy, compact = false }: { owner: string; label: string; assignee: { id: string; name: string } | null; users: MentionableUser[]; open: boolean; setOpen: (open: boolean) => void; onSelect: (id: string | null) => void; busy: boolean; compact?: boolean }) {
  const [query, setQuery] = useState(""); const searchRef = useRef<HTMLInputElement>(null);
  const close = useCallback(() => setOpen(false), [setOpen]); const floating = useAnchoredPopover({ open, onClose: close, placement: "bottom-end" });
  useEffect(() => { if (!open) setQuery(""); }, [open]);
  const id = popoverId(owner, "assignee"); const matches = users.filter((user) => `${user.name} ${user.role}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <button ref={floating.refs.setReference} type="button" className={`subtask-checklist__metadata-trigger${assignee ? " subtask-checklist__metadata-trigger--filled" : ""}${compact ? " subtask-checklist__composer-trigger" : ""}`} aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} onKeyDown={floating.onKeyDown} onClick={() => setOpen(!open)} title={assignee?.name}>
      {assignee ? <span className="subtask-checklist__assignee avatar"><span aria-hidden="true">{initials(assignee.name)}</span><span className="sr-only">Assigned to {assignee.name}</span></span> : <span aria-hidden="true">♙</span>}
    </button>
    {open && <AnchoredPopover context={floating.context} floatingStyles={floating.floatingStyles} initialFocus={searchRef} onKeyDown={floating.onKeyDown}><div id={id} className="subtask-popover__content" role="group" aria-label={label}>
      <label className="sr-only" htmlFor={`${id}-search`}>Search assignees</label><input ref={searchRef} id={`${id}-search`} type="search" value={query} placeholder="Search members…" onChange={(event) => setQuery(event.target.value)} />
      <div className="subtask-popover__members">{matches.map((user) => <button key={user.id} type="button" className="subtask-popover__member" disabled={busy} onClick={() => { onSelect(user.id === assignee?.id ? null : user.id); close(); }}>{user.name}<small>{user.role}</small></button>)}</div>
    </div></AnchoredPopover>}
  </>;
}

function ActionsControl({ owner, title, open, setOpen, busy, onDelete }: { owner: string; title: string; open: boolean; setOpen: (open: boolean) => void; busy: boolean; onDelete: () => void }) {
  const close = useCallback(() => setOpen(false), [setOpen]); const floating = useAnchoredPopover({ open, onClose: close }); const id = popoverId(owner, "actions");
  return <>
    <button ref={floating.refs.setReference} type="button" className="subtask-checklist__overflow" aria-label={`Actions for ${title}`} aria-expanded={open} aria-controls={open ? id : undefined} onKeyDown={floating.onKeyDown} onClick={() => setOpen(!open)}>⋯</button>
    {open && <AnchoredPopover context={floating.context} floatingStyles={floating.floatingStyles} initialFocus={0} onKeyDown={floating.onKeyDown}><div id={id} className="subtask-popover__content" role="group" aria-label={`Actions for ${title}`}><button type="button" className="button button--secondary" disabled={busy} onClick={() => { if (!window.confirm("Delete this subtask?")) return; close(); onDelete(); }}>Delete</button></div></AnchoredPopover>}
  </>;
}

function SortableSubtaskRow({ item, users, busy, editing, draftTitle, popover, setPopover, onUpdate, onRemove, onBeginEditing, onEndEditing, titleInputRef, itemRef, gripRef }: { item: Subtask; users: MentionableUser[]; busy: boolean; editing: boolean; draftTitle: string; popover: ActivePopover; setPopover: (value: ActivePopover) => void; onUpdate: (body: Record<string, unknown>, action: string) => void; onRemove: () => void; onBeginEditing: () => void; onEndEditing: () => void; titleInputRef: (element: HTMLInputElement | null) => void; itemRef: (element: HTMLElement | null) => void; gripRef: (element: HTMLButtonElement | null) => void }) {
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
      <DueDateControl owner={item.id} label={`Due date for ${item.title}`} value={item.dueDate} open={activeKind === "due"} setOpen={(open) => setKind("due", open)} onSave={(dueDate) => onUpdate({ dueDate }, "due-date")} busy={busy} />
      <AssigneeControl owner={item.id} label={`Assignee for ${item.title}`} assignee={item.assignee} users={users} open={activeKind === "assignee"} setOpen={(open) => setKind("assignee", open)} onSelect={(assigneeId) => onUpdate({ assigneeId }, "assignee")} busy={busy} />
      <ActionsControl owner={item.id} title={item.title} open={activeKind === "actions"} setOpen={(open) => setKind("actions", open)} busy={busy} onDelete={onRemove} />
    </div>
  </article>;
}

export function SubtaskChecklist({ projectId }: { projectId: string }) {
  const [subtasks, setSubtasks] = useState<Subtask[]>([]); const [users, setUsers] = useState<MentionableUser[]>([]); const [loading, setLoading] = useState(true); const [adding, setAdding] = useState(false); const [busy, setBusy] = useState<Set<string>>(new Set());
  const [newTitle, setNewTitle] = useState(""); const [newAssigneeId, setNewAssigneeId] = useState<string | null>(null); const [newDueDate, setNewDueDate] = useState<string | null>(null); const [composerOpen, setComposerOpen] = useState(false); const [activePopover, setActivePopover] = useState<ActivePopover>(null);
  const [draftTitles, setDraftTitles] = useState<Record<string, string>>({}); const [notice, setNotice] = useState(""); const [open, setOpen] = useState(true); const [editingId, setEditingId] = useState<string | null>(null);
  const panelId = useId(); const itemRefs = useRef(new Map<string, HTMLElement>()); const titleInputRefs = useRef(new Map<string, HTMLInputElement>()); const gripRefs = useRef(new Map<string, HTMLButtonElement>()); const composerInputRef = useRef<HTMLInputElement>(null); const priorEditingId = useRef<string | null>(null); const cancelledTitles = useRef(new Set<string>()); const restoreAddFocus = useRef(false); const busyRef = useRef(new Set<string>());
  const itemRef = (id: string) => (element: HTMLElement | null) => { if (element) itemRefs.current.set(id, element); else itemRefs.current.delete(id); };
  const titleInputRef = (id: string) => (element: HTMLInputElement | null) => { if (element) titleInputRefs.current.set(id, element); else titleInputRefs.current.delete(id); };
  const gripRef = (id: string) => (element: HTMLButtonElement | null) => { if (element) gripRefs.current.set(id, element); else gripRefs.current.delete(id); };
  const load = useCallback(async (): Promise<boolean> => { setLoading(true); try { const response = await apiGet<ChecklistResponse>(`/api/projects/${encodeURIComponent(projectId)}/subtasks`); setSubtasks((response.subtasks ?? []).slice().sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))); return true; } catch (error) { setNotice(message(error, "Checklist could not be loaded.")); return false; } finally { setLoading(false); } }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void apiGet<{ users: MentionableUser[] }>(`/api/mentionable-users?projectId=${encodeURIComponent(projectId)}&q=`).then((response) => setUsers(response.users ?? [])).catch(() => setNotice("Assignees could not be loaded.")); }, [projectId]);
  useLayoutEffect(() => { const changed = editingId !== priorEditingId.current; priorEditingId.current = editingId; if (!editingId || !changed || [...busy].some((key) => key.startsWith(`${editingId}:`))) return; const input = titleInputRefs.current.get(editingId); if (input && !input.disabled) input.focus(); }, [busy, editingId]);
  useLayoutEffect(() => { if (!composerOpen && restoreAddFocus.current) { restoreAddFocus.current = false; document.getElementById(`subtask-add-${projectId}`)?.focus(); } }, [composerOpen, projectId]);
  function setAction(id: string, value: boolean) { const next = new Set(busyRef.current); if (value) next.add(id); else next.delete(id); busyRef.current = next; setBusy(next); }
  function replace(updated: Subtask) { setSubtasks((current) => current.map((item) => item.id === updated.id ? updated : item).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))); }
  function itemIsBusy(id: string) { return [...busy].some((key) => key.startsWith(`${id}:`)); }
  function beginEditing(item: Subtask) { if (itemIsBusy(item.id)) return; cancelledTitles.current.delete(item.id); setDraftTitles((current) => ({ ...current, [item.id]: current[item.id] ?? item.title })); setEditingId(item.id); }
  async function update(item: Subtask, body: Record<string, unknown>, action: string) { const key = `${item.id}:${action}`; setAction(key, true); setNotice(""); try { replace(await apiPatch<Subtask, Record<string, unknown>>(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(item.id)}`, body)); } catch (error) { setNotice(message(error, "Subtask could not be updated.")); } finally { setAction(key, false); } }
  function titleAction(item: Subtask, body: Record<string, unknown>) { if ("__draft" in body) { setDraftTitles((current) => ({ ...current, [item.id]: String(body.__draft) })); return; } if ("__cancelTitle" in body) { cancelledTitles.current.add(item.id); setDraftTitles((current) => ({ ...current, [item.id]: item.title })); return; } if ("__saveTitle" in body) { const title = draftTitles[item.id] ?? item.title; if (cancelledTitles.current.delete(item.id)) return; if (title !== item.title && title.trim()) void update(item, { title }, "title"); } }
  function resetComposer(focus = true) { setNewTitle(""); setNewAssigneeId(null); setNewDueDate(null); setActivePopover(null); if (focus) restoreAddFocus.current = true; setComposerOpen(false); }
  async function add(event: React.FormEvent) { event.preventDefault(); if (!newTitle.trim()) return; setAdding(true); setNotice(""); const body: { title: string; assigneeId?: string; dueDate?: string } = { title: newTitle }; if (newAssigneeId) body.assigneeId = newAssigneeId; if (newDueDate) body.dueDate = newDueDate; try { const task = await apiPost<Subtask, typeof body>(`/api/projects/${encodeURIComponent(projectId)}/subtasks`, body); setSubtasks((current) => [...current, task].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))); resetComposer(); } catch (error) { setNotice(message(error, "Subtask could not be added.")); } finally { setAdding(false); } }
  async function remove(item: Subtask, index: number) { const key = `${item.id}:delete`; setAction(key, true); setNotice(""); const nextFocusId = subtasks[index + 1]?.id ?? subtasks[index - 1]?.id; try { await apiDelete(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(item.id)}`); setActivePopover(null); setEditingId((current) => current === item.id ? null : current); setSubtasks((current) => current.filter((candidate) => candidate.id !== item.id)); window.setTimeout(() => { if (nextFocusId) itemRefs.current.get(nextFocusId)?.querySelector<HTMLButtonElement>(".subtask-checklist__title-trigger")?.focus(); else if (composerOpen) composerInputRef.current?.focus(); else document.getElementById(`subtask-add-${projectId}`)?.focus(); }, 0); } catch (error) { setNotice(message(error, "Subtask could not be deleted.")); } finally { setAction(key, false); } }
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  async function onDragEnd(event: DragEndEvent) { const activeId = String(event.active.id); const neighbors = reorderNeighbors(subtasks.map((item) => item.id), activeId, event.over ? String(event.over.id) : null); if (!neighbors) return; const formerIndex = subtasks.findIndex((item) => item.id === activeId); const key = `${activeId}:reorder`; setAction(key, true); setNotice(""); let reload = false; try { await apiPost<{ position: number }, { beforeId: string | null; afterId: string | null }>(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(activeId)}/reorder`, { beforeId: neighbors.beforeId, afterId: neighbors.afterId }); reload = await load(); } catch (error) { if (error instanceof ApiError && error.status === 409) { setNotice("Subtask order changed; reload and try again"); reload = await load(); } else setNotice(message(error, "Subtask could not be reordered.")); } finally { setAction(key, false); if (reload) scheduleReorderFocus(gripRefs.current, activeId, formerIndex, composerOpen, composerInputRef.current, projectId, () => busyRef.current.has(key)); } }
  const doneCount = subtasks.filter((item) => item.done).length; const total = subtasks.length; const percent = total === 0 ? 0 : Math.round((doneCount / total) * 100); const composerAssignee = users.find((user) => user.id === newAssigneeId) ?? null;
  return <section className="subtask-checklist" aria-label="Project checklist"><header className="subtask-checklist__head"><h3><button type="button" className="subtask-checklist__toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}><span className="ey">Checklist</span><span className="subtask-checklist__toggle-meta"><span className="subtask-checklist__progress-text">{doneCount} of {total} complete · {percent}%</span><span className="subtask-checklist__chevron" aria-hidden="true">{open ? "−" : "+"}</span></span><progress value={doneCount} max={Math.max(total, 1)} aria-hidden="true" /></button></h3></header><div className="subtask-checklist__notice" aria-live="polite">{notice}</div><div id={panelId} className={`subtask-checklist__panel${open ? "" : " is-collapsed"}`} aria-hidden={!open}>{loading ? <div className="project-collaboration__state" aria-live="polite">Loading checklist…</div> : <>{!subtasks.length && <div className="project-collaboration__state">No subtasks yet.</div>}<DndContext sensors={sensors} onDragStart={() => setActivePopover(null)} onDragEnd={(event) => void onDragEnd(event)}><SortableContext items={subtasks.map((item) => item.id)} strategy={verticalListSortingStrategy}><div className="subtask-checklist__items">{subtasks.map((item, index) => <SortableSubtaskRow key={item.id} item={item} users={users} busy={itemIsBusy(item.id)} editing={editingId === item.id} draftTitle={draftTitles[item.id] ?? item.title} popover={activePopover} setPopover={setActivePopover} onUpdate={(body, action) => action === "draft" || action === "title" ? titleAction(item, body) : void update(item, body, action)} onRemove={() => void remove(item, index)} onBeginEditing={() => beginEditing(item)} onEndEditing={() => { if (editingId === item.id) setEditingId(null); }} titleInputRef={titleInputRef(item.id)} itemRef={itemRef(item.id)} gripRef={gripRef(item.id)} />)}</div></SortableContext></DndContext>{composerOpen ? <form className="subtask-checklist__composer" onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); resetComposer(); } }} onSubmit={(event) => void add(event)}><label className="sr-only" htmlFor={`subtask-composer-${projectId}`}>Add a subtask</label><input ref={composerInputRef} id={`subtask-composer-${projectId}`} autoFocus value={newTitle} maxLength={500} disabled={adding} onChange={(event) => setNewTitle(event.target.value)} placeholder="Add a subtask…" /><div className="subtask-checklist__composer-controls"><AssigneeControl owner="composer" label="Assignee for new subtask" assignee={composerAssignee} users={users} open={activePopover?.owner === "composer" && activePopover.kind === "assignee"} setOpen={(value) => setActivePopover(value ? { owner: "composer", kind: "assignee" } : null)} onSelect={setNewAssigneeId} busy={adding} compact /><DueDateControl owner="composer" label="Due date for new subtask" value={newDueDate} open={activePopover?.owner === "composer" && activePopover.kind === "due"} setOpen={(value) => setActivePopover(value ? { owner: "composer", kind: "due" } : null)} onSave={setNewDueDate} busy={adding} compact /><span /><button className="button button--secondary" type="button" disabled={adding} onClick={() => resetComposer()}>Cancel</button><button className="button" type="submit" disabled={adding || !newTitle.trim()}>{adding ? "Adding…" : "Add"}</button></div></form> : <button id={`subtask-add-${projectId}`} type="button" className="subtask-checklist__add-button" onClick={() => setComposerOpen(true)}>+ Add an item</button>}</>}</div></section>;
}
