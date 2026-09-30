import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RICH_TEXT_JSON_MAX_BYTES, richTextDocByteLength, richTextPlainText, type RichTextDoc } from "@quincy/shared";
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
import { useNow } from "../lib/use-now";
import { META_TEXT } from "./quincy/Eyebrow";
import { Button } from "./quincy/Button";
import { StatusPill } from "./quincy/StatusPill";
import { EmptyState } from "./quincy/EmptyState";
import { Notice } from "./quincy/Notice";
import { InitialsAvatar } from "./quincy/InitialsAvatar";
import { CollaborationTimestamp } from "./quincy/CollaborationTimestamp";
import { ICON_BUTTON } from "./quincy/icon-button";
import { Menu, MenuPrimitive } from "./quincy/menu";

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

const COMMENT_LIMIT = 10_000;

const MENU_ITEM =
  "flex items-center w-full min-h-[32px] max-[721px]:min-h-[44px] px-[var(--space-3)] py-[var(--space-2)] cursor-pointer " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground " +
  "data-[highlighted]:bg-secondary";

type CommentItemProps = {
  comment: Comment;
  isOwn: boolean;
  now: number;
  saving: boolean;
  editing: RichTextDoc | undefined;
  editingOverBytes: boolean;
  loadMentionables: (query: string) => Promise<MentionableUser[]>;
  onEditStart: (comment: Comment) => void;
  onEditChange: (value: RichTextDoc) => void;
  onEditCancel: () => void;
  onEditSave: () => void;
  onDelete: (comment: Comment) => Promise<void>;
};

/**
 * One comment (#376): avatar, then a header line (name, "You" on your own, External editor pill,
 * relative time with the absolute date in a tooltip, "· Edited"), the "⋯" menu for the author, and
 * the body below spanning the text columns. A hairline separates items; there are no left rules.
 * Edit / Delete are author-only exactly as before — `isOwn` is derived from the effective session
 * user by the caller (the impersonated user while an Admin impersonates), and the server enforces it.
 */
