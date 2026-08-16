import { useCallback, useEffect, useRef, useState } from "react";
import type { RichTextDoc } from "@quincy/shared";
import { apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";
import { useSession } from "../lib/auth";
import { RichTextContent } from "./RichTextContent";
import { RichTextEditor } from "./RichTextEditor";
import type { MentionableUser } from "./MentionAutocomplete";
import { SubtaskChecklist } from "./SubtaskChecklist";

type Comment = { id: string; author: { id: string; name: string }; body: string; content: RichTextDoc; createdAt: string; editedAt: string | null };
type CommentResponse = { project: { id: string; street: string }; comments: Comment[]; nextCursor?: string };
const emptyDoc = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });

export function ProjectCollaborationPanel({ projectId }: { projectId: string }) {
  const session = useSession();
  const currentUserId = session.data?.user.id;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches);
  const [project, setProject] = useState<CommentResponse["project"]>();
  const [comments, setComments] = useState<Comment[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string>();
  const [content, setContent] = useState<RichTextDoc>(emptyDoc);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{ id: string; content: RichTextDoc }>();

  const load = useCallback(async (before?: string) => {
    if (before) setLoadingOlder(true); else setLoading(true);
    setError(undefined);
    try {
      const response = await apiGet<CommentResponse>(`/api/projects/${encodeURIComponent(projectId)}/comments?limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      setProject(response.project); setNextCursor(response.nextCursor);
      setComments((current) => before ? [...response.comments, ...current] : response.comments);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Comments could not be loaded."); }
    finally { if (before) setLoadingOlder(false); else setLoading(false); }
  }, [projectId]);

  useEffect(() => { if (open) void load(); }, [load, open]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 720px)"); const change = () => setNarrow(media.matches); change(); media.addEventListener("change", change); return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!open || !narrow) return;
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); window.setTimeout(() => triggerRef.current?.focus(), 0); } };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [narrow, open]);

  const loadMentionables = useCallback(async (query: string): Promise<MentionableUser[]> => {
    const response = await apiGet<{ users: MentionableUser[] }>(`/api/mentionable-users?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(query)}`);
    return response.users;
  }, [projectId]);
  async function submit() {
    setSaving(true); setError(undefined);
    try { const comment = await apiPost<Comment, { content: RichTextDoc }>(`/api/projects/${encodeURIComponent(projectId)}/comments`, { content }); setComments((current) => [...current, comment]); setContent(emptyDoc()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Comment could not be posted."); }
    finally { setSaving(false); }
  }
  async function saveEdit() {
    if (!editing) return; setSaving(true); setError(undefined);
    try { const comment = await apiPatch<Comment, { content: RichTextDoc }>(`/api/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(editing.id)}`, { content: editing.content }); setComments((current) => current.map((item) => item.id === comment.id ? comment : item)); setEditing(undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Comment could not be updated."); }
    finally { setSaving(false); }
  }
  async function remove(comment: Comment) {
    if (!window.confirm("Delete this comment?")) return; setSaving(true); setError(undefined);
    try { await apiDelete(`/api/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(comment.id)}`); setComments((current) => current.filter((item) => item.id !== comment.id)); if (editing?.id === comment.id) setEditing(undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Comment could not be deleted."); }
    finally { setSaving(false); }
  }
  function close() { setOpen(false); window.setTimeout(() => triggerRef.current?.focus(), 0); }

  return <section className="edit-project__collaboration-wrap">
    <button ref={triggerRef} type="button" className="button button--secondary edit-project__collaboration-toggle" aria-expanded={open} aria-controls={`project-collaboration-${projectId}`} onClick={() => setOpen((value) => !value)}>{open ? "Hide collaboration" : "Show collaboration"}</button>
    {open && <>
      {narrow && <div className="edit-project__collaboration-scrim" aria-hidden="true" onClick={close} />}
      <aside id={`project-collaboration-${projectId}`} className={`edit-project__collaboration${narrow ? " edit-project__collaboration--drawer" : ""}`} aria-label="Project collaboration">
        <div className="edit-project__collaboration-head"><div><div className="ey">Collaboration</div><h2 className="serif">{project?.street ?? "Project comments"}</h2></div>{narrow && <button type="button" className="button button--secondary" onClick={close}>Close</button>}</div>
        {error && <div className="notice" role="alert">{error}</div>}
        <SubtaskChecklist projectId={projectId} />
        {loading ? <div className="edit-project__collaboration-state" role="status">Loading comments…</div> : <>
          {nextCursor && <button className="button button--secondary" type="button" disabled={loadingOlder} onClick={() => void load(nextCursor)}>{loadingOlder ? "Loading…" : "Load older comments"}</button>}
          <div className="edit-project__comments">{comments.length ? comments.map((comment) => <article key={comment.id} className="edit-project__comment"><header><strong>{comment.author.name}</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time></header>{editing?.id === comment.id ? <><RichTextEditor value={editing.content} onChange={(value) => setEditing({ id: comment.id, content: value })} limit={10_000} disabled={saving} loadMentionables={loadMentionables} placeholder="Edit comment…" onSubmit={() => void saveEdit()} /><div className="edit-project__comment-actions"><button className="button button--secondary" type="button" disabled={saving} onClick={() => setEditing(undefined)}>Cancel</button><button className="button" type="button" disabled={saving} onClick={() => void saveEdit()}>Save</button></div></> : <><RichTextContent content={comment.content} />{comment.editedAt && <small>Edited</small>}{comment.author.id === currentUserId && <div className="edit-project__comment-actions"><button type="button" className="button button--secondary" onClick={() => setEditing({ id: comment.id, content: comment.content })}>Edit</button><button type="button" className="button button--secondary" disabled={saving} onClick={() => void remove(comment)}>Delete</button></div>}</>}</article>) : <div className="edit-project__collaboration-state">No comments yet.</div>}</div>
          <form className="edit-project__comment-compose" onSubmit={(event) => { event.preventDefault(); void submit(); }}><label className="sr-only" htmlFor={`project-comment-${projectId}`}>Write a comment</label><RichTextEditor id={`project-comment-${projectId}`} value={content} onChange={setContent} limit={10_000} disabled={saving} loadMentionables={loadMentionables} placeholder="Write a project comment…" onSubmit={() => void submit()} /><div><span>Use @ to mention project participants</span><button className="button" type="submit" disabled={saving}>{saving ? "Posting…" : "Post comment"}</button></div></form>
        </>}
      </aside>
    </>}
  </section>;
}
