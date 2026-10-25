import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RICH_TEXT_JSON_MAX_BYTES, richTextDocByteLength, richTextPlainText, type RichTextDoc } from "@quincy/shared";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";
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
import { classifyProjectAccessError, invalidateProjectSurfaces, projectCollaborationDataGeneration, recordProjectArchivedRefusal, useProjectAccessTermination } from "../lib/project-data";
import { stripEmbeddedDisplay } from "../lib/rich-text-tiptap";
import { useProjectCommentDraft } from "../lib/project-comment-drafts";
import { RichTextContent } from "./RichTextContent";
import { QuincyRichTextEditor } from "./QuincyRichTextEditor";
import type { RichTextEditorHandle } from "./QuincyRichTextEditorBase";
import { NoteComposerBox } from "./quincy/NoteComposerBox";
import { PHONE_VIEWPORT_QUERY, useMediaQuery } from "../lib/use-media-query";
import type { MentionableUser } from "./MentionAutocomplete";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { cn } from "../lib/utils";
import { useNow } from "../lib/use-now";
import { META_TEXT } from "./quincy/Eyebrow";
import { Button } from "./quincy/Button";
import { StatusPill } from "./quincy/StatusPill";
import { EmptyState } from "./quincy/EmptyState";
import { Notice } from "./quincy/Notice";
import { InitialsAvatar } from "./quincy/InitialsAvatar";
import { CollaborationTimestamp } from "./quincy/CollaborationTimestamp";
import { ViaClientMark } from "./ViaClientMark";
import { ICON_BUTTON } from "./quincy/icon-button";
import { MENU_ITEM, Menu, MenuPrimitive } from "./quincy/menu";
import { ARCHIVED_NOTICE_CLASS } from "./archived-notice";

export type ProjectDiscussionAccessFailureResource = "comments" | "comment-read-marker" | "nested-comment";

export type ProjectDiscussionThreadProps = {
  projectId: string;
  currentUserId?: string;
  presented?: boolean;
  consumeDiscussion403?: boolean;
  /** The Project is archived: the discussion is read-only (#527). The collaboration-only view reads it from the staff collaboration summary. */
  archived?: boolean;
  onAccessFailure?: (error: unknown, resource: ProjectDiscussionAccessFailureResource) => void;
  onUnreadCountChange?: (count: number) => void;
  children?: (discussion: {
    content: ReactNode;
    project: CommentResponse["project"] | undefined;
    scrollRootRef: RefCallback<HTMLElement>;
  }) => ReactNode;
};

const emptyDoc = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });

const COMMENT_LIMIT = 10_000;
const COMMENT_TOO_LONG = `Comments can be ${new Intl.NumberFormat("en").format(COMMENT_LIMIT)} characters at most.`;
const WAIT_FOR_UPLOADS = "Wait for the uploads to finish.";
/** An Attachment failed to upload (#952): Post and Save wait until it is retried or removed, so a post never goes out missing a file. */
const RETRY_OR_REMOVE = "Retry or remove the file that failed.";
/** The paperclip takes any file on a Project comment (#952): photos and videos embed, everything else is attached. */
const ATTACH_LABEL = "Add files";
const TOO_LARGE = "This formatting is too large to save; remove list items or formatting.";
/** A line in the note box above its row, beside Send or Save (the Video composer's problem line): label type. */
const BOX_LINE = "m-0 [font:var(--type-label)] text-destructive";
/** The box's paperclip opens the editor's picker, and on a phone its bubble docks to the box (frame P2). */
const boxOf = (field: HTMLElement | null) => field?.closest('[data-testid="note-composer-box"]') ?? null;

/** The server refused a write because the Project is archived (#527): a 409 with this code. Upload refusals are not this: they stay in-editor errors. */
function isCommentArchivedRefusal(error: unknown) { return error instanceof ApiError && error.status === 409 && typeof error.details === "object" && error.details !== null && (error.details as { code?: unknown }).code === "comment_project_archived"; }
const COMMENT_DELETE_COPY = {
  title: "Delete comment?", action: "Delete", pending: "Deleting…", fallbackSubject: "This comment",
  description: (subject: ReactNode) => <>{subject} will be removed from the discussion for everyone, with any images and files in it. This can't be undone.</>,
};
const DISCUSSION_ARCHIVED_COPY = "Read-only while archived. Restore the project before commenting.";

