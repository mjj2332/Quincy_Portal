import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import { NOTICE_BODY_MAX_LENGTH, NOTICE_RICH_TEXT_JSON_MAX_BYTES, richTextDocByteLength, richTextPlainText, type RichTextDoc } from "@quincy/shared";
import { stripEmbeddedDisplay } from "../lib/rich-text-tiptap";
import { createNoticeBoardPost, deleteNoticeBoardPost, editNoticeBoardPost, useNoticeBoardPostsQuery, useNoticeBoardPresentation, useNoticeBoardReadStateQuery } from "../lib/notice-board-data";
import { ApiError, apiGet } from "../lib/api";
import { cn } from "@/lib/utils";
import { RichTextContent } from "./RichTextContent";
import { QuincyRichTextEditor } from "./QuincyRichTextEditor";
import { META_TEXT } from "./quincy/Eyebrow";
import { buttonClasses } from "./quincy/Button";
import { EmptyState } from "./quincy/EmptyState";
import { Notice } from "./quincy/Notice";
import { ICON_BUTTON } from "./quincy/icon-button";
import { MENU_ITEM, Menu, MenuPrimitive } from "./quincy/menu";
import { NoticeDeleteDialog } from "./NoticeDeleteDialog";
import type { MentionableUser } from "./MentionAutocomplete";
import type { NoticeBoardPost } from "../lib/notice-board-data";

// Two separate complete strings, not "create plus overrides" — `.px-0` is emitted before
// `.px-[var(--space-5)]` under Tailwind's utility order, so an override form would silently
// lose the padding drop the edit composer needs (§5.4, Sol r2 #3).
const CREATE_COMPOSER = "grid gap-[var(--space-3)] px-[var(--space-5)] py-[var(--space-4)]";
const EDIT_COMPOSER = "grid gap-[var(--space-3)] pt-[var(--space-4)] px-0 pb-0";
const COMPOSER_FOOT = "flex flex-wrap items-center justify-between gap-[var(--space-3)]";
// `!normal-case` is mandatory: a plain `normal-case` loses to `META_TEXT`'s `uppercase` on
// emission order (§2.2, Sol r1 #5 — this exact bug shipped once already in TB8-07).
const MENTION_HINT = cn(META_TEXT, "!normal-case", "flex-[1_1_12rem] min-w-0");

// The "⋯" trigger's hit area (28px, 44px at <=721px: `ICON_BUTTON`'s min-h) is taller than the author line
// (`--type-eyebrow` = `--text-xs` at 1.2 line-height), and would stretch the header, making own notices
// taller than others'. A negative block margin of half the difference lets it overhang the row instead:
// the row stays one author-line tall, the trigger keeps its full hit area, centred on that line.
// At <=721px the 44px box overhangs 14.8px into the row's 16px padding, so the global focus outline (2px offset +
// 2px stroke) would reach past it onto the divider; draw that ring inside the box there instead.
const TRIGGER_OVERHANG =
  "-my-[calc((28px_-_1.2*var(--text-xs))/2)] max-[721px]:-my-[calc((44px_-_1.2*var(--text-xs))/2)] " +
  "max-[721px]:-outline-offset-2 max-[721px]:focus-visible:!-outline-offset-2";

const EMPTY_DOC: RichTextDoc = { type: "doc", content: [{ type: "paragraph" }] };
type NoticeBoardMutation = "create" | "edit" | "delete";

export type { NoticeBoardPost };

function relativeTime(value: string): string {
  const timestamp = new Date(value).valueOf(); if (!Number.isFinite(timestamp)) return "Unknown time";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["day", 86_400], ["hour", 3_600], ["minute", 60], ["second", 1]];
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, amount] of units) if (Math.abs(seconds) >= amount || unit === "second") return formatter.format(Math.round(seconds / amount), unit);
  return "just now";
}

