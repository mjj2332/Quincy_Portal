import type { VideoNoteDto, VideoNoteThreadDto } from "@quincy/shared";

export type NoteStatusFilter = "open" | "resolved" | "all";
export type NoteVisibilityFilter = "all" | "public" | "internal";
export type NoteFilters = Readonly<{ status: NoteStatusFilter; visibility: NoteVisibilityFilter }>;

export const DEFAULT_NOTE_FILTERS: NoteFilters = { status: "open", visibility: "all" };

/** A deleted root nobody replied to reads as nothing: hidden from the list, the markers and the counts (4d5a §B "DTO rules"). */
export function isHiddenTombstone(thread: VideoNoteThreadDto): boolean {
  return thread.deleted && thread.replies.length === 0;
}

const matchesStatus = (thread: VideoNoteThreadDto, status: NoteStatusFilter) => status === "all" || (status === "resolved") === (thread.resolved !== null);
const matchesVisibility = (thread: VideoNoteThreadDto, visibility: NoteVisibilityFilter) => visibility === "all" || thread.visibility === visibility;

/** Roots that pass both filters. Replies stay attached to their root. */
export function visibleThreads(threads: readonly VideoNoteThreadDto[], filters: NoteFilters): VideoNoteThreadDto[] {
  return threads.filter((thread) => !isHiddenTombstone(thread) && matchesStatus(thread, filters.status) && matchesVisibility(thread, filters.visibility));
}

/**
 * Counts of roots. Each axis is counted under the OTHER axis's filter (so a button's number is what choosing it would show);
 * `totals` ignore both filters (the header's "5 open · 2 resolved").
 */
export function noteCounts(threads: readonly VideoNoteThreadDto[], filters: NoteFilters) {
  const live = threads.filter((thread) => !isHiddenTombstone(thread));
  const underVisibility = live.filter((thread) => matchesVisibility(thread, filters.visibility));
  const underStatus = live.filter((thread) => matchesStatus(thread, filters.status));
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
