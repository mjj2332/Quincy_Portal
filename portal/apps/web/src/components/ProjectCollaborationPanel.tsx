import { useCallback, useEffect, useRef, useState } from "react";
import type { RichTextDoc } from "@quincy/shared";
import { apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";
import { useSession } from "../lib/auth";
import { RichTextContent } from "./RichTextContent";
import { RichTextEditor } from "./RichTextEditor";
import type { MentionableUser } from "./MentionAutocomplete";
import { SubtaskChecklist } from "./SubtaskChecklist";

type Comment = { id: string; author: { id: string; name: string }; body: string; content: RichTextDoc; createdAt: string; editedAt: string | null };
export type CommentResponse = { project: { id: string; street: string }; comments: Comment[]; nextCursor?: string };
const emptyDoc = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });

export function ProjectCollaborationPanel({ projectId, openSignal, onOpenSignalConsumed, mode = "overlay", initialComments }: { projectId: string; openSignal?: number; onOpenSignalConsumed?: (signal: number) => void; mode?: "overlay" | "standalone"; initialComments?: CommentResponse }) {
  const session = useSession();
  const currentUserId = session.data?.user.id;
  const overlay = mode === "overlay";
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRootRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastConsumedSignalRef = useRef<number>();
  const pendingSignalRef = useRef<number>();
  const [overlayOpen, setOverlayOpen] = useState(false);
  const open = overlay ? overlayOpen : true;
  const [project, setProject] = useState<CommentResponse["project"] | undefined>(initialComments?.project);
  const [comments, setComments] = useState<Comment[]>(initialComments?.comments ?? []);
  const [nextCursor, setNextCursor] = useState<string | undefined>(initialComments?.nextCursor);
  const [loadedInitial, setLoadedInitial] = useState(Boolean(initialComments));
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string>();
  const [content, setContent] = useState<RichTextDoc>(emptyDoc);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{ id: string; content: RichTextDoc }>();

  useEffect(() => {
    setProject(initialComments?.project); setComments(initialComments?.comments ?? []); setNextCursor(initialComments?.nextCursor); setLoadedInitial(Boolean(initialComments));
  }, [initialComments, projectId]);

  useEffect(() => {
    if (!overlay || openSignal === undefined || openSignal === lastConsumedSignalRef.current) return;
    pendingSignalRef.current = openSignal;
    setOverlayOpen(true);
  }, [openSignal, overlay]);
  useEffect(() => {
    if (!overlay || !open || pendingSignalRef.current === undefined) return;
    const signal = pendingSignalRef.current;
    closeRef.current?.focus();
    pendingSignalRef.current = undefined;
    lastConsumedSignalRef.current = signal;
    onOpenSignalConsumed?.(signal);
  }, [onOpenSignalConsumed, open, openSignal, overlay]);

  const load = useCallback(async (before?: string) => {
    if (before) setLoadingOlder(true); else setLoading(true);
    setError(undefined);
    try {
      const response = await apiGet<CommentResponse>(`/api/projects/${encodeURIComponent(projectId)}/comments?limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      setProject(response.project); setNextCursor(response.nextCursor);
      setComments((current) => before ? [...response.comments, ...current] : response.comments);
      setLoadedInitial(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Comments could not be loaded."); }
    finally { if (before) setLoadingOlder(false); else setLoading(false); }
  }, [projectId]);
  useEffect(() => { if (open && !loadedInitial) void load(); }, [load, loadedInitial, open]);

  const close = useCallback(() => {
    if (!overlay) return;
    setOverlayOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, [overlay]);
  useEffect(() => {
    if (!overlay || !open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !panelRootRef.current?.contains(document.activeElement)) return;
      event.preventDefault(); close();
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [close, open, overlay]);

  const loadMentionables = useCallback(async (query: string): Promise<MentionableUser[]> => (await apiGet<{ users: MentionableUser[] }>(`/api/mentionable-users?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(query)}`)).users, [projectId]);
  async function submit() { setSaving(true); setError(undefined); try { const comment = await apiPost<Comment, { content: RichTextDoc }>(`/api/projects/${encodeURIComponent(projectId)}/comments`, { content }); setComments((current) => [...current, comment]); setContent(emptyDoc()); } catch (reason) { setError(reason instanceof Error ? reason.message : "Comment could not be posted."); } finally { setSaving(false); } }
  async function saveEdit() { if (!editing) return; setSaving(true); setError(undefined); try { const comment = await apiPatch<Comment, { content: RichTextDoc }>(`/api/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(editing.id)}`, { content: editing.content }); setComments((current) => current.map((item) => item.id === comment.id ? comment : item)); setEditing(undefined); } catch (reason) { setError(reason instanceof Error ? reason.message : "Comment could not be updated."); } finally { setSaving(false); } }
  async function remove(comment: Comment) { if (!window.confirm("Delete this comment?")) return; setSaving(true); setError(undefined); try { await apiDelete(`/api/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(comment.id)}`); setComments((current) => current.filter((item) => item.id !== comment.id)); if (editing?.id === comment.id) setEditing(undefined); } catch (reason) { setError(reason instanceof Error ? reason.message : "Comment could not be deleted."); } finally { setSaving(false); } }

  const contentMarkup = <>
    <div className="project-collaboration__head"><div><div className="ey">Collaboration</div><h2 className="serif">{project?.street ?? "Project comments"}</h2></div>{overlay && <button ref={closeRef} type="button" className="button button--secondary" onClick={close}>Close collaboration</button>}</div>
    {error && <div className="notice" role="alert">{error}</div>}
    <SubtaskChecklist projectId={projectId} />
    {loading ? <div className="project-collaboration__state" role="status">Loading comments…</div> : <>
      {nextCursor && <button className="button button--secondary" type="button" disabled={loadingOlder} onClick={() => void load(nextCursor)}>{loadingOlder ? "Loading…" : "Load older comments"}</button>}
      <div className="project-collaboration__comments">{comments.length ? comments.map((comment) => <article key={comment.id} className="project-collaboration__comment"><header><strong>{comment.author.name}</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time></header>{editing?.id === comment.id ? <><RichTextEditor value={editing.content} onChange={(value) => setEditing({ id: comment.id, content: value })} limit={10_000} disabled={saving} loadMentionables={loadMentionables} placeholder="Edit comment…" onSubmit={() => void saveEdit()} /><div className="project-collaboration__comment-actions"><button className="button button--secondary" type="button" disabled={saving} onClick={() => setEditing(undefined)}>Cancel</button><button className="button" type="button" disabled={saving} onClick={() => void saveEdit()}>Save</button></div></> : <><RichTextContent content={comment.content} />{comment.editedAt && <small>Edited</small>}{comment.author.id === currentUserId && <div className="project-collaboration__comment-actions"><button type="button" className="button button--secondary" onClick={() => setEditing({ id: comment.id, content: comment.content })}>Edit</button><button type="button" className="button button--secondary" disabled={saving} onClick={() => void remove(comment)}>Delete</button></div>}</>}</article>) : <div className="project-collaboration__state">No comments yet.</div>}</div>
      <form className="project-collaboration__comment-compose" onSubmit={(event) => { event.preventDefault(); void submit(); }}><label className="sr-only" htmlFor={`project-comment-${projectId}`}>Write a comment</label><RichTextEditor id={`project-comment-${projectId}`} value={content} onChange={setContent} limit={10_000} disabled={saving} loadMentionables={loadMentionables} placeholder="Write a project comment…" onSubmit={() => void submit()} /><div><span>Use @ to mention project participants</span><button className="button" type="submit" disabled={saving}>{saving ? "Posting…" : "Post comment"}</button></div></form>
    </>}
  </>;
  if (!overlay) return <section className="project-collaboration project-collaboration--standalone" aria-label="Project collaboration">{contentMarkup}</section>;
  return <section className="project-collaboration__wrap"><button ref={triggerRef} type="button" className="project-collaboration__toggle" aria-label={open ? "Hide collaboration" : "Show collaboration"} aria-expanded={open} aria-controls={`project-collaboration-${projectId}`} onClick={() => setOverlayOpen((value) => !value)}><span aria-hidden="true">Collaboration</span></button>{open && <aside ref={panelRootRef} id={`project-collaboration-${projectId}`} className="project-collaboration" aria-label="Project collaboration">{contentMarkup}</aside>}</section>;
}
