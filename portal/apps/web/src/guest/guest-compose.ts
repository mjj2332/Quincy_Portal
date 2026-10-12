import { VIDEO_NOTE_BODY_MAX, videoNoteBody, type GuestNoteCreateInput, type GuestNoteEditInput, type GuestNoteThreadDto, type MarkupItem, type RichTextDoc } from "@quincy/shared";
import { marksToFrames, type NoteMarks } from "../lib/video-note-marks";
import { waitPhrase } from "./GuestVerifyDialog";
import type { DecisionResult, WriteResult } from "./guest-api";

/**
 * A note's plain text, what the server stores as its `body` (#835): a picture or video reads as a count hint, so a note that is only media is a note. Empty means there is nothing to post.
 * The same words are used wherever a draft is judged, so the composer, a reply and an edit agree.
 */
export const noteText = (doc: RichTextDoc): string => videoNoteBody(doc).trim();

/** Whether two documents are the same note. The editor re-serialises what it is given, so equality is by value. */
export const sameDoc = (a: RichTextDoc, b: RichTextDoc): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Everything a create sends, built from the composer's draft; or the one thing wrong with it, in words for the guest. The note travels as `content`, a rich document (images and videos, never a mention). */
export function composeInput({ doc, marks, frameCount, items, drawingFrame }: {
  doc: RichTextDoc; marks: NoteMarks; frameCount: number; items: readonly MarkupItem[]; drawingFrame: number | null;
}): { ok: true; input: GuestNoteCreateInput } | { ok: false; problem: string } {
  const text = noteText(doc);
  if (text === "") return { ok: false, problem: "Write a note first." };
  if (text.length > VIDEO_NOTE_BODY_MAX) return { ok: false, problem: "That note is too long." };
  const frames = marksToFrames(marks, frameCount);
  if (frames === null) return { ok: false, problem: "Mark the frame the note is about." };
  const input: GuestNoteCreateInput = { startFrame: frames.startFrame, ...(frames.endFrame === null ? {} : { endFrame: frames.endFrame }), content: doc };
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
  if (list.some((thread) => thread.id === next.id)) return list.map((thread) => (thread.id === next.id ? next : thread)).sort(before);
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
    // A dropped connection, a 5xx or an unreadable answer says nothing about whether the write landed: the page re-reads the notes, and the guest checks them before sending again.
    case "unreachable": return "Couldn't reach Quincy, so your change may or may not have been saved. The notes are being refreshed: check them before you try again.";
    case "rejected":
      if (result.error === "not_author") return "You can only change your own notes.";
      if (result.error === "frame_out_of_range" || result.error === "drawing_frame_outside") return "Those frames are outside this film.";
      if (result.error === "markup_too_large" || result.error === "payload_too_large" || result.error === "content_too_large") return "That note is too large to send. Try a shorter note or a simpler drawing.";
      return "That couldn't be saved. Check it and try again.";
  }
}

/** What an edit started from, so only what the guest really changed is sent. `hadDrawing` is whether the note carried a drawing when the edit opened. */
export type EditBaseline = { doc: RichTextDoc; startFrame: number; endFrame: number | null; hadDrawing: boolean };
export type EditPatch = Omit<GuestNoteEditInput, "expectedRevision">;

/**
 * The fields of a PATCH built from an edit draft; `patch` is null when nothing differs from the baseline. The server refuses frames together with a drawing change (`markup_and_frames`),
 * and refuses frames on a note that has a drawing (`markup_locks_frames`); the composer prevents both, and this is the second line, in words, rather than a 422 the guest cannot read.
 */
export function editPatch({ doc, marks, frameCount, items, drawingFrame, drawingRemoved, baseline }: {
  doc: RichTextDoc; marks: NoteMarks; frameCount: number; items: readonly MarkupItem[]; drawingFrame: number | null; drawingRemoved: boolean; baseline: EditBaseline;
}): { ok: true; patch: EditPatch | null } | { ok: false; problem: string } {
  const text = noteText(doc);
  if (text === "") return { ok: false, problem: "A note can't be empty." };
  if (text.length > VIDEO_NOTE_BODY_MAX) return { ok: false, problem: "That note is too long." };
  const frames = marksToFrames(marks, frameCount);
  if (frames === null) return { ok: false, problem: "Mark the frame the note is about." };
  const patch: EditPatch = {};
  if (!sameDoc(doc, baseline.doc)) patch.content = doc;
  const framesChanged = frames.startFrame !== baseline.startFrame || frames.endFrame !== baseline.endFrame;
  const drawingChanged = items.length > 0 || (drawingRemoved && baseline.hadDrawing);
  if (framesChanged && drawingChanged) return { ok: false, problem: "Save the new frames first, then change the drawing (or the other way round)." };
  if (framesChanged && baseline.hadDrawing) return { ok: false, problem: "The frames can't change while the note has a drawing. Remove the drawing and save, then change the frames." };
  if (framesChanged) { patch.startFrame = frames.startFrame; patch.endFrame = frames.endFrame; }
  if (items.length > 0) {
    if (drawingFrame === null) return { ok: false, problem: "Draw again to attach the drawing to a frame." };
    const fits = frames.endFrame === null ? drawingFrame === frames.startFrame : drawingFrame >= frames.startFrame && drawingFrame < frames.endFrame;
    if (!fits) return { ok: false, problem: "Your drawing is on a frame outside the note's marks. Move the marks to cover it, or draw again." };
    patch.markup = [...items] as NonNullable<EditPatch["markup"]>;
    patch.drawingFrame = drawingFrame;
  } else if (drawingRemoved && baseline.hadDrawing) patch.markup = null;
  return { ok: true, patch: Object.keys(patch).length === 0 ? null : patch };
}

/** What to tell the guest about a decision that did not land. Null for a success and for the refusals that change the page instead of saying something in the dialog (unverified, archived, gone, disabled). */
export function decisionFailureText(result: DecisionResult): string | null {
  switch (result.kind) {
    case "ok": case "unverified": case "archived": case "gone": case "disabled": return null;
    case "conflict": return "Another decision was recorded at the same moment. Try again.";
    case "limited": return `You're sending decisions too quickly. Try again in ${waitPhrase(result.retryAfterSeconds)}.`;
    // A dropped connection, a 5xx or an unreadable answer says nothing about whether the decision landed: the page re-reads the videos, and the guest checks before sending again.
    case "unreachable": return "Couldn't reach Quincy, so your decision may or may not have been recorded. The page is being refreshed: check it before you try again.";
    case "rejected": return result.error === "payload_too_large" ? "That note is too long." : "That couldn't be sent. Check your note and try again.";
  }
}
