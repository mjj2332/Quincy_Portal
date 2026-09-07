import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { RICH_TEXT_JSON_MAX_BYTES, richTextDocByteLength, type RichTextDoc } from "@quincy/shared";
import { createNoticeBoardPost, deleteNoticeBoardPost, editNoticeBoardPost, useNoticeBoardPostsQuery, useNoticeBoardPresentation, useNoticeBoardReadStateQuery } from "../lib/notice-board-data";
import { apiGet } from "../lib/api";
import { cn } from "@/lib/utils";
import { RichTextContent } from "./RichTextContent";
import { RichTextEditor } from "./RichTextEditor";
import { Eyebrow, META_TEXT } from "./quincy/Eyebrow";
import { buttonClasses } from "./ui/button";
import { EmptyState } from "./quincy/EmptyState";
import { Notice } from "./quincy/Notice";
import type { MentionableUser } from "./MentionAutocomplete";
import type { NoticeBoardPost } from "../lib/notice-board-data";

// `!outline-solid`, not `!outline`: `cn()` is twMerge, and it discards a bare
// `focus-visible:!outline` as conflicting with the `-[length:…]` utility (Sol r2 #4, verified).
const RING =
  "focus-visible:!outline-solid focus-visible:!outline-[length:var(--border-width-bold)] " +
  "focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-2";

// `min-w` is prescribed because `buttonClasses` contains NO min-width at all (§2.1); height
// alone is not a touch target. `min-h-[38px]` is prescribed because the `text` variant's own
// `min-h-[32px]` beats BASE's 38px under twMerge, and this release converges on 38/44, not 32/44.
const ACTION_SIZING = "min-h-[38px] max-[721px]:min-w-[44px] max-[721px]:min-h-[44px] px-[var(--space-2)]";

const EDIT_ACTION = buttonClasses("text", { className: ACTION_SIZING });

// `!` is load-bearing: the `text` variant sets `!text-foreground-secondary`, which a plain
// `text-destructive` cannot outrank even though twMerge keeps both (Sol #4, verified).
const DELETE_ACTION = buttonClasses("text", {
  className: ACTION_SIZING + " !text-destructive hover:not-disabled:!text-destructive",
});

// Two separate complete strings, not "create plus overrides" — `.px-0` is emitted before
// `.px-[var(--space-5)]` under Tailwind's utility order, so an override form would silently
// lose the padding drop the edit composer needs (§5.4, Sol r2 #3).
const CREATE_COMPOSER = "grid gap-[var(--space-3)] px-[var(--space-5)] py-[var(--space-4)]";
const EDIT_COMPOSER = "grid gap-[var(--space-3)] pt-[var(--space-4)] px-0 pb-0";
const COMPOSER_FOOT = "flex flex-wrap items-center justify-between gap-[var(--space-3)]";
// `!normal-case` is mandatory: a plain `normal-case` loses to `META_TEXT`'s `uppercase` on
// emission order (§2.2, Sol r1 #5 — this exact bug shipped once already in TB8-07).
const MENTION_HINT = cn(META_TEXT, "!normal-case", "flex-[1_1_12rem] min-w-0");

const COLLAPSE_KEY = "quincy:dashboard:noticeboard:v2";
const EMPTY_DOC: RichTextDoc = { type: "doc", content: [{ type: "paragraph" }] };
type NoticeBoardMutation = "create" | "edit";

export type { NoticeBoardPost };

