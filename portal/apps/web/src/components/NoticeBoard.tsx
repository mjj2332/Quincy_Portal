import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { RICH_TEXT_JSON_MAX_BYTES, richTextDocByteLength, type RichTextDoc } from "@quincy/shared";
import { apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";
import { RichTextContent } from "./RichTextContent";
import { RichTextEditor } from "./RichTextEditor";
import type { MentionableUser } from "./MentionAutocomplete";

const COLLAPSE_KEY = "quincy:dashboard:noticeboard:v2";
const SEEN_KEY_PREFIX = "quincy:dashboard:noticeboard:seen:";
const COLLAPSED_POLL_MS = 60_000;
const EXPANDED_POLL_MS = 25_000;
const EMPTY_DOC: RichTextDoc = { type: "doc", content: [{ type: "paragraph" }] };

export type NoticeBoardPost = { id: string; authorId: string; authorName: string; body: string; content: RichTextDoc; createdAt: string; editedAt: string | null };
type PostsResponse = { posts: NoticeBoardPost[] };
type LatestResponse = { id: string | null; createdAt: string | null };

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
  const panelId = useId(); const seenStorageKey = `${SEEN_KEY_PREFIX}${currentUserId}`;
  const [open, setOpen] = useState(readOpen); const lastPersisted = useRef(open);
  const [seenId, setSeenId] = useState<string | null>(() => readStorage(seenStorageKey)); const [latestId, setLatestId] = useState<string | null>(null);
  const [posts, setPosts] = useState<NoticeBoardPost[]>([]); const [content, setContent] = useState<RichTextDoc>(EMPTY_DOC);
  const [editingId, setEditingId] = useState<string | null>(null); const [editingContent, setEditingContent] = useState<RichTextDoc>(EMPTY_DOC);
  const [isPosting, setIsPosting] = useState(false); const [isSaving, setIsSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  const loadMentionables = useCallback(async (query: string): Promise<MentionableUser[]> => {
    const result = await apiGet<{ users: MentionableUser[] }>(`/api/mentionable-users?scope=notice-board&q=${encodeURIComponent(query)}`);
    return result.users;
  }, []);
  const postingOverBytes = richTextDocByteLength(content) > RICH_TEXT_JSON_MAX_BYTES;
  const editingOverBytes = richTextDocByteLength(editingContent) > RICH_TEXT_JSON_MAX_BYTES;

  useEffect(() => { setSeenId(readStorage(seenStorageKey)); }, [seenStorageKey]);
  useEffect(() => { if (lastPersisted.current === open) return; lastPersisted.current = open; try { window.localStorage.setItem(COLLAPSE_KEY, String(open)); } catch { /* Storage can be disabled. */ } }, [open]);
  function markSeen(id: string | null) { setSeenId(id); try { if (id === null) window.localStorage.removeItem(seenStorageKey); else window.localStorage.setItem(seenStorageKey, id); } catch { /* Storage can be disabled. */ } }
  useEffect(() => {
    let active = true;
    const loadLatest = async () => { try { const response = await apiGet<LatestResponse>("/api/notice-board/posts/latest"); if (active) { setLatestId(response.id); setError(null); } } catch { if (active) setError("Notice board is unavailable."); } };
    const loadPosts = async () => { try { const response = await apiGet<PostsResponse>("/api/notice-board/posts?limit=50"); if (!active) return; setPosts(response.posts); const newestId = response.posts[0]?.id ?? null; setLatestId(newestId); markSeen(newestId); setError(null); } catch { if (active) setError("Notice board is unavailable."); } };
    if (open) { void loadPosts(); const timer = window.setInterval(() => void loadPosts(), EXPANDED_POLL_MS); return () => { active = false; window.clearInterval(timer); }; }
    void loadLatest(); const timer = window.setInterval(() => void loadLatest(), COLLAPSED_POLL_MS); return () => { active = false; window.clearInterval(timer); };
  }, [open, seenStorageKey]);

  async function submit(event?: FormEvent) {
    event?.preventDefault(); if (isPosting || postingOverBytes) return; setIsPosting(true);
    try { const post = await apiPost<NoticeBoardPost, { content: RichTextDoc }>("/api/notice-board/posts", { content }); setPosts((current) => [post, ...current]); setLatestId(post.id); markSeen(post.id); setContent(EMPTY_DOC); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The post could not be published."); }
    finally { setIsPosting(false); }
  }
  async function saveEdit(id: string) {
    if (isSaving || editingOverBytes) return; setIsSaving(true);
    try { const post = await apiPatch<NoticeBoardPost, { content: RichTextDoc }>(`/api/notice-board/posts/${encodeURIComponent(id)}`, { content: editingContent }); setPosts((current) => current.map((currentPost) => currentPost.id === id ? post : currentPost)); setEditingId(null); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The post could not be updated."); }
    finally { setIsSaving(false); }
  }
  async function deletePost(id: string) { try { await apiDelete<{ ok: true }>(`/api/notice-board/posts/${encodeURIComponent(id)}`); setPosts((current) => current.filter((post) => post.id !== id)); } catch (reason) { setError(reason instanceof Error ? reason.message : "The post could not be deleted."); } }

  const hasUnread = latestId !== null && latestId !== seenId;
  return <section className="notice-board" aria-label="Notice board">
    <button className="notice-board__toggle" type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}><span><span className="ey">Staff notice board</span><span className="notice-board__summary">Messages for the production desk</span></span>{hasUnread && <span className="notice-board__badge" aria-label="New notice" />}<span className="notice-board__chevron" aria-hidden="true">{open ? "−" : "+"}</span></button>
    <div id={panelId} className={`notice-board__panel${open ? "" : " is-collapsed"}`} aria-hidden={!open}>
      {error && <div className="notice-board__error" role="alert">{error}</div>}
      <div className="notice-board__posts" aria-live="polite">
        {posts.length === 0 && <p className="notice-board__empty">No notices yet.</p>}
        {posts.map((post) => <article className="notice-board__post" key={post.id}>
          <div className="notice-board__post-head"><span className="notice-board__author">{post.authorName}</span><time dateTime={post.createdAt}>{relativeTime(post.createdAt)}</time>{post.editedAt && <span className="notice-board__edited" title={post.editedAt}>edited</span>}{post.authorId === currentUserId && <><button className="notice-board__edit" type="button" onClick={() => { setEditingId(post.id); setEditingContent(post.content); }}>Edit</button><button className="notice-board__delete" type="button" onClick={() => void deletePost(post.id)}>Delete</button></>}</div>
          {editingId === post.id ? <div className="notice-board__composer notice-board__edit-composer"><RichTextEditor value={editingContent} onChange={setEditingContent} limit={2_000} disabled={isSaving} loadMentionables={loadMentionables} placeholder="Edit notice…" onSubmit={() => void saveEdit(post.id)} /><div className="notice-board__composer-foot"><button className="button button--secondary" type="button" disabled={isSaving} onClick={() => setEditingId(null)}>Cancel</button><button className="button" type="button" disabled={isSaving || editingOverBytes} onClick={() => void saveEdit(post.id)}>{isSaving ? "Saving…" : "Save"}</button></div></div> : <RichTextContent content={post.content} />}
        </article>)}
      </div>
      <form className="notice-board__composer" onSubmit={(event) => void submit(event)}><label className="sr-only" htmlFor={`${panelId}-body`}>Write a notice</label><RichTextEditor id={`${panelId}-body`} value={content} onChange={setContent} limit={2_000} disabled={isPosting} loadMentionables={loadMentionables} placeholder="Write a notice for the team…" onSubmit={() => void submit()} /><div className="notice-board__composer-foot"><span>Use @ to mention active staff</span><button className="button" type="submit" disabled={isPosting || postingOverBytes}>{isPosting ? "Posting…" : "Post notice"}</button></div></form>
    </div>
  </section>;
}