type CommentItemProps = {
  comment: Comment;
  isOwn: boolean;
  readOnly: boolean;
  now: number;
  saving: boolean;
  editing: RichTextDoc | undefined;
  editingOverBytes: boolean;
  /** The refused save of this edit, shown in its box beside Save. */
  editError: string | undefined;
  phone: boolean;
  projectId: string;
  loadMentionables: (query: string) => Promise<MentionableUser[]>;
  onEditStart: (comment: Comment) => void;
  onEditChange: (value: RichTextDoc) => void;
  onEditCancel: () => void;
  onEditSave: () => void;
  /** Opens the Delete confirmation (#568); the thread owns the dialog and the request. */
  onDeleteRequest: (comment: Comment) => void;
};

/**
 * One comment (#376): avatar, then a header line (name, "You" on your own, External editor pill,
 * relative time with the absolute date in a tooltip, "· Edited"), the "⋯" menu for the author, and
 * the body below spanning the text columns. A hairline separates items; there are no left rules.
 * Edit / Delete are author-only exactly as before — `isOwn` is derived from the effective session
 * user by the caller (the impersonated user while an Admin impersonates), and the server enforces it.
 */
function CommentItem({ comment, isOwn, readOnly, now, saving, editing, editingOverBytes, editError, phone, projectId, loadMentionables, onEditStart, onEditChange, onEditCancel, onEditSave, onDeleteRequest }: CommentItemProps) {
  const articleRef = useRef<HTMLElement>(null);
  const focusActions = useCallback(() => { articleRef.current?.querySelector<HTMLElement>('[data-testid="comment-actions"]')?.focus(); }, []);
  // Set when Edit is chosen from the "⋯" menu: the menu's close would otherwise return focus to the
  // trigger, so `finalFocus` hands it to the edit editor (caret at the end) instead.
  const focusEditorOnClose = useRef(false);
  // Set when Delete is chosen: the confirmation dialog owns focus, so the menu's close must not take it back (#568).
  const deletePending = useRef(false);
  const focusEditor = useCallback((): HTMLElement | false | undefined => {
    if (deletePending.current) return false;
    if (!focusEditorOnClose.current) return undefined;
    const surface = articleRef.current?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!surface) return undefined;
    focusEditorOnClose.current = false;
    surface.focus();
    const selection = window.getSelection();
    if (selection) { const range = document.createRange(); range.selectNodeContents(surface); range.collapse(false); selection.removeAllRanges(); selection.addRange(range); }
    return surface;
  }, []);
  const [editUploading, setEditUploading] = useState(false);
  const [editFailedFiles, setEditFailedFiles] = useState(0);
  const editEditor = useRef<RichTextEditorHandle>(null);
  const editField = useRef<HTMLDivElement>(null);
  const [editStrip, setEditStrip] = useState<HTMLDivElement | null>(null);
  const [editPreviews, setEditPreviews] = useState<HTMLDivElement | null>(null);
  // Every save path (the Save button, and Ctrl/Cmd+Enter in the editor) goes through this: an image still uploading would be lost.
  const saveEdit = () => { if (!editUploading && editFailedFiles === 0) onEditSave(); };
  const isEditing = editing !== undefined;
  const wasEditing = useRef(false);
  useEffect(() => {
    // Leaving the in-place editor (Cancel or a saved edit) hands focus back to the "⋯" that opened it.
    if (wasEditing.current && !isEditing) focusActions();
    wasEditing.current = isEditing;
  }, [focusActions, isEditing]);
  return <article ref={articleRef} data-comment-id={comment.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-[var(--space-3)] gap-y-[var(--space-2)] min-w-0 py-[var(--space-4)] first:pt-0 [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border last:border-b-0">
    <InitialsAvatar name={comment.author.name} />
    <header className="flex flex-wrap items-baseline gap-x-[var(--space-2)] gap-y-[var(--space-1)] min-w-0 self-center">
      <strong className="[font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] text-foreground min-w-0 [overflow-wrap:anywhere]">{comment.author.name}</strong>
      {isOwn && <StatusPill tone="neutral">You</StatusPill>}
      {comment.author.isExternal && <StatusPill tone="info">External editor</StatusPill>}
      <ViaClientMark client={comment.viaClient} />
      <CollaborationTimestamp instant={comment.createdAt} now={now} mode="relative" />
      {comment.editedAt && <span className={cn(META_TEXT, "!normal-case")}>· Edited</span>}
    </header>
    {isOwn && !readOnly ? <Menu triggerLabel={`Actions for comment by ${comment.author.name}`} label="Comment actions" triggerClassName={cn(ICON_BUTTON, "me-[var(--space-1)]")} triggerTestId="comment-actions" finalFocus={focusEditor} onOpenChange={(open) => { if (open) deletePending.current = false; }} trigger={<span aria-hidden="true">⋯</span>}>
      <MenuPrimitive.Item className={MENU_ITEM} disabled={isEditing || saving} onClick={() => { focusEditorOnClose.current = true; onEditStart(comment); }}>Edit</MenuPrimitive.Item>
      <MenuPrimitive.Item className={cn(MENU_ITEM, "text-destructive")} disabled={saving} onClick={() => { deletePending.current = true; onDeleteRequest(comment); }}>Delete</MenuPrimitive.Item>
    </Menu> : <span aria-hidden="true" />}
    <div className="col-start-2 col-span-2 max-[721px]:col-start-1 max-[721px]:col-span-3 grid gap-[var(--space-2)] min-w-0">
      {/* The edit (#950): the note composer box's post variant, E1's Cancel and Save in place of Send. */}
      {editing ? <NoteComposerBox
        variant="post" label="Edit comment" testId="discussion-comment-edit" phone={phone}
        field={<div ref={editField} className="min-w-0">
          <QuincyRichTextEditor
            preset="note" ref={editEditor} value={editing} onChange={onEditChange} limit={COMMENT_LIMIT} disabled={saving} loadMentionables={loadMentionables} placeholder="Edit comment…" ariaLabel="Edit comment" onSubmit={saveEdit}
            media={{ projectId }} linkPreviews={{ projectId }} attachments={{ projectId }} onUploadingChange={setEditUploading} onFailedFilesChange={setEditFailedFiles}
            stripContainer={editStrip} previewContainer={editPreviews} bubbleDocked={phone} bubbleDockTo={() => boxOf(editField.current)}
          />
        </div>}
        previews={<div ref={setEditPreviews} className="empty:hidden" />}
        strip={<div ref={setEditStrip} className="empty:hidden" />}
        notice={editError ? <p role="alert" data-testid="discussion-edit-problem" className={BOX_LINE}>{editError}</p> : null}
        attach={{ onPick: () => { editEditor.current?.pickMedia(); }, disabled: saving, label: ATTACH_LABEL }}
        save={{
          onSave: saveEdit, onCancel: onEditCancel, disabled: saving || editingOverBytes || editUploading || editFailedFiles > 0, pending: saving,
          ...(editUploading ? { reason: WAIT_FOR_UPLOADS } : editFailedFiles > 0 ? { reason: RETRY_OR_REMOVE } : editingOverBytes ? { reason: TOO_LARGE } : {}),
        }}
      /> : <RichTextContent className="rich-text--body" content={comment.content} />}
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
  archived = false,
  onAccessFailure,
  onUnreadCountChange,
  children,
}: ProjectDiscussionThreadProps) {
  const session = useSession();
  const queryClient = useQueryClient();
  const terminateOnUnauthorized = useProjectAccessTermination();
  const currentUserId = providedCurrentUserId ?? session.data?.user.id;
  const viewerName = session.data?.user.name;
  const now = useNow();
  const [content, setContent, clearDraftIfSubmitted] = useProjectCommentDraft(projectId);
  const [saving, setSaving] = useState(false);
  const [composerUploading, setComposerUploading] = useState(false);
  const [composerFailedFiles, setComposerFailedFiles] = useState(0);
  const [editing, setEditing] = useState<{ id: string; content: RichTextDoc }>();
  // A refused Post or Save, shown in the box that sent it (#950: beside Send or Save).
  const [mutationError, setMutationError] = useState<{ text: string; from: "post" | "edit" }>();
  const phone = useMediaQuery(PHONE_VIEWPORT_QUERY);
  const composerEditor = useRef<RichTextEditorHandle>(null);
  const composerField = useRef<HTMLDivElement>(null);
  const [composerStrip, setComposerStrip] = useState<HTMLDivElement | null>(null);
  const [composerPreviews, setComposerPreviews] = useState<HTMLDivElement | null>(null);
  const [discussionDeniedFor, setDiscussionDeniedFor] = useState<string>();
  // Delete confirmation (#568). The focus hand-off runs after `deleteTarget` is cleared, so the target and the comment order live in a ref.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; excerpt: string } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const lastDeleteTarget = useRef<{ id: string; order: string[]; deleted: boolean } | null>(null);
  // Read-only comes from the `archived` prop alone. A write refused as archived records the fact in the cache (#566), which feeds the prop at once.
  const readOnly = archived;
  const priorReadOnly = useRef(readOnly);
  const focusAfterFlip = useRef<{ inThread: boolean } | null>(null);
  // Bumped per recorded refusal: a poll can archive the Project while a write is pending, so `readOnly` is already true when the 409 lands.
  const [refusalGeneration, setRefusalGeneration] = useState(0);
  const composerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
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

  // Turning read-only (by the latch or by the prop arriving with a refetch) drops an open edit and its error: the controls that own them are gone.
  // The composer's draft is kept, in state and in storage, and returns after Restore.
  useLayoutEffect(() => { const was = priorReadOnly.current; priorReadOnly.current = readOnly; if (was || !readOnly) return; setEditing(undefined); setMutationError(undefined); }, [readOnly]);
  // A refusal removes the focused control (the saving editor is disabled, then unmounted): focus the notice, but only when focus was genuinely lost
  // (body, disabled, disconnected, or an ancestor of the thread). A connected, enabled control elsewhere keeps it, and nothing moves on load (#450/#452).
  useLayoutEffect(() => {
    const flip = focusAfterFlip.current; if (!readOnly || !flip) return;
    focusAfterFlip.current = null;
    const active = document.activeElement; const notice = noticeRef.current;
    if (!active || active === document.body || active.matches(":disabled") || (flip.inThread && (!active.isConnected || (notice !== null && active.contains(notice))))) notice?.focus();
  }, [readOnly, refusalGeneration]);
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

  const postingOverBytes = richTextDocByteLength(stripEmbeddedDisplay(content)) > RICH_TEXT_JSON_MAX_BYTES;
  const editingOverBytes = editing ? richTextDocByteLength(stripEmbeddedDisplay(editing.content)) > RICH_TEXT_JSON_MAX_BYTES : false;
  // Post is disabled for an empty or over-limit comment (previously it posted and the server
  // rejected it with a 400); keyboard submit already refused the same cases.
  const postingPlainText = richTextPlainText(content);
  const postingTooLong = postingPlainText.length > COMMENT_LIMIT;
  const canPost = !saving && !composerUploading && composerFailedFiles === 0 && !postingOverBytes && postingPlainText.trim() !== "" && !postingTooLong;
  const sendReason = composerUploading ? WAIT_FOR_UPLOADS : composerFailedFiles > 0 ? RETRY_OR_REMOVE : postingTooLong ? COMMENT_TOO_LONG : postingOverBytes ? TOO_LARGE : undefined;
  const postProblem = postingTooLong ? COMMENT_TOO_LONG : mutationError?.from === "post" ? mutationError.text : undefined;

  const focusInThread = () => { const active = document.activeElement; return active !== null && (composerRef.current?.contains(active) === true || listRef.current?.contains(active) === true); };
  /** Handles an archived refusal of a Post, Save or Delete: the thread goes read-only, nothing is optimistic, and the header and Checklist catch up. */
  async function enterArchived(inThread: boolean) {
    focusAfterFlip.current = { inThread }; setMutationError(undefined); setRefusalGeneration((generation) => generation + 1);
    await recordProjectArchivedRefusal(queryClient, projectId);
    void invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "detail" }, { kind: "collaboration-summary" }, { kind: "activity" }], dashboard: true, calendar: true, gantt: true });
  }

  async function submit() {
    if (!canPost) return;
    const mutationProjectId = projectId;
    const submitted = content;
    const inThread = focusInThread();
    setSaving(true); setMutationError(undefined);
    try {
      const comment = await apiPost<Comment, { content: RichTextDoc }>(`/api/projects/${encodeURIComponent(projectId)}/comments`, { content: stripEmbeddedDisplay(submitted) });
      // D3: a posted comment is no longer a draft even if the sheet closed mid-post (the isCurrent
      // guard below would otherwise leave it stored and restore it, to be posted twice).
      clearDraftIfSubmitted(submitted);
      if (!presentation.isCurrent(mutationProjectId)) return;
      prependProjectComment(queryClient, projectId, comment);
      setContent(emptyDoc());
      void invalidateProjectCommentResources(queryClient, projectId, ["comments", "comment-read-marker", "activity"]);
    } catch (reason) {
      if (presentation.isCurrent(mutationProjectId)) {
        if (isCommentArchivedRefusal(reason)) { void enterArchived(inThread); return; }
        consumeOrForward(reason, "comments");
        setMutationError({ text: errorMessage(reason, "Comment could not be posted."), from: "post" });
      }
    } finally {
      if (presentation.isCurrent(mutationProjectId)) setSaving(false);
    }
  }

  async function saveEdit() {
    if (!editing || saving || editingOverBytes) return;
    const mutationProjectId = projectId;
    const inThread = focusInThread();
    setSaving(true); setMutationError(undefined);
    try {
      const comment = await apiPatch<Comment, { content: RichTextDoc }>(`/api/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(editing.id)}`, { content: stripEmbeddedDisplay(editing.content) });
      if (!presentation.isCurrent(mutationProjectId)) return;
      replaceProjectComment(queryClient, projectId, comment);
      setEditing(undefined);
      void invalidateProjectCommentResources(queryClient, projectId, ["comments", "activity"]);
    } catch (reason) {
      if (presentation.isCurrent(mutationProjectId)) {
        if (isCommentArchivedRefusal(reason)) { void enterArchived(inThread); return; }
        consumeOrForward(reason, "nested-comment");
        setMutationError({ text: errorMessage(reason, "Comment could not be updated."), from: "edit" });
      }
    } finally {
      if (presentation.isCurrent(mutationProjectId)) setSaving(false);
    }
  }

  function requestDelete(comment: Comment) {
    const text = richTextPlainText(comment.content).trim();
    lastDeleteTarget.current = { id: comment.id, order: comments.map((candidate) => candidate.id), deleted: false };
    setDeleteError(null);
    setDeleteTarget({ id: comment.id, excerpt: text.length > 60 ? `${text.slice(0, 60)}…` : text });
  }

  // Sends the captured id only. The dialog stays open, with the message inside it, when the delete fails.
  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    const target = deleteTarget;
    const mutationProjectId = projectId;
    const inThread = focusInThread();
    setSaving(true); setDeleting(true); setDeleteError(null);
    try {
      await apiDelete(`/api/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(target.id)}`);
      if (!presentation.isCurrent(mutationProjectId)) return;
      removeProjectComment(queryClient, projectId, target.id);
      if (editing?.id === target.id) setEditing(undefined);
      if (lastDeleteTarget.current) lastDeleteTarget.current.deleted = true;
      setDeleteTarget(null);
      void invalidateProjectCommentResources(queryClient, projectId, ["comments", "comment-read-marker", "activity"]);
    } catch (reason) {
      if (presentation.isCurrent(mutationProjectId)) {
        if (isCommentArchivedRefusal(reason)) { setDeleteTarget(null); void enterArchived(inThread); return; }
        consumeOrForward(reason, "nested-comment");
        setDeleteError(errorMessage(reason, "Comment could not be deleted."));
      }
    } finally {
      if (presentation.isCurrent(mutationProjectId)) { setSaving(false); setDeleting(false); }
    }
  }

  // Resolved when the dialog closes; never `undefined`, so focus never falls to body. Cancel/Escape: the comment's own "⋯".
  // After a delete: the next surviving "⋯", then the previous, then the composer. A refusal that turned the thread read-only: the notice.
  function deleteFinalFocus(): HTMLElement | true {
    const target = lastDeleteTarget.current; const list = listRef.current;
    if (!target) return true;
    if (noticeRef.current) return noticeRef.current;
    const triggerOf = (id: string) => [...list?.querySelectorAll<HTMLElement>("[data-comment-id]") ?? []].find((node) => node.dataset.commentId === id)?.querySelector<HTMLElement>('[data-testid="comment-actions"]') ?? null;
    const at = target.order.indexOf(target.id);
    const successors = [...target.order.slice(at + 1), ...target.order.slice(0, at).reverse()];
    for (const id of target.deleted ? successors : [target.id, ...successors]) { const trigger = triggerOf(id); if (trigger) return trigger; }
    return composerRef.current?.querySelector<HTMLElement>('[contenteditable="true"]') ?? true;
  }

  useEffect(() => { setDeleteTarget(null); setDeleteError(null); setDeleting(false); }, [projectId]);

  // The composer (#950): the note composer box's post variant, R1's row (the paperclip and a round Send). The hint line is gone (C2): "@" is
  // in the placeholder. The avatar beside it is the thread's own layout.
  const composer = <div ref={composerRef} data-testid="discussion-composer" className="flex items-start gap-[var(--space-3)] mb-[var(--space-5)]">
    {typeof viewerName === "string" && viewerName !== "" && <InitialsAvatar name={viewerName} className="mt-[var(--space-1)] max-[721px]:hidden" />}
    <NoteComposerBox
      variant="post" label="Write a comment" testId="discussion-composer-form" phone={phone} className="min-w-0 flex-1"
      field={<div ref={composerField} className="min-w-0">
        <label className="sr-only" htmlFor={`project-comment-${projectId}`}>Write a comment</label>
        <QuincyRichTextEditor
          preset="note" ref={composerEditor} id={`project-comment-${projectId}`} value={content} onChange={setContent} limit={COMMENT_LIMIT} disabled={saving} loadMentionables={loadMentionables}
          placeholder={phone ? "Write a project comment…" : "Write a project comment… Use @ to mention project participants."} onSubmit={() => void submit()}
          media={{ projectId }} linkPreviews={{ projectId }} attachments={{ projectId }} onUploadingChange={setComposerUploading} onFailedFilesChange={setComposerFailedFiles}
          stripContainer={composerStrip} previewContainer={composerPreviews} bubbleDocked={phone} bubbleDockTo={() => boxOf(composerField.current)}
        />
      </div>}
      previews={<div ref={setComposerPreviews} className="empty:hidden" />}
      strip={<div ref={setComposerStrip} className="empty:hidden" />}
      notice={postProblem ? <p role="alert" data-testid="discussion-composer-problem" className={BOX_LINE}>{postProblem}</p> : null}
      attach={{ onPick: () => { composerEditor.current?.pickMedia(); }, disabled: saving, label: ATTACH_LABEL }}
      send={{ label: saving ? "Posting…" : "Post comment", onSend: () => void submit(), disabled: !canPost, pending: saving, ...(sendReason ? { reason: sendReason } : {}) }}
    />
  </div>;

  const contentMarkup = <>
    {listError && !discussionDenied && <Notice tone="critical" role="alert">{errorMessage(listError, "Comments could not be loaded.")}</Notice>}
    {!discussionDenied && !listLoading && (readOnly ? <div className="mb-[var(--space-5)]"><p ref={noticeRef} tabIndex={-1} className={ARCHIVED_NOTICE_CLASS} data-testid="discussion-archived-notice">{DISCUSSION_ARCHIVED_COPY}</p></div> : composer)}
    <div ref={presentation.anchorRef} data-testid="discussion-read-anchor" className="w-px h-px m-0 overflow-hidden" aria-hidden="true" />
    {discussionDenied ? <EmptyState role="status" size="compact" title="No discussion access." /> : listLoading ? <EmptyState role="status" size="compact" title="Loading comments…" /> : <>
      <div ref={listRef} data-testid="discussion-comments" className="grid">{comments.length ? comments.map((comment) => <CommentItem
        key={comment.id}
        comment={comment}
        isOwn={comment.author.id === currentUserId}
        readOnly={readOnly}
        now={now}
        saving={saving}
        editing={editing?.id === comment.id ? editing.content : undefined}
        editingOverBytes={editingOverBytes}
        editError={editing?.id === comment.id && mutationError?.from === "edit" ? mutationError.text : undefined}
        phone={phone}
        projectId={projectId}
        loadMentionables={loadMentionables}
        onEditStart={(target) => { setEditing({ id: target.id, content: target.content }); setMutationError((error) => error?.from === "edit" ? undefined : error); }}
        onEditChange={(value) => setEditing({ id: comment.id, content: value })}
        onEditCancel={() => { setEditing(undefined); setMutationError((error) => error?.from === "edit" ? undefined : error); }}
        onEditSave={() => void saveEdit()}
        onDeleteRequest={requestDelete}
      />) : <EmptyState size="compact" title="No comments yet." />}</div>
      {commentsQuery.hasNextPage && <Button variant="secondary" className="justify-self-start" type="button" disabled={commentsQuery.isFetchingNextPage} onClick={() => void commentsQuery.fetchNextPage()}>{commentsQuery.isFetchingNextPage ? "Loading…" : "Load older comments"}</Button>}
    </>}
    <ConfirmDeleteDialog open={deleteTarget !== null} excerpt={deleteTarget?.excerpt ?? ""} deleting={deleting} error={deleteError} onConfirm={() => void confirmDelete()} onCancel={() => setDeleteTarget(null)} finalFocus={deleteFinalFocus} testIdPrefix="comment-delete" copy={COMMENT_DELETE_COPY} />
  </>;

  if (children) return <>{children({ content: contentMarkup, project, scrollRootRef: presentation.scrollRootRef })}</>;
  return contentMarkup;
}
