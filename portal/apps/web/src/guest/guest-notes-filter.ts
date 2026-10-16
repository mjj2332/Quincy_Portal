import type { GuestNoteDto, GuestNoteThreadDto } from "@quincy/shared";

/**
 * The guest's phone notes filter (#879 PR 3b, P2 `NotesFilter`): status, root author and search over the threads the link already shows. Pure, and guest-only: it reads the guest DTO and
 * nothing of the staff notes model (`lib/video-note-view.ts`), whose author keys need ids a guest never receives. A guest author is keyed by kind and name, so two guests who share a
 * name are one choice and the studio is never a guest.
 *
 * A deleted root with no replies is never listed (the staff list's rule); one with replies stays, as "Note deleted" with them. A pinned root (an edit or a reply open on it) is listed
 * whatever the filters say, so a form is never hidden under the person typing in it. Counts and markers follow the filters alone.
 */
export type GuestNoteStatus = "open" | "resolved" | "all";
export type GuestNoteFilters = Readonly<{ status: GuestNoteStatus; author: string | null; query: string | null }>;

/** A phone guest starts on the open notes (owner decision, 2026-10-16); the desktop list is not filtered at all. */
export const GUEST_PHONE_FILTERS: GuestNoteFilters = { status: "open", author: null, query: null };

export const guestAuthorKey = (author: GuestNoteDto["author"]): string => `${author.kind}:${author.name}`;

const hiddenTombstone = (thread: GuestNoteThreadDto) => thread.deleted && thread.replies.length === 0;
const matchesStatus = (thread: GuestNoteThreadDto, status: GuestNoteStatus) => status === "all" || (status === "resolved") === thread.resolved;
const matchesAuthor = (thread: GuestNoteThreadDto, author: string | null) => author === null || guestAuthorKey(thread.author) === author;
function matchesQuery(thread: GuestNoteThreadDto, query: string | null): boolean {
  const needle = query?.trim().toLocaleLowerCase() ?? "";
  if (needle === "") return true;
  return [thread, ...thread.replies].some((note) => !note.deleted && (note.body.toLocaleLowerCase().includes(needle) || note.author.name.toLocaleLowerCase().includes(needle)));
}

/** The "Everyone ⌄" choices: each live root's author once, by name. */
export function guestNoteAuthors(threads: readonly GuestNoteThreadDto[]): Array<{ key: string; name: string }> {
  const byKey = new Map<string, string>();
  for (const thread of threads) if (!thread.deleted) byKey.set(guestAuthorKey(thread.author), thread.author.name);
  return [...byKey].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** The roots the filters show, plus any pinned root, in the server's order. */
export function guestVisibleThreads(threads: readonly GuestNoteThreadDto[], filters: GuestNoteFilters, pinned: ReadonlySet<string>): GuestNoteThreadDto[] {
  return threads.filter((thread) => !hiddenTombstone(thread) && (pinned.has(thread.id) || (matchesStatus(thread, filters.status) && matchesAuthor(thread, filters.author) && matchesQuery(thread, filters.query))));
}

/** Each status's count under the author and the search: what choosing it would show. */
export function guestNoteCounts(threads: readonly GuestNoteThreadDto[], filters: GuestNoteFilters): Record<GuestNoteStatus, number> {
  const narrowed = threads.filter((thread) => !hiddenTombstone(thread) && matchesAuthor(thread, filters.author) && matchesQuery(thread, filters.query));
  const resolved = narrowed.filter((thread) => thread.resolved).length;
  return { open: narrowed.length - resolved, resolved, all: narrowed.length };
}
