import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RICH_TEXT_JSON_MAX_BYTES, richTextDocByteLength, type RichTextDoc } from "@quincy/shared";
import { apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";
import { useSession } from "../lib/auth";
import {
  invalidateProjectCommentResources,
  prependProjectComment,
  removeProjectComment,
  replaceProjectComment,
  useProjectCommentPresentation,
  useProjectCommentReadStateQuery,
  useProjectCommentsQuery,
  type Comment,
} from "../lib/project-comments";
import { useProjectAccessTermination } from "../lib/project-data";
import { RichTextContent } from "./RichTextContent";
import { RichTextEditor } from "./RichTextEditor";
import type { MentionableUser } from "./MentionAutocomplete";
import { SubtaskChecklist } from "./SubtaskChecklist";
import { confirm } from "../lib/confirm";

const emptyDoc = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });
type AccessFailureResource = "comments" | "comment-read-marker" | "nested-comment";

type ProjectCollaborationPanelProps = {
  projectId: string;
  openSignal?: number;
  onOpenSignalConsumed?: (signal: number) => void;
  mode?: "overlay" | "standalone";
  onAccessFailure?: (error: unknown, resource: AccessFailureResource) => void;
};

function errorMessage(value: unknown, fallback: string) {
  return value instanceof Error ? value.message : fallback;
}

