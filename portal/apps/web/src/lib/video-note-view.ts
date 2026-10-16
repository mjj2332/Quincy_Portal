import type { VideoNoteDto, VideoNoteThreadDto } from "@quincy/shared";

export type NoteStatusFilter = "open" | "resolved" | "all";
export type NoteVisibilityFilter = "all" | "public" | "internal";
/**
 * `author` is a root author's key (`authorKey`), null for Everyone; `query` is the search text, null while search is closed (#879 PR 3b). Both are the phone notes head's:
 * the desktop panel always holds null / null.
 */
export type NoteFilters = Readonly<{ status: NoteStatusFilter; visibility: NoteVisibilityFilter; author: string | null; query: string | null }>;

export const DEFAULT_NOTE_FILTERS: NoteFilters = { status: "open", visibility: "all", author: null, query: null };

/** A note author's stable key: the kind and the id (a staff person's, a guest's), so two people with one name stay apart. */
export function authorKey(author: VideoNoteDto["author"]): string {
  return author.kind === "staff" ? `staff:${author.person.id}` : `guest:${author.id}`;
}
const authorName = (author: VideoNoteDto["author"]) => (author.kind === "staff" ? author.person.name : author.name);

/** The "Everyone ⌄" options: the authors of live roots (a deleted root, a reply-only author are not offered), once each, by name. */
export function noteAuthors(threads: readonly VideoNoteThreadDto[]): Array<{ key: string; name: string }> {
  const byKey = new Map<string, string>();
  for (const thread of threads) if (!thread.deleted) byKey.set(authorKey(thread.author), authorName(thread.author));
  return [...byKey].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/**
 * Search (#879 PR 3b): the trimmed text, case-insensitive and literal, against the root's body, its live replies' bodies and their authors' names. A deleted note contributes
 * nothing. An empty or closed search matches everything.
 */
export function matchesQuery(thread: VideoNoteThreadDto, query: string | null): boolean {
  const needle = query?.trim().toLocaleLowerCase() ?? "";
  if (needle === "") return true;
  return [thread, ...thread.replies].some((note) => !note.deleted && (note.body.toLocaleLowerCase().includes(needle) || authorName(note.author).toLocaleLowerCase().includes(needle)));
}

/** A deleted root nobody replied to reads as nothing: hidden from the list, the markers and the counts (4d5a §B "DTO rules"). */
export function isHiddenTombstone(thread: VideoNoteThreadDto): boolean {
  return thread.deleted && thread.replies.length === 0;
}

const matchesStatus = (thread: VideoNoteThreadDto, status: NoteStatusFilter) => status === "all" || (status === "resolved") === (thread.resolved !== null);
const matchesVisibility = (thread: VideoNoteThreadDto, visibility: NoteVisibilityFilter) => visibility === "all" || thread.visibility === visibility;
const matchesAuthor = (thread: VideoNoteThreadDto, author: string | null) => author === null || authorKey(thread.author) === author;

/** Roots that pass every filter. Replies stay attached to their root. */
export function visibleThreads(threads: readonly VideoNoteThreadDto[], filters: NoteFilters): VideoNoteThreadDto[] {
  return threads.filter((thread) => !isHiddenTombstone(thread) && matchesStatus(thread, filters.status) && matchesVisibility(thread, filters.visibility) && matchesAuthor(thread, filters.author) && matchesQuery(thread, filters.query));
}

/**
 * Counts of roots. Each of status and visibility is counted under the other three filters (so a choice's number is what choosing it would show);
 * `totals` ignore every filter (the header's "5 open · 2 resolved", the Notes tab's count).
 */
export function noteCounts(threads: readonly VideoNoteThreadDto[], filters: NoteFilters) {
  const live = threads.filter((thread) => !isHiddenTombstone(thread));
  const narrowed = live.filter((thread) => matchesAuthor(thread, filters.author) && matchesQuery(thread, filters.query));
  const underVisibility = narrowed.filter((thread) => matchesVisibility(thread, filters.visibility));
  const underStatus = narrowed.filter((thread) => matchesStatus(thread, filters.status));
  const open = (list: VideoNoteThreadDto[]) => list.filter((thread) => thread.resolved === null).length;
  return {
    status: { open: open(underVisibility), resolved: underVisibility.length - open(underVisibility), all: underVisibility.length },
    visibility: { all: underStatus.length, public: underStatus.filter((thread) => thread.visibility === "public").length, internal: underStatus.filter((thread) => thread.visibility === "internal").length },
    totals: { open: open(live), resolved: live.length - open(live) },
  };
}

/** Author-only: a guest note is never the signed-in person's. (Impersonation needs no code here: the session user is the impersonated user.) */
export function isOwnNote(note: Pick<VideoNoteDto, "author">, userId: string | null): boolean {
  return userId !== null && note.author.kind === "staff" && note.author.person.id === userId;
}

/** `01:00:42:13` for a point, `01:00:20:00 → 01:00:26:10` for a range, where the right side is the last included frame (`endFrame - 1`). */
export function noteAnchorLabel(note: Pick<VideoNoteDto, "startFrame" | "endFrame">, timecode: (frame: number) => string): string {
  if (note.startFrame === null) return "";
  return note.endFrame === null ? timecode(note.startFrame) : `${timecode(note.startFrame)} → ${timecode(note.endFrame - 1)}`;
}

const byReply = (a: VideoNoteDto, b: VideoNoteDto) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
const byRoot = (a: VideoNoteThreadDto, b: VideoNoteThreadDto) => (a.startFrame ?? 0) - (b.startFrame ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** Replaces (by root id) or inserts a thread, keeping 5a's order: roots by `startFrame, createdAt, id`; replies by `createdAt, id`. */
export function upsertThread(list: readonly VideoNoteThreadDto[], thread: VideoNoteThreadDto): VideoNoteThreadDto[] {
  const next = { ...thread, replies: [...thread.replies].sort(byReply) };
  return [...list.filter((existing) => existing.id !== thread.id), next].sort(byRoot);
}

export function removeThread(list: readonly VideoNoteThreadDto[], rootId: string): VideoNoteThreadDto[] {
  return list.filter((thread) => thread.id !== rootId);
}
