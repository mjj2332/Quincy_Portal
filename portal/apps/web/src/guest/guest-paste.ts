import { type GuestNotePasteSkipReason, type GuestNoteThreadDto, type GuestVideoDto } from "@quincy/shared";
import { waitPhrase } from "./GuestVerifyDialog";
import type { PasteResult } from "./guest-api";

type GrantedVersion = GuestVideoDto["versions"][number];

/** Why a note is not in the list to copy, in the words a guest would use. (The staff dialog has its own copy of these, in a file the guest page may not import.) */
export const PASTE_SKIP_COPY: Record<GuestNotePasteSkipReason, string> = {
  already_copied: "Already copied to this version",
  out_of_range: "Falls outside this version",
  drawing_outside: "Drawing would fall outside the note",
  deleted: "Deleted on the source version",
  reply: "Replies are not copied on their own",
  not_author: "Only your own notes can be copied",
};

/** The Version the notes are most likely wanted from: the one just before the target, else the newest other. `versions` is newest first, as the server sends it. Null when there is no other. */
export function defaultSource(versions: readonly GrantedVersion[], target: GrantedVersion): GrantedVersion | null {
  const others = versions.filter((candidate) => candidate.assetId !== target.assetId);
  return others.find((candidate) => candidate.version < target.version) ?? others[0] ?? null;
}

/** An own note of the source Version, as the list shows it before any plan exists. */
export type PastableNote = { id: string; excerpt: string; startFrame: number; endFrame: number | null };

/**
 * The notes of the source Version that the guest may ask to copy: their own ROOT notes that are not deleted (a reply is copied with nothing, and a tombstone has nothing to copy). With the
 * `markup` part off the server answers the stub for a request that names a drawn note, so those are counted and left out here instead of sending the guest to the unavailable page. Every
 * such note is returned, however many: one request carries at most `GUEST_NOTE_PASTE_MAX`, so the dialog lets the guest choose which (and never drops one silently).
 */
export function pastableNotes(threads: readonly GuestNoteThreadDto[], markupAllowed: boolean): { ids: string[]; items: PastableNote[]; drawn: number } {
  const own = threads.filter((thread) => thread.parentId === null && !thread.deleted && thread.author.kind === "guest" && thread.author.self);
  const drawn = markupAllowed ? 0 : own.filter((thread) => thread.hasMarkup).length;
  const usable = own.filter((thread) => markupAllowed || !thread.hasMarkup);
  return { ids: usable.map((thread) => thread.id), items: usable.map((thread) => ({ id: thread.id, excerpt: thread.body, startFrame: thread.startFrame ?? 0, endFrame: thread.endFrame })), drawn };
}

/** What to tell the guest about a preview or commit that did not go through. Null for the answers the page handles itself (success, verification, the link going away, the archive). */
export function pasteFailureText(result: PasteResult<unknown>, phase: "preview" | "commit"): string | null {
  switch (result.kind) {
    case "limited": return `You're pasting too quickly. Try again in ${waitPhrase(result.retryAfterSeconds)}.`;
    case "unreachable": return phase === "commit" ? "Couldn't reach Quincy. Check your connection and try again. Pasting again never makes a second copy." : "Couldn't reach Quincy. Check your connection and try again.";
    case "rejected": return "Those notes can't be pasted between these two versions.";
    default: return null;
  }
}
