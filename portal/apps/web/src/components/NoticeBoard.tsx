import { useEffect, useId, useState, type FormEvent } from "react";
import { apiDelete, apiGet, apiPost } from "../lib/api";

const COLLAPSE_KEY = "quincy:dashboard:noticeboard";
const SEEN_KEY_PREFIX = "quincy:dashboard:noticeboard:seen:";
const COLLAPSED_POLL_MS = 60_000;
const EXPANDED_POLL_MS = 25_000;

export type NoticeBoardPost = {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
};

type PostsResponse = { posts: NoticeBoardPost[] };
type LatestResponse = { id: string | null; createdAt: string | null };

function readStorage(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function readOpen(): boolean { return readStorage(COLLAPSE_KEY) === "true"; }

function relativeTime(value: string): string {
  const timestamp = new Date(value).valueOf();
  if (!Number.isFinite(timestamp)) return "Unknown time";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400], ["hour", 3_600], ["minute", 60], ["second", 1],
  ];
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, amount] of units) {
    if (Math.abs(seconds) >= amount || unit === "second") return formatter.format(Math.round(seconds / amount), unit);
  }
  return "just now";
}

export function NoticeBoard({ currentUserId }: { currentUserId: string }) {
  const panelId = useId();
  const seenStorageKey = `${SEEN_KEY_PREFIX}${currentUserId}`;
  const [open, setOpen] = useState(readOpen);
  const [seenId, setSeenId] = useState<string | null>(() => readStorage(seenStorageKey));
  const [latestId, setLatestId] = useState<string | null>(null);
  const [posts, setPosts] = useState<NoticeBoardPost[]>([]);
  const [body, setBody] = useState("");
  const [isPosting, setIsPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setSeenId(readStorage(seenStorageKey)); }, [seenStorageKey]);

  useEffect(() => {
    try { window.localStorage.setItem(COLLAPSE_KEY, String(open)); } catch { /* Storage can be disabled. */ }
  }, [open]);

  function markSeen(id: string | null) {
    setSeenId(id);
    try {
      if (id === null) window.localStorage.removeItem(seenStorageKey);
      else window.localStorage.setItem(seenStorageKey, id);
    } catch { /* Storage can be disabled. */ }
  }

  useEffect(() => {
    let active = true;
    const loadLatest = async () => {
      try {
        const response = await apiGet<LatestResponse>("/api/notice-board/posts/latest");
        if (active) { setLatestId(response.id); setError(null); }
      } catch {
        if (active) setError("Notice board is unavailable.");
      }
    };
    const loadPosts = async () => {
      try {
        const response = await apiGet<PostsResponse>("/api/notice-board/posts?limit=50");
        if (!active) return;
        setPosts(response.posts);
        const newestId = response.posts[0]?.id ?? null;
        setLatestId(newestId);
        markSeen(newestId);
        setError(null);
      } catch {
        if (active) setError("Notice board is unavailable.");
      }
    };

    if (open) {
      void loadPosts();
      const timer = window.setInterval(() => void loadPosts(), EXPANDED_POLL_MS);
      return () => { active = false; window.clearInterval(timer); };
    }

    void loadLatest();
    const timer = window.setInterval(() => void loadLatest(), COLLAPSED_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [open, seenStorageKey]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || isPosting) return;
    setIsPosting(true);
    try {
      const post = await apiPost<NoticeBoardPost, { body: string }>("/api/notice-board/posts", { body: trimmed });
      setPosts((current) => [post, ...current]);
      setLatestId(post.id);
      markSeen(post.id);
      setBody("");
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The post could not be published.");
    } finally {
      setIsPosting(false);
    }
  }

  async function deletePost(id: string) {
    try {
      await apiDelete<{ ok: true }>(`/api/notice-board/posts/${encodeURIComponent(id)}`);
      setPosts((current) => current.filter((post) => post.id !== id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The post could not be deleted.");
    }
  }

  const hasUnread = latestId !== null && latestId !== seenId;
  return <section className="notice-board" aria-label="Notice board">
    <button className="notice-board__toggle" type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
      <span><span className="ey">Staff notice board</span><span className="notice-board__summary">Messages for the production desk</span></span>
      {hasUnread && <span className="notice-board__badge" aria-label="New notice" />}
      <span className="notice-board__chevron" aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    <div id={panelId} className={`notice-board__panel${open ? "" : " is-collapsed"}`} aria-hidden={!open}>
      {error && <div className="notice-board__error" role="alert">{error}</div>}
      <div className="notice-board__posts" aria-live="polite">
        {posts.length === 0 && <p className="notice-board__empty">No notices yet.</p>}
        {posts.map((post) => <article className="notice-board__post" key={post.id}>
          <div className="notice-board__post-head">
            <span className="notice-board__author">{post.authorName}</span>
            <time dateTime={post.createdAt}>{relativeTime(post.createdAt)}</time>
            {post.authorId === currentUserId && <button className="notice-board__delete" type="button" onClick={() => void deletePost(post.id)}>Delete</button>}
          </div>
          <p>{post.body}</p>
        </article>)}
      </div>
      <form className="notice-board__composer" onSubmit={(event) => void submit(event)}>
        <label className="sr-only" htmlFor={`${panelId}-body`}>Write a notice</label>
        <textarea id={`${panelId}-body`} value={body} maxLength={2000} onChange={(event) => setBody(event.target.value)} placeholder="Write a notice for the team…" rows={3} />
        <div className="notice-board__composer-foot"><span>{body.length}/2000</span><button className="button" type="submit" disabled={isPosting || !body.trim()}>{isPosting ? "Posting…" : "Post notice"}</button></div>
      </form>
    </div>
  </section>;
}
