import { videoDtoSchema, type VideoDto } from "@quincy/shared";
import { ApiError } from "./api";

/** Which Review status refusal an error is (#863). Apart from the data layer so the pill can show its text without importing the query code. */
export type ReviewStatusErrorKind = "archived" | "not_latest" | "conflict" | "access" | "network" | "uncertain" | "other";
/** `not_latest` and `conflict` carry the server's fresh Video, which the cache takes before the caller sees the error. */
export type ClassifiedReviewStatusError = { kind: ReviewStatusErrorKind; video?: VideoDto };

const detailsOf = (error: ApiError): Record<string, unknown> => (error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {});

/** A transport failure or a server error may hide a committed write, so neither is retried: the person is told to check. */
export function classifyReviewStatusError(error: unknown): ClassifiedReviewStatusError {
  if (!(error instanceof ApiError)) return { kind: "uncertain" };
  const details = detailsOf(error); const code = details.code;
  if (error.status === 0) return { kind: "network" };
  if (error.status === 409 && code === "project_archived") return { kind: "archived" };
  if (error.status === 409 && (code === "not_latest_version" || code === "review_status_conflict")) {
    const video = videoDtoSchema.safeParse(details.video);
    return { kind: code === "not_latest_version" ? "not_latest" : "conflict", ...(video.success ? { video: video.data } : {}) };
  }
  if (error.status === 403 || error.status === 404) return { kind: "access" };
  if (error.status >= 500) return { kind: "uncertain" };
  return { kind: "other" };
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
