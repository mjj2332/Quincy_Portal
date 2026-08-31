import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RICH_TEXT_JSON_MAX_BYTES, richTextDocByteLength, type RichTextDoc } from "@quincy/shared";
import { apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";
import { externalApiGet } from "../lib/external-api-response";
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
  type CommentResponse,
} from "../lib/project-comments";
import { classifyProjectAccessError, projectCollaborationDataGeneration, useProjectAccessTermination } from "../lib/project-data";
import { RichTextContent } from "./RichTextContent";
import { RichTextEditor } from "./RichTextEditor";
import type { MentionableUser } from "./MentionAutocomplete";
import { confirm } from "../lib/confirm";

export type ProjectDiscussionAccessFailureResource = "comments" | "comment-read-marker" | "nested-comment";

export type ProjectDiscussionThreadProps = {
  projectId: string;
  currentUserId?: string;
  presented?: boolean;
  consumeDiscussion403?: boolean;
  onAccessFailure?: (error: unknown, resource: ProjectDiscussionAccessFailureResource) => void;
  onUnreadCountChange?: (count: number) => void;
  beforeAnchor?: ReactNode;
  children?: (discussion: {
    content: ReactNode;
    project: CommentResponse["project"] | undefined;
    scrollRootRef: RefCallback<HTMLElement>;
  }) => ReactNode;
};

const emptyDoc = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });

function errorMessage(value: unknown, fallback: string) {
  return value instanceof Error ? value.message : fallback;
}

function isDiscussionOnlyForbidden(error: unknown) {
  return classifyProjectAccessError(error, "comments")?.scope === "collaboration";
}

/**
 * The comment stream and its presentation/read-state coordinator, without the
 * checklist or any surrounding panel chrome. The optional render slot lets the
 * Workspace keep this component mounted while its overlay is closed.
 */
