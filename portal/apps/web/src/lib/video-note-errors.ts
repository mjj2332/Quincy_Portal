import { videoNotePastePreviewResponseSchema, videoNoteThreadDtoSchema, type VideoNotePastePreviewResponse, type VideoNoteThreadDto } from "@quincy/shared";
import { ApiError } from "./api";

/** Which 5a refusal an error is (#741 5b). Kept apart from the data layer so the form store, which the collection loads eagerly, need not import the query code. */
export type VideoNoteErrorKind = "archived" | "conflict" | "deleted" | "gone" | "access" | "range" | "network" | "stale" | "markup" | "other";
/** The refusals only a drawing can earn (#741 6b): 413 `markup_too_large`, and the 422s of the markup rules. */
export type VideoMarkupErrorCode = "markup_too_large" | "markup_and_frames" | "markup_on_reply" | "drawing_frame_required" | "drawing_frame_outside" | "markup_locks_frames";
const MARKUP_CODES: readonly string[] = ["markup_too_large", "markup_and_frames", "markup_on_reply", "drawing_frame_required", "drawing_frame_outside", "markup_locks_frames"] satisfies VideoMarkupErrorCode[];

/** What each drawing refusal says to a person. */
export const MARKUP_ERROR_TEXT: Record<VideoMarkupErrorCode, string> = {
  markup_too_large: "That drawing is too large to save. Undo some of it and try again.",
  markup_and_frames: "A note's frames and its drawing can't change in one save. Save one, then the other.",
  markup_on_reply: "Only a note can carry a drawing, not a reply.",
  drawing_frame_required: "The drawing has no frame. Press Draw again to pick one.",
  drawing_frame_outside: "The drawing has to be on a frame the note covers. Draw again inside its frames.",
  markup_locks_frames: "A note with a drawing can't be moved. Remove the drawing first.",
};
/** `stale` is a paste commit whose source notes changed since the preview: `preview` is the server's current plan. */
export type ClassifiedVideoNoteError = { kind: VideoNoteErrorKind; thread?: VideoNoteThreadDto; frameCount?: number; preview?: VideoNotePastePreviewResponse; markupCode?: VideoMarkupErrorCode };

const detailsOf = (error: ApiError): Record<string, unknown> => (error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {});

/** Which of the 5a refusals this is. A transport failure (status 0) is `network`: the request may have been applied, so nothing retries it. */
export function classifyVideoNoteError(error: unknown): ClassifiedVideoNoteError {
  if (!(error instanceof ApiError)) return { kind: "other" };
  const details = detailsOf(error);
  if (error.status === 0) return { kind: "network" };
  if (error.status === 409 && details.code === "project_archived") return { kind: "archived" };
  if (error.status === 409 && details.code === "note_deleted") return { kind: "deleted" };
  if (error.status === 409 && details.code === "note_conflict") {
    const parsed = videoNoteThreadDtoSchema.safeParse(details.thread);
    return parsed.success ? { kind: "conflict", thread: parsed.data } : { kind: "other" };
  }
  if (error.status === 409 && details.code === "paste_stale") {
    const parsed = videoNotePastePreviewResponseSchema.safeParse(details.preview);
    return parsed.success ? { kind: "stale", preview: parsed.data } : { kind: "other" };
  }
  if (error.status === 403) return error.message.startsWith("Forbidden: only the author") ? { kind: "other" } : { kind: "access" }; // an authorship refusal is an ordinary error; any other 403 is access
  if (error.status === 404) return details.error === "Note not found" || error.message === "Note not found" ? { kind: "gone" } : { kind: "access" };
  if ((error.status === 413 || error.status === 422) && typeof details.code === "string" && MARKUP_CODES.includes(details.code)) return { kind: "markup", markupCode: details.code as VideoMarkupErrorCode };
  if (error.status === 422 && details.code === "frame_out_of_range") return { kind: "range", ...(typeof details.frameCount === "number" ? { frameCount: details.frameCount } : {}) };
  return { kind: "other" };
}
