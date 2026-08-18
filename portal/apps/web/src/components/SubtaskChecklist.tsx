import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";
import { initials } from "../lib/initials";
import type { MentionableUser } from "./MentionAutocomplete";

type Subtask = {
  id: string; title: string; done: boolean; position: number; assignee: { id: string; name: string } | null;
  assignmentVersion: number; dueDate: string | null; createdBy: string; createdAt: string; updatedAt: string;
};
type ChecklistResponse = { subtasks?: Subtask[] };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function dueDateParts(value: string | null) { const [date = "", time = ""] = (value ?? "").split("T"); return { date, time }; }
function formatDueDate(value: string) {
  const { date, time } = dueDateParts(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return value;
  const [, year, month, day] = match;
  const monthIndex = Number(month) - 1;
  const yearNumber = Number(year);
  const maxDay = [31, yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthIndex] ?? 0;
  if (monthIndex < 0 || monthIndex > 11 || Number(day) < 1 || Number(day) > maxDay || (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) return value;
  const display = `${Number(day)} ${MONTHS[monthIndex]}${Number(year) === new Date().getFullYear() ? "" : ` ${year}`}`;
  return time ? `${display} · ${time}` : display;
}

export function SubtaskChecklist({ projectId }: { projectId: string }) {
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  const [users, setUsers] = useState<MentionableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [newTitle, setNewTitle] = useState("");
  const [draftTitles, setDraftTitles] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const panelId = useId();
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const itemRefCallbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const titleInputRefs = useRef(new Map<string, HTMLInputElement>());
  const titleInputRefCallbacks = useRef(new Map<string, (element: HTMLInputElement | null) => void>());
  const priorEditingId = useRef<string | null>(null);
  const cancelledTitles = useRef(new Set<string>());

  function itemRef(id: string) {
    let callback = itemRefCallbacks.current.get(id);
    if (!callback) {
      callback = (element) => { if (element) itemRefs.current.set(id, element); else itemRefs.current.delete(id); };
      itemRefCallbacks.current.set(id, callback);
    }
    return callback;
  }
  function titleInputRef(id: string) {
    let callback = titleInputRefCallbacks.current.get(id);
    if (!callback) {
      callback = (element) => { if (element) titleInputRefs.current.set(id, element); else titleInputRefs.current.delete(id); };
      titleInputRefCallbacks.current.set(id, callback);
    }
    return callback;
  }

  const load = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    try {
      const response = await apiGet<ChecklistResponse>(`/api/projects/${encodeURIComponent(projectId)}/subtasks`);
      setSubtasks((response.subtasks ?? []).slice().sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)));
      return true;
    } catch (error) { setNotice(message(error, "Checklist could not be loaded.")); return false; }
    finally { setLoading(false); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void apiGet<{ users: MentionableUser[] }>(`/api/mentionable-users?projectId=${encodeURIComponent(projectId)}&q=`)
      .then((response) => setUsers(response.users ?? []))
      .catch(() => setNotice("Assignees could not be loaded."));
  }, [projectId]);
  useEffect(() => {
    if (!openMenuId) return;
    const onPointerDown = (event: PointerEvent) => { if (!itemRefs.current.get(openMenuId)?.contains(event.target as Node)) setOpenMenuId(null); };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [openMenuId]);
  useLayoutEffect(() => {
    const changed = editingId !== priorEditingId.current;
    priorEditingId.current = editingId;
    if (!editingId || !changed || [...busy].some((key) => key.startsWith(`${editingId}:`))) return;
    const input = titleInputRefs.current.get(editingId);
    if (input && !input.disabled) input.focus();
  }, [busy, editingId]);

  function setAction(id: string, value: boolean) { setBusy((current) => { const next = new Set(current); if (value) next.add(id); else next.delete(id); return next; }); }
  function replace(updated: Subtask) { setSubtasks((current) => current.map((item) => item.id === updated.id ? updated : item).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))); }
  function itemIsBusy(id: string) { return [...busy].some((key) => key.startsWith(`${id}:`)); }
  function beginEditing(item: Subtask) { if (itemIsBusy(item.id)) return; cancelledTitles.current.delete(item.id); setDraftTitles((current) => ({ ...current, [item.id]: current[item.id] ?? item.title })); setEditingId(item.id); }
  async function update(item: Subtask, body: Record<string, unknown>, action: string) {
    const key = `${item.id}:${action}`; setAction(key, true); setNotice("");
    try { replace(await apiPatch<Subtask, Record<string, unknown>>(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(item.id)}`, body)); }
    catch (error) { setNotice(message(error, "Subtask could not be updated.")); }
    finally { setAction(key, false); }
  }
  async function add(event: React.FormEvent) {
    event.preventDefault(); if (!newTitle.trim()) return;
    setAdding(true); setNotice("");
    try { const task = await apiPost<Subtask, { title: string }>(`/api/projects/${encodeURIComponent(projectId)}/subtasks`, { title: newTitle }); setSubtasks((current) => [...current, task]); setNewTitle(""); }
    catch (error) { setNotice(message(error, "Subtask could not be added.")); }
    finally { setAdding(false); }
  }
  async function move(item: Subtask, direction: "up" | "down"): Promise<boolean> {
    const key = `${item.id}:move-${direction}`; setAction(key, true); setNotice("");
    try {
      await apiPost<{ position: number }, { direction: "up" | "down" }>(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(item.id)}/move`, { direction });
      return await load();
    } catch (error) { setNotice(message(error, "Subtask could not be moved.")); return false; }
    finally { setAction(key, false); }
  }
  async function moveFromMenu(item: Subtask, direction: "up" | "down") {
    if (!await move(item, direction)) return;
    setOpenMenuId(null);
    window.setTimeout(() => itemRefs.current.get(item.id)?.querySelector<HTMLButtonElement>("[data-subtask-actions-trigger]")?.focus(), 0);
  }
  async function remove(item: Subtask, index: number) {
    const key = `${item.id}:delete`; setAction(key, true); setNotice("");
    const nextFocusId = subtasks[index + 1]?.id ?? subtasks[index - 1]?.id;
    try {
      await apiDelete(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(item.id)}`);
      setOpenMenuId((current) => current === item.id ? null : current);
      setEditingId((current) => current === item.id ? null : current);
      setSubtasks((current) => current.filter((candidate) => candidate.id !== item.id));
      window.setTimeout(() => (nextFocusId ? itemRefs.current.get(nextFocusId)?.querySelector<HTMLButtonElement>(".subtask-checklist__title-trigger") : document.getElementById(`subtask-add-${projectId}`))?.focus(), 0);
    } catch (error) { setNotice(message(error, "Subtask could not be deleted.")); }
    finally { setAction(key, false); }
  }

  const doneCount = subtasks.filter((item) => item.done).length;
  const total = subtasks.length;
  const percent = total === 0 ? 0 : Math.round((doneCount / total) * 100);
  return <section className="subtask-checklist" aria-label="Project checklist">
    <header className="subtask-checklist__head"><h3><button type="button" className="subtask-checklist__toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}><span className="ey">Checklist</span><span className="subtask-checklist__toggle-meta"><span className="subtask-checklist__progress-text">{doneCount} of {total} complete · {percent}%</span><span className="subtask-checklist__chevron" aria-hidden="true">{open ? "−" : "+"}</span></span><progress value={doneCount} max={Math.max(total, 1)} aria-hidden="true" /></button></h3></header>
    <div className="subtask-checklist__notice" aria-live="polite">{notice}</div>
    <div id={panelId} className={`subtask-checklist__panel${open ? "" : " is-collapsed"}`} aria-hidden={!open}>
      {loading ? <div className="project-collaboration__state" aria-live="polite">Loading checklist…</div> : <>
        {!subtasks.length && <div className="project-collaboration__state">No subtasks yet.</div>}
        <div className="subtask-checklist__items">
          {subtasks.map((item, index) => {
            const title = draftTitles[item.id] ?? item.title;
            const due = dueDateParts(item.dueDate);
            const itemBusy = itemIsBusy(item.id);
            const editing = editingId === item.id;
            const menuOpen = openMenuId === item.id;
            const menuId = `subtask-actions-${item.id}`;
            return <article key={item.id} ref={itemRef(item.id)} className={`subtask-checklist__item${item.done ? " subtask-checklist__item--done" : ""}${menuOpen ? " is-menu-open" : ""}`} onBlur={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              if (editingId === item.id) setEditingId(null);
              if (openMenuId === item.id) setOpenMenuId(null);
            }}>
              <div className="subtask-checklist__summary">
                <label className="subtask-checklist__done"><input type="checkbox" checked={item.done} disabled={itemBusy} onChange={(event) => void update(item, { done: event.target.checked }, "done")} /><span className="sr-only">Mark {item.title} complete</span></label>
                {editing ? <input ref={titleInputRef(item.id)} className="subtask-checklist__title" aria-label="Subtask title" value={title} disabled={itemBusy} onChange={(event) => setDraftTitles((current) => ({ ...current, [item.id]: event.target.value }))} onBlur={() => {
                  if (cancelledTitles.current.delete(item.id)) return;
                  if (title !== item.title && title.trim()) void update(item, { title }, "title");
                }} onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") { event.preventDefault(); cancelledTitles.current.add(item.id); setDraftTitles((current) => ({ ...current, [item.id]: item.title })); event.currentTarget.blur(); }
                }} /> : <button type="button" className="subtask-checklist__title-trigger" disabled={itemBusy} onClick={() => beginEditing(item)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); beginEditing(item); } }}>{item.title}</button>}
                {!editing && item.dueDate && <time className="subtask-checklist__due" dateTime={item.dueDate}><span className="sr-only">Due </span>{formatDueDate(item.dueDate)}</time>}
                {!editing && item.assignee && <span className="subtask-checklist__assignee avatar" title={item.assignee.name}><span aria-hidden="true">{initials(item.assignee.name)}</span><span className="sr-only">Assigned to {item.assignee.name}</span></span>}
                <button type="button" className="subtask-checklist__overflow" data-subtask-actions-trigger aria-label={`Actions for ${item.title}`} aria-expanded={menuOpen} aria-controls={menuId} onClick={() => setOpenMenuId((current) => current === item.id ? null : item.id)}>⋯</button>
              </div>
              {editing && <div className="subtask-checklist__edit-controls"><select aria-label={`Assignee for ${item.title}`} value={item.assignee?.id ?? ""} disabled={itemBusy} onChange={(event) => void update(item, { assigneeId: event.target.value || null }, "assignee")}><option value="">Unassigned</option>{users.map((user) => <option key={user.id} value={user.id}>{user.name} · {user.role}</option>)}</select><input aria-label={`Due date for ${item.title}`} type="date" value={due.date} disabled={itemBusy} onChange={(event) => { const date = event.target.value; void update(item, { dueDate: date ? `${date}${due.time ? `T${due.time}` : ""}` : null }, "due-date"); }} /><input aria-label={`Due time for ${item.title}`} type="time" value={due.time} disabled={itemBusy || !due.date} onChange={(event) => { if (!due.date) return; void update(item, { dueDate: `${due.date}${event.target.value ? `T${event.target.value}` : ""}` }, "due-time"); }} /></div>}
              {menuOpen && <div id={menuId} className="subtask-checklist__overflow-actions" role="group" aria-label={`Actions for ${item.title}`} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setOpenMenuId(null); window.setTimeout(() => itemRefs.current.get(item.id)?.querySelector<HTMLButtonElement>("[data-subtask-actions-trigger]")?.focus(), 0); } }}><button type="button" className="button button--secondary" data-move="up" aria-label={`Move ${item.title} up`} disabled={itemBusy || index === 0} onClick={() => void moveFromMenu(item, "up")}>Move up</button><button type="button" className="button button--secondary" data-move="down" aria-label={`Move ${item.title} down`} disabled={itemBusy || index === subtasks.length - 1} onClick={() => void moveFromMenu(item, "down")}>Move down</button><button type="button" className="button button--secondary" disabled={itemBusy} onClick={() => void remove(item, index)}>Delete</button></div>}
            </article>;
          })}
        </div>
        <form className="subtask-checklist__add" onSubmit={(event) => void add(event)}><label className="sr-only" htmlFor={`subtask-add-${projectId}`}>Add a subtask</label><input id={`subtask-add-${projectId}`} value={newTitle} maxLength={500} disabled={adding} onChange={(event) => setNewTitle(event.target.value)} placeholder="Add a subtask…" /><button className="button" type="submit" disabled={adding || !newTitle.trim()}>{adding ? "Adding…" : "Add task"}</button></form>
      </>}
    </div>
  </section>;
}