export function ProjectCollaborationPanel({ projectId, openSignal, onOpenSignalConsumed, mode = "overlay", onAccessFailure }: ProjectCollaborationPanelProps) {
  const session = useSession();
  const queryClient = useQueryClient();
  const terminateOnUnauthorized = useProjectAccessTermination();
  const currentUserId = session.data?.user.id;
  const overlay = mode === "overlay";
  const [overlayOpen, setOverlayOpen] = useState(true);
  const open = overlay ? overlayOpen : true;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRootRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastConsumedSignalRef = useRef<number | undefined>(undefined);
  const pendingSignalRef = useRef<number | undefined>(undefined);
  const [content, setContent] = useState<RichTextDoc>(emptyDoc);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{ id: string; content: RichTextDoc }>();
  const [mutationError, setMutationError] = useState<string>();
  const presentation = useProjectCommentPresentation({ projectId, open, onAccessError: (error) => onAccessFailure?.(error, "comments") });
  // Keep one enabled comments observer mounted while the panel is closed. The presentation
  // coordinator owns whether a closed→open transition needs its scoped head refresh; letting the
  // observer toggle enabled would make TanStack refetch every stale infinite page first.
  const commentsQuery = useProjectCommentsQuery(projectId, true, presentation.readAttemptRegistrar, open);
  const readStateQuery = useProjectCommentReadStateQuery(projectId, true);
  const commentsData = commentsQuery.data;
  const comments = useMemo(() => {
    const seen = new Set<string>();
    return commentsData?.pages.flatMap((page) => page.comments).filter((comment) => {
      if (seen.has(comment.id)) return false;
      seen.add(comment.id);
      return true;
    }) ?? [];
  }, [commentsData]);
  const project = commentsData?.pages[0]?.project;
  const listLoading = commentsQuery.isPending && !commentsData;
  const listError = commentsQuery.error;
  const unreadCount = readStateQuery.data?.unreadCount ?? 0;

  useEffect(() => { void presentation.drain(commentsData, readStateQuery.data); }, [commentsData, presentation, readStateQuery.data]);
  useEffect(() => { if (listError) onAccessFailure?.(listError, "comments"); }, [listError, onAccessFailure]);
  useEffect(() => { if (readStateQuery.error) onAccessFailure?.(readStateQuery.error, "comment-read-marker"); }, [onAccessFailure, readStateQuery.error]);

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
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [close, open, overlay]);

  const accessFailure = useCallback((reason: unknown, resource: AccessFailureResource) => {
    terminateOnUnauthorized(reason);
    onAccessFailure?.(reason, resource);
  }, [onAccessFailure, terminateOnUnauthorized]);

  const loadMentionables = useCallback(async (query: string): Promise<MentionableUser[]> => {
    try { return (await apiGet<{ users: MentionableUser[] }>(`/api/mentionable-users?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(query)}`)).users; }
    catch (reason) { accessFailure(reason, "comments"); throw reason; }
  }, [accessFailure, projectId]);

  const postingOverBytes = richTextDocByteLength(content) > RICH_TEXT_JSON_MAX_BYTES;
  const editingOverBytes = editing ? richTextDocByteLength(editing.content) > RICH_TEXT_JSON_MAX_BYTES : false;

  async function submit() {
    if (saving || postingOverBytes) return;
    const mutationProjectId = projectId;
    setSaving(true); setMutationError(undefined);
    try {
      const comment = await apiPost<Comment, { content: RichTextDoc }>(`/api/projects/${encodeURIComponent(projectId)}/comments`, { content });
      if (!presentation.isCurrent(mutationProjectId)) return;
      prependProjectComment(queryClient, projectId, comment);
      setContent(emptyDoc());
      void invalidateProjectCommentResources(queryClient, projectId, ["comments", "comment-read-marker"]);
    } catch (reason) { if (presentation.isCurrent(mutationProjectId)) { accessFailure(reason, "comments"); setMutationError(errorMessage(reason, "Comment could not be posted.")); } }
    finally { if (presentation.isCurrent(mutationProjectId)) setSaving(false); }
  }

  async function saveEdit() {
    if (!editing || saving || editingOverBytes) return;
    const mutationProjectId = projectId;
    setSaving(true); setMutationError(undefined);
    try {
      const comment = await apiPatch<Comment, { content: RichTextDoc }>(`/api/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(editing.id)}`, { content: editing.content });
      if (!presentation.isCurrent(mutationProjectId)) return;
      replaceProjectComment(queryClient, projectId, comment);
      setEditing(undefined);
      void invalidateProjectCommentResources(queryClient, projectId, ["comments"]);
    } catch (reason) { if (presentation.isCurrent(mutationProjectId)) { accessFailure(reason, "nested-comment"); setMutationError(errorMessage(reason, "Comment could not be updated.")); } }
    finally { if (presentation.isCurrent(mutationProjectId)) setSaving(false); }
  }

  async function remove(comment: Comment) {
    if (!await confirm({ title: "Delete comment?", message: "Delete this comment?", confirmLabel: "Delete", danger: true })) return;
    const mutationProjectId = projectId;
    setSaving(true); setMutationError(undefined);
    try {
      await apiDelete(`/api/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(comment.id)}`);
      if (!presentation.isCurrent(mutationProjectId)) return;
      removeProjectComment(queryClient, projectId, comment.id);
      if (editing?.id === comment.id) setEditing(undefined);
      void invalidateProjectCommentResources(queryClient, projectId, ["comments", "comment-read-marker"]);
    } catch (reason) { if (presentation.isCurrent(mutationProjectId)) { accessFailure(reason, "nested-comment"); setMutationError(errorMessage(reason, "Comment could not be deleted.")); } }
    finally { if (presentation.isCurrent(mutationProjectId)) setSaving(false); }
  }

  const unreadLabel = unreadCount > 99 ? "99+" : String(unreadCount);
  const toggleLabel = open ? "Hide collaboration" : unreadCount > 0 ? `Show collaboration (${unreadCount} unread comment${unreadCount === 1 ? "" : "s"})` : "Show collaboration";
  const headerMarkup = <div className="project-collaboration__head"><div><div className="ey">Collaboration</div><h2 className="serif">{project?.street ?? "Project comments"}</h2></div>{overlay && <button ref={closeRef} type="button" className="button button--secondary" onClick={close}>Hide ›</button>}</div>;
  const contentMarkup = <>
    {listError && <div className="notice" role="alert">{errorMessage(listError, "Comments could not be loaded.")}</div>}
    {mutationError && <div className="notice" role="alert">{mutationError}</div>}
    <SubtaskChecklist projectId={projectId} />
    <div ref={presentation.anchorRef} className="project-collaboration__read-anchor" aria-hidden="true" />
    {listLoading ? <div className="project-collaboration__state" role="status">Loading comments…</div> : <>
      <div className="project-collaboration__comments">{comments.length ? comments.map((comment) => <article key={comment.id} className="project-collaboration__comment"><header><strong>{comment.author.name}</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time></header>{editing?.id === comment.id ? <><RichTextEditor value={editing.content} onChange={(value) => setEditing({ id: comment.id, content: value })} limit={10_000} disabled={saving} loadMentionables={loadMentionables} placeholder="Edit comment…" onSubmit={() => void saveEdit()} /><div className="project-collaboration__comment-actions"><button className="button button--secondary" type="button" disabled={saving} onClick={() => setEditing(undefined)}>Cancel</button><button className="button" type="button" disabled={saving || editingOverBytes} onClick={() => void saveEdit()}>Save</button></div></> : <><RichTextContent content={comment.content} />{comment.editedAt && <small>Edited</small>}{comment.author.id === currentUserId && <div className="project-collaboration__comment-actions"><button type="button" className="button button--secondary" onClick={() => setEditing({ id: comment.id, content: comment.content })}>Edit</button><button type="button" className="button button--secondary" disabled={saving} onClick={() => void remove(comment)}>Delete</button></div>}</>}</article>) : <div className="project-collaboration__state">No comments yet.</div>}</div>
      {commentsQuery.hasNextPage && <button className="button button--secondary" type="button" disabled={commentsQuery.isFetchingNextPage} onClick={() => void commentsQuery.fetchNextPage()}>{commentsQuery.isFetchingNextPage ? "Loading…" : "Load older comments"}</button>}
      <form className="project-collaboration__comment-compose" onSubmit={(event) => { event.preventDefault(); void submit(); }}><label className="sr-only" htmlFor={`project-comment-${projectId}`}>Write a comment</label><RichTextEditor id={`project-comment-${projectId}`} value={content} onChange={setContent} limit={10_000} disabled={saving} loadMentionables={loadMentionables} placeholder="Write a project comment…" onSubmit={() => void submit()} /><div><span>Use @ to mention project participants</span><button className="button" type="submit" disabled={saving || postingOverBytes}>{saving ? "Posting…" : "Post comment"}</button></div></form>
    </>}
  </>;

  if (!overlay) return <section className="project-collaboration project-collaboration--standalone" aria-label="Project collaboration">{headerMarkup}{contentMarkup}</section>;
  return <section className="project-collaboration__wrap"><button ref={triggerRef} type="button" className="project-collaboration__toggle" aria-label={toggleLabel} aria-expanded={open} aria-controls={`project-collaboration-${projectId}`} onClick={() => setOverlayOpen((value) => !value)}><span aria-hidden="true">Collaboration</span>{unreadCount > 0 && <span className="project-collaboration__unread" aria-hidden="true">{unreadLabel}</span>}</button>{open && <aside ref={panelRootRef} id={`project-collaboration-${projectId}`} className="project-collaboration project-collaboration--overlay" aria-label="Project collaboration">{headerMarkup}<div ref={presentation.scrollRootRef} className="project-collaboration__scroll">{contentMarkup}</div></aside>}</section>;
}
