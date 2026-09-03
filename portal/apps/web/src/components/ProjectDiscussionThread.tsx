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
import { cn } from "../lib/utils";
import { META_TEXT } from "./ui/eyebrow";
import { buttonClasses } from "./ui/button";
import { StatusPill } from "./ui/status-pill";
import { EmptyState } from "./quincy/EmptyState";
import { Notice } from "./quincy/Notice";

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
    // "nested-comment" (an edit/delete rejection) is deliberately excluded from local
    // consumption: the server checks membership before authorship, and both failures surface as
    // the same 403, so it can't be trusted to mean collaboration access was lost — it's just as
    // likely an author-only mismatch, which must not collapse the whole Discussion view.
    if (resource !== "nested-comment" && consumeDiscussion403 && isDiscussionOnlyForbidden(reason)) {
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
    {listError && !discussionDenied && <Notice tone="critical" role="alert">{errorMessage(listError, "Comments could not be loaded.")}</Notice>}
    {mutationError && !discussionDenied && <Notice tone="critical" role="alert">{mutationError}</Notice>}
    {beforeAnchor}
    <div ref={presentation.anchorRef} data-testid="discussion-read-anchor" className="w-px h-px m-0 overflow-hidden" aria-hidden="true" />
    {discussionDenied ? <EmptyState role="status" title="No discussion access." className="px-0 py-[var(--space-4)] text-left" /> : listLoading ? <EmptyState role="status" title="Loading comments…" className="px-0 py-[var(--space-4)] text-left" /> : <>
      <div data-testid="discussion-comments" className="grid gap-[var(--space-5)]">{comments.length ? comments.map((comment) => { const isOwn = comment.author.id === currentUserId; return <article key={comment.id} className={cn("grid gap-[var(--space-2)] min-w-0 ps-[var(--space-3)] py-[var(--space-1)] [border-left-style:solid]", isOwn ? "border-l-[length:var(--border-width-rule)] border-l-primary" : "border-l-[length:var(--border-width-hair)] border-l-border")}><header className="flex flex-wrap items-baseline gap-x-[var(--space-2)] gap-y-[var(--space-1)] min-w-0"><strong className="[font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] text-foreground min-w-0 [overflow-wrap:anywhere]">{comment.author.name}</strong>{comment.author.isExternal && <StatusPill tone="info">External editor</StatusPill>}<time dateTime={comment.createdAt} className={META_TEXT}>{new Date(comment.createdAt).toLocaleString()}</time></header>{editing?.id === comment.id ? <><RichTextEditor value={editing.content} onChange={(value) => setEditing({ id: comment.id, content: value })} limit={10_000} disabled={saving} loadMentionables={loadMentionables} placeholder="Edit comment…" onSubmit={() => void saveEdit()} /><div className="flex justify-end gap-[var(--space-3)]"><button className={buttonClasses("secondary")} type="button" disabled={saving} onClick={() => setEditing(undefined)}>Cancel</button><button className={buttonClasses("primary")} type="button" disabled={saving || editingOverBytes} onClick={() => void saveEdit()}>Save</button></div></> : <><RichTextContent content={comment.content} />{comment.editedAt && <small className={META_TEXT}>Edited</small>}{isOwn && <div className="flex justify-end gap-[var(--space-3)]"><button type="button" className={buttonClasses("text")} onClick={() => setEditing({ id: comment.id, content: comment.content })}>Edit</button><button type="button" className={buttonClasses("text")} disabled={saving} onClick={() => void remove(comment)}>Delete</button></div>}</>}</article>; }) : <EmptyState title="No comments yet." className="px-0 py-[var(--space-4)] text-left" />}</div>
      {commentsQuery.hasNextPage && <button className={buttonClasses("secondary", { className: "justify-self-start" })} type="button" disabled={commentsQuery.isFetchingNextPage} onClick={() => void commentsQuery.fetchNextPage()}>{commentsQuery.isFetchingNextPage ? "Loading…" : "Load older comments"}</button>}
      <form data-testid="discussion-composer" className="grid gap-[var(--space-2)] pt-[var(--space-3)] [border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border" onSubmit={(event) => { event.preventDefault(); void submit(); }}><label className="sr-only" htmlFor={`project-comment-${projectId}`}>Write a comment</label><RichTextEditor id={`project-comment-${projectId}`} value={content} onChange={setContent} limit={10_000} disabled={saving} loadMentionables={loadMentionables} placeholder="Write a project comment…" onSubmit={() => void submit()} /><div className="flex flex-wrap items-center justify-between gap-[var(--space-3)]"><span className={cn(META_TEXT, "!normal-case")}>Use @ to mention project participants</span><button className={buttonClasses("primary")} type="submit" disabled={saving || postingOverBytes}>{saving ? "Posting…" : "Post comment"}</button></div></form>
    </>}
  </>;

  if (children) return <>{children({ content: contentMarkup, project, scrollRootRef: presentation.scrollRootRef })}</>;
  return contentMarkup;
}
