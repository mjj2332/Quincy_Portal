import { VIDEO_NOTE_BODY_MAX, type GuestNoteCreateInput, type GuestNoteThreadDto, type MarkupItem } from "@quincy/shared";
import { marksToFrames, type NoteMarks } from "../lib/video-note-marks";
import { waitPhrase } from "./GuestVerifyDialog";
import type { WriteResult } from "./guest-api";

/** Everything a create sends, built from the composer's draft; or the one thing wrong with it, in words for the guest. */
export function composeInput({ body, marks, frameCount, items, drawingFrame }: {
  body: string; marks: NoteMarks; frameCount: number; items: readonly MarkupItem[]; drawingFrame: number | null;
}): { ok: true; input: GuestNoteCreateInput } | { ok: false; problem: string } {
  const text = body.trim();
  if (text === "") return { ok: false, problem: "Write a note first." };
  if (text.length > VIDEO_NOTE_BODY_MAX) return { ok: false, problem: "That note is too long." };
  const frames = marksToFrames(marks, frameCount);
  if (frames === null) return { ok: false, problem: "Mark the frame the note is about." };
  const input: GuestNoteCreateInput = { startFrame: frames.startFrame, ...(frames.endFrame === null ? {} : { endFrame: frames.endFrame }), body: text };
  if (items.length === 0 || drawingFrame === null) return { ok: true, input };
  // The server's rule: a point note's drawing is on its frame, a range note's anywhere in [start, end).
  const fits = frames.endFrame === null ? drawingFrame === frames.startFrame : drawingFrame >= frames.startFrame && drawingFrame < frames.endFrame;
  if (!fits) return { ok: false, problem: "Your drawing is on a frame outside the note's marks. Move the marks to cover it, or draw again." };
  return { ok: true, input: { ...input, markup: [...items] as GuestNoteCreateInput["markup"], drawingFrame } };
}

/** The server's list order: roots by start frame, then created, then id. */
const before = (a: GuestNoteThreadDto, b: GuestNoteThreadDto): number =>
  (a.startFrame ?? -1) - (b.startFrame ?? -1) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function upsertThread(list: readonly GuestNoteThreadDto[], next: GuestNoteThreadDto): GuestNoteThreadDto[] {
  if (list.some((thread) => thread.id === next.id)) return list.map((thread) => (thread.id === next.id ? next : thread));
  return [...list, next].sort(before);
}
export const removeThread = (list: readonly GuestNoteThreadDto[], id: string): GuestNoteThreadDto[] => list.filter((thread) => thread.id !== id);

/** What to tell the guest about a write that did not land (or, for a conflict, did not apply as written). Null for a success. */
export function failureText(result: WriteResult): string | null {
  switch (result.kind) {
    case "ok": return null;
    case "conflict": return "This note changed since you opened it. The latest version is shown. Check it, then save again.";
    case "deleted": return "This note was deleted.";
    case "unverified": return "Verify your email again to keep going.";
    case "archived": return "This project was archived, so notes are read-only.";
    case "gone": return "This link isn't available.";
    case "limited": return `You're adding notes too quickly. Try again in ${waitPhrase(result.retryAfterSeconds)}.`;
    case "unreachable": return "Couldn't reach Quincy. Nothing was changed. Try again.";
    case "rejected":
      if (result.error === "not_author") return "You can only change your own notes.";
      if (result.error === "frame_out_of_range" || result.error === "drawing_frame_outside") return "Those frames are outside this film.";
      if (result.error === "markup_too_large" || result.error === "payload_too_large") return "That note is too large to send. Try a shorter note or a simpler drawing.";
      return "That couldn't be saved. Check it and try again.";
  }
}
