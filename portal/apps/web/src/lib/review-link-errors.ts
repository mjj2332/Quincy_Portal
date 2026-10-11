import { ApiError } from "./api";

/**
 * What a refused Review link request means to a person (#741 11b), and what the UI does next. Kept apart from the data layer so the form
 * store (loaded eagerly by the collection) imports no query code. `gateClosed` is the gate part off (404 "Not found"), the capability gone
 * (403) or the Project hidden: the UI hides itself. `refetch` means the list on screen is stale (the link changed, was revoked or is gone).
 */
export type ReviewLinkErrorAction = "none" | "refetch" | "gateClosed";
export type ClassifiedReviewLinkError = { text: string; action: ReviewLinkErrorAction; code?: string };

const detailsOf = (error: ApiError): Record<string, unknown> => (error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {});

const CODE_COPY: Record<string, { text: string; action: ReviewLinkErrorAction }> = {
  link_revoked: { text: "This Review link was revoked, so it can't be changed.", action: "refetch" },
  link_expired: { text: "This Review link has expired. Extend its expiry first, then replace it.", action: "refetch" },
  grant_required: { text: "Grant at least one Version. To stop sharing a Video, remove it instead.", action: "none" },
  grant_not_version: { text: "That Version no longer belongs to this Video. The list was refreshed.", action: "refetch" },
  project_archived: { text: "Archived projects are read-only; Review links can't be changed. Revoking still works.", action: "none" },
  already_on_link: { text: "That Video is already on this link.", action: "refetch" },
  link_conflict: { text: "The Review link changed. It was reloaded; try again.", action: "refetch" },
  video_other_project: { text: "Every Video must belong to this Project. The list was refreshed.", action: "refetch" },
  expiry_out_of_range: { text: "The expiry must be between one hour and 365 days from now.", action: "none" },
};

export function classifyReviewLinkError(error: unknown): ClassifiedReviewLinkError {
  if (!(error instanceof ApiError)) return { text: "Something went wrong. Try again.", action: "none" };
  const details = detailsOf(error);
  const code = typeof details.code === "string" ? details.code : undefined;
  if (error.status === 0) return { text: "Couldn't reach the server. Check the Review links list before trying again.", action: "none" };
  if (code && CODE_COPY[code]) return { ...CODE_COPY[code]!, code };
  if (error.status === 403) return { text: "You can't manage Review links on this Project.", action: "gateClosed" };
  if (error.status === 404) {
    const said = typeof details.error === "string" ? details.error : error.message;
    if (said === "Review link not found") return { text: "That Review link no longer exists. The list was refreshed.", action: "refetch" };
    if (said === "That Video is not on this link.") return { text: "That Video is no longer on this link. The list was refreshed.", action: "refetch" };
    return { text: "Review links aren't available on this Project.", action: "gateClosed" };
  }
  if (error.status === 429) return { text: "Too many requests. Wait a moment and try again.", action: "none" };
  return { text: error.message || "Something went wrong. Try again.", action: "none", ...(code ? { code } : {}) };
}
