import type { VideoDto } from "@quincy/shared";
import { classifyVersionWriteError, freshVideoOf } from "./video-version-write-errors";

/** Which Review status refusal an error is (#863). Apart from the data layer so the pill can show its text without importing the query code. */
export type ReviewStatusErrorKind = "archived" | "not_latest" | "conflict" | "access" | "network" | "uncertain" | "other";
/** `not_latest` and `conflict` carry the server's fresh Video, which the cache takes before the caller sees the error. */
export type ClassifiedReviewStatusError = { kind: ReviewStatusErrorKind; video?: VideoDto };

/** A transport failure or a server error may hide a committed write, so neither is retried: the person is told to check. Review status adds its own 409, `conflict`; its 400 stays `other`. */
export function classifyReviewStatusError(error: unknown): ClassifiedReviewStatusError {
  return classifyVersionWriteError<ClassifiedReviewStatusError>(error, (apiError, code, details) =>
    (apiError.status === 409 && code === "review_status_conflict" ? { kind: "conflict", ...freshVideoOf(details) } : null));
}

export function reviewStatusErrorText(kind: ReviewStatusErrorKind): string {
  switch (kind) {
    case "not_latest": return "A newer version was uploaded. Its review status is set on that version, and the list has been refreshed.";
    case "conflict": return "The review status changed while you were looking. It has been refreshed; choose again if you still want to change it.";
    case "archived": return "This project is archived, so the review status is read-only.";
    case "access": return "You no longer have access to this. It has been refreshed.";
    case "network": return "Couldn't reach the server. The change may have been applied; check the status before trying again.";
    case "uncertain": return "Something went wrong on the server. The change may have been applied; check the status before trying again.";
    case "other": return "That didn't go through. Try again.";
  }
}