function readStorage(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } }
function readOpen(): boolean { return readStorage(COLLAPSE_KEY) !== "false"; }
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
  const [open, setOpen] = useState(readOpen);
  const lastPersistedOpen = useRef(open);
  const [content, setContent] = useState<RichTextDoc>(EMPTY_DOC);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState<RichTextDoc>(EMPTY_DOC);
  const [noticeBoardMutation, setNoticeBoardMutation] = useState<NoticeBoardMutation | null>(null);
  const noticeBoardMutationRef = useRef<NoticeBoardMutation | null>(null);
  const [presentationError, setPresentationError] = useState<string | null>(null);
  const [mutationErrors, setMutationErrors] = useState<Partial<Record<"create" | "edit" | "delete", string>>>({});
  const postsQuery = useNoticeBoardPostsQuery(open);
  const readStateQuery = useNoticeBoardReadStateQuery();
  const posts = postsQuery.data ?? [];
  const readState = readStateQuery.data;

  const loadMentionables = useCallback(async (query: string): Promise<MentionableUser[]> => {
    const result = await apiGet<{ users: MentionableUser[] }>(`/api/mentionable-users?scope=notice-board&q=${encodeURIComponent(query)}`);
    return result.users;
  }, []);

  const presentation = useNoticeBoardPresentation({
    principalId: currentUserId,
    open,
    posts,
    readState,
    onError: (reason) => setPresentationError(reason instanceof Error ? reason.message : "Notice board is unavailable."),
    onSuccess: () => setPresentationError(null),
  });

  const postingOverBytes = richTextDocByteLength(content) > RICH_TEXT_JSON_MAX_BYTES;
  const editingOverBytes = richTextDocByteLength(editingContent) > RICH_TEXT_JSON_MAX_BYTES;
  const queryError = postsQuery.error ?? readStateQuery.error;
  const mutationError = mutationErrors.create ?? mutationErrors.edit ?? mutationErrors.delete ?? null;
  const visibleError = mutationError ?? presentationError ?? (queryError ? "Notice board is unavailable." : null);
  const setMutationError = (operation: "create" | "edit" | "delete", reason: unknown, fallback: string) => {
    setMutationErrors((current) => ({ ...current, [operation]: reason instanceof Error ? reason.message : fallback }));
  };
  const clearMutationError = (operation: "create" | "edit" | "delete") => {
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

  useEffect(() => {
    if (lastPersistedOpen.current === open) return;
    lastPersistedOpen.current = open;
    try { window.localStorage.setItem(COLLAPSE_KEY, String(open)); } catch { /* Storage can be disabled. */ }
  }, [lastPersistedOpen, open]);

  async function submit(event?: FormEvent) {
    event?.preventDefault(); if (postingOverBytes || !beginNoticeBoardMutation("create")) return;
    try {
      await createNoticeBoardPost(queryClient, content);
      setContent(EMPTY_DOC); clearMutationError("create");
    } catch (reason) {
      setMutationError("create", reason, "The post could not be published.");
    } finally { finishNoticeBoardMutation("create"); }
  }

  async function saveEdit(id: string) {
    if (editingOverBytes || !beginNoticeBoardMutation("edit")) return;
    try {
      await editNoticeBoardPost(queryClient, id, editingContent);
      setEditingId(null); setEditingContent(EMPTY_DOC); clearMutationError("edit");
    } catch (reason) {
      setMutationError("edit", reason, "The post could not be updated.");
    } finally { finishNoticeBoardMutation("edit"); }
  }

  async function deletePost(id: string) {
    try {
      await deleteNoticeBoardPost(queryClient, id);
      clearMutationError("delete");
    } catch (reason) { setMutationError("delete", reason, "The post could not be deleted."); }
  }

  const renderEditComposer = (id: string) => <div data-slot="notice-board-edit-composer" className={EDIT_COMPOSER}>
    <RichTextEditor value={editingContent} onChange={setEditingContent} limit={2_000} disabled={isBusy} loadMentionables={loadMentionables} placeholder="Edit notice…" onSubmit={() => void saveEdit(id)} />
    <div className={COMPOSER_FOOT}><button className={buttonClasses("secondary")} type="button" disabled={isBusy} onClick={() => { setEditingId(null); setEditingContent(EMPTY_DOC); }}>Cancel</button><button className={buttonClasses("primary")} type="button" disabled={isBusy || editingOverBytes} onClick={() => void saveEdit(id)}>{isSaving ? "Saving…" : "Save"}</button></div>
  </div>;

  const hasUnread = (readState?.unreadCount ?? 0) > 0;
  const editingPostStillExists = editingId !== null && posts.some((post) => post.id === editingId);
  return <section className="mb-[var(--space-6)] border-[length:var(--border-width-hair)] border-solid border-border bg-card" aria-label="Notice board">
    <button
      data-slot="notice-board-toggle"
      className={cn(
        "w-full flex items-center gap-[var(--space-4)] px-[var(--space-5)] py-[var(--space-4)] min-h-[44px] bg-transparent border-0 [border-left-style:solid] border-l-[length:var(--border-width-rule)] text-left text-foreground cursor-pointer transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:bg-secondary",
        hasUnread ? "border-l-border-strong" : "border-l-transparent",
        RING,
      )}
      type="button"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => setOpen((value) => !value)}
    >
      <span className="flex flex-col gap-[var(--space-1)] flex-1 min-w-0">
        <Eyebrow>Staff notice board</Eyebrow>
        <span className="[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">Messages for the production desk</span>
      </span>
      {hasUnread && (
        <>
          <span className="sr-only" data-slot="notice-board-unread-indicator">New notice</span>
          <span aria-hidden="true" className="w-[7px] h-[7px] flex-none rounded-[var(--radius-pill)] bg-primary" />
        </>
      )}
      <span className="[font:var(--weight-regular)_var(--text-xl)/1_var(--font-sans)] text-foreground-secondary" aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    <div id={panelId} className="border-t-[length:var(--border-width-hair)] [border-top-style:solid] border-t-border" aria-hidden={!open} hidden={!open}>
      {visibleError && <Notice tone="critical" role="alert">{visibleError}</Notice>}
      <div className="grid" aria-live="polite" ref={posts.length === 0 ? presentation.anchorRef : undefined}>
        {posts.length === 0 && <EmptyState title="No notices yet." className="px-[var(--space-5)] py-[var(--space-5)] text-left" />}
        {posts.map((post) => <article className="px-[var(--space-5)] py-[var(--space-4)] border-b-[length:var(--border-width-hair)] [border-bottom-style:solid] border-b-border" data-slot="notice-board-post" key={post.id} ref={post.id === posts[0]?.id ? presentation.anchorRef : undefined}>
          <header className="flex flex-wrap items-baseline gap-x-[var(--space-3)] gap-y-[var(--space-1)] min-w-0">
            <span className="[font:var(--type-eyebrow)] text-foreground min-w-0 [overflow-wrap:anywhere]">{post.authorName}</span>
            <time dateTime={post.createdAt} className={META_TEXT}>{relativeTime(post.createdAt)}</time>
            {post.editedAt && <span title={post.editedAt} className={META_TEXT}>edited</span>}
          </header>
          {editingId === post.id
            ? renderEditComposer(post.id)
            /* `mt-[var(--space-2)]` replaces the now-retired post-body top-margin rule that used to
               live in app.css. The article is not a grid, and the first rich-text child has no margin of its
               own, so without this the content renders flush against the header (Sol r2 #2).
               `RichTextContent` takes `className` and appends it to `rich-text` by plain string
               concatenation — no `cn()`, so no twMerge — which is fine here: `mt-` conflicts with nothing
               in `.rich-text`. */
            : <RichTextContent content={post.content} className="mt-[var(--space-2)]" />}
          {post.authorId === currentUserId && (
            <div className="flex justify-end gap-[var(--space-3)] mt-[var(--space-2)]">
              <button type="button" className={EDIT_ACTION} data-slot="notice-board-edit" onClick={() => { setEditingId(post.id); setEditingContent(post.content); }}>Edit</button>
              <button type="button" className={DELETE_ACTION} data-slot="notice-board-delete" onClick={() => void deletePost(post.id)}>Delete</button>
            </div>
          )}
        </article>)}
        {editingId && !editingPostStillExists && <article className="px-[var(--space-5)] py-[var(--space-4)] border-b-[length:var(--border-width-hair)] [border-bottom-style:solid] border-b-border bg-secondary" data-slot="notice-board-post">
          <Notice tone="caution" role="status">This notice was changed or deleted elsewhere. Your draft is still here.</Notice>
          {renderEditComposer(editingId)}
        </article>}
      </div>
      <form data-slot="notice-board-composer" className={CREATE_COMPOSER} onSubmit={(event) => void submit(event)}><label className="sr-only" htmlFor={`${panelId}-body`}>Write a notice</label><RichTextEditor id={`${panelId}-body`} value={content} onChange={setContent} limit={2_000} disabled={isBusy} loadMentionables={loadMentionables} placeholder="Write a notice for the team…" onSubmit={() => void submit()} /><div className={COMPOSER_FOOT}><span className={MENTION_HINT}>Use @ to mention active staff</span><button className={buttonClasses("primary")} type="submit" disabled={isBusy || postingOverBytes}>{isPosting ? "Posting…" : "Post notice"}</button></div></form>
    </div>
  </section>;
}