export function ProjectDiscussionThread({
  projectId,
  currentUserId: providedCurrentUserId,
  presented = true,
  consumeDiscussion403 = true,
  onAccessFailure,
  onUnreadCountChange,
  beforeAnchor,
  children,
}: ProjectDiscussionThreadProps) {
  const session = useSession();
  const queryClient = useQueryClient();
  const terminateOnUnauthorized = useProjectAccessTermination();
  const currentUserId = providedCurrentUserId ?? session.data?.user.id;
  const [content, setContent] = useState<RichTextDoc>(emptyDoc);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{ id: string; content: RichTextDoc }>();
  const [mutationError, setMutationError] = useState<string>();
  const [discussionDeniedFor, setDiscussionDeniedFor] = useState<string>();
  const consumeOrForward = useCallback((reason: unknown, resource: ProjectDiscussionAccessFailureResource) => {
    if (consumeDiscussion403 && isDiscussionOnlyForbidden(reason)) {
      setDiscussionDeniedFor(projectId);
      return;
    }
    terminateOnUnauthorized(reason);
    onAccessFailure?.(reason, resource);
  }, [consumeDiscussion403, onAccessFailure, projectId, terminateOnUnauthorized]);

  const presentation = useProjectCommentPresentation({
    projectId,
    open: presented,
    onAccessError: (error) => consumeOrForward(error, "comments"),
  });
  // Keep one enabled comments observer mounted while the Workspace overlay is
  // closed. The coordinator decides whether a presented transition qualifies
  // for its scoped head refresh; toggling enabled would refetch every stale
  // infinite page before that coordinator can take over.
  const commentsQuery = useProjectCommentsQuery(projectId, true, presentation.readAttemptRegistrar, presented);
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
  const listDenied = Boolean(consumeDiscussion403 && listError && isDiscussionOnlyForbidden(listError));
  const discussionDenied = listDenied || discussionDeniedFor === projectId;

  useEffect(() => { void presentation.drain(commentsData, readStateQuery.data); }, [commentsData, presentation, readStateQuery.data]);
  useEffect(() => {
    onUnreadCountChange?.(unreadCount);
  }, [onUnreadCountChange, unreadCount]);
  useEffect(() => {
    if (!listError) return;
    consumeOrForward(listError, "comments");
  }, [consumeOrForward, listError]);
  useEffect(() => {
    if (!readStateQuery.error) return;
    consumeOrForward(readStateQuery.error, "comment-read-marker");
  }, [consumeOrForward, readStateQuery.error]);

  const loadMentionables = useCallback(async (query: string): Promise<MentionableUser[]> => {
    const generation = projectCollaborationDataGeneration(queryClient, projectId);
    try {
      const response = session.data?.user.role === "external_editor"
        ? await externalApiGet("mentionable", `/api/mentionable-users?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(query)}`) as { users: MentionableUser[] }
        : await apiGet<{ users: MentionableUser[] }>(`/api/mentionable-users?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(query)}`);
      if (projectCollaborationDataGeneration(queryClient, projectId) !== generation) throw new DOMException("The operation was aborted.", "AbortError");
      return response.users;
    } catch (reason) {
      consumeOrForward(reason, "comments");
      throw reason;
    }
  }, [consumeOrForward, projectId, queryClient, session.data?.user.role]);

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
      void invalidateProjectCommentResources(queryClient, projectId, ["comments", "comment-read-marker", "activity"]);
    } catch (reason) {
      if (presentation.isCurrent(mutationProjectId)) {
        consumeOrForward(reason, "comments");
        setMutationError(errorMessage(reason, "Comment could not be posted."));
      }
    } finally {
      if (presentation.isCurrent(mutationProjectId)) setSaving(false);
    }
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
      void invalidateProjectCommentResources(queryClient, projectId, ["comments", "activity"]);
    } catch (reason) {
      if (presentation.isCurrent(mutationProjectId)) {
        consumeOrForward(reason, "nested-comment");
        setMutationError(errorMessage(reason, "Comment could not be updated."));
      }
    } finally {
      if (presentation.isCurrent(mutationProjectId)) setSaving(false);
    }
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
      void invalidateProjectCommentResources(queryClient, projectId, ["comments", "comment-read-marker", "activity"]);
    } catch (reason) {
      if (presentation.isCurrent(mutationProjectId)) {
        consumeOrForward(reason, "nested-comment");
        setMutationError(errorMessage(reason, "Comment could not be deleted."));
      }
    } finally {
      if (presentation.isCurrent(mutationProjectId)) setSaving(false);
    }
  }

  const contentMarkup = <>
    {listError && !discussionDenied && <div className="notice" role="alert">{errorMessage(listError, "Comments could not be loaded.")}</div>}
    {mutationError && !discussionDenied && <div className="notice" role="alert">{mutationError}</div>}
    {beforeAnchor}
    <div ref={presentation.anchorRef} className="project-collaboration__read-anchor" aria-hidden="true" />
    {discussionDenied ? <div className="project-collaboration__state" role="status">No discussion access.</div> : listLoading ? <div className="project-collaboration__state" role="status">Loading comments…</div> : <>
      <div className="project-collaboration__comments">{comments.length ? comments.map((comment) => <article key={comment.id} className="project-collaboration__comment"><header><strong>{comment.author.name}</strong>{comment.author.isExternal && <span className="statetag">External editor</span>}<time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time></header>{editing?.id === comment.id ? <><RichTextEditor value={editing.content} onChange={(value) => setEditing({ id: comment.id, content: value })} limit={10_000} disabled={saving} loadMentionables={loadMentionables} placeholder="Edit comment…" onSubmit={() => void saveEdit()} /><div className="project-collaboration__comment-actions"><button className="button button--secondary" type="button" disabled={saving} onClick={() => setEditing(undefined)}>Cancel</button><button className="button" type="button" disabled={saving || editingOverBytes} onClick={() => void saveEdit()}>Save</button></div></> : <><RichTextContent content={comment.content} />{comment.editedAt && <small>Edited</small>}{comment.author.id === currentUserId && <div className="project-collaboration__comment-actions"><button type="button" className="button button--secondary" onClick={() => setEditing({ id: comment.id, content: comment.content })}>Edit</button><button type="button" className="button button--secondary" disabled={saving} onClick={() => void remove(comment)}>Delete</button></div>}</>}</article>) : <div className="project-collaboration__state">No comments yet.</div>}</div>
      {commentsQuery.hasNextPage && <button className="button button--secondary" type="button" disabled={commentsQuery.isFetchingNextPage} onClick={() => void commentsQuery.fetchNextPage()}>{commentsQuery.isFetchingNextPage ? "Loading…" : "Load older comments"}</button>}
      <form className="project-collaboration__comment-compose" onSubmit={(event) => { event.preventDefault(); void submit(); }}><label className="sr-only" htmlFor={`project-comment-${projectId}`}>Write a comment</label><RichTextEditor id={`project-comment-${projectId}`} value={content} onChange={setContent} limit={10_000} disabled={saving} loadMentionables={loadMentionables} placeholder="Write a project comment…" onSubmit={() => void submit()} /><div><span>Use @ to mention project participants</span><button className="button" type="submit" disabled={saving || postingOverBytes}>{saving ? "Posting…" : "Post comment"}</button></div></form>
    </>}
  </>;

  if (children) return <>{children({ content: contentMarkup, project, scrollRootRef: presentation.scrollRootRef })}</>;
  return contentMarkup;
}
