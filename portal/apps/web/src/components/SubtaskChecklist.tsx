import { useCallback, useEffect, useRef, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";
import type { MentionableUser } from "./MentionAutocomplete";

type Subtask = {
  id: string; title: string; done: boolean; position: number; assignee: { id: string; name: string } | null;
  assignmentVersion: number; dueDate: string | null; createdBy: string; createdAt: string; updatedAt: string;
};
type ChecklistResponse = { subtasks?: Subtask[] };

function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }

export function SubtaskChecklist({ projectId }: { projectId: string }) {
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  const [users, setUsers] = useState<MentionableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [newTitle, setNewTitle] = useState("");
  const [draftTitles, setDraftTitles] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [moveFocus, setMoveFocus] = useState<{ id: string; direction: "up" | "down" } | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const itemRefCallbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());

  function itemRef(id: string) {
    let callback = itemRefCallbacks.current.get(id);
    if (!callback) {
      callback = (element) => { if (element) itemRefs.current.set(id, element); else itemRefs.current.delete(id); };
      itemRefCallbacks.current.set(id, callback);
    }
    return callback;
  }

  useEffect(() => {
    if (!moveFocus) return;
    const timeout = window.setTimeout(() => {
      itemRefs.current.get(moveFocus.id)?.querySelector<HTMLButtonElement>(`[data-move="${moveFocus.direction}"]`)?.focus();
      setMoveFocus(null);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [moveFocus]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiGet<ChecklistResponse>(`/api/projects/${encodeURIComponent(projectId)}/subtasks`);
      setSubtasks((response.subtasks ?? []).slice().sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)));
    } catch (error) { setNotice(message(error, "Checklist could not be loaded.")); }
    finally { setLoading(false); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void apiGet<{ users: MentionableUser[] }>(`/api/mentionable-users?projectId=${encodeURIComponent(projectId)}&q=`)
      .then((response) => setUsers(response.users ?? []))
      .catch(() => setNotice("Assignees could not be loaded."));
  }, [projectId]);

  function setAction(id: string, value: boolean) {
    setBusy((current) => { const next = new Set(current); if (value) next.add(id); else next.delete(id); return next; });
  }
  function replace(updated: Subtask) {
    setSubtasks((current) => current.map((item) => item.id === updated.id ? updated : item).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)));
  }
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
  async function move(item: Subtask, direction: "up" | "down") {
    const key = `${item.id}:move-${direction}`; setAction(key, true); setNotice("");
    try {
      await apiPost<{ position: number }, { direction: "up" | "down" }>(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(item.id)}/move`, { direction });
      await load();
      setMoveFocus({ id: item.id, direction });
    } catch (error) { setNotice(message(error, "Subtask could not be moved.")); }
    finally { setAction(key, false); }
  }
  async function remove(item: Subtask, index: number) {
    const key = `${item.id}:delete`; setAction(key, true); setNotice("");
    const nextFocusId = subtasks[index + 1]?.id ?? subtasks[index - 1]?.id;
    try {
      await apiDelete(`/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(item.id)}`);
      setSubtasks((current) => current.filter((candidate) => candidate.id !== item.id));
      window.setTimeout(() => (nextFocusId ? itemRefs.current.get(nextFocusId)?.querySelector<HTMLButtonElement>("button") : document.getElementById(`subtask-add-${projectId}`))?.focus(), 0);
    } catch (error) { setNotice(message(error, "Subtask could not be deleted.")); }
    finally { setAction(key, false); }
  }

  return <section className="subtask-checklist" aria-label="Project checklist">
    <header className="subtask-checklist__head"><div><div className="ey">Checklist</div><h3>{subtasks.filter((item) => item.done).length}/{subtasks.length} complete</h3></div></header>
    <div className="subtask-checklist__notice" aria-live="polite">{notice}</div>
    {loading ? <div className="project-collaboration__state" aria-live="polite">Loading checklist…</div> : <>
      {!subtasks.length && <div className="project-collaboration__state">No subtasks yet.</div>}
      <div className="subtask-checklist__items">
        {subtasks.map((item, index) => {
          const title = draftTitles[item.id] ?? item.title;
          const itemBusy = [...busy].some((key) => key.startsWith(`${item.id}:`));
          return <article key={item.id} ref={itemRef(item.id)} className={`subtask-checklist__item${item.done ? " subtask-checklist__item--done" : ""}`}>
            <label className="subtask-checklist__done"><input type="checkbox" checked={item.done} disabled={itemBusy} onChange={(event) => void update(item, { done: event.target.checked }, "done")} /><span className="sr-only">Mark {item.title} complete</span></label>
            <input className="subtask-checklist__title" aria-label="Subtask title" value={title} disabled={itemBusy} onChange={(event) => setDraftTitles((current) => ({ ...current, [item.id]: event.target.value }))} onBlur={() => { if (title !== item.title && title.trim()) void update(item, { title }, "title"); }} onKeyDown={(event) => { if (event.key === "Enter") { event.currentTarget.blur(); } if (event.key === "Escape") { setDraftTitles((current) => ({ ...current, [item.id]: item.title })); event.currentTarget.blur(); } }} />
            <select aria-label={`Assignee for ${item.title}`} value={item.assignee?.id ?? ""} disabled={itemBusy} onChange={(event) => void update(item, { assigneeId: event.target.value || null }, "assignee")}><option value="">Unassigned</option>{users.map((user) => <option key={user.id} value={user.id}>{user.name} · {user.role}</option>)}</select>
            <input aria-label={`Due date for ${item.title}`} type="date" value={item.dueDate ?? ""} disabled={itemBusy} onChange={(event) => void update(item, { dueDate: event.target.value || null }, "due-date")} />
            <div className="subtask-checklist__actions"><button type="button" className="button button--secondary" data-move="up" aria-label={`Move ${item.title} up`} disabled={itemBusy || index === 0} onClick={() => void move(item, "up")}>↑</button><button type="button" className="button button--secondary" data-move="down" aria-label={`Move ${item.title} down`} disabled={itemBusy || index === subtasks.length - 1} onClick={() => void move(item, "down")}>↓</button><button type="button" className="button button--secondary" disabled={itemBusy} onClick={() => void remove(item, index)}>Delete</button></div>
          </article>;
        })}
      </div>
      <form className="subtask-checklist__add" onSubmit={(event) => void add(event)}><label className="sr-only" htmlFor={`subtask-add-${projectId}`}>Add a subtask</label><input id={`subtask-add-${projectId}`} value={newTitle} maxLength={500} disabled={adding} onChange={(event) => setNewTitle(event.target.value)} placeholder="Add a subtask…" /><button className="button" type="submit" disabled={adding || !newTitle.trim()}>{adding ? "Adding…" : "Add task"}</button></form>
    </>}
  </section>;
}