export function NoticeBoard({ currentUserId }: { currentUserId: string }) {
  const queryClient = useQueryClient();
  const panelId = useId();
  const mentionHintRef = useRef<HTMLSpanElement>(null); // the helper line the table bar may extend down to (#535)
  const [content, setContent] = useState<RichTextDoc>(EMPTY_DOC);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState<RichTextDoc>(EMPTY_DOC);
  // Separate locks: an upload in the new-post composer must not hold the edit composer, nor the other way round (#496).
  const [composerUploading, setComposerUploading] = useState(false);
  const [editUploading, setEditUploading] = useState(false);
  const [noticeBoardMutation, setNoticeBoardMutation] = useState<NoticeBoardMutation | null>(null);
  const noticeBoardMutationRef = useRef<NoticeBoardMutation | null>(null);
  const [presentationError, setPresentationError] = useState<string | null>(null);
  const [mutationErrors, setMutationErrors] = useState<Partial<Record<"create" | "edit", string>>>({});
  // Captured when the dialog opens: `order` lets the dialog (and the focus hand-off) survive a refetch that drops the post.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; excerpt: string; order: string[] } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const lastDeleteTarget = useRef<{ id: string; order: string[]; deleted: boolean } | null>(null); // the close hand-off runs after `deleteTarget` is cleared
  // The id whose own Cancel/Save just ended its edit: only that notice's "⋯" takes focus back, never one
  // whose edit was merely replaced by another notice's Edit.
  const restoreTriggerFor = useRef<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const postsQuery = useNoticeBoardPostsQuery(true);
  const readStateQuery = useNoticeBoardReadStateQuery();
  const posts = postsQuery.data ?? [];
  const readState = readStateQuery.data;

  const loadMentionables = useCallback(async (query: string): Promise<MentionableUser[]> => {
    const result = await apiGet<{ users: MentionableUser[] }>(`/api/mentionable-users?scope=notice-board&q=${encodeURIComponent(query)}`);
    return result.users;
  }, []);

  const presentation = useNoticeBoardPresentation({
    principalId: currentUserId,
    open: true,
    posts,
    readState,
    onError: (reason) => setPresentationError(reason instanceof Error ? reason.message : "Notice board is unavailable."),
    onSuccess: () => setPresentationError(null),
  });

  // Over either cap the editor says so and the action is disabled: the server (the notice profile)
  // would answer 400, and the character counter reads the same untrimmed plain text.
  const overCap = (doc: RichTextDoc) => richTextDocByteLength(stripEmbeddedDisplay(doc)) > NOTICE_RICH_TEXT_JSON_MAX_BYTES || richTextPlainText(doc).length > NOTICE_BODY_MAX_LENGTH;
  const postingOverBytes = overCap(content);
  const editingOverBytes = overCap(editingContent);
  const queryError = postsQuery.error ?? readStateQuery.error;
  const mutationError = mutationErrors.create ?? mutationErrors.edit ?? null;
  const visibleError = mutationError ?? presentationError ?? (queryError ? "Notice board is unavailable." : null);
  const setMutationError = (operation: "create" | "edit", reason: unknown, fallback: string) => {
    setMutationErrors((current) => ({ ...current, [operation]: reason instanceof Error ? reason.message : fallback }));
  };
  const clearMutationError = (operation: "create" | "edit") => {
    setMutationErrors((current) => {
      if (!current[operation]) return current;
      const next = { ...current };
      delete next[operation];
      return next;
    });
  };
  const isBusy = noticeBoardMutation !== null;
  const isPosting = noticeBoardMutation === "create";
  const isSaving = noticeBoardMutation === "edit";
  const isDeleting = noticeBoardMutation === "delete";
  const beginNoticeBoardMutation = (operation: NoticeBoardMutation) => {
    if (noticeBoardMutationRef.current !== null) return false;
    noticeBoardMutationRef.current = operation;
    setNoticeBoardMutation(operation);
    return true;
  };
  const finishNoticeBoardMutation = (operation: NoticeBoardMutation) => {
    if (noticeBoardMutationRef.current !== operation) return;
    noticeBoardMutationRef.current = null;
    setNoticeBoardMutation(null);
  };

  async function submit(event?: FormEvent) {
    event?.preventDefault(); if (postingOverBytes || composerUploading || !beginNoticeBoardMutation("create")) return;
    try {
      await createNoticeBoardPost(queryClient, stripEmbeddedDisplay(content));
      setContent(EMPTY_DOC); clearMutationError("create");
    } catch (reason) {
      setMutationError("create", reason, "The post could not be published.");
    } finally { finishNoticeBoardMutation("create"); }
  }

  async function saveEdit(id: string) {
    if (editingOverBytes || editUploading || !beginNoticeBoardMutation("edit")) return;
    try {
      await editNoticeBoardPost(queryClient, id, stripEmbeddedDisplay(editingContent));
      restoreTriggerFor.current = id; setEditingId(null); setEditingContent(EMPTY_DOC); clearMutationError("edit");
    } catch (reason) {
      setMutationError("edit", reason, "The post could not be updated.");
    } finally { finishNoticeBoardMutation("edit"); }
  }

  const requestDelete = (post: NoticeBoardPost) => {
    const text = richTextPlainText(post.content).trim();
    const target = { id: post.id, excerpt: text.length > 60 ? `${text.slice(0, 60)}…` : text, order: posts.map((candidate) => candidate.id) };
    lastDeleteTarget.current = { id: target.id, order: target.order, deleted: false };
    setDeleteError(null);
    setDeleteTarget(target);
  };

  const markDeleted = () => { if (lastDeleteTarget.current) lastDeleteTarget.current.deleted = true; };

  // Sends the captured id only, never another notice. A 404 means it is already gone: close, no error.
  async function confirmDelete() {
    if (!deleteTarget || !beginNoticeBoardMutation("delete")) return;
    try {
      await deleteNoticeBoardPost(queryClient, deleteTarget.id);
      markDeleted(); setDeleteTarget(null); setDeleteError(null);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) { markDeleted(); setDeleteTarget(null); setDeleteError(null); }
      else setDeleteError(reason instanceof Error ? reason.message : "The notice could not be deleted. Try again.");
    } finally { finishNoticeBoardMutation("delete"); }
  }

  // Resolved when the dialog closes; never `undefined`, so focus never falls to body. Cancel/Escape: the
  // notice's own "⋯". After a delete (success or 404, even if the refetch since failed and the cached list
  // still holds it): the next surviving "⋯", then the previous, then the composer; never the deleted notice's.
  function deleteFinalFocus(): HTMLElement | true {
    const root = sectionRef.current;
    const target = lastDeleteTarget.current;
    if (!root || !target) return true;
    const triggerOf = (id: string) => [...root.querySelectorAll<HTMLElement>("[data-post-id]")].find((node) => node.dataset.postId === id)?.querySelector<HTMLElement>('[data-testid="notice-board-actions"]') ?? null;
    const at = target.order.indexOf(target.id);
    const successors = [...target.order.slice(at + 1), ...target.order.slice(0, at).reverse()];
    for (const id of target.deleted ? successors : [target.id, ...successors]) { const trigger = triggerOf(id); if (trigger) return trigger; }
    return root.querySelector<HTMLElement>('[data-slot="notice-board-composer"] [contenteditable="true"]') ?? true;
  }

  const renderEditComposer = (id: string) => <div data-slot="notice-board-edit-composer" className={EDIT_COMPOSER}>
    <QuincyRichTextEditor preset="document" value={editingContent} onChange={setEditingContent} limit={NOTICE_BODY_MAX_LENGTH} maxBytes={NOTICE_RICH_TEXT_JSON_MAX_BYTES} disabled={isBusy} loadMentionables={loadMentionables} placeholder="Edit notice…" onSubmit={() => void saveEdit(id)} media={{ noticeBoard: true }} linkPreviews={{ noticeBoard: true }} onUploadingChange={setEditUploading} />
    <div className={COMPOSER_FOOT}><button className={buttonClasses("secondary")} type="button" disabled={isBusy} onClick={() => { restoreTriggerFor.current = id; setEditingId(null); setEditingContent(EMPTY_DOC); }}>Cancel</button><button className={buttonClasses("primary")} type="button" disabled={isBusy || editingOverBytes || editUploading} onClick={() => void saveEdit(id)}>{isSaving ? "Saving…" : "Save"}</button></div>
  </div>;

  const hasUnread = (readState?.unreadCount ?? 0) > 0;
  const editingPostStillExists = editingId !== null && posts.some((post) => post.id === editingId);
  return <section ref={sectionRef} className="mb-[var(--space-6)] border-[length:var(--border-width-hair)] border-solid border-border bg-card" aria-label="Notice board">
    {hasUnread && (
      <span className="flex items-center gap-[var(--space-2)] px-[var(--space-5)] pt-[var(--space-4)]">
        <span className="sr-only" data-slot="notice-board-unread-indicator">New notice</span>
        <span aria-hidden="true" className="w-[7px] h-[7px] flex-none rounded-[var(--radius-pill)] bg-primary" />
      </span>
    )}
    <div id={panelId} data-slot="notice-board-panel">
      {visibleError && <Notice tone="critical" role="alert">{visibleError}</Notice>}
      <div className="grid" aria-live="polite" ref={posts.length === 0 ? presentation.anchorRef : undefined}>
        {posts.length === 0 && <EmptyState title="No notices yet." className="px-[var(--space-5)] py-[var(--space-5)] text-left" />}
        {posts.map((post) => <NoticeItem
          key={post.id}
          post={post}
          isOwn={post.authorId === currentUserId}
          isEditing={editingId === post.id}
          isBusy={isBusy}
          articleRef={post.id === posts[0]?.id ? presentation.anchorRef : undefined}
          restoreTriggerFor={restoreTriggerFor}
          onEditStart={() => { setEditingId(post.id); setEditingContent(post.content); }}
          onDeleteRequest={() => requestDelete(post)}
          editor={editingId === post.id ? renderEditComposer(post.id) : null}
        />)}
        {editingId && !editingPostStillExists && <article className="px-[var(--space-5)] py-[var(--space-4)] border-b-[length:var(--border-width-hair)] [border-bottom-style:solid] border-b-border bg-secondary" data-slot="notice-board-post">
          <Notice tone="caution" role="status">This notice was changed or deleted elsewhere. Your draft is still here.</Notice>
          {renderEditComposer(editingId)}
        </article>}
      </div>
      <form data-slot="notice-board-composer" className={CREATE_COMPOSER} onSubmit={(event) => void submit(event)}><label className="sr-only" htmlFor={`${panelId}-body`}>Write a notice</label><QuincyRichTextEditor preset="document" id={`${panelId}-body`} value={content} onChange={setContent} limit={NOTICE_BODY_MAX_LENGTH} maxBytes={NOTICE_RICH_TEXT_JSON_MAX_BYTES} disabled={isBusy} loadMentionables={loadMentionables} placeholder="Write a notice for the team…" onSubmit={() => void submit()} media={{ noticeBoard: true }} linkPreviews={{ noticeBoard: true }} onUploadingChange={setComposerUploading} tableBubbleFloor={mentionHintRef} /><div className={COMPOSER_FOOT}><span ref={mentionHintRef} className={MENTION_HINT}>Use @ to mention active staff</span><button className={buttonClasses("primary")} type="submit" disabled={isBusy || postingOverBytes || composerUploading}>{isPosting ? "Posting…" : "Post notice"}</button></div></form>
    </div>
    <NoticeDeleteDialog open={deleteTarget !== null} excerpt={deleteTarget?.excerpt ?? ""} deleting={isDeleting} error={deleteError} onConfirm={() => void confirmDelete()} onCancel={() => setDeleteTarget(null)} finalFocus={deleteFinalFocus} />
  </section>;
}

