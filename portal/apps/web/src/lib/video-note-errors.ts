import { videoNotePastePreviewResponseSchema, videoNoteThreadDtoSchema, type VideoNotePastePreviewResponse, type VideoNoteThreadDto } from "@quincy/shared";
import { ApiError } from "./api";

/** Which 5a refusal an error is (#741 5b). Kept apart from the data layer so the form store, which the collection loads eagerly, need not import the query code. */
export type VideoNoteErrorKind = "archived" | "conflict" | "deleted" | "gone" | "access" | "range" | "network" | "stale" | "other";
/** `stale` is a paste commit whose source notes changed since the preview: `preview` is the server's current plan. */
export type ClassifiedVideoNoteError = { kind: VideoNoteErrorKind; thread?: VideoNoteThreadDto; frameCount?: number; preview?: VideoNotePastePreviewResponse };

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
  if (error.status === 422 && details.code === "frame_out_of_range") return { kind: "range", ...(typeof details.frameCount === "number" ? { frameCount: details.frameCount } : {}) };
  return { kind: "other" };
}