function CommentItem({ comment, isOwn, now, saving, editing, editingOverBytes, loadMentionables, onEditStart, onEditChange, onEditCancel, onEditSave, onDelete }: CommentItemProps) {
  const articleRef = useRef<HTMLElement>(null);
  const focusActions = useCallback(() => { articleRef.current?.querySelector<HTMLElement>('[data-testid="comment-actions"]')?.focus(); }, []);
  // Set when Edit is chosen from the "⋯" menu: the menu's close would otherwise return focus to the
  // trigger, so `finalFocus` hands it to the edit editor (caret at the end) instead.
  const focusEditorOnClose = useRef(false);
  const focusEditor = useCallback((): HTMLElement | undefined => {
    if (!focusEditorOnClose.current) return undefined;
    const surface = articleRef.current?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!surface) return undefined;
    focusEditorOnClose.current = false;
    surface.focus();
    const selection = window.getSelection();
    if (selection) { const range = document.createRange(); range.selectNodeContents(surface); range.collapse(false); selection.removeAllRanges(); selection.addRange(range); }
    return surface;
  }, []);
  const isEditing = editing !== undefined;
  const wasEditing = useRef(false);
  useEffect(() => {
    // Leaving the in-place editor (Cancel or a saved edit) hands focus back to the "⋯" that opened it.
    if (wasEditing.current && !isEditing) focusActions();
    wasEditing.current = isEditing;
  }, [focusActions, isEditing]);
  return <article ref={articleRef} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-[var(--space-3)] gap-y-[var(--space-2)] min-w-0 py-[var(--space-4)] first:pt-0 [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border last:border-b-0">
    <InitialsAvatar name={comment.author.name} />
    <header className="flex flex-wrap items-baseline gap-x-[var(--space-2)] gap-y-[var(--space-1)] min-w-0 self-center">
      <strong className="[font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] text-foreground min-w-0 [overflow-wrap:anywhere]">{comment.author.name}</strong>
      {isOwn && <StatusPill tone="neutral">You</StatusPill>}
      {comment.author.isExternal && <StatusPill tone="info">External editor</StatusPill>}
      <CollaborationTimestamp instant={comment.createdAt} now={now} mode="relative" />
      {comment.editedAt && <span className={cn(META_TEXT, "!normal-case")}>· Edited</span>}
    </header>
    {isOwn ? <Menu triggerLabel={`Actions for comment by ${comment.author.name}`} label="Comment actions" triggerClassName={ICON_BUTTON} triggerTestId="comment-actions" finalFocus={focusEditor} trigger={<span aria-hidden="true">⋯</span>}>
      <MenuPrimitive.Item className={MENU_ITEM} disabled={isEditing || saving} onClick={() => { focusEditorOnClose.current = true; onEditStart(comment); }}>Edit</MenuPrimitive.Item>
      <MenuPrimitive.Item className={cn(MENU_ITEM, "text-destructive")} disabled={saving} onClick={() => { void onDelete(comment).finally(focusActions); }}>Delete</MenuPrimitive.Item>
    </Menu> : <span aria-hidden="true" />}
    <div className="col-start-2 col-span-2 max-[721px]:col-start-1 max-[721px]:col-span-3 grid gap-[var(--space-2)] min-w-0">
      {editing ? <>
        <RichTextEditor variant="field" value={editing} onChange={onEditChange} limit={COMMENT_LIMIT} disabled={saving} loadMentionables={loadMentionables} placeholder="Edit comment…" onSubmit={onEditSave} />
        <div className="flex justify-end gap-[var(--space-3)]"><Button variant="secondary" type="button" disabled={saving} onClick={onEditCancel}>Cancel</Button><Button type="button" disabled={saving || editingOverBytes} onClick={onEditSave}>Save</Button></div>
      </> : <RichTextContent className="rich-text--body" content={comment.content} />}
    </div>
  </article>;
}

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
  const viewerName = session.data?.user.name;
  const now = useNow();
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
  // Post is disabled for an empty or over-limit comment (previously it posted and the server
  // rejected it with a 400); keyboard submit already refused the same cases.
  const postingPlainText = richTextPlainText(content);
  const canPost = !saving && !postingOverBytes && postingPlainText.trim() !== "" && postingPlainText.length <= COMMENT_LIMIT;

  async function submit() {
    if (!canPost) return;
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

  const composer = <form data-testid="discussion-composer" className="flex items-start gap-[var(--space-3)] mb-[var(--space-5)]" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    {typeof viewerName === "string" && viewerName !== "" && <InitialsAvatar name={viewerName} className="mt-[var(--space-1)] max-[721px]:hidden" />}
    <div className="grid gap-[var(--space-2)] min-w-0 flex-1">
      <label className="sr-only" htmlFor={`project-comment-${projectId}`}>Write a comment</label>
      <RichTextEditor variant="field" id={`project-comment-${projectId}`} value={content} onChange={setContent} limit={COMMENT_LIMIT} disabled={saving} loadMentionables={loadMentionables} placeholder="Write a project comment…" onSubmit={() => void submit()} />
      <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)]"><span className={cn(META_TEXT, "!normal-case")}>Use @ to mention project participants</span><Button type="submit" className="ml-auto" disabled={!canPost}>{saving ? "Posting…" : "Post"}</Button></div>
    </div>
  </form>;

  const contentMarkup = <>
    {listError && !discussionDenied && <Notice tone="critical" role="alert">{errorMessage(listError, "Comments could not be loaded.")}</Notice>}
    {mutationError && !discussionDenied && <Notice tone="critical" role="alert">{mutationError}</Notice>}
    {beforeAnchor}
    {!discussionDenied && !listLoading && composer}
    <div ref={presentation.anchorRef} data-testid="discussion-read-anchor" className="w-px h-px m-0 overflow-hidden" aria-hidden="true" />
    {discussionDenied ? <EmptyState role="status" size="compact" title="No discussion access." /> : listLoading ? <EmptyState role="status" size="compact" title="Loading comments…" /> : <>
      <div data-testid="discussion-comments" className="grid">{comments.length ? comments.map((comment) => <CommentItem
        key={comment.id}
        comment={comment}
        isOwn={comment.author.id === currentUserId}
        now={now}
        saving={saving}
        editing={editing?.id === comment.id ? editing.content : undefined}
        editingOverBytes={editingOverBytes}
        loadMentionables={loadMentionables}
        onEditStart={(target) => setEditing({ id: target.id, content: target.content })}
        onEditChange={(value) => setEditing({ id: comment.id, content: value })}
        onEditCancel={() => setEditing(undefined)}
        onEditSave={() => void saveEdit()}
        onDelete={remove}
      />) : <EmptyState size="compact" title="No comments yet." />}</div>
      {commentsQuery.hasNextPage && <Button variant="secondary" className="justify-self-start" type="button" disabled={commentsQuery.isFetchingNextPage} onClick={() => void commentsQuery.fetchNextPage()}>{commentsQuery.isFetchingNextPage ? "Loading…" : "Load older comments"}</Button>}
    </>}
  </>;

  if (children) return <>{children({ content: contentMarkup, project, scrollRootRef: presentation.scrollRootRef })}</>;
  return contentMarkup;
}