type NoticeItemProps = {
  post: NoticeBoardPost;
  isOwn: boolean;
  isEditing: boolean;
  isBusy: boolean;
  articleRef: Ref<HTMLElement> | undefined;
  restoreTriggerFor: { current: string | null };
  onEditStart: () => void;
  onDeleteRequest: () => void;
  /** The edit composer, shown in place of the body while this notice is being edited. */
  editor: ReactNode;
};

/**
 * One notice: author, time, "edited", and for the author a "⋯" menu (Edit, Delete) in the header
 * (#523; the same pattern as the Discussion comment menu, #491). Delete only requests the board's
 * confirmation dialog. The menu is hidden while the notice is being edited, so Delete never sits
 * beside Save. Author-only is unchanged: `isOwn` comes from the effective user.
 */
function NoticeItem({ post, isOwn, isEditing, isBusy, articleRef, restoreTriggerFor, onEditStart, onDeleteRequest, editor }: NoticeItemProps) {
  const ownRef = useRef<HTMLElement | null>(null);
  const setRefs = useCallback((node: HTMLElement | null) => {
    ownRef.current = node;
    if (typeof articleRef === "function") articleRef(node);
    else if (articleRef) (articleRef as { current: HTMLElement | null }).current = node;
  }, [articleRef]);
  const focusActions = useCallback(() => { ownRef.current?.querySelector<HTMLElement>('[data-testid="notice-board-actions"]')?.focus(); }, []);
  // Set when Edit is chosen: the menu unmounts with the edit (the "⋯" is hidden while editing), so its
  // own close hand-off never runs and the effect below puts focus in the editor instead.
  const focusEditorOnEdit = useRef(false);
  // Set when Delete is chosen: the dialog now owns focus, so the menu's close must not move it (`false`).
  const deletePending = useRef(false);
  // Set when Edit is chosen: Base UI's close hand-off would otherwise land on another notice's "⋯" (this
  // one is unmounted) after the editor took focus, so the close must not move it (`false`).
  const editPending = useRef(false);
  const menuFinalFocus = useCallback((): false | undefined => (deletePending.current || editPending.current ? false : undefined), []);
  const wasEditing = useRef(false);
  useEffect(() => {
    // Leaving the in-place editor by this notice's own Cancel or a saved edit hands focus back to the "⋯"
    // that opened it. Leaving because another notice's Edit began must not, or it steals that editor's focus.
    if (wasEditing.current && !isEditing && restoreTriggerFor.current === post.id) { restoreTriggerFor.current = null; focusActions(); }
    wasEditing.current = isEditing;
  }, [focusActions, isEditing, post.id, restoreTriggerFor]);
  useEffect(() => {
    if (!isEditing || !focusEditorOnEdit.current) return;
    let frame = 0; let attempts = 0;
    // The rich-text editor mounts its contenteditable a tick after the composer renders.
    const focusWhenReady = () => {
      const surface = ownRef.current?.querySelector<HTMLElement>('[contenteditable="true"]');
      if (!surface) { if (++attempts < 20) frame = requestAnimationFrame(focusWhenReady); return; }
      focusEditorOnEdit.current = false;
      surface.focus();
      const selection = window.getSelection();
      if (selection) { const range = document.createRange(); range.selectNodeContents(surface); range.collapse(false); selection.removeAllRanges(); selection.addRange(range); }
    };
    focusWhenReady();
    return () => cancelAnimationFrame(frame);
  }, [isEditing]);
  return <article className="px-[var(--space-5)] py-[var(--space-4)] border-b-[length:var(--border-width-hair)] [border-bottom-style:solid] border-b-border" data-slot="notice-board-post" data-post-id={post.id} ref={setRefs}>
    <header className="flex items-start gap-[var(--space-3)] min-w-0">
      <div className="flex flex-1 min-w-0 flex-wrap items-baseline gap-x-[var(--space-3)] gap-y-[var(--space-1)] self-center">
        <span className="[font:var(--type-eyebrow)] text-foreground min-w-0 [overflow-wrap:anywhere]">{post.authorName}</span>
        <time dateTime={post.createdAt} className={META_TEXT}>{relativeTime(post.createdAt)}</time>
        {post.editedAt && <span title={post.editedAt} className={META_TEXT}>edited</span>}
      </div>
      {isOwn && !isEditing && <Menu triggerLabel={`Actions for notice by ${post.authorName}`} label="Notice actions" triggerClassName={cn(ICON_BUTTON, "shrink-0 self-center", TRIGGER_OVERHANG)} triggerTestId="notice-board-actions" finalFocus={menuFinalFocus} onOpenChange={(open) => { if (open) { deletePending.current = false; editPending.current = false; } }} trigger={<span aria-hidden="true">⋯</span>}>
        <MenuPrimitive.Item className={MENU_ITEM} disabled={isBusy} onClick={() => { focusEditorOnEdit.current = true; editPending.current = true; onEditStart(); }}>Edit</MenuPrimitive.Item>
        <MenuPrimitive.Item className={cn(MENU_ITEM, "text-destructive")} disabled={isBusy} onClick={() => { deletePending.current = true; onDeleteRequest(); }}>Delete</MenuPrimitive.Item>
      </Menu>}
    </header>
    {isEditing
      ? editor
      /* `mt-[var(--space-2)]` replaces the now-retired post-body top-margin rule that used to
         live in app.css. The article is not a grid, and the first rich-text child has no margin of its
         own, so without this the content renders flush against the header (Sol r2 #2).
         `RichTextContent` takes `className` and appends it to `rich-text` by plain string
         concatenation — no `cn()`, so no twMerge — which is fine here: `mt-` conflicts with nothing
         in `.rich-text`. */
      : <RichTextContent content={post.content} className="mt-[var(--space-2)]" />}
  </article>;
}
